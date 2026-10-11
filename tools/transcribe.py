#!/usr/bin/env python3
"""Default speech-to-text for whatsapp-assistant-mcp: prints the transcript of one audio file to stdout.

Uses faster-whisper (local, no API key). Runs on a GPU when one is usable, otherwise on the CPU.

  python3 tools/transcribe.py [--model small] [--languages en,de] <audio file>

--model      any faster-whisper model name (tiny, base, small, medium, large-v3-turbo, ...); default: small
--languages  optional comma-separated list of the languages you expect. If detection lands outside the
             list, the first listed language is used instead (short clips are sometimes detected as a
             closely related language).
"""
import argparse
import sys


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('audio')
    ap.add_argument('--model', default='small')
    ap.add_argument('--languages', default='')
    a = ap.parse_args()
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit('faster-whisper is not installed: pip install -r tools/requirements-speech.txt')
    allowed = [l.strip() for l in a.languages.split(',') if l.strip()]
    last = None
    for device, compute in (('cuda', 'float16'), ('cpu', 'int8')):
        try:
            model = WhisperModel(a.model, device=device, compute_type=compute)
            segments, info = model.transcribe(a.audio, vad_filter=True)
            text = ' '.join(s.text.strip() for s in segments).strip()
            if allowed and info.language not in allowed:
                segments, info = model.transcribe(a.audio, vad_filter=True, language=allowed[0])
                text = ' '.join(s.text.strip() for s in segments).strip()
            print(text)
            return
        except Exception as e:  # no usable GPU: fall back to the CPU
            last = e
    sys.exit(f'transcription failed: {last}')


if __name__ == '__main__':
    main()
