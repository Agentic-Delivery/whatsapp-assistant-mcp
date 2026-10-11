// Voice-note retention: off unless configured; deletes by age, then oldest-first to fit the size cap;
// never touches transcripts or other media; config validation refuses nonsense values.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const temps = [];
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ret-')); temps.push(d); return d; };
const DAY = 86400000;
function file(dir, name, bytes, ageDays, now) {
  const p = path.join(dir, name); fs.writeFileSync(p, Buffer.alloc(bytes));
  const t = (now - ageDays * DAY) / 1000; fs.utimesSync(p, t, t); return p;
}

test('(r1) with no retention configured nothing is deleted', async () => {
  const { pruneVoiceNotes } = await import('../src/wa-client.js');
  const d = tmp(); const vn = path.join(d, 'voice-notes'); fs.mkdirSync(vn); const now = Date.now();
  file(vn, '1-voice-note.ogg', 10, 400, now);
  const r = pruneVoiceNotes(d, {}, now);
  assert.equal(r.deleted.length, 0);
  assert.ok(fs.existsSync(path.join(vn, '1-voice-note.ogg')));
});

test('(r2) old voice notes go; transcripts, look-alike documents, links and other media stay; a bad entry never stops the run', async () => {
  const { pruneVoiceNotes } = await import('../src/wa-client.js');
  const d = tmp(); const vn = path.join(d, 'voice-notes'); fs.mkdirSync(vn); const now = Date.now();
  file(vn, '1-voice-note.ogg', 10, 40, now);
  file(vn, '1-voice-note.ogg.txt', 10, 40, now);
  file(vn, '1-voice-note.txt', 10, 40, now);
  file(vn, '1-voice-note.srt', 10, 40, now);
  file(vn, '2-voice-note.ogg', 10, 5, now);
  fs.symlinkSync(path.join(vn, 'missing-target'), path.join(vn, '3-voice-note.ogg')); // dangling link
  const t = (now - 400 * DAY) / 1000; fs.lutimesSync(path.join(vn, '3-voice-note.ogg'), t, t);
  fs.mkdirSync(path.join(vn, '4-voice-note.ogg'));                                   // a folder with a matching name
  fs.utimesSync(path.join(vn, '4-voice-note.ogg'), t, t);
  file(d, '5-contract-voice-note.pdf', 10, 400, now);                                 // a document a sender named like a voice note
  file(d, '6-voice-note.ogg', 10, 400, now);                                          // anything outside voice-notes/ is never touched
  file(d, '7-image.jpg', 10, 400, now);
  const r = pruneVoiceNotes(d, { voiceNoteDays: 30 }, now);
  assert.deepEqual(r.deleted, ['1-voice-note.ogg']);
  assert.deepEqual(fs.readdirSync(vn).sort(), ['1-voice-note.ogg.txt', '1-voice-note.srt', '1-voice-note.txt', '2-voice-note.ogg', '3-voice-note.ogg', '4-voice-note.ogg']);
  assert.deepEqual(fs.readdirSync(d).sort(), ['5-contract-voice-note.pdf', '6-voice-note.ogg', '7-image.jpg', 'voice-notes']);
});

test('(r3) the size cap deletes the oldest voice notes first until the rest fit', async () => {
  const { pruneVoiceNotes } = await import('../src/wa-client.js');
  const d = tmp(); const vn = path.join(d, 'voice-notes'); fs.mkdirSync(vn); const now = Date.now(); const MB = 1024 * 1024;
  file(vn, '1-voice-note.ogg', 2 * MB, 3, now);
  file(vn, '2-voice-note.ogg', 2 * MB, 2, now);
  file(vn, '3-voice-note.ogg', 2 * MB, 1, now);
  const r = pruneVoiceNotes(d, { voiceNoteMaxMB: 5 }, now);
  assert.deepEqual(r.deleted, ['1-voice-note.ogg']);
  assert.equal(r.kept, 2);
});

test('(r4) config: retention is optional, and must hold positive numbers when given', async () => {
  const dir = tmp(); process.env.WA_HOME = dir;
  const { loadConfig } = await import('../src/config.js');
  const write = (extra) => fs.writeFileSync(path.join(dir, 'wa-mcp.config.json'), JSON.stringify({ chats: [{ jid: '1@s.whatsapp.net' }], ...extra }));
  write({}); assert.deepEqual(loadConfig().retention, { voiceNoteDays: null, voiceNoteMaxMB: null });
  write({ retention: { voiceNoteDays: 30, voiceNoteMaxMB: 200 } }); assert.deepEqual(loadConfig().retention, { voiceNoteDays: 30, voiceNoteMaxMB: 200 });
  write({ retention: { voiceNoteDays: -1 } }); assert.throws(() => loadConfig(), /positive number/);
  write({ retention: 'forever' }); assert.throws(() => loadConfig(), /must be an object/);
});
