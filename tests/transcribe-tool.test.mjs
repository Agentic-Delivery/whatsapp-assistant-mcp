// tools/transcribe.py, the default transcriber, run against a scripted faster-whisper stub (no model needed):
// which languages it decodes and what it prints, per detection case.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.PYTHON || 'python3';

function run(script, languages) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-tx-')), 'log');
  fs.writeFileSync(log, '');
  const args = [path.join(root, 'tools', 'transcribe.py'), 'clip.ogg'];
  if (languages) args.push('--languages', languages);
  const r = spawnSync(python, args, {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: path.join(root, 'tests', 'fixtures', 'stub-whisper'), STUB_SCRIPT: JSON.stringify(script), STUB_LOG: log },
  });
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  fs.rmSync(path.dirname(log), { recursive: true, force: true });
  return { out: r.stdout.replace(/\n$/, ''), err: r.stderr, status: r.status, calls };
}
const detect = (language, probability, duration = 3) => ({ language, probability, duration });

test('(t1) a sure detection inside the list is printed as is, decoded once', () => {
  const r = run({ detect: detect('en', 0.9), runs: { en: [['Hello there.', -0.3, 4, 2]] } }, 'en,de');
  assert.equal(r.out, 'Hello there.');
  assert.deepEqual(r.calls, ['decode', 'detect']);
});

test('(t2) without --languages, detection decides', () => {
  const r = run({ detect: detect('nl', 0.2), runs: { nl: [['nl text', -0.9, 3, 1]] } });
  assert.equal(r.out, 'nl text');
  assert.deepEqual(r.calls, ['decode', 'detect']);
});

test('(t3) one listed language is simply used: no detection, no prefix', () => {
  const r = run({ detect: detect('en', 0.1), runs: { de: [['de text', -0.5, 4, 2]] } }, 'de');
  assert.equal(r.out, 'de text');
  assert.deepEqual(r.calls, ['decode', 'de']);
});

test('(t4) unsure short clip: the detected run is reused, the others are tried, the most confident wins, marked uncertain', () => {
  const r = run({ detect: detect('en', 0.24), runs: { en: [['en mishearing', -0.72, 4, 2]], de: [['de text, the right one', -0.37, 6, 2]] } }, 'en,de');
  assert.equal(r.out, '[uncertain] de text, the right one');
  assert.deepEqual(r.calls, ['decode', 'detect', 'de'], 'the detected language must not be decoded a second time');
});

test('(t5) short clip detected outside the list: every listed language is tried, never the detected one', () => {
  const r = run({ detect: detect('is', 0.98), runs: { is: [['detected language, never listed', -0.05, 4, 3]], en: [['en text, the right one', -0.3, 4, 3]], de: [['de text, a worse fit', -0.9, 4, 3]] } }, 'en,de');
  assert.equal(r.out, '[uncertain] en text, the right one');
  assert.deepEqual(r.calls, ['decode', 'detect', 'en', 'de']);
});

test('(t6) a confident fragment covering under half the speech does not beat a full transcript', () => {
  const r = run({ detect: detect('en', 0.3), runs: { en: [['A whole sentence of real speech here.', -0.6, 9, 4]], de: [['de fragment', -0.1, 2, 1]] } }, 'en,de');
  assert.equal(r.out, '[uncertain] A whole sentence of real speech here.');
});

test('(t7) longer clips are never re-tried: unsure inside the list keeps detection; outside uses the first listed', () => {
  const inside = run({ detect: detect('en', 0.4, 60), runs: { en: [['Long talk.', -0.4, 30, 60]] } }, 'en,de');
  assert.equal(inside.out, 'Long talk.');
  assert.deepEqual(inside.calls, ['decode', 'detect']);
  const outside = run({ detect: detect('is', 0.9, 60), runs: { de: [['de text, long', -0.4, 30, 60]] } }, 'de,en');
  assert.equal(outside.out, 'de text, long');
  assert.deepEqual(outside.calls, ['decode', 'detect', 'de']);
});

test('(t8) silence prints an empty line, never a bare prefix', () => {
  const r = run({ detect: detect('en', 0.2), runs: {} }, 'en,de');
  assert.equal(r.status, 0);
  assert.equal(r.out, '');
});

test('(t9) an unknown language code is refused up front with a clear message', () => {
  const r = run({ detect: detect('en', 0.9), runs: {} }, 'en,xx');
  assert.notEqual(r.status, 0);
  assert.match(r.err, /unknown language code\(s\) in --languages: xx/);
  assert.deepEqual(r.calls, []);
});

test('(t11) an unreadable audio file gives a one-line error, not a traceback', () => {
  const r = run({ decode_fails: true, detect: detect('en', 0.9), runs: {} }, 'en,de');
  assert.notEqual(r.status, 0);
  assert.equal(r.err.trim(), 'could not read audio: not an audio file');
});

test('(t12) a repeated language code counts once: one language means no detection', () => {
  const r = run({ detect: detect('en', 0.1), runs: { de: [['de text', -0.5, 4, 2]] } }, 'de,de');
  assert.equal(r.out, 'de text');
  assert.deepEqual(r.calls, ['decode', 'de']);
});

test('(t10) no usable GPU: the CPU path runs and the audio is still decoded only once', () => {
  const r = run({ cuda_fails: true, detect: detect('en', 0.9), runs: { en: [['Hi.', -0.2, 2, 1]] } }, 'en,de');
  assert.equal(r.out, 'Hi.');
  assert.deepEqual(r.calls, ['decode', 'detect']);
});
