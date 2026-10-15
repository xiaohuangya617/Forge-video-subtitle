"""Atomic, chained window records. Outputs are rebuilt on restart, never appended."""
import hashlib
import json
import os
import math
from pathlib import Path
import tempfile
from types import SimpleNamespace as NS

def encoded(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,allow_nan=False,separators=(',',':')).encode('utf-8')

def pack(segment):
    return {**vars(segment),'words':[vars(w) for w in segment.words]}

def unpack(data):
    return NS(**{**data,'words':[NS(**w) for w in data['words']]})

class Recording:
    def __init__(self,sink):self.sink=sink;self.events=[]
    def write(self,event,**data):
        self.events.append({'event':event,**data});self.sink.write(event,**data)

class Checkpoint:
    def __init__(self,directory,identity):
        self.previous=hashlib.sha256(encoded(identity)).hexdigest()
        self.root=Path(directory)/self.previous if directory else None
        if self.root:self.root.mkdir(parents=True,exist_ok=True)
    def read(self,index):
        if not self.root:return None
        try:
            wrapper=json.loads((self.root/f'{index:05}.json').read_text('utf-8'))
            data=wrapper['data']
            digest=hashlib.sha256(encoded(data)).hexdigest()
            if data['previous']!=self.previous or data['index']!=index or digest!=wrapper['sha256']:return None
            budget=data['budget']
            assert isinstance(budget['buckets'],dict)
            for key in ('duration','count','audio','wall'):
                assert math.isfinite(budget[key]) and budget[key]>=0
            for key,value in budget['buckets'].items():
                int(key)
                assert isinstance(value['kinds'],dict)
                for field in ('count','audio','wall'):assert math.isfinite(value[field]) and value[field]>=0
                assert isinstance(value.get('no_gain',0),int) and value.get('no_gain',0)>=0
            assert data['language'] is None or isinstance(data['language'],str)
            assert all(isinstance(e,dict) and isinstance(e['event'],str) for e in data['events'])
            for s in data['segments']:
                assert isinstance(s['text'],str) and isinstance(s['confidence'],dict)
                assert math.isfinite(s['start']) and math.isfinite(s['end']) and s['end']>s['start']
                assert s['words'] and all(math.isfinite(w['start']) and math.isfinite(w['end']) and w['end']>w['start'] and isinstance(w['word'],str) for w in s['words'])
                unpack(s)
            self.previous=digest
            return data
        except (OSError,ValueError,KeyError,TypeError,AssertionError,AttributeError,OverflowError):return None
    def save(self,index,segments,events,budget,language):
        if not self.root:return
        data={'index':index,'previous':self.previous,'segments':[pack(s) for s in segments],
              'events':events,'budget':vars(budget),'language':language}
        digest=hashlib.sha256(encoded(data)).hexdigest()
        fd,temp=tempfile.mkstemp(prefix='.window-',suffix='.tmp',dir=self.root)
        try:
            with os.fdopen(fd,'wb') as f:
                f.write(encoded({'data':data,'sha256':digest}));f.flush();os.fsync(f.fileno())
            os.replace(temp,self.root/f'{index:05}.json')
            self.previous=digest
        finally:
            if os.path.exists(temp):os.unlink(temp)
