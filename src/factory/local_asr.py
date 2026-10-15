"""Silent local ASR worker. Loads one model and processes a batch in order."""
import argparse, hashlib, json, os, re, shutil, subprocess, sys, tempfile, threading, time, unicodedata, wave
from pathlib import Path
from functools import lru_cache
from types import SimpleNamespace
from recognition_refine import dialogue_noise

_OUTPUT_LOCK = threading.Lock()
MAX_CUE_SECONDS = 5.0
MIN_CUE_SECONDS = 0.6
MAX_CONTEXT_TOKENS = 96
MAX_HOTWORD_TOKENS = 48

def bounded_hints(model, context, hotwords):
    """Use the actual Whisper tokenizer, leaving room for history and new text.

    faster-whisper 1.1.1 retains up to 223 history tokens independently of
    hotwords. 48 hotword tokens + 223 history + 4 control tokens = 275,
    leaving at least 173 of the 448 positions for decoding.
    """
    tokenizer = model.hf_tokenizer
    def size(text):
        return len(tokenizer.encode(' ' + text.strip(), add_special_tokens=False).ids) if text else 0
    original_context = context.strip()
    context = original_context[:MAX_CONTEXT_TOKENS * 8]
    while context and size(context) > MAX_CONTEXT_TOKENS:
        context = context[:-1].rstrip()
    words = []
    for word in re.split(r'[\s,、，]+', str(hotwords or '').strip()):
        if not word or word in words:
            continue
        if size(' '.join(words + [word])) > MAX_HOTWORD_TOKENS:
            break
        words.append(word)
    hotwords = ' '.join(words)
    emit({'event':'hint-budget','contextTokens':size(context),
          'hotwordTokens':size(hotwords), 'contextTrimmed':context != original_context})
    return context or None, hotwords or None

def srt_block(number, cue):
    return f'{number}\n{stamp(cue["start"])} --> {stamp(max(cue["end"], cue["start"] + 0.01))}\n{cue["text"]}\n\n'

def write_srt(path, cues):
    # Replace atomically so the incremental recovery file remains valid on error.
    target = Path(path)
    fd, temp = tempfile.mkstemp(dir=target.parent, prefix='.subtitle-', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            for number, cue in enumerate(cues, 1):
                handle.write(srt_block(number, cue))
        os.replace(temp, target)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)

def clean_transcript_text(value):
    """Remove obvious ASR noise while preserving normal dialogue."""
    text = unicodedata.normalize('NFKC', str(value or ''))
    text = re.sub(r'[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\ufeff]', '', text)
    text = re.sub(r'\s+', ' ', text).strip()
    if not text:
        return '', '空结果'
    if '\ufffd' in text or re.search(r'[ÃÂÐ]', text):
        return '', '乱码'
    visible = [char for char in text if not char.isspace()]
    if not visible or not any(char.isalnum() or '\u3040' <= char <= '\u30ff' or '\u3400' <= char <= '\u9fff' for char in visible):
        return '', '无意义符号'
    text = re.sub(r'([^\w\s\u3040-\u30ff\u3400-\u9fff])\1{3,}', r'\1\1', text)
    text = re.sub(r'([A-Za-z])\1{4,}', r'\1\1', text)
    visible = [char for char in text if not char.isspace()]
    if len(visible) >= 4 and len(set(visible)) == 1:
        return '', '重复字符'
    punctuation = sum(1 for char in visible if unicodedata.category(char).startswith('P') or unicodedata.category(char).startswith('S'))
    if len(visible) >= 5 and punctuation / len(visible) > 0.78:
        return '', '无意义符号'
    kana = sum(1 for char in text if '\u3040' <= char <= '\u30ff')
    han = sum(1 for char in text if '\u3400' <= char <= '\u9fff')
    latin = sum(1 for char in text if ('A' <= char <= 'Z') or ('a' <= char <= 'z'))
    words = re.findall(r'[A-Za-z]+', text)
    # A foreign-language line is not by itself evidence of hallucination.
    return text, ''

@lru_cache(maxsize=1)
def japanese_tokenizer():
    from janome.tokenizer import Tokenizer
    return Tokenizer()


def lexical_words(words):
    """Merge ASR subwords crossing a dictionary word; never invent character times."""
    if not words:
        return []
    compact = lambda text: re.sub(r'\s+', '', text)
    full = ''.join(compact(w.word) for w in words)
    if not re.search(r'[\u3040-\u30ff\u3400-\u9fff]', full):
        return words
    boundaries = set(); offset = 0
    for token in japanese_tokenizer().tokenize(full):
        if token.part_of_speech.startswith(('助詞','助動詞')):
            boundaries.discard(offset)
        offset += len(token.surface)
        boundaries.add(offset)
    # Merge source entries only: a dictionary never supplies replacement text.
    merged = []; current = []; offset = 0
    for word in words:
        current.append(word); offset += len(compact(word.word))
        if offset in boundaries:
            merged.append(SimpleNamespace(start=current[0].start, end=current[-1].end,
                                          word=''.join(w.word for w in current)))
            current = []
    if current:
        merged.append(SimpleNamespace(start=current[0].start, end=current[-1].end,
                                      word=''.join(w.word for w in current)))
    return merged


def aligned_groups(segment, japanese=True, diagnostic=None):
    """Group actual Whisper word times; never stretch text across silence."""
    words = list(getattr(segment, 'words', None) or [])
    def conservative_fallback(reason):
        """Keep a short, credible segment when only word alignment is broken.

        Segment timing is measured by Whisper and is safe for a short phrase;
        it must never become a general-purpose repair for long or weak output.
        """
        text, _ = clean_transcript_text(segment.text)
        confidence = getattr(segment, 'confidence', {}) or {}
        start = max(0.0, float(getattr(segment, 'start', 0.0)))
        end = float(getattr(segment, 'end', start))
        duration = end - start
        if (not text or not 0 < duration <= MAX_CUE_SECONDS
                or confidence.get('probability', 0) < .65
                or confidence.get('logprob', -100) < -.9
                or confidence.get('no_speech', 1) > .4
                or dialogue_noise(text)):
            return []
        if diagnostic:
            diagnostic.write('alignment-fallback', start=start, end=end,
                             text=text, reason=reason,
                             timing_review=True)
        return [{'start':start, 'end':end, 'text':text, 'timing_review':True,
                 'cues':[{'start':start, 'end':end, 'text':text}]}]
    # A long sentence squeezed into <0.8s with almost all tokens having zero
    # duration is not usable alignment (common opening-noise hallucination).
    if words and len(re.sub(r'\s+', '', segment.text)) >= 10:
        collapsed = sum(w.end-w.start < 0.01 for w in words)
        if max(w.end for w in words)-min(w.start for w in words) < 0.8 and collapsed/len(words) >= 0.8:
            return []
    if japanese:
        merged = lexical_words(words)
        # A merged lexical word longer than 5s must retain its original timed pieces.
        if all(w.end-w.start <= MAX_CUE_SECONDS for w in merged):
            words = merged
    if not words:
        text, _ = clean_transcript_text(segment.text)
        if not text:
            return []
        start = max(0.0, float(segment.start))
        end = float(segment.end)
        if end <= start or end-start > MAX_CUE_SECONDS:
            return []
        # Without alignment keep the sentence intact and flag it for review.
        return [{'start':start, 'end':end, 'text':text, 'timing_review':True,
                 'cues':[{'start':start, 'end':end, 'text':text}]}]
    # If one or more word timestamps are malformed, preserve a short credible
    # sentence using Whisper's measured segment bounds for manual review.
    if any(float(getattr(w, 'end', 0)) <= float(getattr(w, 'start', 0))
           or float(getattr(w, 'end', 0)) - float(getattr(w, 'start', 0)) > MAX_CUE_SECONDS
           or float(getattr(w, 'start', 0)) < float(segment.start) - .04
           or float(getattr(w, 'end', 0)) > float(segment.end) + .04
           for w in words):
        return conservative_fallback('词级时间异常，保留模型整句实测时间')
    phrases = []; current = []
    for word in words:
        text = str(word.word or '')
        if not text.strip():
            continue
        start = max(0.0, float(word.start))
        end = float(word.end)
        if end <= start or end-start > MAX_CUE_SECONDS:
            return conservative_fallback('词级时间异常，保留模型整句实测时间')
        gap = start - current[-1]['end'] if current else 0
        # Japanese Whisper 'words' may be subword fragments. A small gap inside
        # an unbroken spelling must not turn e.g. ね + え into separate phrases.
        lexical_boundary = text[:1].isspace() or (current and re.search(r'[。！？!?、,]$', current[-1]['text']))
        if current and (gap >= 1.6 or (gap >= 0.6 and lexical_boundary)
                        or end - current[0]['start'] > 20):
            phrases.append(current); current = []
        current.append({'start':start, 'end':end, 'text':text})
        if re.search(r'[。！？!?]\s*$', text):
            phrases.append(current); current = []
    if current:
        phrases.append(current)
    groups = []
    for phrase in phrases:
        review = any(w['end'] - w['start'] > MAX_CUE_SECONDS for w in phrase)
        # Minimize fragments using pauses/whitespace/punctuation, preserving the
        # measured timestamps. No character slicing or duration interpolation.
        size = len(phrase)
        costs = [float('inf')] * (size + 1); costs[size] = 0
        choices = [size] * size
        for i in range(size - 1, -1, -1):
            for j in range(i + 1, size + 1):
                duration = phrase[j-1]['end'] - phrase[i]['start']
                if duration > MAX_CUE_SECONDS and j > i + 1:
                    break
                text = ''.join(w['text'] for w in phrase[i:j]).strip()
                penalty = 10 + (18 if len(text) < 3 or duration < 0.7 else 0)
                if j < size:
                    gap = phrase[j]['start'] - phrase[j-1]['end']
                    boundary = phrase[j]['text'][:1].isspace() or re.search(r'[。！？!?、,]$', text)
                    penalty += 0 if boundary else 5
                    if gap >= 0.18 and boundary:
                        penalty -= 1
                    if re.match(r'[っゃゅょぁぃぅぇぉッャュョァィゥェォー]', phrase[j]['text']):
                        penalty += 20
                total = penalty + costs[j]
                if total < costs[i]:
                    costs[i] = total; choices[i] = j
        pieces = []; i = 0
        while i < size:
            j = choices[i]
            raw_text = ''.join(w['text'] for w in phrase[i:j])
            text, reason = clean_transcript_text(raw_text)
            if diagnostic and (not text or text != raw_text.strip()):
                diagnostic.write('split-filter', start=phrase[i]['start'], end=phrase[j-1]['end'],
                                 raw=raw_text, text=text, reason=reason or '规范字符与空白')
            if text:
                start = phrase[i]['start']
                pieces.append({'start':start, 'end':phrase[j-1]['end'], 'text':text})
            i = j
        if pieces:
            groups.append({'start':phrase[0]['start'], 'end':phrase[-1]['end'],
                           'text':''.join(w['text'] for w in phrase).strip(),
                           'timing_review':review or getattr(segment,'timing_review',False), 'cues':pieces})
    return groups


def semantic_continuation(left, right):
    gap = right['start'] - left['end']
    return (0 <= gap <= .8 and right['end']-left['start'] <= MAX_CUE_SECONDS
            and not re.search(r'[。！？!?]\s*$', left['text'])
            and bool(re.match(r'\s*(?:わけ(?:が)?ない|わけじゃない|わけではない|ではない|じゃない|くない|ないで|ません|なかった)', right['text'])))


def readable_groups(groups, duration):
    """Merge adjacent flashes or use at most 0.6 seconds of available display time.

    Audio group bounds remain measured bounds; readability padding is display-only.
    Called per independent speech window so it never joins distant conversations.
    """
    joined = []
    for group in groups:
        group = {**group, 'cues':[dict(c) for c in group['cues']]}
        if joined:
            prev = joined[-1]
            a, b = prev['cues'][-1], group['cues'][0]
            if semantic_continuation(a, b):
                a['text'] += b['text']; a['end'] = b['end']
                prev['end'] = b['end']; prev['text'] += b['text']
                prev['timing_review'] = prev.get('timing_review', False) or group.get('timing_review', False)
                group['cues'].pop(0)
                if not group['cues']:
                    continue
                group['start'] = group['cues'][0]['start']
                group['text'] = ''.join(c['text'] for c in group['cues'])
                a, b = prev['cues'][-1], group['cues'][0]
            if (not re.search(r'[。！？!?]\s*$',a['text'])
                    and min(a['end']-a['start'], b['end']-b['start']) < MIN_CUE_SECONDS
                    and 0 <= b['start']-a['end'] <= 0.55
                    and group['end']-prev['start'] <= 5):
                prev['end'] = group['end']; prev['text'] += group['text']
                prev['timing_review'] = prev.get('timing_review', False) or group.get('timing_review', False)
                prev['cues'].extend(group['cues'])
                continue
        joined.append(group)
    for group in joined:
        pieces = group['cues']; i = 0
        while i < len(pieces):
            cue = pieces[i]
            if i and semantic_continuation(pieces[i-1], cue):
                pieces[i-1]['text'] += cue['text']; pieces[i-1]['end'] = cue['end']
                pieces.pop(i); continue
            if cue['end']-cue['start'] < MIN_CUE_SECONDS:
                if i and not re.search(r'[。！？!?]\s*$',pieces[i-1]['text']) and cue['end']-pieces[i-1]['start'] <= MAX_CUE_SECONDS and 0<=cue['start']-pieces[i-1]['end'] <= 0.55:
                    pieces[i-1]['text'] += cue['text']; pieces[i-1]['end'] = cue['end']
                    pieces.pop(i); continue
                if i+1 < len(pieces) and not re.search(r'[。！？!?]\s*$',cue['text']) and pieces[i+1]['end']-cue['start'] <= MAX_CUE_SECONDS and 0<=pieces[i+1]['start']-cue['end'] <= 0.55:
                    cue['text'] += pieces[i+1]['text']; cue['end'] = pieces[i+1]['end']
                    pieces.pop(i+1); continue
            i += 1
    flat = [c for g in joined for c in g['cues']]
    for i, cue in enumerate(flat):
        before = flat[i-1]['end'] if i else 0.0
        after = flat[i+1]['start'] if i+1 < len(flat) else duration
        cue['start'] = max(before, cue['start'])
        cue['end'] = max(cue['start'], min(cue['end'], after))
        if cue['end']-cue['start'] < MIN_CUE_SECONDS:
            cue['end'] = min(after, cue['start']+MIN_CUE_SECONDS)
            cue['start'] = max(before, cue['end']-MIN_CUE_SECONDS)
    return joined


def transcribe_windows(model, media, language, context, hotwords, diagnostic):
    from recognition_quality import transcribe_windows as quality_transcribe
    return quality_transcribe(model, media, language, context, hotwords,
                              diagnostic, clean_transcript_text, emit)


def prepare_aux_groups(groups, duration):
    """Pad phrase edges without reaching a neighboring phrase's speech."""
    requests = []
    for index, group in enumerate(groups):
        if group.get('timing_review'):
            continue
        before = groups[index - 1]['end'] if index else 0.0
        after = groups[index + 1]['start'] if index + 1 < len(groups) else duration
        start = max(0.0, group['start'] - 0.20, min(group['start'], (before + group['start']) / 2))
        end = min(duration, group['end'] + 0.20, max(group['end'], (after + group['end']) / 2))
        requests.append({'start':start, 'end':end, 'group_id':index})
    return requests


def match_aux_phrases(cues, groups, requests, results):
    """Match only anchored text boundaries; retain unaligned whole-phrase text."""
    from difflib import SequenceMatcher
    mapped = ['（时间定位待复核）'] * len(cues)
    uncertain = 0
    def characters(text):
        text = unicodedata.normalize('NFKC', str(text or ''))
        positions = [i for i, ch in enumerate(text) if ch.isalnum()]
        return text, ''.join(text[i] for i in positions), positions
    for request, raw in zip(requests, results):
        group = groups[request['group_id']]
        indices = group['cue_indices']
        if isinstance(raw, dict) and raw.get('error'):
            for i in indices:
                mapped[i] = '（本段复核失败，详见日志）'
            continue
        candidate = re.sub(r'\s+', ' ', str(raw or '')).strip()
        if not candidate:
            for i in indices:
                mapped[i] = '（未识别）'
            continue
        if len(indices) == 1:
            mapped[indices[0]] = candidate
            continue
        main = ''.join(characters(cues[i]['text'])[1] for i in indices)
        candidate, other, offsets = characters(candidate)
        matcher = SequenceMatcher(None, main, other, autojunk=False)
        splits = [0]; boundary = 0
        if matcher.ratio() >= 0.65:
            for i in indices[:-1]:
                boundary += len(characters(cues[i]['text'])[1])
                block = next((b for b in matcher.get_matching_blocks()
                              if b.a < boundary < b.a + b.size), None)
                if block is None:
                    break
                offset = block.b + boundary - block.a
                splits.append(offsets[offset])
        if len(splits) == len(indices):
            splits.append(len(candidate))
            for n, i in enumerate(indices):
                mapped[i] = candidate[splits[n]:splits[n+1]].strip() or '（未识别）'
        else:
            uncertain += 1
            mapped[indices[0]] = '（整句参考，分句未对齐）' + candidate
            for i in indices[1:]:
                mapped[i] = f'（分句未对齐，整句见第 {indices[0] + 1} 条）'
    return mapped, uncertain

def stamp(seconds):
    ms = max(0, int(round(seconds * 1000)))
    h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f'{h:02d}:{m:02d}:{s:02d},{ms:03d}'

def write_comparison_srt(path, cues, moonshine, reazon, selected_models):
    """Write all model texts on the main model's fixed timeline for comparison."""
    if not path:
        return
    lines = []
    for number, cue in enumerate(cues, 1):
        def value(values, label):
            if label not in selected_models:
                return '（未启用）'
            text = values[number - 1] if number - 1 < len(values) else ''
            return str(text or '').strip() or '（未识别）'
        lines += [
            str(number),
            f'{stamp(cue["start"])} --> {stamp(max(cue["end"], cue["start"] + 0.01))}',
            f'[Whisper] {cue["text"] or "（未识别）"}',
            f'[Moonshine] {value(moonshine, "moonshine")}',
            f'[ReazonSpeech] {value(reazon, "reazonspeech")}',
            ''
        ]
    Path(path).write_text('\n'.join(lines), encoding='utf-8')

def emit(message):
    # Heartbeat and recognition events come from different threads. Keep each
    # JSON event on one complete line so Electron can always parse it.
    line = json.dumps(message, ensure_ascii=False)
    with _OUTPUT_LOCK:
        print(line, flush=True)

def _safe_native_model_dir(source, label):
    from native_cache import safe_model_dir
    return safe_model_dir(source, label)

def _decode_to_wav(media):
    """Decode one media file to a temporary 16 kHz mono WAV for auxiliary models."""
    import av
    import numpy as np
    container = av.open(str(media))
    stream = next((item for item in container.streams.audio), None)
    if stream is None:
        container.close()
        raise RuntimeError('没有可用的音频轨道')
    resampler = av.audio.resampler.AudioResampler(format='s16', layout='mono', rate=16000)
    from native_cache import work_dir
    fd, output = tempfile.mkstemp(prefix='smart-subtitle-audio-', suffix='.wav', dir=work_dir())
    os.close(fd)
    try:
        with wave.open(output, 'wb') as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
            for frame in container.decode(stream):
                converted = resampler.resample(frame) or []
                for item in converted:
                    wav.writeframes(item.to_ndarray().astype(np.int16).tobytes())
            for item in (resampler.resample(None) or []):
                wav.writeframes(item.to_ndarray().astype(np.int16).tobytes())
    finally:
        container.close()
    return output

def _read_wav_range(path, start, end):
    import numpy as np
    with wave.open(str(path), 'rb') as wav:
        rate = wav.getframerate()
        first = max(0, int(float(start) * rate))
        count = max(1, int(max(0.05, float(end) - float(start)) * rate))
        wav.setpos(min(first, wav.getnframes()))
        raw = wav.readframes(count)
    values = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    return values.tolist(), rate

def _aux_text_from_moonshine(transcriber, audio, rate):
    transcript = transcriber.transcribe_without_streaming(audio, rate)
    return ' '.join(line.text.strip() for line in transcript.lines if line.text and line.text.strip()).strip()

def _run_moonshine(model_dir, wav_path, cues, emit):
    from moonshine_voice.transcriber import ModelArch, Transcriber
    model_path = _safe_native_model_dir(model_dir, 'moonshine')
    transcriber = Transcriber(model_path, ModelArch.SMALL_STREAMING)
    results = []
    try:
        total = len(cues)
        for number, cue in enumerate(cues, 1):
            try:
                audio, rate = _read_wav_range(wav_path, cue['start'], cue['end'])
                if audio and len(audio) < rate:
                    audio.extend([0.0] * (rate-len(audio)))
                text = _aux_text_from_moonshine(transcriber, audio, rate) if audio else ''
            except Exception as exc:
                text = {'error':str(exc)}
                emit({'event':'aux-item-error','model':'Moonshine','current':number,'message':str(exc)})
            results.append(text)
            emit({'event':'aux-item','model':'Moonshine','current':number,'result':text})
            emit({'event':'aux-progress','model':'Moonshine','current':number,'total':total})
    finally:
        transcriber.close()
    return results

def _run_reazon(model_dir, wav_path, cues, emit):
    import numpy as np
    import sherpa_onnx
    root = _safe_native_model_dir(model_dir, 'reazonspeech')
    recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=str(root / 'encoder-epoch-99-avg-1.int8.onnx'),
        decoder=str(root / 'decoder-epoch-99-avg-1.int8.onnx'),
        joiner=str(root / 'joiner-epoch-99-avg-1.int8.onnx'),
        tokens=str(root / 'tokens.txt'), num_threads=2,
        sample_rate=16000, feature_dim=80, decoding_method='greedy_search')
    results = []
    total = len(cues)
    for number, cue in enumerate(cues, 1):
        try:
            audio, rate = _read_wav_range(wav_path, cue['start'], cue['end'])
            if not audio:
                text = ''
            else:
                # Pad with silence, never borrow neighboring speech to satisfy
                # the convolution encoder's minimum input length.
                values = np.asarray(audio, dtype=np.float32)
                values = np.pad(values, (0, max(0, rate-len(values))))
                stream = recognizer.create_stream()
                stream.accept_waveform(rate, values)
                recognizer.decode_stream(stream)
                text = (stream.result.text or '').strip()
        except Exception as exc:
            text = {'error':str(exc)}
            emit({'event':'aux-item-error','model':'ReazonSpeech','current':number,'message':str(exc)})
        results.append(text)
        emit({'event':'aux-item','model':'ReazonSpeech','current':number,'result':text})
        emit({'event':'aux-progress','model':'ReazonSpeech','current':number,'total':total})
    return results

def _run_aux_isolated(model_name, model_dir, wav_path, cues, emit):
    """Run Moonshine or ReazonSpeech in its own process to isolate ONNX DLLs."""
    worker = Path(__file__).with_name('aux_worker.py')
    # Long videos exceed Windows' command line limit if all cues are arguments.
    from native_cache import work_dir
    with tempfile.TemporaryDirectory(prefix='subtitle-aux-', dir=work_dir()) as work:
        cue_file = Path(work) / 'cues.json'
        cue_file.write_text(json.dumps(cues, ensure_ascii=False), encoding='utf-8')
        with tempfile.TemporaryFile(mode='w+', encoding='utf-8', dir=work) as error_file:
            process = subprocess.Popen(
                [sys.executable, str(worker), '--model', model_name, '--model-dir', str(model_dir),
                 '--wav', str(wav_path), '--cues-file', str(cue_file)],
                stdout=subprocess.PIPE, stderr=error_file, text=True, encoding='utf-8',
                errors='replace', env=os.environ.copy(),
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            result = None; errors = []; partial = {}
            for line in process.stdout:
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if message.get('event') in ('aux-progress','aux-item-error'):
                    emit(message)
                elif message.get('event') == 'aux-item':
                    position = int(message.get('current',0))-1
                    if 0 <= position < len(cues):
                        partial[position] = message.get('result','')
                elif message.get('event') == 'aux-result':
                    result = message.get('results') or []
                elif message.get('event') == 'aux-failure':
                    errors.append(message.get('message') or '副模型进程失败')
            code = process.wait()
            process.stdout.close()
            error_file.seek(0)
            stderr = error_file.read().strip()
            if code != 0 or result is None or len(result) != len(cues):
                detail = errors[-1] if errors else (stderr[-1200:] if stderr else f'副模型返回不完整或退出：{code}')
                if partial:
                    emit({'event':'aux-error','model':model_name,'message':detail,'retained':len(partial)})
                    return [partial.get(i, {'error':detail}) for i in range(len(cues))]
                raise RuntimeError(detail)
            return result

def transcribe_one(model, job, index, total, aux_models=None):
    from recognition_quality import Diagnostics, ENGINE
    diagnostic = Diagnostics(job.get('diagnostic_output'))
    diagnostic.checkpoint_dir = job.get('checkpoint_dir')
    diagnostic.checkpoint_key = job.get('checkpoint_key','')
    diagnostic.dialogue_only = job.get('dialogue_only',True)
    diagnostic.write('session', engine=ENGINE, media=str(job['media']),
                     user_context=job.get('context') or '', user_hotwords=job.get('hotwords') or '',
                     dialogue_only=diagnostic.dialogue_only,started_at=time.strftime('%Y-%m-%dT%H:%M:%S%z'),
                     model=job.get('model_identity',''),model_load=job.get('model_timing'))
    started=time.monotonic();cpu=time.process_time()
    try:
        return _transcribe_one(model, job, index, total, aux_models, diagnostic)
    except BaseException as exc:
        diagnostic.write('error', message=str(exc))
        raise
    finally:
        if not diagnostic.completed:
            diagnostic.write('run-time',wall_seconds=time.monotonic()-started,cpu_seconds=time.process_time()-cpu,
                             stages=diagnostic.timings,complete=False)
        diagnostic.close()


def _transcribe_one(model, job, index, total, aux_models, diagnostic):
    media = str(job['media']); name = str(job.get('name') or Path(media).name)
    context = str(job.get('context') or '').strip()
    context, hotwords = bounded_hints(model, context, job.get('hotwords'))
    cues=[]; groups=[]; filtered_count=0; started=time.monotonic(); heartbeat_stop=threading.Event()
    pending_group = None
    def heartbeat():
        while not heartbeat_stop.wait(2): emit({'event':'heartbeat','file':name,'index':index,'total':total,'elapsed':time.monotonic()-started})
    thread=threading.Thread(target=heartbeat, daemon=True)
    thread.start()
    partial = Path(job.get('partial_output') or str(Path(job['output']).with_suffix('.未完成.srt')))
    def can_join_groups(left, right):
        """Join only adjacent short measured groups in the final output layer."""
        if not left or not right or not left.get('cues') or not right.get('cues'):
            return False
        a, b = left['cues'][-1], right['cues'][0]
        if semantic_continuation(a, b):
            return True
        if re.search(r'[。！？!?]\s*$', a['text']):
            return False
        if min(a['end']-a['start'], b['end']-b['start']) >= MIN_CUE_SECONDS:
            return False
        return (0 <= b['start']-a['end'] <= 0.55
                and right['end']-left['start'] <= MAX_CUE_SECONDS)

    def flush_pending():
        nonlocal pending_group
        if not pending_group:
            return
        pending_group['cue_indices'] = []
        for cue in pending_group.pop('cues'):
            # Word alignment can overlap slightly; keep published cues ordered.
            if cues:
                cue['start'] = max(cue['start'], cues[-1]['end'])
            if cue['end'] <= cue['start'] or cue['end']-cue['start'] > MAX_CUE_SECONDS+0.001:
                diagnostic.write('review', **cue, reason='字幕合并后时间异常，不伪造时间', exported=False)
                continue
            pending_group['cue_indices'].append(len(cues))
            cues.append(cue)
            diagnostic.write('subtitle', number=len(cues), **cue)
            recovery.write(srt_block(len(cues), cue))
            recovery.flush()
            emit({'event':'progress','file':name,'index':index,'total':total, **cue})
        if pending_group['cue_indices']:
            groups.append(pending_group)
        pending_group = None
    try:
        segments, info = transcribe_windows(model, media, job.get('language') or None, context, hotwords, diagnostic)
        emit({'event':'info','file':name,'index':index,'total':total,'duration':info.duration,'language':info.language})
        # Exclusive creation protects a previous interrupted task's results.
        recovery = partial.open('x', encoding='utf-8')
    except BaseException:
        heartbeat_stop.set(); thread.join(timeout=0.2)
        raise
    try:
        for seg in segments:
            processing=time.monotonic();processing_cpu=time.process_time()
            text, reason = clean_transcript_text(seg.text)
            diagnostic.write('post-filter', start=seg.start, end=seg.end, raw=seg.text, text=text, reason=reason)
            if not text:
                filtered_count += 1
                emit({'event':'filtered','file':name,'index':index,'total':total,'start':seg.start,'end':seg.end,'reason':reason})
                emit({'event':'progress','file':name,'index':index,'total':total,'start':seg.start,'end':seg.end,'text':''})
                continue
            aligned = aligned_groups(seg, japanese=info.language == 'ja', diagnostic=diagnostic)
            if diagnostic.dialogue_only:
                kept=[]
                for group in aligned:
                    # Split at removed cues so readability merging cannot bridge filtered speech.
                    run=[]
                    for cue in group['cues']:
                        reason=dialogue_noise(cue['text'])
                        if reason:
                            diagnostic.write('review',**cue,reason=reason,exported=False,retried=False)
                            if run:kept.append({**group,'start':run[0]['start'],'end':run[-1]['end'],'text':''.join(c['text'] for c in run),'cues':run});run=[]
                        else:run.append(cue)
                    if run:kept.append({**group,'start':run[0]['start'],'end':run[-1]['end'],'text':''.join(c['text'] for c in run),'cues':run})
                aligned=kept
            if not aligned:
                diagnostic.write('review', start=seg.start, end=seg.end, text=seg.text, reason='无法按真实词时间拆分，保留诊断供复核', exported=False)
                filtered_count += 1
                emit({'event':'filtered','file':name,'index':index,'total':total,'start':seg.start,'end':seg.end,'reason':'时间定位异常或无有效文字'})
                emit({'event':'progress','file':name,'index':index,'total':total,'start':seg.start,'end':seg.end,'text':''})
            for group in readable_groups(aligned, getattr(seg,'display_end',seg.end)):
                if pending_group and can_join_groups(pending_group, group):
                    diagnostic.write('fragment-join', start=pending_group['start'], end=group['end'],
                                     text=pending_group['text'] + group['text'],
                                     reason='最终字幕层跨识别段合并相邻短片段')
                    pending_group['end'] = group['end']
                    pending_group['text'] += group['text']
                    pending_group['timing_review'] |= group.get('timing_review', False)
                    if semantic_continuation(pending_group['cues'][-1], group['cues'][0]):
                        previous = pending_group['cues'][-1]; following = group['cues'][0]
                        previous['text'] += following['text']; previous['end'] = following['end']
                        pending_group['cues'].extend(group['cues'][1:])
                    else:
                        pending_group['cues'].extend(group['cues'])
                else:
                    flush_pending()
                    pending_group = group
            if not getattr(seg, 'words', None):
                emit({'event':'alignment-warning','file':name,'message':'部分台词缺少词级时间，已保留整句并标记待复核'})
            diagnostic.write('stage-time',stage='subtitle-processing',wall_seconds=time.monotonic()-processing,cpu_seconds=time.process_time()-processing_cpu)
        flush_pending()
    except Exception:
        if cues:
            emit({'event':'partial-saved','file':name,'index':index,'total':total,'output':str(partial),'cues':len(cues)})
        raise
    finally:
        recovery.close()
        if not cues:
            partial.unlink(missing_ok=True)
        heartbeat_stop.set(); thread.join(timeout=0.2)
    moonshine_results = reazon_results = []
    selected = list(aux_models or [])
    requests = prepare_aux_groups(groups, info.duration)
    agreements = changed = uncertain = aux_failures = 0
    if selected and cues:
        auxiliary_started=time.monotonic();auxiliary_cpu=time.process_time()
        wav_path = None
        try:
            emit({'event':'aux-start','file':name,'index':index,'total':total,'models':selected,'cues':len(cues),'phrases':len(requests)})
            if requests:
                wav_path = _decode_to_wav(media)
            if 'moonshine' in selected and requests:
                try:
                    moonshine_results = _run_aux_isolated('moonshine', job['moonshine_model'], wav_path, requests, emit)
                except Exception as exc:
                    emit({'event':'aux-error','model':'Moonshine','message':str(exc)})
            if 'reazonspeech' in selected and requests:
                try:
                    reazon_results = _run_aux_isolated('reazonspeech', job['reazonspeech_model'], wav_path, requests, emit)
                except Exception as exc:
                    emit({'event':'aux-error','model':'ReazonSpeech','message':str(exc)})
            for label in selected:
                raw = moonshine_results if label == 'moonshine' else reazon_results
                aux_failures += sum(isinstance(item, dict) and bool(item.get('error')) for item in raw)
                if requests and not raw:
                    aux_failures += len(requests)
                if raw or not requests:
                    mapped, count = match_aux_phrases(cues, groups, requests, raw)
                    uncertain += count
                else:
                    mapped = ['（复核未完成）'] * len(cues)
                if label == 'moonshine':
                    moonshine_results = mapped
                else:
                    reazon_results = mapped
            comparison_output = str(job.get('comparison_output') or '').strip()
            if comparison_output:
                write_comparison_srt(comparison_output, cues, moonshine_results, reazon_results, selected)
            emit({'event':'aux-done','file':name,'index':index,'total':total,'agreements':agreements,'changed':0,'failedPhrases':aux_failures,'uncertainPhrases':uncertain,'comparisonOnly':True,'comparisonOutput':comparison_output})
        finally:
            diagnostic.write('stage-time',stage='auxiliary',wall_seconds=time.monotonic()-auxiliary_started,cpu_seconds=time.process_time()-auxiliary_cpu)
            if wav_path:
                try: os.unlink(wav_path)
                except OSError: pass
    else:
        agreements = changed = 0
    if selected and not cues and job.get('comparison_output'):
        write_comparison_srt(job['comparison_output'], [], [], [], selected)
    output_started=time.monotonic();output_cpu=time.process_time()
    write_srt(job['output'], cues)
    partial.unlink(missing_ok=True)
    diagnostic.write('stage-time',stage='output',wall_seconds=time.monotonic()-output_started,cpu_seconds=time.process_time()-output_cpu)
    diagnostic.write('run-time',wall_seconds=time.monotonic()-started,stages=diagnostic.timings,complete=True)
    diagnostic.write('complete', cues=len(cues), reviews=diagnostic.reviews)
    emit({'event':'done','timing':{'wall_seconds':time.monotonic()-started,'stages':diagnostic.timings},'reviewCount':diagnostic.reviews,'file':name,'index':index,'total':total,'output':job['output'],'comparisonOutput':str(job.get('comparison_output') or ''),'duration':info.duration,'cues':len(cues),'filtered':filtered_count,'auxAgreements':agreements,'auxChanged':changed,'auxFailures':aux_failures})

def run(args):
    from faster_whisper import WhisperModel
    jobs=json.loads(args.jobs_json)
    if not isinstance(jobs,list) or not jobs: raise ValueError('任务列表为空')
    emit({'event':'loading','total':len(jobs)})
    model=WhisperModel(str(Path(args.model).resolve()), device='cpu', compute_type='int8')
    emit({'event':'loaded','total':len(jobs)})
    aux_models = [item for item in (json.loads(args.aux_models or '[]')) if item in ('moonshine', 'reazonspeech')]
    failed = 0
    for index, job in enumerate(jobs, 1):
        try:
            transcribe_one(model, job, index, len(jobs), aux_models=aux_models)
        except Exception as exc:
            failed += 1
            partial = Path(job.get('partial_output') or str(Path(job['output']).with_suffix('.未完成.srt')))
            emit({'event':'job-error','file':str(job.get('name') or Path(job.get('media','')).name),'index':index,'total':len(jobs),'message':str(exc),'partialOutput':str(partial) if partial.exists() and partial.stat().st_size else ''})
    emit({'event':'all-done','total':len(jobs),'failed':failed})

if __name__ == '__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--jobs-json',required=True); parser.add_argument('--model',required=True); parser.add_argument('--aux-models',default='[]')
    try: run(parser.parse_args())
    except Exception as exc: emit({'event':'error','message':str(exc)}); sys.exit(1)
