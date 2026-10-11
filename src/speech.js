// Optional speech support: a configured command transcribes incoming voice notes, and another turns text
// into a voice note. Both are plain programs started directly (never through a shell), so any engine works;
// tools/transcribe.py and tools/speak.py are the open defaults. Nothing here runs unless "speech" is configured.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SPEECH_TIMEOUT_MS = 300000;
export const MAX_SPEAK_CHARS = 2000;
/** Voice notes waiting for transcription beyond this are refused with a transcript-error instead of queued. */
export const MAX_TRANSCRIBE_QUEUE = 50;
const MAX_OUTPUT = 4 * 1024 * 1024;
// Running speech process groups and open speak folders: when this process exits (a shutdown signal, a crash),
// the groups are killed and the folders deleted, so no speech engine outlives the bridge and no spoken text is
// left in the temp dir.
const runningGroups = new Set();
const openSpeakDirs = new Set();
process.on('exit', () => {
  for (const pid of runningGroups) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }
  for (const dir of openSpeakDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});
const SETUP_HINT = 'see "Speech" in the README (pip install -r tools/requirements-speech.txt, ffmpeg for speaking)';

/**
 * Runs argv[0] with the remaining args, replacing {name} placeholders. Resolves stdout; rejects with a readable
 * reason. The program gets its own process group, so a timeout stops everything it started (an ffmpeg it spawned
 * included) instead of leaving a child that keeps writing after the caller has cleaned up.
 */
export function runSpeechCommand(argv, values, timeoutMs = SPEECH_TIMEOUT_MS) {
  const args = argv.slice(1).map((a) => a.replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m)));
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    if (child.pid) runningGroups.add(child.pid);
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); runningGroups.delete(child.pid); fn(v); } };
    // Decode as UTF-8 on the stream, so a character split across two chunks is not corrupted.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUTPUT) stdout += d; });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-MAX_OUTPUT); });
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      // Settle now rather than on 'close': a helper that left the group could hold the pipes open for ever.
      finish(reject, new Error(`speech command timed out after ${timeoutMs / 1000}s: ${argv[0]}`));
    }, timeoutMs);
    child.on('error', (err) => finish(reject, err.code === 'ENOENT'
      ? new Error(`speech command not found: ${argv[0]} -- ${SETUP_HINT}`)
      : new Error(`speech command could not start (${argv[0]}): ${err.message} -- ${SETUP_HINT}`)));
    child.on('close', (code, signal) => {
      if (timedOut) return finish(reject, new Error(`speech command timed out after ${timeoutMs / 1000}s: ${argv[0]}`));
      if (code === 0) return finish(resolve, stdout);
      const last = stderr.trim().split('\n').slice(-3).join(' | ');
      finish(reject, new Error(`speech command failed (${argv[0]}): ${last || `exit ${code ?? signal}`} -- ${SETUP_HINT}`));
    });
  });
}

/** Transcribes one audio file with the configured command; returns the trimmed text (may be empty). */
export async function transcribeFile(cmd, file, timeoutMs) {
  return (await runSpeechCommand(cmd, { input: file }, timeoutMs)).trim();
}

let transcribeTail = Promise.resolve();
let transcribeWaiting = 0;
/**
 * Like transcribeFile, but one at a time: each run loads a speech model, so a burst of voice notes must not
 * start them all at once. Beyond MAX_TRANSCRIBE_QUEUE waiting files it rejects instead of queueing.
 */
export function queueTranscription(cmd, file, timeoutMs) {
  if (transcribeWaiting >= MAX_TRANSCRIBE_QUEUE) {
    return Promise.reject(new Error(`too many voice notes waiting for transcription (${MAX_TRANSCRIBE_QUEUE}); this one was skipped`));
  }
  transcribeWaiting++;
  const run = transcribeTail.then(() => transcribeFile(cmd, file, timeoutMs));
  transcribeTail = run.catch(() => {}).finally(() => { transcribeWaiting--; });
  return run;
}

/**
 * Speaks text with the configured command. Both the text and the audio live in a fresh private folder
 * (mode 0700) in the system temp dir. Returns the .ogg path; the caller deletes it with removeSpokenFile.
 * On any failure the folder is deleted here.
 */
export async function speakToFile(cmd, text, timeoutMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-speak-')); // mkdtemp creates it 0700
  openSpeakDirs.add(dir);
  const textFile = path.join(dir, 'text.txt');
  const output = path.join(dir, 'voice-note.ogg');
  try {
    fs.writeFileSync(textFile, text, { mode: 0o600 });
    await runSpeechCommand(cmd, { textFile, output }, timeoutMs);
    fs.rmSync(textFile, { force: true });
    if (!fs.existsSync(output)) throw new Error(`the speak command finished but wrote no file at {output} -- ${SETUP_HINT}`);
    return output;
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    openSpeakDirs.delete(dir);
    throw err;
  }
}

/** Deletes a file made by speakToFile together with its private folder. */
export function removeSpokenFile(file) {
  const dir = path.dirname(file);
  if (openSpeakDirs.has(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    openSpeakDirs.delete(dir);
  } else {
    fs.rmSync(file, { force: true });
  }
}
