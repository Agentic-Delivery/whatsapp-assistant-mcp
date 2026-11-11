// `/status` (owner, 2026-11-11): a message that is only `/status` in an allowlisted chat gets the factory runner's
// report as a quoted reply and is written to neither inbox. Fake Baileys, temp WA_HOME; no network.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { clearOwnMessages, makeOnMessage, rememberOwnMessage } from '../src/daemon.js';
import { isStatusCommand, readStatusReport } from '../src/status.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.WA_CLIENT_FAKE = path.join(__dirname, 'fixtures', 'fake-baileys.js');
const GROUP = '120363000000000000@g.us';
const ANNA = '46700000000@s.whatsapp.net';
const REPORT = 'Factory status at 15:02 UTC\nWorking: building ×2\n';

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function setup({ at = new Date().toISOString(), canPost = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-status-'));
  dirs.push(home);
  process.env.WA_HOME = home;
  const statusFile = path.join(home, 'status.txt');
  fs.writeFileSync(statusFile, REPORT);
  fs.writeFileSync(path.join(home, 'status.json'), JSON.stringify({ at }));
  fs.writeFileSync(path.join(home, 'wa-mcp.config.json'), JSON.stringify({ chats: [{ jid: GROUP, name: 'G', canPost }], statusFile }));
  const channelInbox = path.join(home, 'channel-inbox.jsonl');
  const sent = [];
  const config = loadConfig();
  const status = {
    file: config.statusFile, maxAgeMs: config.statusMaxAgeMinutes * 60_000,
    canPost: (jid) => !!config.chats.find((c) => c.jid === jid)?.canPost,
    send: async (jid, text, quote) => { sent.push({ jid, text, quote }); return 'R1'; },
  };
  const onMessage = makeOnMessage(new Set([GROUP]), () => {}, {}, () => {}, { inbox: channelInbox }, status);
  return { home, sent, onMessage, channelInbox };
}

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const msg = (text, extra = {}) => ({ ts: 1, chatJid: GROUP, msgId: 'M1', text, senderJid: ANNA, fromMe: false, ...extra });

test('only a message that is wholly /status counts', () => {
  assert.equal(isStatusCommand({ text: '  /STATUS ' }), true);
  assert.equal(isStatusCommand({ text: '/status please' }), false);
  assert.equal(isStatusCommand({ text: 'what is the /status' }), false);
  assert.equal(isStatusCommand({ text: '/status', type: 'transcript' }), false);
});

test('/status is answered as a quoted reply with the report and reaches no inbox', async () => {
  clearOwnMessages();
  const { home, sent, onMessage, channelInbox } = setup();
  await onMessage(msg('/status'), { key: { participant: ANNA } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, GROUP);
  assert.equal(sent[0].text, REPORT.trim());
  assert.deepEqual(sent[0].quote, { msgId: 'M1', participant: ANNA, fromMe: false, text: '/status' });
  assert.equal(read(path.join(home, 'inbox.jsonl')), '', 'not in the native inbox');
  assert.equal(read(channelInbox), '', 'not in the factory channel inbox');
});

test('an ordinary message still reaches the inbox; a chat without canPost gets no answer', async () => {
  clearOwnMessages();
  const a = setup();
  await a.onMessage(msg('hello /status'), {});
  assert.equal(a.sent.length, 0);
  assert.match(read(path.join(a.home, 'inbox.jsonl')), /hello \/status/);
  const b = setup({ canPost: false });
  await b.onMessage(msg('/status'), {});
  assert.equal(b.sent.length, 0);
  assert.equal(read(path.join(b.home, 'inbox.jsonl')), '');
});

test('our own /status-looking send never triggers it', async () => {
  clearOwnMessages();
  const { sent, onMessage } = setup();
  rememberOwnMessage('OWN1');
  await onMessage(msg('/status', { msgId: 'OWN1', fromMe: true }), {});
  assert.equal(sent.length, 0);
});

test('a stale report reads as unavailable; an offline one is shown however old', () => {
  const now = Date.parse('2026-11-11T15:00:00Z');
  const { home } = setup({ at: '2026-11-11T14:40:00Z' });
  assert.equal(readStatusReport(path.join(home, 'status.txt'), { now }), "Status unavailable: the factory's last report is 20 minutes old.");
  fs.writeFileSync(path.join(home, 'status.txt'), 'Factory status at 10:00 UTC\nOffline: factory stopped\n');
  assert.match(readStatusReport(path.join(home, 'status.txt'), { now }), /Offline: factory stopped/);
  assert.match(readStatusReport('/nonexistent/status.txt', { now }), /^Status unavailable/);
});
