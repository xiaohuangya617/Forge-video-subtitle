"""Full timeline ASR with bounded, distributed second passes (no new model)."""
import hashlib
import math
import re
import time
from difflib import SequenceMatcher
from types import SimpleNamespace as NS

from recognition_quality import RATE, compact, finite, join_zero_duration_words, prompt_echo, local_language_anomaly
from recognition_refine import breath_like, breath_review, retry_bounds, dialogue_noise, measured_phrase
from recognition_checkpoint import Checkpoint, Recording, unpack


def plan_windows(samples, speech, target=24, padding=1.5, pauses=None):
    """Disjoint ownership cores cover every sample; input context may overlap."""
    if samples <= 0:
        return []
    speech = sorted(speech, key=lambda s: s['start'])
    boundaries = list(pauses or [])
    for left, right in zip(speech, speech[1:]):
        if right['start'] > left['end']:
            boundaries.append((left['end'] + right['start']) // 2)
    windows, cursor = [], 0
    while cursor < samples:
        # Longer windows save fixed model overhead in quiet sections. Dense,
        # continuous speech is kept at the 20-second baseline because it is
        # more sensitive to long-window word alignment and sentence drift.
        candidate_end = min(samples, cursor + int(target * RATE))
        candidate_len = max(1, candidate_end - cursor)
        speech_overlap = sum(max(0, min(candidate_end, s['end']) -
                                max(cursor, s['start'])) for s in speech)
        dense = speech_overlap / candidate_len >= .78 and sum(
            1 for s in speech if s['start'] < candidate_end and s['end'] > cursor) >= 2
        window_target = 20 if dense else target
        aim = min(samples, cursor + int(window_target * RATE))
        nearby = [p for p in boundaries if cursor + 12*RATE <= p < samples
                  and abs(p-aim) <= 4*RATE]
        end = min(nearby, key=lambda p: abs(p-aim)) if nearby and samples-aim > 4*RATE else aim
        if samples-end < 3*RATE:
            end = samples
        windows.append({'core_start': cursor, 'core_end': end,
                        'start': max(0, cursor-int(padding*RATE)),
                        'end': min(samples, end+int(padding*RATE)),
                        'target_seconds': window_target})
        cursor = end
    return windows


class DistributedBudget:
    """Unused early allowances cannot consume later ten-minute allocations."""
    def __init__(self, duration):
        self.duration = duration
        self.buckets = {}
        self.count = 0
        self.audio = self.wall = 0.0

    def reserve(self, start, seconds, kind):
        bucket_id = int(start // 600)
        bucket_duration = max(1, min(600, self.duration-bucket_id*600))
        bucket = self.buckets.setdefault(bucket_id, {'count':0, 'audio':0., 'wall':0., 'kinds':{}})
        count_limit = max(2, math.ceil(bucket_duration/100))
        audio_limit = max(25, bucket_duration*.15)
        wall_limit = max(40, bucket_duration*.25)
        timing_reserve = max(1, math.ceil(count_limit/3))
        ordinary = sum(v for k,v in bucket['kinds'].items() if k!='时间修复')
        if kind!='时间修复' and (ordinary>=count_limit-timing_reserve
                or bucket.get('no_gain',0)>=2 or bucket['audio']+seconds>audio_limit*.65
                or bucket['wall']>=wall_limit*.65):
            return None
        if (bucket['count'] >= count_limit or bucket['audio']+seconds > audio_limit
                or bucket['wall'] >= wall_limit):
            return None
        bucket['count'] += 1
        bucket['audio'] += seconds
        bucket['kinds'][kind] = bucket['kinds'].get(kind, 0)+1
        self.count += 1
        self.audio += seconds
        return bucket_id

    def finish(self, bucket_id, elapsed, adopted=None, kind=None):
        self.buckets[bucket_id]['wall'] += elapsed
        self.wall += elapsed
        if adopted is not None and kind!='时间修复':
            bucket=self.buckets[bucket_id]
            bucket['no_gain']=0 if adopted else bucket.get('no_gain',0)+1


def assess(segment, context, cleaner):
    text, removed = cleaner(segment.text)
    c = segment.confidence
    issues = []
    if not text:
        issues.append(removed or '空结果')
    if prompt_echo(text, context):
        issues.append('疑似提示污染')
    if re.search(r'(.{2,12})\1{3,}', compact(text)):
        issues.append('异常重复')
    weak = sum([c['probability'] < .55, c['logprob'] < -.85, c['no_speech'] > .5])
    if weak >= 2:
        issues.append('多项识别可信证据偏弱')
    if c.get('zero_ratio', 0) >= .7 and len(compact(text)) >= 6:
        issues.append('多数词缺乏独立时间定位')
    if re.search(r'ご視聴ありがとうございました|字幕をご覧ください|チャンネル登録', text):
        issues.append('疑似模板字幕，需要复核原音')
    language_anomaly = local_language_anomaly(text)
    if language_anomaly:
        issues.append(language_anomaly)
    words = segment.words
    invalid = not words
    previous = segment.start
    for word in words:
        if (word.end <= word.start or word.end-word.start > 5 or word.start < previous-.04
                or word.start < segment.start-.04 or word.end > segment.end+.04):
            invalid = True
        previous = word.end
    if compact(''.join(w.word for w in words)) != compact(segment.text):
        invalid = True
    if invalid and text:
        issues.append('无法可靠定位完整文字')
    # Low volume alone never rejects text. Require combined acoustic evidence.
    unsupported = ((c['logprob'] < -1.5 and c['probability'] < .45)
                   or (c['no_speech'] > .8 and c['logprob'] < -1.0)
                   or (c.get('zero_ratio', 0) >= .7 and c['no_speech'] > .6))
    contaminated = prompt_echo(text, context) or bool(re.search(
        r'ご視聴ありがとうございました|字幕をご覧ください|チャンネル登録', text))
    contaminated = contaminated or bool(language_anomaly)
    timing_weak = c.get('zero_ratio', 0) >= .55 and (c['probability'] < .7 or c['logprob'] < -.65)
    loop_weak = bool(re.search(r'(.{2,8})\1{3,}', compact(text))) and (c['probability'] < .8 or c['logprob'] < -.45)
    fragment = bool(re.fullmatch(r'(?:を|が|に|で|と|は|も|の|から|ので|けど)', compact(text)))
    if timing_weak:
        issues.append('词时间退化且声学可信度不足')
    if loop_weak:
        issues.append('循环文字缺乏足够声学支持')
    if fragment:
        issues.append('孤立助词残片，无法构成完整台词')
    usable = bool(text) and not invalid and not unsupported and weak < 2 and not contaminated and not timing_weak and not loop_weak and not fragment
    score = c['logprob'] + .5*c['probability'] - .3*c['no_speech']
    return {'text':text, 'issues':issues, 'usable':usable, 'score':score, 'timing_invalid':invalid}


def decode(model, audio, start, end, language, context, hotwords, diag, window_id, attempt, beam=5):
    began=time.monotonic();cpu=time.process_time()
    try:
        return _decode(model,audio,start,end,language,context,hotwords,diag,window_id,attempt,beam)
    finally:
        diag.write('stage-time',stage='primary' if attempt=='primary' else 'retry',window=window_id,
                   wall_seconds=time.monotonic()-began,cpu_seconds=time.process_time()-cpu)


def _decode(model, audio, start, end, language, context, hotwords, diag, window_id, attempt, beam=5):
    offset = start/RATE
    diag.write('model-input', window=window_id, attempt=attempt, start=offset, end=end/RATE,
               context=context or '', hotwords=hotwords or '', beam_size=beam,temperature=0.)
    segments, detail = model.transcribe(audio[start:end], language=language,
        initial_prompt=context, hotwords=hotwords, vad_filter=False, beam_size=beam,
        word_timestamps=True, condition_on_previous_text=False,temperature=0.)
    result = []
    for raw in segments:
        words = [NS(start=offset+finite(w.start), end=offset+finite(w.end), word=w.word)
                 for w in (raw.words or [])]
        raw_words = [{'start':w.start, 'end':w.end, 'text':w.word,
                      'probability':finite(getattr(rw, 'probability', 0))}
                     for w, rw in zip(words, raw.words or [])]
        confidence = {'probability':sum(w['probability'] for w in raw_words)/max(1,len(words)),
                      'logprob':finite(raw.avg_logprob, -100),
                      'no_speech':finite(raw.no_speech_prob, 1),
                      'zero_ratio':sum(w.end <= w.start for w in words)/max(1,len(words))}
        diag.write('model-raw', window=window_id, attempt=attempt, text=raw.text,
                   start=offset+raw.start, end=offset+raw.end, words=raw_words,
                   avg_logprob=confidence['logprob'], no_speech_prob=confidence['no_speech'],
                   temperature=getattr(raw,'temperature',None))
        joined = join_zero_duration_words(words)
        if len(words) != len(joined):
            diag.write('alignment-join', window=window_id, attempt=attempt,
                       before=len(words), after=len(joined), zero_ratio=confidence['zero_ratio'])
        a = min([offset+raw.start]+[w.start for w in joined])
        b = max([offset+raw.end]+[w.end for w in joined])
        segment=NS(start=a, end=b, text=raw.text, words=joined, confidence=confidence,
                   raw_start=offset+raw.start,raw_end=offset+raw.end)
        repaired=measured_phrase(segment)
        if repaired:
            diag.write('alignment-phrase',window=window_id,start=repaired.start,end=repaired.end,
                       text=repaired.text,reason='保留模型实测短句时间，替代不完整的子词时间')
        result.append(repaired or segment)
    return result, getattr(detail, 'language', language)


def retry_ranges(segments, assessments, speech, window, dialogue_only=False):
    ranges = []
    for seg, check in zip(segments, assessments):
        if check['issues'] and not breath_like(seg.text) and not (dialogue_only and dialogue_noise(seg.text)):
            timing=check.get('timing_invalid',False)
            ranges.append({'start':seg.start, 'end':seg.end, 'kind':'时间修复' if timing else '疑难重试',
                           'priority':4 if timing else 3 if not check['usable'] else 2})
    for s in speech:
        a, b = max(s['start'], window['core_start'])/RATE, min(s['end'], window['core_end'])/RATE
        if b-a >= .6 and not any(x.start < b and x.end > a for x in segments):
            ranges.append({'start':a, 'end':b, 'kind':'覆盖补查', 'priority':3})
    merged = []
    for r in sorted(ranges, key=lambda x:x['start']):
        if merged and r['kind']==merged[-1]['kind'] and r['start']-merged[-1]['end'] <= .8 and r['end']-merged[-1]['start'] <= 12:
            merged[-1]['end'] = max(merged[-1]['end'], r['end'])
            merged[-1]['priority'] = max(merged[-1]['priority'], r['priority'])
        else:
            merged.append(dict(r))
    return sorted(merged, key=lambda x:(-x['priority'], x['start']))


def choose_range(original, proposed, context, cleaner):
    """Transactional replacement; an empty/weak retry never removes usable text."""
    before = [assess(s, context, cleaner) for s in original]
    after = [assess(s, context, cleaner) for s in proposed]
    good = [(s,c) for s,c in zip(proposed,after) if c['usable'] and not c['issues']]
    if not good or len(good) != len(proposed):
        return original, '保留原结果；复听为空或证据不足'
    # Every usable original must still be represented before replacing a range.
    for s,c in zip(original,before):
        if c['usable'] and not any(SequenceMatcher(None,compact(s.text),compact(''.join(
                t.text for t in proposed[i:j]))).ratio()>=.55
                for i in range(len(proposed)) for j in range(i+1,len(proposed)+1)):
            return original, '保留原结果；复听未保留原可用台词'
    old_good = [(s,c) for s,c in zip(original,before) if c['usable']]
    if not old_good:
        return proposed, '采用复听；原结果为空或无法可靠输出'
    if any(c.get('timing_invalid') for c in before):
        full=compact(''.join(s.text for s in original));replacement=compact(''.join(s.text for s in proposed))
        if SequenceMatcher(None,full,replacement).ratio()>=.75:
            return proposed, '采用复听；文字相互支持且时间定位恢复'
    left = compact(''.join(s.text for s,c in old_good))
    right = compact(''.join(s.text for s,c in good))
    similarity = SequenceMatcher(None,left,right).ratio()
    old_score = sum(c['score'] for s,c in old_good)/len(old_good)
    new_score = sum(c['score'] for s,c in good)/len(good)
    if similarity >= .55 and new_score >= old_score+.1 and any(c['issues'] for c in before):
        return proposed, '采用复听；文字相互支持且异常消失'
    return original, '保留原结果；差异未得到足够证据支持'


def own_segment(segment, core_start, core_end):
    """Each measured word belongs to exactly one timeline core by its midpoint."""
    words = [w for w in segment.words if core_start <= (w.start+w.end)/2 < core_end]
    if not words:
        return None
    return NS(start=words[0].start, end=words[-1].end,
              text=''.join(w.word for w in words), words=words, confidence=segment.confidence,
              display_end=max(words[-1].end, min(core_end, words[-1].end+.2)),
              timing_review=getattr(segment,'timing_review',False))


def transcribe_windows(model, media, language, context, hotwords, diag, cleaner, emit):
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import get_speech_timestamps, VadOptions
    began=time.monotonic();cpu=time.process_time()
    audio = decode_audio(media, sampling_rate=RATE)
    diag.write('stage-time',stage='audio-read',wall_seconds=time.monotonic()-began,cpu_seconds=time.process_time()-cpu)
    began=time.monotonic();cpu=time.process_time()
    dialogue_only=getattr(diag,'dialogue_only',True)
    duration = len(audio)/RATE
    speech = get_speech_timestamps(audio, VadOptions(threshold=.35,
        min_speech_duration_ms=100, min_silence_duration_ms=600,
        speech_pad_ms=400, max_speech_duration_s=28)) if len(audio) else []
    # Low-energy pause locations only choose boundaries; they never discard audio.
    import numpy as np
    frame = RATE//10
    energy = np.mean(np.abs(audio[:len(audio)//frame*frame].reshape(-1,frame)),axis=1) if len(audio)>=frame else []
    pauses = []
    for i in range(1,len(energy)-1):
        if energy[i] < .002 and energy[i] <= energy[i-1] and energy[i] <= energy[i+1]:
            pauses.append(i*frame+frame//2)
    windows = plan_windows(len(audio), speech, pauses=pauses)
    checkpoint = Checkpoint(getattr(diag,'checkpoint_dir',None), {
        'engine':'factory-asr-4.1.8','key':getattr(diag,'checkpoint_key',''),'dialogue_only':dialogue_only,
        'decode_policy':'adaptive-window24-dense20-beam5-repair7',
        'audio':hashlib.sha256(memoryview(audio)).hexdigest(), 'language':language,
        'context':context,'hotwords':hotwords,'windows':windows})
    diag.write('vad', duration=duration, threshold=.35, role='分段及复听参考，不丢弃未命中范围',
               windows=[{'start':s['start']/RATE,'end':s['end']/RATE} for s in speech])
    diag.write('coverage-plan', duration=duration, mode='complete', windows=[
        {k:v/RATE for k,v in w.items()} for w in windows])
    if language is None and speech:
        sample = max(speech, key=lambda s:s['end']-s['start'])
        language, _, _ = model.detect_language(audio=audio[sample['start']:sample['end']])
    info = NS(duration=duration, language=language or 'auto')
    budget = DistributedBudget(duration)
    diag.write('stage-time',stage='prepare',wall_seconds=time.monotonic()-began,cpu_seconds=time.process_time()-cpu)

    diagnostic = diag
    def generate():
        diag = diagnostic
        detected = language
        completed = 0
        last_words = []
        try:
            for idx, window in enumerate(windows, 1):
                start, end = window['start'], window['end']
                a, b = window['core_start']/RATE, window['core_end']/RATE
                began=time.monotonic();cpu=time.process_time()
                cached = checkpoint.read(idx)
                diag.write('stage-time',stage='checkpoint-read',wall_seconds=time.monotonic()-began,cpu_seconds=time.process_time()-cpu)
                if cached:
                    diag = diagnostic
                    detected = cached['language']; info.language = detected or 'auto'
                    budget.__dict__.update(cached['budget'])
                    budget.buckets = {int(k):v for k,v in budget.buckets.items()}
                    for record in cached['events']:
                        diag.write(record['event'],**{k:v for k,v in record.items() if k not in ('event','cached')},cached=True)
                    outputs = [unpack(s) for s in cached['segments']]
                    for s in outputs:
                        last_words=s.words
                        yield s
                    completed=window['core_end']
                    emit({'event':'checkpoint-resume','current':idx,'total':len(windows),'end':b})
                    continue
                diag = Recording(diagnostic)
                outputs = []
                emit({'event':'coverage-progress','current':idx,'total':len(windows),'start':a,'end':a})
                if not np.any(audio[start:end]):
                    segments, guessed = [], detected
                    diag.write('digital-silence',window=idx,start=a,end=b)
                else:
                    segments, guessed = decode(model,audio,start,end,detected,context,hotwords,
                                               diag,idx,'primary',beam=5)
                if detected is None and guessed:
                    detected = guessed
                    info.language = guessed
                checks = [assess(s,context,cleaner) for s in segments]
                ranges = retry_ranges(segments,checks,speech,window,dialogue_only)
                decisions = []
                attempted = []
                for r in ranges:
                    bounds = retry_bounds(r,segments,start/RATE,end/RATE)
                    if bounds is None:
                        diag.write('review',window=idx,start=r['start'],end=r['end'],text='',
                                   reason='复听前边界检查未通过，保留原结果',retried=False)
                        continue
                    ra,rb = bounds
                    if rb <= ra:
                        continue
                    if any(x <= ra+.01 and y >= rb-.01 for x,y in attempted):
                        diag.write('retry-skipped',window=idx,start=ra,end=rb,reason='已复听相同范围')
                        continue
                    bucket = budget.reserve(a, rb-ra, r['kind'])
                    if bucket is None:
                        decisions.append('本时间段额外复听预算已用尽')
                        diag.write('review', window=idx,start=ra,end=rb,text='',
                                   reason='本时间段额外复听预算已用尽', kind=r['kind'], retried=False)
                        continue
                    emit({'event':'recognition-retry','start':ra,'end':rb,'kind':r['kind']})
                    attempted.append((ra,rb))
                    began = time.monotonic();adopted=False
                    try:
                        proposed, _ = decode(model,audio,int(ra*RATE),int(rb*RATE),detected,
                                             None,None,diag,idx,'retry-no-prompt',beam=7)
                        # Only replace originals wholly inside the input, never a crossing sentence.
                        candidates = [s for s in segments if s.start >= ra-.01 and s.end <= rb+.01]
                        crossing = [s for s in segments if s.start < rb and s.end > ra and s not in candidates]
                        proposed = [s for s in proposed if s.start >= ra-.01 and s.end <= rb+.01]
                        if dialogue_only:
                            proposed=[s for s in proposed if not dialogue_noise(s.text)]
                        winner, decision = choose_range(candidates,proposed,context,cleaner)
                        if crossing:
                            winner, decision = candidates, '保留原结果；复听边界跨越已有句子'
                        if winner is proposed:
                            adopted=True
                            segments = sorted([s for s in segments if s not in candidates]+proposed,
                                              key=lambda s:s.start)
                        decisions.append(decision)
                        diag.write('retry-decision',window=idx,start=ra,end=rb,decision=decision,
                                   original=''.join(s.text for s in candidates),
                                   proposed=''.join(s.text for s in proposed),kind=r['kind'])
                    except Exception as exc:
                        decisions.append('复听异常，原结果保留')
                        diag.write('review',window=idx,start=ra,end=rb,text='',retried=True,
                                   reason='复听异常，原结果保留',message=str(exc))
                    finally:
                        budget.finish(bucket,time.monotonic()-began,adopted,r['kind'])
                for segment in segments:
                    owned = own_segment(segment,a,b)
                    if not owned:
                        if segment.start < b and segment.end > a and not segment.words:
                            diag.write('review',window=idx,start=segment.start,end=segment.end,
                                       text=segment.text,reason='缺少有效词时间，保留诊断',exported=False,
                                       retried=any(x < segment.end and y > segment.start for x,y in attempted))
                        continue
                    check = assess(segment,context,cleaner)
                    if breath_review(segment,speech,dialogue_only):
                        check['usable']=False
                        check['issues'].append((dialogue_noise(segment.text) if dialogue_only else '') or '气声或重复碎片且声学证据不足，移入复核')
                    if getattr(segment,'timing_review',False):
                        check['issues'].append('使用模型实测短句时间，建议核对')
                    if check['issues']:
                        diag.write('review',window=idx,start=owned.start,end=owned.end,text=owned.text,
                                   reasons=check['issues'],exported=check['usable'],
                                   retried=any(x < owned.end and y > owned.start for x,y in attempted),
                                   decision='；'.join(decisions) or '保留供复核')
                    diag.write('decision',window=idx,start=owned.start,end=owned.end,
                               text=owned.text,exported=check['usable'],decision='输出' if check['usable'] else '证据或时间定位不足')
                    if not check['usable']:
                        continue
                    # Context overlap can move an identical boundary word slightly across the core.
                    while owned.words and last_words:
                        first = owned.words[0]
                        duplicate = next((w for w in last_words[-8:] if compact(w.word)==compact(first.word)
                                          and min(w.end,first.end)>max(w.start,first.start)),None)
                        if duplicate is None:
                            break
                        diag.write('overlap-dedup',start=first.start,end=first.end,text=first.word)
                        owned.words.pop(0)
                    if not owned.words:
                        continue
                    owned.text = ''.join(w.word for w in owned.words)
                    owned.start = owned.words[0].start
                    last_words = owned.words
                    outputs.append(owned)
                if outputs:
                    last_words = outputs[-1].words
                diag.write('coverage-complete-window',window=idx,start=a,end=b)
                began=time.monotonic();cpu=time.process_time()
                checkpoint.save(idx,outputs,diag.events,budget,detected)
                diagnostic.write('stage-time',stage='checkpoint-write',wall_seconds=time.monotonic()-began,cpu_seconds=time.process_time()-cpu)
                for owned in outputs:
                    yield owned
                completed = window['core_end']
                emit({'event':'coverage-progress','current':idx,'total':len(windows),'end':b,'completed':True})
        finally:
            diag = diagnostic
            diag.write('coverage-summary',duration=duration,processed_until=completed/RATE,
                       complete=completed==len(audio),primary_windows=len(windows))
            diag.write('retry-summary',count=budget.count,audio_seconds=budget.audio,
                       wall_seconds=budget.wall,buckets=budget.buckets,
                       note='按十分钟独立分配并预留时间修复额度；普通复听连续两次未采用则停止该区间普通复听；正常覆盖不占预算')
    return generate(), info
