// Optional speech: configured commands transcribe incoming voice notes and speak text as voice notes.
// Fake commands stand in for the real engines; they are run with execFile, never through a shell.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_BAILEYS_PATH = path.join(__dirname, 'fixtures', 'fake-baileys.js');
const FAKE_TRANSCRIBE = [process.execPath, path.join(__dirname, 'fixtures', 'fake-transcribe.mjs'), '{input}'];
const FAKE_SPEAK = [process.execPath, path.join(__dirname, 'fixtures', 'fake-speak.mjs'), '--text-file', '{textFile}', '--output', '{output}'];
const POST = '5555555555@s.whatsapp.net';
const temps = [];
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

function home(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-speech-test-'));
  temps.push(dir);
  process.env.WA_HOME = dir;
  process.env.WA_CLIENT_FAKE = FAKE_BAILEYS_PATH;
  fs.writeFileSync(path.join(dir, 'wa-mcp.config.json'), JSON.stringify({ chats: [{ jid: POST, name: 'P', canPost: true }, { jid: 'g1@g.us', name: 'G', canPost: false }], ...extra }));
  return dir;
}
const inbox = (dir) => fs.readFileSync(path.join(dir, 'inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const voiceRaw = (id) => ({ key: { remoteJid: 'g1@g.us', id }, message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', fileLength: 100, ptt: true } } });

test('(s1) a saved voice note is transcribed: transcript record in the inbox and a .txt next to the audio', async () => {
  const dir = home();
  const { makeOnMessage } = await import('../src/daemon.js');
  await makeOnMessage(new Set(['g1@g.us']), () => {}, { transcribe: FAKE_TRANSCRIBE })({ ts: 1, chatJid: 'g1@g.us', text: '[voice note]', msgId: 'v1' }, voiceRaw('v1'));
  const t = inbox(dir).find((r) => r.type === 'transcript' && r.msgId === 'v1');
  assert.ok(t, 'transcript record missing');
  assert.equal(t.text, 'hello from the voice note');
  assert.equal(fs.readFileSync(t.mediaPath + '.txt', 'utf8').trim(), 'hello from the voice note');
});

test('(s2) a missing transcribe program gives a transcript-error with a setup hint; the audio is still saved', async () => {
  const dir = home();
  const { makeOnMessage } = await import('../src/daemon.js');
  await makeOnMessage(new Set(['g1@g.us']), () => {}, { transcribe: ['no-such-program-xyz', '{input}'] })({ ts: 1, chatJid: 'g1@g.us', text: '[voice note]', msgId: 'v2' }, voiceRaw('v2'));
  const recs = inbox(dir);
  assert.ok(recs.find((r) => r.type === 'media-saved' && r.msgId === 'v2'));
  const e = recs.find((r) => r.type === 'transcript-error' && r.msgId === 'v2');
  assert.match(e.error, /not found: no-such-program-xyz/);
  assert.match(e.error, /README/);
});

test('(s3) without speech configured, voice notes are only saved', async () => {
  const dir = home();
  const { makeOnMessage } = await import('../src/daemon.js');
  await makeOnMessage(new Set(['g1@g.us']))({ ts: 1, chatJid: 'g1@g.us', text: '[voice note]', msgId: 'v3' }, voiceRaw('v3'));
  assert.equal(inbox(dir).filter((r) => String(r.type).startsWith('transcript')).length, 0);
});

test('(s4) speak_voice_note speaks via the configured command, sends a ptt voice note and deletes its temp audio', async () => {
  const dir = home({ speech: { speak: FAKE_SPEAK } });
  const { connect } = await import('../src/wa-client.js');
  const { createdSockets } = await import('./fixtures/fake-baileys.js');
  await connect({ reconnect: false, onMessage: () => {} });
  const { speakVoiceNote } = await import('../src/mcp-server.js');
  const { handleSendCommand } = await import('../src/daemon.js');
  const { loadConfig } = await import('../src/config.js');
  const pump = (async () => {
    for (let i = 0; i < 200; i++) {
      const p = path.join(dir, 'outbox.jsonl');
      if (fs.existsSync(p)) { const cmd = JSON.parse(fs.readFileSync(p, 'utf8').trim().split('\n').at(-1)); await handleSendCommand(cmd, loadConfig()); return cmd; }
      await new Promise((r) => setTimeout(r, 25));
    }
  })();
  const [res, cmd] = await Promise.all([speakVoiceNote({ jid: POST, text: 'Hi, this is the assistant.' }), pump]);
  assert.equal(cmd.type, 'send-voice');
  assert.equal(createdSockets.at(-1).__sent.at(-1).content.ptt, true);
  assert.match(createdSockets.at(-1).__sent.at(-1).content.audio.toString(), /Hi, this is the assistant\./);
  assert.equal(res.sent, true);
  assert.equal(fs.existsSync(cmd.path), false, 'the generated audio must be deleted after the send');
});

test('(s5) speak_voice_note refuses: not configured (with a hint), canPost:false, empty or too long text', async () => {
  home();
  const { speakVoiceNote } = await import('../src/mcp-server.js');
  await assert.rejects(() => speakVoiceNote({ jid: POST, text: 'hi' }), /speech\.speak is not configured.*README/);
  home({ speech: { speak: FAKE_SPEAK } });
  await assert.rejects(() => speakVoiceNote({ jid: 'g1@g.us', text: 'hi' }), /canPost:false/);
  await assert.rejects(() => speakVoiceNote({ jid: POST, text: '  ' }), /non-empty/);
  await assert.rejects(() => speakVoiceNote({ jid: POST, text: 'x'.repeat(2001) }), /limited to 2000/);
});

test('(s6) the text reaches the engine only as file content: shell syntax in it is not executed', async () => {
  const marker = path.join(os.tmpdir(), `wa-speech-pwned-${process.pid}`);
  const { speakToFile } = await import('../src/speech.js');
  const out = await speakToFile(FAKE_SPEAK, `hello $(touch ${marker}) \`touch ${marker}\``);
  assert.equal(fs.existsSync(marker), false);
  assert.match(fs.readFileSync(out, 'utf8'), /\$\(touch/);
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
});

test('(s7) config: speech commands must be string arrays that carry their placeholders', async () => {
  const dir = home();
  const { loadConfig } = await import('../src/config.js');
  const write = (speech) => fs.writeFileSync(path.join(dir, 'wa-mcp.config.json'), JSON.stringify({ chats: [{ jid: POST }], speech }));
  write({ transcribe: FAKE_TRANSCRIBE, speak: FAKE_SPEAK }); assert.deepEqual(loadConfig().speech, { transcribe: FAKE_TRANSCRIBE, speak: FAKE_SPEAK });
  write({ transcribe: ['whisper'] }); assert.throws(() => loadConfig(), /\{input\} placeholder/);
  write({ speak: ['tts', '{textFile}'] }); assert.throws(() => loadConfig(), /\{output\} placeholder/);
  write({ speak: 'tts {textFile} {output}' }); assert.throws(() => loadConfig(), /array of strings/);
  write({ transcibe: FAKE_TRANSCRIBE }); assert.throws(() => loadConfig(), /unknown key speech\.transcibe/);
});

test('(s8) poll_chats delivers transcripts (content) but still skips protocol records', async () => {
  const dir = home();
  const { appendInbox } = await import('../src/wa-client.js');
  const { pollChats } = await import('../src/mcp-server.js');
  appendInbox({ ts: 1, chatJid: POST, text: '[voice note]', msgId: 'a' });
  appendInbox({ ts: 2, chatJid: POST, type: 'media-saved', msgId: 'a' });
  appendInbox({ ts: 3, chatJid: POST, type: 'transcript', text: 'see you at nine', msgId: 'a' });
  const got = (await pollChats())[POST];
  assert.deepEqual(got.map((r) => r.type || 'msg'), ['msg', 'transcript']);
});

test('(s9) only a real voice note is transcribed: a document named *-voice-note.* is not', async () => {
  const dir = home();
  const { makeOnMessage } = await import('../src/daemon.js');
  const doc = { key: { remoteJid: 'g1@g.us', id: 'd1' }, message: { documentMessage: { fileName: 'report-voice-note.pdf', mimetype: 'application/pdf', fileLength: 100 } } };
  await makeOnMessage(new Set(['g1@g.us']), () => {}, { transcribe: FAKE_TRANSCRIBE })({ ts: 1, chatJid: 'g1@g.us', text: '[document]', msgId: 'd1' }, doc);
  const recs = inbox(dir);
  assert.ok(recs.find((r) => r.type === 'media-saved' && r.msgId === 'd1'), 'the document itself is still saved');
  assert.equal(recs.filter((r) => String(r.type).startsWith('transcript')).length, 0);
});

test('(s10) a failing speak command leaves no audio or text behind', async () => {
  const { speakToFile } = await import('../src/speech.js');
  const err = await speakToFile([...FAKE_SPEAK, '--fail'], 'private words').then(() => null, (e) => e);
  assert.ok(err, 'must reject');
  const written = String(err.message).match(/after writing (\S+)/)[1];
  assert.equal(fs.existsSync(written), false, 'the audio the engine wrote must be deleted');
  assert.equal(fs.existsSync(path.dirname(written)), false, 'the private folder (with the text) must be deleted');
});

const speakDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('wa-speak-')).sort();

test('(s11) a timeout stops everything the speak command started and cleans up', async () => {
  const late = path.join(os.tmpdir(), `wa-speech-late-${process.pid}`);
  fs.rmSync(late, { force: true });
  const before = speakDirs();
  const { speakToFile } = await import('../src/speech.js');
  await assert.rejects(() => speakToFile([...FAKE_SPEAK, '--hang', late], 'hi', 200), /timed out/);
  assert.deepEqual(speakDirs(), before, 'the private folder must be deleted after a timeout');
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(fs.existsSync(late), false, 'a child of the speak command kept running after the timeout');
});

test('(s15) a timeout ends the call even when a helper that left the process group holds the output open', async () => {
  const { runSpeechCommand } = await import('../src/speech.js');
  const t0 = Date.now();
  await assert.rejects(() => runSpeechCommand([process.execPath, path.join(__dirname, 'fixtures', 'fake-escaper.mjs')], {}, 300), /timed out/);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

test('(s16) non-ASCII output split across chunks is decoded intact', async () => {
  const { runSpeechCommand } = await import('../src/speech.js');
  assert.equal(await runSpeechCommand([process.execPath, path.join(__dirname, 'fixtures', 'fake-split-utf8.mjs')], {}), 'é\n');
});

test('(s17) when the bridge exits mid-speech, the engine is stopped and the private folder deleted', async () => {
  const late = path.join(os.tmpdir(), `wa-speech-exit-${process.pid}`);
  fs.rmSync(late, { force: true });
  const before = speakDirs();
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [path.join(__dirname, 'fixtures', 'exit-while-speaking.mjs'), late]);
  assert.deepEqual(speakDirs(), before, 'the private folder (with the text) must be deleted on exit');
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(fs.existsSync(late), false, 'the speech engine kept running after the bridge exited');
});

test('(s12) the text and the audio live in a private folder: text file 0600, folder 0700', async () => {
  const { speakToFile, removeSpokenFile } = await import('../src/speech.js');
  const out = await speakToFile(FAKE_SPEAK, 'hello');
  assert.match(fs.readFileSync(out, 'utf8'), /\|file:600\|dir:700$/);
  assert.equal(fs.existsSync(path.join(path.dirname(out), 'text.txt')), false, 'the text file is gone once the audio exists');
  removeSpokenFile(out);
  assert.equal(fs.existsSync(path.dirname(out)), false);
});

test('(s13) arguments reach the program exactly as configured: shell syntax in them is not run', async () => {
  const marker = path.join(os.tmpdir(), `wa-speech-argv-${process.pid}`);
  const { runSpeechCommand } = await import('../src/speech.js');
  const literal = `$(touch ${marker})`;
  const out = await runSpeechCommand([process.execPath, path.join(__dirname, 'fixtures', 'fake-args.mjs'), literal, '{input}'], { input: 'a b;c' });
  assert.deepEqual(JSON.parse(out), [literal, 'a b;c']);
  assert.equal(fs.existsSync(marker), false);
});

test('(s14) transcriptions run one at a time', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-speech-queue-'));
  temps.push(dir);
  const files = [1, 2, 3].map((i) => { const f = path.join(dir, `${i}.ogg`); fs.writeFileSync(f, 'x'); return f; });
  const { queueTranscription } = await import('../src/speech.js');
  const cmd = [process.execPath, path.join(__dirname, 'fixtures', 'fake-transcribe-exclusive.mjs'), '{input}'];
  const texts = await Promise.all(files.map((f) => queueTranscription(cmd, f)));
  assert.deepEqual(texts, ['one at a time', 'one at a time', 'one at a time']);
});
