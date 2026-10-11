#!/usr/bin/env python3
"""Default text-to-speech for whatsapp-assistant-mcp: turns a text file into an Ogg/Opus voice note.

Uses Kokoro (open-weight, Apache-2.0, runs on a normal CPU) and ffmpeg.

  python3 tools/speak.py [--voice af_heart] [--lang a] --text-file in.txt --output out.ogg

--voice  a Kokoro voice name (af_heart, am_michael, bf_emma, ...); default: af_heart
--lang   Kokoro language code: a = American English (default), b = British English. Kokoro supports more
         languages, but they need extra packages beyond tools/requirements-speech.txt; see Kokoro's README.
"""
import argparse
import os
import subprocess
import sys
import tempfile


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--text-file', required=True)
    ap.add_argument('--output', required=True)
    ap.add_argument('--voice', default='af_heart')
    ap.add_argument('--lang', default='a')
    a = ap.parse_args()
    try:
        import numpy as np
        import soundfile as sf
        from kokoro import KPipeline
    except ImportError:
        sys.exit('kokoro is not installed: pip install -r tools/requirements-speech.txt')
    text = open(a.text_file, encoding='utf-8').read().strip()
    if not text:
        sys.exit('the text file is empty')
    pipeline = KPipeline(lang_code=a.lang)
    audio = [chunk for _, _, chunk in pipeline(text, voice=a.voice)]
    if not audio:
        sys.exit('no audio was produced')
    # next to the output, so whoever cleans up the output's folder also removes this if we are killed mid-way
    fd, wav = tempfile.mkstemp(suffix='.wav', dir=os.path.dirname(os.path.abspath(a.output)))
    os.close(fd)
    try:
        sf.write(wav, np.concatenate(audio), 24000)
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-c:a', 'libopus', '-b:a', '32k',
                        '-ac', '1', '-ar', '48000', a.output], check=True)
    except FileNotFoundError:
        sys.exit('ffmpeg is not installed (needed to write Ogg/Opus)')
    finally:
        os.remove(wav)


if __name__ == '__main__':
    main()
