"""Scripted stand-in for faster-whisper, so tools/transcribe.py can be tested without a model.

STUB_SCRIPT (JSON): {"detect": {"language", "probability", "duration"}, "runs": {"<lang>": [[text, avg_logprob,
tokens, seconds], ...]}, "cuda_fails": bool, "decode_fails": bool}. Each transcribe() call is logged to STUB_LOG as the forced language
or "detect"; each decode_audio() call as "decode"."""
import json
import os
from types import SimpleNamespace

SCRIPT = json.loads(os.environ['STUB_SCRIPT'])


def _log(entry):
    with open(os.environ['STUB_LOG'], 'a') as f:
        f.write(entry + '\n')


def decode_audio(path):
    _log('decode')
    if SCRIPT.get('decode_fails'):
        raise ValueError('not an audio file')
    return ('decoded', path)


class WhisperModel:
    def __init__(self, name, device='cpu', compute_type='int8'):
        if device == 'cuda' and SCRIPT.get('cuda_fails'):
            raise RuntimeError('no CUDA here')

    def transcribe(self, audio, vad_filter=True, language=None):
        assert audio[0] == 'decoded', 'transcribe must get the decoded audio, not the file path'
        _log(language or 'detect')
        d = SCRIPT['detect']
        lang = language or d['language']
        segments = [SimpleNamespace(text=t, avg_logprob=lp, tokens=[0] * n, start=0.0, end=sec)
                    for t, lp, n, sec in SCRIPT['runs'].get(lang, [])]
        info = SimpleNamespace(language=lang, language_probability=1.0 if language else d['probability'],
                               duration_after_vad=d.get('duration', 3))
        return iter(segments), info
