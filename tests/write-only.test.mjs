// Write-only chats (canRead:false): allowlisted for posting, never stored, never readable.
// Run with `node --test tests/`. Each test gets its own temp WA_HOME and the fake Baileys client.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { listChats, pollChats, readChatMessages } from '../src/mcp-server.js';
import { appendInbox } from '../src/wa-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.WA_CLIENT_FAKE = path.join(__dirname, 'fixtures', 'fake-baileys.js');

const homes = [];
after(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });

const READ = '111@g.us';
const ALERT = '222@g.us';

function home(chats) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mcp-wo-'));
  homes.push(dir);
  process.env.WA_HOME = dir;
  fs.writeFileSync(path.join(dir, 'wa-mcp.config.json'), JSON.stringify({ chats }));
  return dir;
}

test('canRead defaults to true and canRead:false is kept', () => {
  home([{ jid: READ, name: 'R', canPost: true }, { jid: ALERT, name: 'A', canPost: true, canRead: false }]);
  const { chats } = loadConfig();
  assert.equal(chats.find((c) => c.jid === READ).canRead, true);
  assert.equal(chats.find((c) => c.jid === ALERT).canRead, false);
});

test('a chat that is neither readable nor postable is refused at load', () => {
  home([{ jid: ALERT, name: 'A', canPost: false, canRead: false }]);
  assert.throws(() => loadConfig(), /canRead:false and canPost:false/);
});

test('the daemon stores only readable chats; a write-only message is skipped without a knock', async () => {
  const dir = home([{ jid: READ, name: 'R', canPost: true }, { jid: ALERT, name: 'A', canPost: true, canRead: false }]);
  const { makeOnMessage, splitAllowlist } = await import('../src/daemon.js');
  const { readable, writeOnly } = splitAllowlist(loadConfig());
  assert.deepEqual([...readable], [READ]);
  assert.deepEqual([...writeOnly], [ALERT]);
  const skipped = [];
  const onMessage = makeOnMessage(readable, (r) => skipped.push(r.chatJid));
  await onMessage({ ts: 1, chatJid: ALERT, text: 'owner-internal', msgId: 'a1' }, {});
  await onMessage({ ts: 2, chatJid: READ, text: 'customer', msgId: 'r1' }, {});
  const inbox = fs.readFileSync(path.join(dir, 'inbox.jsonl'), 'utf8');
  assert.ok(!inbox.includes('owner-internal'), 'a write-only chat must never reach inbox.jsonl');
  assert.ok(inbox.includes('customer'));
  assert.deepEqual(skipped, [ALERT]);
});

test('read_chat_messages refuses a write-only chat; poll_chats and list_chats never expose it', async () => {
  home([{ jid: READ, name: 'R', canPost: true }, { jid: ALERT, name: 'A', canPost: true, canRead: false }]);
  // A line written before the chat was made write-only must still not be returned.
  appendInbox({ ts: 1, chatJid: ALERT, text: 'old internal line', msgId: 'o1' });
  appendInbox({ ts: 2, chatJid: READ, text: 'hello', msgId: 'h1' });
  await assert.rejects(() => readChatMessages({ jid: ALERT }), /write-only/);
  const polled = await pollChats();
  assert.equal(polled[ALERT], undefined);
  assert.equal(polled[READ].length, 1);
  const { chats } = await listChats();
  const alert = chats.find((c) => c.jid === ALERT);
  assert.equal(alert.canRead, false);
  assert.equal(alert.recentMessageCount, 0);
});
