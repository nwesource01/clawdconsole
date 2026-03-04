#!/usr/bin/env python3
"""Persistent STT worker.

Protocol: JSONL over stdin/stdout.
Input: {"id":"...","path":"/path/to/audio","model":"tiny.en"}
Output: {"id":"...","ok":true,"text":"..."} or {"id":"...","ok":false,"error":"..."}
"""

import json, os, sys, traceback

def eprint(*a):
    try:
        print(*a, file=sys.stderr, flush=True)
    except Exception:
        pass

try:
    from faster_whisper import WhisperModel
except Exception as e:
    eprint("failed_import_faster_whisper", str(e))
    raise

MODEL_NAME = os.environ.get('STT_MODEL', 'tiny.en')
DEVICE = os.environ.get('STT_DEVICE', 'cpu')
COMPUTE = os.environ.get('STT_COMPUTE_TYPE', 'int8')

# Load once (warm)
model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE)

def transcribe(path, model_name=None):
    # If caller asks for a different model than we loaded, just use loaded model.
    # (Operator can restart service to change env.)
    segments, info = model.transcribe(path, vad_filter=True, beam_size=1)
    parts = []
    for seg in segments:
        t = (seg.text or '').strip()
        if t:
            parts.append(t)
    return ' '.join(parts).strip()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except Exception:
        continue

    req_id = str(req.get('id') or '')
    audio_path = str(req.get('path') or '')
    try:
        if not audio_path or not os.path.exists(audio_path):
            out = {"id": req_id, "ok": False, "error": "missing_audio"}
        else:
            text = transcribe(audio_path, req.get('model'))
            out = {"id": req_id, "ok": True, "text": text}
    except Exception as e:
        out = {"id": req_id, "ok": False, "error": str(e)}
    sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
    sys.stdout.flush()
