"""Factory protocol adapter: keep one 1.15 Whisper model alive across jobs."""
import argparse,json,sys,time
import hashlib
from pathlib import Path
import local_asr as asr
p=argparse.ArgumentParser();p.add_argument('--model',required=True);p.add_argument('--cpu-mode',choices=('performance','balanced'),default='performance');args=p.parse_args()
try:
    from faster_whisper import WhisperModel
    asr.emit({'event':'loading'})
    began=time.monotonic();cpu=time.process_time()
    # Balanced mode leaves scheduling headroom on lower-end machines. The exact
    # percentage remains hardware-dependent; thread count is the stable control.
    import os
    threads=max(1,(os.cpu_count() or 4)*3//4) if args.cpu_mode=='balanced' else 0
    kwargs={'device':'cpu','compute_type':'int8'}
    if threads: kwargs['cpu_threads']=threads
    model=WhisperModel(args.model,**kwargs)
    model_timing={'load_seconds':time.monotonic()-began,'load_cpu_seconds':time.process_time()-cpu}
    began=time.monotonic()
    # Read once per loaded model; content changes must invalidate window records.
    model_hash=hashlib.sha256()
    for file in sorted(Path(args.model).rglob('*')):
        if file.is_file():
            model_hash.update(str(file.relative_to(args.model)).encode('utf-8'))
            with file.open('rb') as stream:
                for block in iter(lambda:stream.read(1024*1024),b''):model_hash.update(block)
    model_timing['identity_seconds']=time.monotonic()-began
    asr.emit({'event':'ready'})
    for line in sys.stdin:
        job=json.loads(line)
        try:
            job['checkpoint_key']=str(job.get('checkpoint_key',''))+':'+model_hash.hexdigest()
            job['model_identity']=Path(args.model).name+':'+model_hash.hexdigest()
            job['model_timing']=model_timing
            asr.transcribe_one(model,job,1,1)
            asr.emit({'event':'task-finished','ok':True})
        except Exception as exc:
            asr.emit({'event':'task-finished','ok':False,'message':str(exc)})
except Exception as exc:
    asr.emit({'event':'error','message':str(exc)})
    sys.exit(1)
