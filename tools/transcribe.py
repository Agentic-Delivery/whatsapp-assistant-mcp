#!/usr/bin/env python3
"""Default speech-to-text for whatsapp-assistant-mcp: prints the transcript of one audio file to stdout.

Uses faster-whisper (local, no API key). Runs on a GPU when one is usable, otherwise on the CPU.

  python3 tools/transcribe.py [--model small] [--languages en,de] <audio file>

--model      any faster-whisper model name (tiny, base, small, medium, large-v3-turbo, ...); default: small
--languages  optional comma-separated list of the languages you expect. With one language, the clip is
             transcribed in it. With several: short clips are often detected as the wrong language, so when
             detection of a short clip (30 s of speech or less) is unsure (below 50%) or lands outside the list,
             the clip is transcribed in each listed language and the most confident result is kept, prefixed
             "[uncertain] " because the language, and so the text, may be wrong (a very short or unclear clip
             can come out as a stock phrase the speaker never said). A longer clip detected outside the list is
             transcribed in the first listed language.
"""
import argparse
import sys

SURE = 0.5          # detection probability below which a short clip is re-tried in each listed language
SHORT_S = 30        # seconds of speech up to which re-trying is worth the extra decoding time
UNSURE = '[uncertain] '


def join(segments):
    """Returns (text, confidence, seconds): joined text, mean log-probability per token weighted by length, and
    the seconds of audio the text covers."""
    segments = list(segments)
    text = ' '.join(s.text.strip() for s in segments).strip()
    tokens = sum(max(len(s.tokens), 1) for s in segments)
    confidence = sum(s.avg_logprob * max(len(s.tokens), 1) for s in segments) / tokens if segments else float('-inf')
    return text, confidence, sum(s.end - s.start for s in segments)


def pick(candidates):
    """The most confident candidate, ignoring ones that cover under half the audio the widest one covers (a wrong
    language forced on speech often yields a short, confident fragment)."""
    widest = max(c[2] for c in candidates)
    return max((c for c in candidates if c[2] * 2 >= widest), key=lambda c: c[1])


def transcribe(model, audio, allowed):
    """The transcript to print for one decoded clip."""
    if len(allowed) == 1:
        return join(model.transcribe(audio, vad_filter=True, language=allowed[0])[0])[0]
    segments, info = model.transcribe(audio, vad_filter=True)
    outside = bool(allowed) and info.language not in allowed
    if not allowed or not (outside or info.language_probability < SURE):
        return join(segments)[0]
    if info.duration_after_vad > SHORT_S:
        if outside:
            return join(model.transcribe(audio, vad_filter=True, language=allowed[0])[0])[0]
        return join(segments)[0]
    candidates = [] if outside else [join(segments)]
    candidates += [join(model.transcribe(audio, vad_filter=True, language=lang)[0])
                   for lang in allowed if lang != info.language]
    text = pick(candidates)[0]
    return UNSURE + text if text else ''


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('audio')
    ap.add_argument('--model', default='small')
    ap.add_argument('--languages', default='')
    a = ap.parse_args()
    try:
        from faster_whisper import WhisperModel, decode_audio
    except ImportError:
        sys.exit('faster-whisper is not installed: pip install -r tools/requirements-speech.txt')
    try:
        from faster_whisper.tokenizer import _LANGUAGE_CODES as known
    except ImportError:
        known = None  # moved in a later version: skip the up-front check (a bad code then fails only when tried)
    allowed = list(dict.fromkeys(l.strip() for l in a.languages.split(',') if l.strip()))
    unknown = [l for l in allowed if known is not None and l not in known]
    if unknown:
        sys.exit(f'unknown language code(s) in --languages: {", ".join(unknown)} (use codes like en, de, fr)')
    try:
        audio = decode_audio(a.audio)  # once, however many languages are tried
    except Exception as e:
        sys.exit(f'could not read audio: {e}')
    last = None
    for device, compute in (('cuda', 'float16'), ('cpu', 'int8')):
        try:
            print(transcribe(WhisperModel(a.model, device=device, compute_type=compute), audio, allowed))
            return
        except Exception as e:  # no usable GPU: fall back to the CPU
            last = e
    sys.exit(f'transcription failed: {last}')


if __name__ == '__main__':
    main()
