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
import { pollChats, sendChatMessage } from '../src/mcp-server.js';
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
  const filePath = path2.join(home, 'doc.pdf');
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
  const filePath = path2.join(home, 'quarterly-report.pdf');
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
  const filePath = path2.join(home, 'brief.pdf');
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
  upsert('m4', 'bot should do x', undefined);                                  // name in text only
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
