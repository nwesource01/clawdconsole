#!/usr/bin/env python3
import argparse, json, os, sys

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default=os.environ.get('STT_MODEL', 'small'))
    ap.add_argument('--device', default=os.environ.get('STT_DEVICE', 'cpu'))
    ap.add_argument('--compute_type', default=os.environ.get('STT_COMPUTE_TYPE', 'int8'))
    ap.add_argument('audio_path')
    args = ap.parse_args()

    audio_path = args.audio_path
    if not os.path.exists(audio_path):
        print(json.dumps({"ok": False, "error": "missing_audio"}))
        return 2

    try:
        from faster_whisper import WhisperModel

        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
        segments, info = model.transcribe(audio_path, vad_filter=True)
        text_parts = []
        for seg in segments:
            t = (seg.text or '').strip()
            if t:
                text_parts.append(t)
        text = ' '.join(text_parts).strip()
        out = {
            "ok": True,
            "text": text,
            "language": getattr(info, 'language', None),
            "duration": getattr(info, 'duration', None),
        }
        print(json.dumps(out, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        return 1

if __name__ == '__main__':
    raise SystemExit(main())
