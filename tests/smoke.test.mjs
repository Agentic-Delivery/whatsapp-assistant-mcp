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
