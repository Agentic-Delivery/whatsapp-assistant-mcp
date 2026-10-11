// Smoke tests, run with `node --test tests/`.
//
// Every test gets its own temp WA_HOME (never ~/.whatsapp-assistant) and points
// WA_CLIENT_FAKE at tests/fixtures/fake-baileys.js so nothing here ever attempts a
// real WhatsApp connection. config.js / wa-client.js read process.env.WA_HOME (and
// WA_CLIENT_FAKE) fresh on every call rather than caching it at import time, so
// setting the env vars before each test is enough for isolation -- no per-test
// module reloads needed.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { pollChats, reactToMessage, sendChatMessage } from '../src/mcp-server.js';
import { appendInbox, connect, readMessages } from '../src/wa-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_BAILEYS_PATH = path.join(__dirname, 'fixtures', 'fake-baileys.js');

const tempHomes = [];

function makeTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mcp-test-'));
  tempHomes.push(dir);
  return dir;
}

function useTempHome() {
  const home = makeTempHome();
  process.env.WA_HOME = home;
  return home;
}

function writeConfig(home, config) {
  fs.writeFileSync(path.join(home, 'wa-mcp.config.json'), JSON.stringify(config));
}

after(() => {
  for (const dir of tempHomes) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('(a) an empty allowlist makes config load throw -- this is what gates daemon startup', () => {
  const home = useTempHome();
  writeConfig(home, { chats: [] });

  assert.throws(() => loadConfig(), /empty or missing "chats" allowlist/);
});

test('(a) a missing config file also throws, naming the expected path', () => {
  const home = useTempHome();
  void home; // no config file written at all

  assert.throws(() => loadConfig(), /config not found at/);
});

test('(b) send_chat_message on a canPost:false chat is rejected without touching outbox', async () => {
  const home = useTempHome();
  const jid = '1111111111@s.whatsapp.net';
  writeConfig(home, { chats: [{ jid, name: 'No Post', canPost: false }] });

  await assert.rejects(() => sendChatMessage({ jid, text: 'hello' }), /canPost:false/);

  const outboxFile = path.join(home, 'outbox.jsonl');
  assert.equal(fs.existsSync(outboxFile), false, 'outbox.jsonl must not be created for a refused send');
});

test('(b) send_chat_message for a jid not on the allowlist is also rejected without touching outbox', async () => {
  const home = useTempHome();
  writeConfig(home, { chats: [{ jid: '2222222222@s.whatsapp.net', name: 'Someone else', canPost: true }] });

  await assert.rejects(
    () => sendChatMessage({ jid: '9999999999@s.whatsapp.net', text: 'hello' }),
    /not in the allowlist/,
  );
  assert.equal(fs.existsSync(path.join(home, 'outbox.jsonl')), false);
});

test('(d) the daemon signs every outgoing message with the agent marker — a shared account stays distinguishable', async () => {
  const home = useTempHome();
  process.env.WA_CLIENT_FAKE = FAKE_BAILEYS_PATH;
  const jid = '3333333333@s.whatsapp.net';
  writeConfig(home, { chats: [{ jid, name: 'Signed', canPost: true }] });

  const { handleSendCommand } = await import('../src/daemon.js');
  const { loadConfig } = await import('../src/config.js');
  const { createdSockets } = await import('./fixtures/fake-baileys.js');
  await connect({ reconnect: false, onMessage: () => {} });
  await handleSendCommand({ ts: Date.now(), type: 'send', jid, text: 'hello there', nonce: 'sig-1' }, loadConfig());

  const sock = createdSockets.at(-1);
  const lastSent = sock.__sent.at(-1);
  assert.ok(lastSent, 'the fake socket must have recorded a send');
  const sentText = lastSent.content?.text ?? lastSent.content;
  assert.match(String(sentText), /^\u{1F916} hello there$/u, 'outgoing text must carry the mechanical agent signature');
});

test('(e) send-file ships the document with a SIGNED caption; canPost:false refuses it', async () => {
  const home = useTempHome();
  process.env.WA_CLIENT_FAKE = FAKE_BAILEYS_PATH;
  const jid = '5555555555@s.whatsapp.net';
  writeConfig(home, { chats: [{ jid, name: 'Docs', canPost: true }] });

  const { handleSendCommand } = await import('../src/daemon.js');
  const { loadConfig } = await import('../src/config.js');
  const { createdSockets } = await import('./fixtures/fake-baileys.js');
  await connect({ reconnect: false, onMessage: () => {} });

  const path2 = await import('node:path');
  const filePath = path2.join(makeTempHome(), 'doc.pdf'); // outside WA_HOME: the bridge refuses to send its own state
  fs.writeFileSync(filePath, 'pdf-bytes');
  await handleSendCommand({ ts: Date.now(), type: 'send-file', jid, path: filePath, fileName: 'doc.pdf', caption: 'first version', nonce: 'f1' }, loadConfig());

  const sent = createdSockets.at(-1).__sent.at(-1);
  assert.ok(sent.content?.document, 'a document payload must be sent');
  assert.equal(sent.content.fileName, 'doc.pdf');
  assert.match(String(sent.content.caption), /^\u{1F916} first version$/u, 'caption must carry the mechanical agent signature');

  const noPostJid = '6666666666@s.whatsapp.net';
  writeConfig(home, { chats: [{ jid: noPostJid, name: 'ReadOnly', canPost: false }] });
  const before = createdSockets.at(-1).__sent.length;
  await handleSendCommand({ ts: Date.now(), type: 'send-file', jid: noPostJid, path: filePath, fileName: 'doc.pdf', nonce: 'f2' }, loadConfig());
  assert.equal(createdSockets.at(-1).__sent.length, before, 'a canPost:false chat must never receive a document');
});

test('(e2) send-file without fileName uses the file basename — a nameless document is unopenable at the receiver', async () => {
  const home = useTempHome();
  process.env.WA_CLIENT_FAKE = FAKE_BAILEYS_PATH;
  const jid = '5555555555@s.whatsapp.net';
  writeConfig(home, { chats: [{ jid, name: 'Docs', canPost: true }] });
  const { handleSendCommand } = await import('../src/daemon.js');
  const { loadConfig } = await import('../src/config.js');
  const { createdSockets } = await import('./fixtures/fake-baileys.js');
  await connect({ reconnect: false, onMessage: () => {} });
  const path2 = await import('node:path');
  const filePath = path2.join(makeTempHome(), 'quarterly-report.pdf'); // outside WA_HOME: the bridge refuses to send its own state
  fs.writeFileSync(filePath, 'pdf-bytes');

  // No fileName at all → the basename (with its extension) travels, never a bare "document".
  await handleSendCommand({ ts: Date.now(), type: 'send-file', jid, path: filePath, nonce: 'g1' }, loadConfig());
  let sent = createdSockets.at(-1).__sent.at(-1);
  assert.equal(sent.content.fileName, 'quarterly-report.pdf');
  assert.equal(sent.content.mimetype, 'application/pdf');

  // Lowercase `filename` (the natural JSON spelling) is honoured as an alias.
  await handleSendCommand({ ts: Date.now(), type: 'send-file', jid, path: filePath, filename: 'renamed.pdf', nonce: 'g2' }, loadConfig());
  sent = createdSockets.at(-1).__sent.at(-1);
  assert.equal(sent.content.fileName, 'renamed.pdf');
});

test('(e3) a document that echoes NAMELESS gets ok:false — the ack reports what arrived, not what was attempted', async () => {
  const home = useTempHome();
  process.env.WA_CLIENT_FAKE = FAKE_BAILEYS_PATH;
  const jid = '5555555555@s.whatsapp.net';
  writeConfig(home, { chats: [{ jid, name: 'Docs', canPost: true }] });
  const { handleSendCommand } = await import('../src/daemon.js');
  const { loadConfig } = await import('../src/config.js');
  const { createdSockets } = await import('./fixtures/fake-baileys.js');
  await connect({ reconnect: false, onMessage: () => {} });
  const path2 = await import('node:path');
  const filePath = path2.join(makeTempHome(), 'brief.pdf'); // outside WA_HOME: the bridge refuses to send its own state
  fs.writeFileSync(filePath, 'pdf-bytes');

  createdSockets.at(-1).__echoMode = 'nameless';
  await handleSendCommand({ ts: Date.now(), type: 'send-file', jid, path: filePath, fileName: 'brief.pdf', nonce: 'h1', echoTimeoutMs: 2000 }, loadConfig());
  let acks = fs.readFileSync(path2.join(home, 'inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.type === 'send-ack');
  assert.equal(acks.at(-1).ok, false, 'a nameless echo must fail the ack');
  assert.match(acks.at(-1).error, /no fileName/);

  createdSockets.at(-1).__echoMode = 'faithful';
  await handleSendCommand({ ts: Date.now(), type: 'send-file', jid, path: filePath, fileName: 'brief.pdf', nonce: 'h2', echoTimeoutMs: 2000 }, loadConfig());
  acks = fs.readFileSync(path2.join(home, 'inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.type === 'send-ack');
  assert.equal(acks.at(-1).ok, true);
  assert.deepEqual(acks.at(-1).verified, { fileName: 'brief.pdf', mimetype: 'application/pdf', bytes: 9 });

  createdSockets.at(-1).__echoMode = 'silent';
  await handleSendCommand({ ts: Date.now(), type: 'send-file', jid, path: filePath, fileName: 'brief.pdf', nonce: 'h3', echoTimeoutMs: 300 }, loadConfig());
  acks = fs.readFileSync(path2.join(home, 'inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.type === 'send-ack');
  assert.equal(acks.at(-1).ok, true, 'a slow/absent echo must not fail a real send');
  assert.equal(acks.at(-1).verified, null);
  assert.match(acks.at(-1).warning, /echo-timeout/);
});

test('(e4) a non-allowlisted sender is logged as a KNOCK (jid + name only, never text) so the allowlist can grow from evidence', async () => {
  const home = useTempHome();
  const { makeOnMessage, recordKnock } = await import('../src/daemon.js');
  const seen = [];
  const handler = makeOnMessage(new Set(['g1@g.us']), (r) => { seen.push(r); recordKnock(r); });
  const secret = 'the private text must never be stored';
  await handler({ chatJid: '46700000000@s.whatsapp.net', senderName: 'Knocker', text: secret, fromMe: false }, null);
  await handler({ chatJid: '46700000000@s.whatsapp.net', senderName: 'Knocker', text: 'again', fromMe: false }, null);
  await handler({ chatJid: 'g1@g.us', senderName: 'Member', text: 'allowed', fromMe: false }, null);
  assert.equal(seen.length, 2, 'only the non-allowlisted messages are skipped');
  const path2 = await import('node:path');
  const knocks = fs.readFileSync(path2.join(home, 'knocks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(knocks.length, 1, 'one knock line per jid per run');
  assert.equal(knocks[0].chatJid, '46700000000@s.whatsapp.net');
  assert.equal(knocks[0].senderName, 'Knocker');
  assert.equal(knocks[0].text, undefined, 'a knock carries no text');
  assert.ok(!fs.readFileSync(path2.join(home, 'knocks.jsonl'), 'utf8').includes(secret), 'private text never reaches disk');
  assert.ok(!fs.existsSync(path2.join(home, 'inbox.jsonl')) || !fs.readFileSync(path2.join(home, 'inbox.jsonl'), 'utf8').includes(secret));
});

test('(e5) a command appended between connection-open and the watcher start is still sent — the offset is snapshotted at process start', async () => {
  const home = useTempHome();
  process.env.WA_CLIENT_FAKE = FAKE_BAILEYS_PATH;
  const jid = '7777777777@s.whatsapp.net';
  writeConfig(home, { chats: [{ jid, name: 'Race', canPost: true }] });
  const { snapshotOutboxOffset, startOutboxWatcher } = await import('../src/daemon.js');
  const { loadConfig } = await import('../src/config.js');
  const path2 = await import('node:path');
  const outbox = path2.join(home, 'outbox.jsonl');

  const startOffset = snapshotOutboxOffset();            // process start
  await connect({ reconnect: false, onMessage: () => {} }); // connection opens ...
  fs.appendFileSync(outbox, JSON.stringify({ type: 'send', jid, nonce: 'race-1', text: 'in the window', echoTimeoutMs: 500 }) + '\n'); // ... a command lands in the window
  const stop = startOutboxWatcher(loadConfig(), startOffset); // watcher starts after
  const deadline = Date.now() + 5000;
  let acks = [];
  while (Date.now() < deadline) {
    const inbox = path2.join(home, 'inbox.jsonl');
    if (fs.existsSync(inbox)) acks = fs.readFileSync(inbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === 'send-ack' && r.nonce === 'race-1');
    if (acks.length) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  stop();
  assert.equal(acks.length, 1, 'the in-window command must be sent and acked, never silently skipped');
  assert.equal(acks[0].ok, true);
});

test('(e6) send_chat_message resolves with the daemon\'s echo verification — the caller sees what arrived', async () => {
  const home = useTempHome();
  process.env.WA_CLIENT_FAKE = FAKE_BAILEYS_PATH;
  const jid = '8888888888@s.whatsapp.net';
  writeConfig(home, { chats: [{ jid, name: 'Verified', canPost: true }] });
  const { handleSendCommand } = await import('../src/daemon.js');
  const { loadConfig } = await import('../src/config.js');
  await connect({ reconnect: false, onMessage: () => {} });

  const pending = sendChatMessage({ jid, text: 'hello' }); // MCP side: writes outbox, waits for the ack
  const outbox = path.join(home, 'outbox.jsonl');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !(fs.existsSync(outbox) && fs.readFileSync(outbox, 'utf8').trim())) await new Promise((r) => setTimeout(r, 50));
  const cmd = JSON.parse(fs.readFileSync(outbox, 'utf8').trim().split('\n').at(-1));
  await handleSendCommand({ ...cmd, echoTimeoutMs: 2000 }, loadConfig()); // daemon side: sends, awaits echo, acks

  const result = await pending;
  assert.equal(result.sent, true);
  assert.deepEqual(result.verified, { text: true }, 'the tool result carries the echo verification, never hides what arrived');
});

test('(e7) an @-mention of THIS account is flagged mentionedMe — by contextInfo jid or LID, never by rendered text', async () => {
  const home = useTempHome();
  process.env.WA_CLIENT_FAKE = FAKE_BAILEYS_PATH;
  const jid = 'grp-mention@g.us';
  writeConfig(home, { chats: [{ jid, name: 'Mentions', canPost: true }] });
  const { createdSockets } = await import('./fixtures/fake-baileys.js');
  const got = [];
  await connect({ reconnect: false, onMessage: (r) => { got.push(r); } });
  const sock = createdSockets.at(-1);
  sock.user.lid = '999000111:5@lid'; // this account's LID identity, device-suffixed like the real one
  const upsert = (id, text, mentionedJid) => sock.ev.emit('messages.upsert', { messages: [{
    key: { remoteJid: jid, fromMe: false, id, participant: 'alice@s.whatsapp.net' }, pushName: 'Alice',
    message: { extendedTextMessage: { text, contextInfo: mentionedJid ? { mentionedJid } : undefined } },
  }] });
  upsert('m1', '@15550000001 can you check?', ['fake-self@s.whatsapp.net']);   // by phone jid
  upsert('m2', '@100000000000002 check', ['999000111@lid']);                  // by LID
  upsert('m3', '@Bob can you?', ['bob@s.whatsapp.net']);                  // someone else
  upsert('m4', 'bot should do x', undefined);                                     // name in text only
  // m5: the mention lives in a DOCUMENT CAPTION — the caption must surface and the mention must count
  sock.ev.emit('messages.upsert', { messages: [{
    key: { remoteJid: jid, fromMe: false, id: 'm5', participant: 'alice@s.whatsapp.net' }, pushName: 'Alice',
    message: { documentMessage: { fileName: 'contract.docx', caption: '@15550000001 check attachment 2', contextInfo: { mentionedJid: ['fake-self@s.whatsapp.net'] } } },
  }] });
  // m6: protocol-only (key rotation) must not become a record at all
  sock.ev.emit('messages.upsert', { messages: [{ key: { remoteJid: jid, fromMe: false, id: 'm6', participant: 'alice@s.whatsapp.net' }, message: { senderKeyDistributionMessage: {} } }] });
  await new Promise((r) => setTimeout(r, 50));
  const by = Object.fromEntries(got.map((r) => [r.msgId, r.mentionedMe]));
  assert.deepEqual(by, { m1: true, m2: true, m3: false, m4: false, m5: true });
  const m5 = got.find((r) => r.msgId === 'm5');
  assert.equal(m5.text, '[document: contract.docx] @15550000001 check attachment 2', 'caption text surfaces beside the document label');
  assert.deepEqual(got.find((r) => r.msgId === 'm3').mentionedJids, ['bob@s.whatsapp.net'], 'the raw mention list is recorded for diagnosis');
});

test('(e8) documents get a real mimetype by extension — docx and md are not octet-stream blobs at the receiver', async () => {
  const { mimetypeFor } = await import('../src/wa-client.js');
  assert.equal(mimetypeFor('Agreement_v0.1.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(mimetypeFor('notes.MD'), 'text/markdown');
  assert.equal(mimetypeFor('deck.pdf'), 'application/pdf');
  assert.equal(mimetypeFor('mystery.bin'), 'application/octet-stream');
  assert.equal(mimetypeFor('clip.mp4'), 'video/mp4');
  assert.equal(mimetypeFor('clip.MOV'), 'video/quicktime');
  assert.equal(mimetypeFor('loop.gif'), 'image/gif');
  assert.equal(mimetypeFor('voice.mp3'), 'audio/mpeg');
});

test('(c) an inbound message for an allowlisted jid lands in inbox.jsonl; poll_chats drains it once, then returns empty', async () => {
  const home = useTempHome();
  process.env.WA_CLIENT_FAKE = FAKE_BAILEYS_PATH;

  const allowedJid = '3333333333@s.whatsapp.net';
  const otherJid = '4444444444@s.whatsapp.net';
  writeConfig(home, { chats: [{ jid: allowedJid, name: 'Allowed', canPost: false }] });

  // Mirrors exactly what daemon.js's onMessage handler does: gate on the allowlist
  // before ever calling appendInbox.
  const allowlist = new Set([allowedJid]);
  const connection = await connect({
    reconnect: false,
    onMessage: (record) => {
      if (allowlist.has(record.chatJid)) appendInbox(record);
    },
  });
  assert.ok(connection.sock, 'the fake connection should resolve with a socket');

  connection.sock.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [
      {
        key: { remoteJid: allowedJid, fromMe: false, id: 'WAM-ALLOWED-1' },
        message: { conversation: 'hello from an allowed contact' },
        pushName: 'Allowed Contact',
      },
      {
        // Not on the allowlist: must be dropped, never written to inbox.jsonl.
        key: { remoteJid: otherJid, fromMe: false, id: 'WAM-OTHER-1' },
        message: { conversation: 'should never be stored' },
        pushName: 'Someone else',
      },
    ],
  });

  const inboxFile = path.join(home, 'inbox.jsonl');
  assert.ok(fs.existsSync(inboxFile), 'inbox.jsonl should have been created');
  const inboxLines = fs.readFileSync(inboxFile, 'utf8').trim().split('\n');
  assert.equal(inboxLines.length, 1, 'only the allowlisted chat message should be stored');

  const stored = JSON.parse(inboxLines[0]);
  assert.equal(stored.chatJid, allowedJid);
  assert.equal(stored.text, 'hello from an allowed contact');
  assert.equal(stored.fromMe, false);
  assert.equal(stored.msgId, 'WAM-ALLOWED-1');

  // Bonus check: the same record is reachable through wa-client's own reader, the
  // one read_chat_messages uses (read the file backwards, filtered by jid).
  const viaReadMessages = readMessages(allowedJid, 30);
  assert.equal(viaReadMessages.length, 1);
  assert.equal(viaReadMessages[0].msgId, 'WAM-ALLOWED-1');

  const firstPoll = await pollChats();
  assert.deepEqual(Object.keys(firstPoll), [allowedJid]);
  assert.equal(firstPoll[allowedJid].length, 1);
  assert.equal(firstPoll[allowedJid][0].msgId, 'WAM-ALLOWED-1');

  const secondPoll = await pollChats();
  assert.deepEqual(secondPoll, {}, 'a second poll_chats with nothing new must return empty (cursor advanced)');
});

test('an allowlisted document is downloaded and noted; the record itself still lands', async () => {
  const home = useTempHome();
  process.env.WA_CLIENT_FAKE = FAKE_BAILEYS_PATH;
  const { makeOnMessage } = await import('../src/daemon.js');
  const handler = makeOnMessage(new Set(['g1@g.us']));
  const record = { ts: 1, chatJid: 'g1@g.us', senderName: 'J', fromMe: false, text: '[document: pricing.html]', msgId: 'm1' };
  const raw = { key: { remoteJid: 'g1@g.us', id: 'm1' }, message: { documentMessage: { fileName: 'pricing.html', fileLength: 512 } } };
  await handler(record, raw);
  const lines = fs.readFileSync(path.join(home, 'inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const saved = lines.find((l) => l.type === 'media-saved');
  assert.ok(saved, 'media-saved note missing');
  assert.ok(saved.mediaPath.includes('downloads'));
  assert.equal(fs.readFileSync(saved.mediaPath, 'utf8'), 'fake-bytes-of:pricing.html');
  assert.ok(lines.some((l) => l.msgId === 'm1' && !l.type), 'plain record missing');
});

test('a NON-allowlisted document downloads NOTHING and stores nothing (blast radius)', async () => {
  const home = useTempHome();
  process.env.WA_CLIENT_FAKE = FAKE_BAILEYS_PATH;
  const { makeOnMessage } = await import('../src/daemon.js');
  let skipped = 0;
  const handler = makeOnMessage(new Set(['allowed@g.us']), () => { skipped += 1; });
  const raw = { key: { remoteJid: 'stranger@g.us', id: 'm2' }, message: { documentMessage: { fileName: 'secret.pdf', fileLength: 10 } } };
  await handler({ ts: 2, chatJid: 'stranger@g.us', text: '[document: secret.pdf]', msgId: 'm2' }, raw);
  assert.equal(skipped, 1);
  assert.ok(!fs.existsSync(path.join(home, 'downloads')), 'downloads dir must not exist');
  assert.ok(!fs.existsSync(path.join(home, 'inbox.jsonl')), 'inbox must not exist');
});

test('an oversize document is skipped with a note, never written', async () => {
  const home = useTempHome();
  process.env.WA_CLIENT_FAKE = FAKE_BAILEYS_PATH;
  const { makeOnMessage } = await import('../src/daemon.js');
  const handler = makeOnMessage(new Set(['g1@g.us']));
  const raw = { key: { remoteJid: 'g1@g.us', id: 'm3' }, message: { documentMessage: { fileName: 'huge.bin', fileLength: 999999999 } } };
  await handler({ ts: 3, chatJid: 'g1@g.us', text: '[document: huge.bin]', msgId: 'm3' }, raw);
  const lines = fs.readFileSync(path.join(home, 'inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const note = lines.find((l) => l.type === 'media-skipped');
  assert.ok(note && String(note.reason).startsWith('too-large'), `expected too-large, got ${JSON.stringify(note)}`);
  const dl = path.join(home, 'downloads');
  assert.ok(!fs.existsSync(dl) || fs.readdirSync(dl).length === 0, 'nothing may be written for oversize');
});

test('an allowlisted IMAGE is downloaded and noted with a typed filename (images are not documents)', async () => {
  const home = useTempHome();
  process.env.WA_CLIENT_FAKE = FAKE_BAILEYS_PATH;
  const { makeOnMessage } = await import('../src/daemon.js');
  const handler = makeOnMessage(new Set(['g1@g.us']));
  const record = { ts: 1, chatJid: 'g1@g.us', senderName: 'B', fromMe: false, text: '[image]', msgId: 'img1' };
  const raw = { key: { remoteJid: 'g1@g.us', id: 'img1' }, message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 900, caption: 'decision' } } };
  await handler(record, raw);
  const lines = fs.readFileSync(path.join(home, 'inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const saved = lines.find((l) => l.type === 'media-saved' && l.msgId === 'img1');
  assert.ok(saved, 'media-saved note missing for image');
  assert.ok(saved.mediaPath.endsWith('.jpg'), `expected .jpg, got ${saved.mediaPath}`);
  assert.equal(saved.mimetype, 'image/jpeg');
});

test('an allowlisted VOICE NOTE is downloaded as voice-note.ogg so an agent can transcribe what was said', async () => {
  const home = useTempHome();
  process.env.WA_CLIENT_FAKE = FAKE_BAILEYS_PATH;
  const { makeOnMessage } = await import('../src/daemon.js');
  const handler = makeOnMessage(new Set(['g1@g.us']));
  const record = { ts: 1, chatJid: 'g1@g.us', senderName: 'B', fromMe: false, text: '[voice note]', msgId: 'vn1' };
  const raw = { key: { remoteJid: 'g1@g.us', id: 'vn1' }, message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', fileLength: 4200, ptt: true, seconds: 3 } } };
  await handler(record, raw);
  const lines = fs.readFileSync(path.join(home, 'inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const saved = lines.find((l) => l.type === 'media-saved' && l.msgId === 'vn1');
  assert.ok(saved, 'media-saved note missing for voice note');
  assert.equal(saved.kind, 'audio');
  assert.ok(saved.mediaPath.endsWith('-voice-note.ogg'), `expected voice-note.ogg, got ${saved.mediaPath}`);
  const { mediaFilename } = await import('../src/wa-client.js');
  assert.equal(mediaFilename('audio', { mimetype: 'audio/mpeg' }), 'audio.mp3', 'a plain audio file keeps its type');
  assert.equal(mediaFilename('video', { mimetype: 'video/mp4; codecs=avc1' }), 'video.mp4', 'mimetype parameters are ignored');
});

test('an oversize voice note is skipped by the 25 MB cap, not downloaded', async () => {
  const home = useTempHome();
  process.env.WA_CLIENT_FAKE = FAKE_BAILEYS_PATH;
  const { makeOnMessage } = await import('../src/daemon.js');
  const handler = makeOnMessage(new Set(['g1@g.us']));
  const raw = { key: { remoteJid: 'g1@g.us', id: 'vn2' }, message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', fileLength: 26 * 1024 * 1024, ptt: true } } };
  await handler({ ts: 1, chatJid: 'g1@g.us', text: '[voice note]', msgId: 'vn2' }, raw);
  const lines = fs.readFileSync(path.join(home, 'inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const note = lines.find((l) => l.type === 'media-skipped' && l.msgId === 'vn2');
  assert.ok(note && String(note.reason).startsWith('too-large'), `expected too-large, got ${JSON.stringify(note)}`);
});

test('19: a document sent with a caption (documentWithCaptionMessage wrapper) is read as a document, not as [messageContextInfo]', async () => {
  const { extractText, mediaPart } = await import('../src/wa-client.js');
  const raw = { message: { messageContextInfo: { deviceListMetadata: {} }, documentWithCaptionMessage: { message: { documentMessage: { fileName: 'Third.md', mimetype: 'text/markdown', caption: 'see attachment' } } } } };
  assert.equal(extractText(raw.message), '[document: Third.md] see attachment');
  assert.equal(mediaPart(raw)?.kind, 'document');
  assert.equal(mediaPart(raw)?.part?.fileName, 'Third.md');
});

test('20: the daemon download gate sees a captioned (wrapped) document as savable media', async () => {
  const { hasSavableMedia } = await import('../src/wa-client.js');
  const wrapped = { message: { messageContextInfo: {}, documentWithCaptionMessage: { message: { documentMessage: { fileName: 'x.md', mimetype: 'text/markdown' } } } } };
  assert.equal(hasSavableMedia(wrapped), true);
  assert.equal(hasSavableMedia({ message: { conversation: 'hello' } }), false);
  // video sent as a video (not as a document) must be saved too, with a real extension
  const vid = { message: { videoMessage: { mimetype: 'video/mp4', fileLength: 1000 } } };
  assert.equal(hasSavableMedia(vid), true);
  const { mediaPart: mp2, mediaFilename } = await import('../src/wa-client.js');
  assert.equal(mp2(vid)?.kind, 'video');
  assert.equal(mediaFilename('video', { mimetype: 'video/mp4' }), 'video.mp4');
  assert.equal(mediaFilename('video', { mimetype: 'video/quicktime' }), 'video.mov');
  assert.equal(mediaFilename('image', { mimetype: 'image/png' }), 'image.png');
  assert.equal(mediaFilename('document', { fileName: '../evil name.pdf' }), 'evil_name.pdf');
  const daemonSrc = fs.readFileSync(new URL('../src/daemon.js', import.meta.url), 'utf8');
  assert.ok(!/raw\?\.message\?\.documentMessage/.test(daemonSrc), 'daemon must not inspect message keys directly');
});

test('21: a quoted reply carries replyToMsgId and replyToText on the record', async () => {
  const { replyContext } = await import('../src/wa-client.js');
  const msg = { extendedTextMessage: { text: 'Yes, that works.', contextInfo: { stanzaId: 'ABC123', participant: '100000000000001@lid', quotedMessage: { conversation: 'Does the quoted reply survive?' } } } };
  const r = replyContext(msg);
  assert.equal(r.replyToMsgId, 'ABC123');
  assert.equal(r.replyToText, 'Does the quoted reply survive?');
  assert.equal(replyContext({ conversation: 'hello' }), null);
});

test('22: a reaction becomes a record of type reaction with emoji and target, never skipped', async () => {
  const { extractMessageRecords } = await import('../src/wa-client.js');
  const payload = { messages: [{ key: { remoteJid: 'g@g.us', id: 'R1', fromMe: false, participant: 'p@lid' }, pushName: 'T', message: { reactionMessage: { text: '👍', key: { remoteJid: 'g@g.us', id: 'TARGET', fromMe: true } } } }] };
  const out = extractMessageRecords(payload);
  assert.equal(out.length, 1);
  assert.equal(out[0].record.type, 'reaction');
  assert.equal(out[0].record.reaction.emoji, '👍');
  assert.equal(out[0].record.reaction.targetMsgId, 'TARGET');
});

test('23: an edited message (protocolMessage.editedMessage) becomes a record carrying the new text and editOfMsgId', async () => {
  const { extractMessageRecords } = await import('../src/wa-client.js');
  const payload = { messages: [{ key: { remoteJid: 'g@g.us', id: 'E1', fromMe: false, participant: 'p@lid' }, message: { protocolMessage: { type: 14, key: { id: 'ORIG' }, editedMessage: { conversation: 'ny text' } } } }] };
  const out = extractMessageRecords(payload);
  assert.equal(out.length, 1);
  assert.equal(out[0].record.text, 'ny text');
  assert.equal(out[0].record.editOfMsgId, 'ORIG');
});

test('24: an unknown message type records its raw keys so it can be diagnosed', async () => {
  const { extractMessageRecords } = await import('../src/wa-client.js');
  const payload = { messages: [{ key: { remoteJid: 'g@g.us', id: 'U1', fromMe: false }, message: { messageContextInfo: {}, someFutureMessage: { foo: 1 } } }] };
  const out = extractMessageRecords(payload);
  assert.equal(out[0].record.text, '[someFutureMessage]');
  assert.deepEqual(out[0].record.rawKeys, ['messageContextInfo', 'someFutureMessage']);
});

test('25: the outbox drain dispatches react commands, not only send/send-file', async () => {
  const src = fs.readFileSync(new URL('../src/daemon.js', import.meta.url), 'utf8');
  assert.ok(/if \(!OUTBOX_TYPES\.has\(cmd\?\.type\)\) continue;/.test(src), 'the drain must filter on OUTBOX_TYPES');
  const { OUTBOX_TYPES } = await import('../src/daemon.js');
  assert.ok(OUTBOX_TYPES.has('react'), 'react must be an accepted outbox command type');
});

test('26: a secretEncryptedMessage records its target message key and inner field names (never the payload)', async () => {
  const { extractMessageRecords } = await import('../src/wa-client.js');
  const payload = { messages: [{ key: { remoteJid: 'd@lid', id: 'S1', fromMe: false }, message: { messageContextInfo: { messageSecret: 'x' }, secretEncryptedMessage: { targetMessageKey: { remoteJid: 'd@lid', id: 'ORIG', fromMe: false }, encPayload: 'AAAA', encIv: 'BBBB', secretEncType: 1 } } }] };
  const out = extractMessageRecords(payload);
  const r = out[0].record;
  assert.equal(r.type, 'secret-encrypted');
  assert.equal(r.targetMsgId, 'ORIG');
  assert.deepEqual(r.innerKeys, ['targetMessageKey', 'encPayload', 'encIv', 'secretEncType']);
  assert.ok(!JSON.stringify(r).includes('AAAA'), 'payload must not be stored');
});

test('26: react_to_message on a canPost:false chat is refused without touching outbox', async () => {
  const home = useTempHome();
  const jid = '1111111111@s.whatsapp.net';
  writeConfig(home, { chats: [{ jid, name: 'No Post', canPost: false }] });

  await assert.rejects(() => reactToMessage({ jid, msgId: 'M1', emoji: '👍' }), /canPost:false/);
  assert.equal(fs.existsSync(path.join(home, 'outbox.jsonl')), false, 'outbox.jsonl must not be created for a refused reaction');
});

test('27: react_to_message writes a react command the daemon dispatches, and resolves with its ack', async () => {
  const home = useTempHome();
  process.env.WA_CLIENT_FAKE = FAKE_BAILEYS_PATH;
  const jid = 'grp-react@g.us';
  writeConfig(home, { chats: [{ jid, name: 'Reactions', canPost: true }] });
  const { handleSendCommand } = await import('../src/daemon.js');
  const { loadConfig } = await import('../src/config.js');
  await connect({ reconnect: false, onMessage: () => {} });

  const pending = reactToMessage({ jid, msgId: 'TARGET', emoji: '✅', participant: 'p@lid' });
  const outbox = path.join(home, 'outbox.jsonl');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !(fs.existsSync(outbox) && fs.readFileSync(outbox, 'utf8').trim())) await new Promise((r) => setTimeout(r, 50));
  const cmd = JSON.parse(fs.readFileSync(outbox, 'utf8').trim().split('\n').at(-1));
  assert.equal(cmd.type, 'react');
  assert.equal(cmd.msgId, 'TARGET');
  assert.equal(cmd.participant, 'p@lid');
  await handleSendCommand(cmd, loadConfig());

  const result = await pending;
  assert.equal(result.reacted, true);
  assert.equal(result.emoji, '✅');
  assert.equal(result.target, 'TARGET');
});

test('(h) delete revokes only our own message: the socket gets {delete: key} with fromMe forced true; canPost:false refuses', async () => {
  const home = useTempHome();
  process.env.WA_CLIENT_FAKE = FAKE_BAILEYS_PATH;
  const jid = '7777777777@g.us';
  const noPostJid = '8888888888@g.us';
  writeConfig(home, { chats: [{ jid, name: 'Group', canPost: true }, { jid: noPostJid, name: 'ReadOnly', canPost: false }] });
  const { handleSendCommand } = await import('../src/daemon.js');
  const { loadConfig } = await import('../src/config.js');
  const { createdSockets } = await import('./fixtures/fake-baileys.js');
  await connect({ reconnect: false, onMessage: () => {} });
  await handleSendCommand({ ts: Date.now(), type: 'delete', jid, msgId: 'ABC123', fromMe: false, nonce: 'd1' }, loadConfig());
  const sock = createdSockets.at(-1);
  const del = sock.__sent.at(-1);
  assert.ok(del && del.content && del.content.delete, 'the fake socket must have recorded a delete');
  assert.equal(del.content.delete.id, 'ABC123');
  assert.equal(del.content.delete.fromMe, true, 'a delete can only ever target our own message');
  assert.equal(del.content.delete.remoteJid, jid);
  const before = sock.__sent.length;
  await handleSendCommand({ ts: Date.now(), type: 'delete', jid: noPostJid, msgId: 'XYZ', nonce: 'd2' }, loadConfig());
  assert.equal(sock.__sent.length, before, 'canPost:false must refuse a delete');
});

test('(i) every command type handleSendCommand handles is let through by the outbox watcher', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/daemon.js', import.meta.url), 'utf8');
  const handled = [...src.matchAll(/cmd\.type === '([a-z-]+)'/g)].map((m) => m[1]);
  const { OUTBOX_TYPES } = await import('../src/daemon.js');
  for (const t of handled) assert.ok(OUTBOX_TYPES.has(t), `outbox watcher would silently skip "${t}"`);
  assert.ok(OUTBOX_TYPES.has('send'), 'plain text sends must pass');
});
