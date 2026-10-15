"""Bounded local ASR recovery with auditable decisions. No replacement model."""
import json
import math
import re

import unicodedata

from types import SimpleNamespace

RATE = 16000
ENGINE = 'factory-asr-4.1.8'


class Diagnostics:
    def __init__(self, path, review_path=None):
        self.timings={}
        self.completed=False
        self.file = open(path, 'a', encoding='utf-8') if path else None
        self.reviews = 0
        # 保留 review_path 参数以兼容旧调用；复核记录统一写入 JSONL 诊断文件。
        self.review_file = None

    def write(self, event, **data):
        if event=='complete':self.completed=True
        if event=='stage-time' and not data.get('cached'):
            item=self.timings.setdefault(data['stage'],{'wall_seconds':0.,'cpu_seconds':0.,'calls':0})
            item['wall_seconds']+=data['wall_seconds'];item['cpu_seconds']+=data['cpu_seconds'];item['calls']+=1
        if event == 'review':
            self.reviews += 1
        if self.file:
            self.file.write(json.dumps({'event': event, **data}, ensure_ascii=False,
                                       allow_nan=False, default=str) + '\n')
            self.file.flush()

    def close(self):
        if self.file:
            self.file.close()


def finite(value, default=0.0):
    try:
        value = float(value)
        return value if math.isfinite(value) else default
    except (TypeError, ValueError):
        return default


def compact(text):
    return ''.join(c for c in unicodedata.normalize('NFKC', str(text)) if c.isalnum())


def prompt_echo(text, context):
    # Ignore short names/hotwords. A matching instruction is a review signal only.
    value = compact(text)
    pieces = re.split(r'[。！？!?\n，、,；;]', context or '')
    return any(len(p := compact(piece)) >= 8 and (p in value or
               (len(value) >= 8 and value in p)) for piece in pieces)


def local_language_anomaly(text):
    """Reject long Latin-only/template output from the local Japanese ASR path.

    Short foreign-looking vocalizations remain available to the translation
    rules. This check only covers long, repeated or template-shaped output so
    it does not become a global confidence threshold.
    """
    value = ''.join(c for c in unicodedata.normalize('NFKC', str(text or ''))
                    if not c.isspace() and c not in '、，,。！？!?…~～')
    if not value:
        return ''
    latin = len(re.findall(r'[A-Za-z]', value))
    kana = len(re.findall(r'[\u3040-\u30ff]', value))
    han = len(re.findall(r'[\u3400-\u9fff]', value))
    if kana or han or latin < 12:
        return ''
    if latin >= 16 or re.search(r'([A-Za-z]{2,})\1{1,}', value, re.I):
        return '长英文或乱码模板式识别结果'
    return ''


def join_zero_duration_words(words):
    """Attach zero-length subword tokens only to an adjacent measured word."""
    result = []
    index = 0
    while index < len(words):
        word = words[index]
        if word.end == word.start:
            if result and -.000001 <= word.start-result[-1].end <= .100001:
                previous = result[-1]
                result[-1] = SimpleNamespace(start=previous.start, end=previous.end,
                                             word=previous.word+word.word)
                index += 1
                continue
            at = index
            text = ''
            while at < len(words) and words[at].end == words[at].start and abs(words[at].start-word.start) <= .100001:
                text += words[at].word
                at += 1
            if (at < len(words) and words[at].end > words[at].start
                    and -.000001 <= words[at].start-word.start <= .100001):
                following = words[at]
                result.append(SimpleNamespace(start=following.start, end=following.end,
                                              word=text+following.word))
                index = at+1
                continue
        result.append(word)
        index += 1
    return result


def transcribe_windows(model, media, language, context, hotwords, diag, cleaner, emit):
    from recognition_complete import transcribe_windows as complete
    return complete(model, media, language, context, hotwords, diag, cleaner, emit)
