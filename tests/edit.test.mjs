// Outbox "edit": replaces the text of one of this account's own messages.
// Fake Baileys only (WA_CLIENT_FAKE), a temp WA_HOME per test: no network, no real account.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { handleSendCommand } from '../src/daemon.js';
import { appendInbox, connect } from '../src/wa-client.js';
import { createdSockets } from './fixtures/fake-baileys.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(__dirname, 'fixtures', 'fake-baileys.js');
const SIG = '\u{1F916} ';
const homes = [];
after(() => { for (const d of homes) fs.rmSync(d, { recursive: true, force: true }); });

const GROUP = '120363000000000001@g.us';
const DM = '46700000001@s.whatsapp.net';
const READONLY = '46700000002@s.whatsapp.net';

async function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-edit-test-'));
  homes.push(home);
  process.env.WA_HOME = home;
  process.env.WA_CLIENT_FAKE = FAKE;
  delete process.env.WA_AGENT_SIG;
  fs.writeFileSync(path.join(home, 'wa-mcp.config.json'), JSON.stringify({ chats: [
    { jid: GROUP, name: 'Group', canPost: true },
    { jid: DM, name: 'Dm', canPost: true },
    { jid: READONLY, name: 'Read only', canPost: false },
  ] }));
  await connect({ reconnect: false, onMessage: () => {} });
  return { home, sock: createdSockets.at(-1) };
}

function ackFor(home, nonce) {
  const lines = fs.readFileSync(path.join(home, 'inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return lines.filter((r) => r.type === 'send-ack' && r.nonce === nonce).at(-1);
}

const edit = (fields) => handleSendCommand({ ts: Date.now(), type: 'edit', nonce: 'n-' + Math.random(), echoTimeoutMs: 500, nackWaitMs: 50, ...fields }, loadConfig());

test('(e1) edit sends {text, edit:key} for our own message and acks ok with the new id, verified', async () => {
  const { home, sock } = await setup();
  appendInbox({ ts: Date.now() - 60000, chatJid: GROUP, fromMe: true, msgId: 'ORIG1', text: SIG + 'old' });
  await edit({ jid: GROUP, msgId: 'ORIG1', text: 'new text', nonce: 'e1' });
  const sent = sock.__sent.at(-1);
  assert.equal(sent.jid, GROUP);
  assert.equal(sent.content.text, SIG + 'new text', 'the edited text carries the agent marker');
  assert.deepEqual(sent.content.edit, { remoteJid: GROUP, id: 'ORIG1', fromMe: true }, 'own message key, no participant');
  const ack = ackFor(home, 'e1');
  assert.equal(ack.ok, true);
  assert.equal(ack.msgId, sent.msgId);
  assert.equal(ack.edited, 'ORIG1');
  assert.deepEqual(ack.verified, { text: true });
  assert.equal(ack.warning, undefined);
});

test('(e2) an already-signed text is not signed twice; fromMe:false in the command cannot redirect the edit', async () => {
  const { home, sock } = await setup();
  await edit({ jid: DM, msgId: 'ORIG2', text: SIG + 'signed', fromMe: false, participant: 'x@lid', nonce: 'e2' });
  const sent = sock.__sent.at(-1);
  assert.equal(sent.content.text, SIG + 'signed');
  assert.deepEqual(sent.content.edit, { remoteJid: DM, id: 'ORIG2', fromMe: true });
  assert.equal(ackFor(home, 'e2').ok, true);
});

test('(e3) an original older than 15 minutes is still edited, with an edit-window warning', async () => {
  const { home } = await setup();
  appendInbox({ ts: Date.now() - 20 * 60000, chatJid: DM, fromMe: true, msgId: 'OLD', text: SIG + 'old' });
  await edit({ jid: DM, msgId: 'OLD', text: 'late', nonce: 'e3' });
  const ack = ackFor(home, 'e3');
  assert.equal(ack.ok, true);
  assert.match(ack.warning, /^edit-window: the original was sent 20 min ago/);
});

test('(e4) a chat not on the allowlist, or canPost:false, is refused locally and nothing is sent', async () => {
  const { home, sock } = await setup();
  const before = sock.__sent.length;
  await edit({ jid: '46799999999@s.whatsapp.net', msgId: 'X', text: 't', nonce: 'e4a' });
  await edit({ jid: READONLY, msgId: 'X', text: 't', nonce: 'e4b' });
  assert.equal(sock.__sent.length, before);
  const a = ackFor(home, 'e4a');
  const b = ackFor(home, 'e4b');
  assert.equal(a.ok, false);
  assert.match(a.error, /not in allowlist/);
  assert.equal(b.ok, false);
  assert.match(b.error, /canPost is false/);
});

test('(e5) a Baileys error on send becomes ok:false with its message', async () => {
  const { home, sock } = await setup();
  sock.__sendError = new Error('Connection Closed');
  await edit({ jid: DM, msgId: 'ORIG5', text: 't', nonce: 'e5' });
  const ack = ackFor(home, 'e5');
  assert.equal(ack.ok, false);
  assert.equal(ack.error, 'Connection Closed');
});

test('(e6) a server refusal (error ack on the edit) becomes ok:false with a readable error', async () => {
  const { home, sock } = await setup();
  sock.__nackCode = '479';
  try {
    await edit({ jid: DM, msgId: 'ORIG6', text: 't', nonce: 'e6' });
  } finally {
    sock.__nackCode = null;
  }
  const ack = ackFor(home, 'e6');
  assert.equal(ack.ok, false);
  assert.match(ack.error, /WhatsApp refused the edit of ORIG6 \(error 479\).*15 minutes/);
});

test('(e7) missing msgId, missing/empty text or missing jid are refused before anything is sent', async () => {
  const { home, sock } = await setup();
  const before = sock.__sent.length;
  await edit({ jid: DM, text: 't', nonce: 'e7a' });
  await edit({ jid: DM, msgId: 'M', nonce: 'e7b' });
  await edit({ jid: DM, msgId: 'M', text: '   ', nonce: 'e7c' });
  await edit({ msgId: 'M', text: 't', nonce: 'e7d' });
  assert.equal(sock.__sent.length, before);
  assert.match(ackFor(home, 'e7a').error, /edit needs msgId/);
  assert.match(ackFor(home, 'e7b').error, /edit needs text/);
  assert.match(ackFor(home, 'e7c').error, /edit needs text/);
  assert.match(ackFor(home, 'e7d').error, /not in allowlist/);
  for (const n of ['e7a', 'e7b', 'e7c', 'e7d']) assert.equal(ackFor(home, n).ok, false);
});
