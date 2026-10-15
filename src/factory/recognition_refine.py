"""Shared dialogue policy and sentence-aware retry boundaries."""
import re
from types import SimpleNamespace as NS
from recognition_quality import compact,RATE

def breath_like(text):
    return bool(re.fullmatch(r'[んンあアぁァうウぅゥえエぇェおオぉォはハーっッ]+',compact(text)))

def dialogue_noise(text):
    """Whole-cue policy only. Never remove a substring from a spoken sentence."""
    value=compact(text).casefold()
    value=''.join(chr(ord(c)-0x60) if 'ァ'<=c<='ヶ' else c for c in value)
    if value in ('笑い声','笑声','笑聲','笑い','喘ぎ声','喘息声','呻吟','呻吟声','吐息','息遣い',
                 '呼吸音','拍手','音楽','音乐','laughter','laughing','sighs','sighing','moaning','music'):
        return '仅保留对白：声音描述'
    # Keep lexical responses, including affirmative and negative acknowledgements.
    if value in ('うん','ううん','うーん','え','えっ','ええ','ええっ','あ','あっ','ああ','お','おお','は','はい','いいえ','嗯','哦','啊'):
        return ''
    if value=='ん' and re.search(r'[?？]',str(text)):return ''
    if re.fullmatch(r'(?:え|えっ|あ|あっ){2}',value):return ''
    if re.fullmatch(r'(?:うん|ううん){1,3}',value):return ''
    if re.fullmatch(r'[んンーっッ]+',value) or re.fullmatch(r'(?:はぁ|はあ|ふぅ|ふう|あぁ|うぅ)+',value):
        return '仅保留对白：孤立气声'
    if breath_like(value) and len(value)>=3:
        return '仅保留对白：连续气声'
    return ''

def breath_review(segment,speech,dialogue_only=False):
    if dialogue_only and dialogue_noise(segment.text):return True
    value=compact(segment.text)
    if not breath_like(value):return False
    c=segment.confidence
    support=any(x['start']/RATE<segment.end and x['end']/RATE>segment.start for x in speech)
    # Protect ordinary acknowledgements unless multiple acoustic signals are weak.
    weak=c['probability']<.55 and (c['logprob']<-1 or c['no_speech']>.65)
    if value in ('うん','え','あ','お','ん') and c['probability']>=.75 and c['no_speech']<.5:
        return False
    repeated=len(value)>=3 and len(set(value.replace('ー','')))<=1
    return weak or (not support and c['no_speech']>.5) or (repeated and c['logprob']<-.8)

def retry_bounds(item,segments,start,end):
    a=max(start,item['start']-.8);b=min(end,item['end']+.8)
    limit=20 if item.get('kind')=='时间修复' else 14
    if b-a>limit:return None
    # Include entire intersecting sentences before spending any retry budget.
    for _ in range(len(segments)+1):
        crossing=[s for s in segments if s.start<b and s.end>a and (s.start<a-.01 or s.end>b+.01)]
        if not crossing:return (a,b)
        na=min([a]+[s.start-.1 for s in crossing]);nb=max([b]+[s.end+.1 for s in crossing])
        if na<start-.01 or nb>end+.01 or nb-na>limit:return None
        a=max(start,na);b=min(end,nb)
    return None

def measured_phrase(segment):
    """Use a measured short phrase when subword alignment lost zero-time text."""
    c=segment.confidence
    a=getattr(segment,'raw_start',segment.start);b=getattr(segment,'raw_end',segment.end)
    words=segment.words
    if (not words or not any(w.end<=w.start for w in words)
        or not 0<b-a<=5 or c['probability']<.65 or c['logprob']<-.9
        or c['no_speech']>.4 or c.get('zero_ratio',1)>=.7
        or compact(''.join(w.word for w in words))!=compact(segment.text)
        or any(w.start<a-.04 or w.end>b+.04 or w.end<w.start for w in words)):
        return None
    return NS(start=a,end=b,text=segment.text,words=[NS(start=a,end=b,word=segment.text)],
              confidence=c,timing_review=True,raw_start=a,raw_end=b)
