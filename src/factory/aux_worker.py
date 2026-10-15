"""One auxiliary ASR model per process to avoid ONNX Runtime DLL conflicts."""
import argparse, json
from pathlib import Path
from local_asr import _run_moonshine, _run_reazon

def emit(message):
    print(json.dumps(message, ensure_ascii=False), flush=True)

parser = argparse.ArgumentParser()
parser.add_argument('--model', required=True)
parser.add_argument('--model-dir', required=True)
parser.add_argument('--wav', required=True)
inputs = parser.add_mutually_exclusive_group(required=True)
inputs.add_argument('--cues')
inputs.add_argument('--cues-file')
args = parser.parse_args()
cues = json.loads(Path(args.cues_file).read_text('utf-8') if args.cues_file else args.cues)
try:
    if args.model == 'moonshine':
        results = _run_moonshine(args.model_dir, args.wav, cues, emit)
    else:
        results = _run_reazon(args.model_dir, args.wav, cues, emit)
    emit({'event': 'aux-result', 'model': args.model, 'results': results})
except Exception as exc:
    emit({'event': 'aux-failure', 'model': args.model, 'message': str(exc)})
    raise
