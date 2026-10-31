// Channel v1 (build contract v1, vd-server docs/design/channel-interface.md §4.2/§4.5): the
// opt-in channel inbox line, the receipt reaction, quoted replies and the typing command.
// Run with `node --test tests/`. Each test gets its own temp WA_HOME and the fake Baileys
// client; nothing here touches a real WhatsApp connection or ~/.whatsapp-assistant.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { connect, extractMessageRecords } from '../src/wa-client.js';
import {
  adapterEventsFor, channelFromEnv, handleSendCommand, makeOnMessage, OUTBOX_TYPES,
  typingJids, writeChannelAdapterEvent,
} from '../src/daemon.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_BAILEYS_PATH = path.join(__dirname, 'fixtures', 'fake-baileys.js');
const FAKE_TRANSCRIBE = [process.execPath, path.join(__dirname, 'fixtures', 'fake-transcribe.mjs'), '{input}'];
process.env.WA_CLIENT_FAKE = FAKE_BAILEYS_PATH;
delete process.env.WA_CHANNEL_INBOX;
delete process.env.WA_RECEIPT_EMOJI;

const GROUP = '120363000000000000@g.us';
const ANNA = '46700000000@s.whatsapp.net';
const DM = '46711111111@s.whatsapp.net';

const homes = [];
after(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });
afterEach(() => {
  mock.timers.reset();
  delete process.env.WA_CHANNEL_INBOX;
  delete process.env.WA_RECEIPT_EMOJI;
});

function home(chats = [{ jid: GROUP, name: 'G', canPost: true }, { jid: DM, name: 'D', canPost: true }]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mcp-ch-'));
  homes.push(dir);
  process.env.WA_HOME = dir;
  fs.writeFileSync(path.join(dir, 'wa-mcp.config.json'), JSON.stringify({ chats }));
  return dir;
}

/** A realistic (record, raw) pair, through the same extraction the connection loop uses. */
function inbound({ chat, id, message, participant, fromMe = false, ts = 1793476800, pushName = 'Anna' }) {
  const key = { remoteJid: chat, id, fromMe, ...(participant ? { participant } : {}) };
  return extractMessageRecords({ messages: [{ key, message, pushName, messageTimestamp: ts }] })[0];
}

function lines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const allow = () => new Set([GROUP, DM]);

test('channel v1 is off when WA_CHANNEL_INBOX is unset: nothing is written beyond the native inbox', async () => {
  const dir = home();
  const would = path.join(dir, 'channel', 'inbox.jsonl');
  assert.equal(channelFromEnv(), null);
  const { record, raw } = inbound({ chat: GROUP, id: 'M0', participant: ANNA, message: { conversation: 'hej' } });
  await makeOnMessage(allow())(record, raw);
  writeChannelAdapterEvent('connected');
  assert.equal(fs.existsSync(would), false);
  assert.equal(fs.existsSync(path.join(dir, 'channel')), false);
  assert.equal(lines(path.join(dir, 'inbox.jsonl')).length, 1, 'the native inbox is unchanged');
});

test('a group message becomes one v1 line with prefixed ids, WhatsApp time and reply link', async () => {
  const dir = home();
  const inbox = path.join(dir, 'channel', 'inbox.jsonl');
  process.env.WA_CHANNEL_INBOX = inbox;
  const { record, raw } = inbound({
    chat: GROUP, id: '3EB0ABC', participant: ANNA,
    message: { extendedTextMessage: { text: 'Kan ni flytta knappen?', contextInfo: { stanzaId: '3EB0Q', participant: DM, quotedMessage: { conversation: 'Klart' } } } },
  });
  const before = Date.now();
  await makeOnMessage(allow())(record, raw);
  const [line, ...rest] = lines(inbox);
  assert.equal(rest.length, 0);
  assert.equal(new Date(line.ingestedAt).getTime() >= before, true);
  delete line.ingestedAt;
  assert.deepEqual(line, {
    v: 1, kind: 'message', platform: 'wa', ts: '2026-10-31T20:00:00.000Z',
    chatId: `wa:${GROUP}`, spaceId: null, threadId: null, msgId: '3EB0ABC',
    senderId: `wa:${ANNA}`, senderName: 'Anna', fromMe: false,
    text: 'Kan ni flytta knappen?', replyToMsgId: '3EB0Q', attachments: [], receipt: null,
  });
  assert.equal(fs.statSync(inbox).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(inbox)).mode & 0o777, 0o700);
});

test('a DM becomes one v1 line whose sender is the chat', async () => {
  const dir = home();
  const inbox = path.join(dir, 'channel', 'inbox.jsonl');
  process.env.WA_CHANNEL_INBOX = inbox;
  const { record, raw } = inbound({ chat: DM, id: 'D1', message: { conversation: 'Hej' }, pushName: 'Bo' });
  await makeOnMessage(allow())(record, raw);
  const [line] = lines(inbox);
  assert.equal(line.chatId, `wa:${DM}`);
  assert.equal(line.senderId, `wa:${DM}`);
  assert.equal(line.senderName, 'Bo');
  assert.equal(line.msgId, 'D1');
  assert.equal(line.replyToMsgId, null);
});

test('not written to v1: own messages, reactions, edits, non-allowlisted chats, send-acks', async () => {
  const dir = home();
  const inbox = path.join(dir, 'channel', 'inbox.jsonl');
  process.env.WA_CHANNEL_INBOX = inbox;
  const on = makeOnMessage(allow());
  const mine = inbound({ chat: GROUP, id: 'E1', fromMe: true, message: { conversation: 'from the factory' } });
  await on(mine.record, mine.raw);
  const react = inbound({ chat: GROUP, id: 'R1', participant: ANNA, message: { reactionMessage: { text: '👍', key: { id: 'X' } } } });
  await on(react.record, react.raw);
  const edit = inbound({ chat: GROUP, id: 'P1', participant: ANNA, message: { protocolMessage: { key: { id: 'X' }, editedMessage: { conversation: 'fixed' } } } });
  await on(edit.record, edit.raw);
  const other = inbound({ chat: 'other@g.us', id: 'O1', participant: ANNA, message: { conversation: 'not ours' } });
  await on(other.record, other.raw);
  // A send-ack goes to the native inbox only.
  await connect({ reconnect: false, onMessage: () => {} });
  await handleSendCommand({ type: 'send', jid: DM, nonce: 'n1', text: 'hello', echoTimeoutMs: 50 }, loadConfig());
  assert.deepEqual(lines(inbox), []);
  assert.ok(lines(path.join(dir, 'inbox.jsonl')).some((r) => r.type === 'send-ack'));
});

test('a saved document rides on the line as an attachment; one line per message', async () => {
  const dir = home();
  const inbox = path.join(dir, 'channel', 'inbox.jsonl');
  process.env.WA_CHANNEL_INBOX = inbox;
  const { record, raw } = inbound({ chat: GROUP, id: 'F1', participant: ANNA, message: { documentMessage: { fileName: 'x.pdf', mimetype: 'application/pdf' } } });
  await makeOnMessage(allow())(record, raw);
  const all = lines(inbox);
  assert.equal(all.length, 1);
  assert.equal(all[0].text, '[document: x.pdf]');
  assert.equal(all[0].attachments.length, 1);
  const a = all[0].attachments[0];
  assert.equal(a.name, 'x.pdf');
  assert.equal(a.mime, 'application/pdf');
  assert.equal(a.bytes, fs.statSync(a.path).size);
  assert.ok(path.isAbsolute(a.path));
});

test('a voice note is written once, with its transcript as text', async () => {
  const dir = home();
  const inbox = path.join(dir, 'channel', 'inbox.jsonl');
  process.env.WA_CHANNEL_INBOX = inbox;
  const { record, raw } = inbound({ chat: GROUP, id: 'V1', participant: ANNA, message: { audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus' } } });
  await makeOnMessage(allow(), () => {}, { transcribe: FAKE_TRANSCRIBE })(record, raw);
  const all = lines(inbox);
  assert.equal(all.length, 1);
  assert.equal(all[0].text, 'hello from the voice note');
  assert.equal(all[0].attachments[0].name, 'voice-note.ogg');
});

test('adapter events: line shape, and which events a connection update means', () => {
  const dir = home();
  const inbox = path.join(dir, 'channel', 'inbox.jsonl');
  process.env.WA_CHANNEL_INBOX = inbox;
  writeChannelAdapterEvent('disconnected', 'status 428: Connection Closed');
  const [line] = lines(inbox);
  assert.equal(line.v, 1);
  assert.equal(line.kind, 'adapter');
  assert.equal(line.platform, 'wa');
  assert.equal(line.event, 'disconnected');
  assert.equal(line.detail, 'status 428: Connection Closed');
  assert.equal('msgId' in line, false);
  assert.deepEqual(adapterEventsFor({ connection: 'open' }), [['connected', null]]);
  assert.deepEqual(adapterEventsFor({ connection: 'connecting' }), []);
  assert.deepEqual(adapterEventsFor({ connection: 'close', loggedOut: true }), [['auth-failed', 'logged out: re-pair needed']]);
  assert.deepEqual(
    adapterEventsFor({ connection: 'close', lastDisconnect: { error: { message: 'Connection Closed', output: { statusCode: 428 } } } }),
    [['disconnected', 'status 428: Connection Closed'], ['reconnecting', null]],
  );
});

// --- receipt -----------------------------------------------------------------------------

function channelWith(dir, react, receiptTimeoutMs = 3000) {
  return { inbox: path.join(dir, 'channel', 'inbox.jsonl'), emoji: '👀', react, receiptTimeoutMs };
}

test('receipt placed: the react names the sender in a group and nobody in a DM, then the line says placed', async () => {
  const dir = home();
  const calls = [];
  const ch = channelWith(dir, async (jid, key, emoji) => { calls.push({ jid, key, emoji }); return 'r1'; });
  const g = inbound({ chat: GROUP, id: 'G1', participant: ANNA, message: { conversation: 'hej' } });
  const d = inbound({ chat: DM, id: 'D1', message: { conversation: 'hej' } });
  await makeOnMessage(allow(), () => {}, {}, () => {}, ch)(g.record, g.raw);
  await makeOnMessage(allow(), () => {}, {}, () => {}, ch)(d.record, d.raw);
  assert.deepEqual(calls, [
    { jid: GROUP, key: { id: 'G1', fromMe: false, participant: ANNA }, emoji: '👀' },
    { jid: DM, key: { id: 'D1', fromMe: false, participant: undefined }, emoji: '👀' },
  ]);
  assert.deepEqual(lines(ch.inbox).map((l) => l.receipt), ['placed', 'placed']);
});

test('receipt failed: a rejected react still writes the line, receipt failed', async () => {
  const dir = home();
  const ch = channelWith(dir, async () => { throw new Error('No active WhatsApp connection'); });
  const g = inbound({ chat: GROUP, id: 'G2', participant: ANNA, message: { conversation: 'hej' } });
  await makeOnMessage(allow(), () => {}, {}, () => {}, ch)(g.record, g.raw);
  const [line] = lines(ch.inbox);
  assert.equal(line.receipt, 'failed');
  assert.equal(line.text, 'hej');
});

test('receipt timeout: a react that never settles is cut off at the bound and the line is still written', async () => {
  const dir = home();
  const ch = channelWith(dir, () => new Promise(() => {}), 3000);
  mock.timers.enable({ apis: ['setTimeout'] });
  const g = inbound({ chat: GROUP, id: 'G3', participant: ANNA, message: { conversation: 'hej' } });
  const done = makeOnMessage(allow(), () => {}, {}, () => {}, ch)(g.record, g.raw);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(lines(ch.inbox), [], 'the line waits for the receipt attempt');
  mock.timers.tick(2999);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(lines(ch.inbox), []);
  mock.timers.tick(1);
  await done;
  const [line] = lines(ch.inbox);
  assert.equal(line.receipt, 'failed');
});

test('receipt from WA_RECEIPT_EMOJI goes through the real sendReaction with the group participant', async () => {
  const dir = home();
  process.env.WA_CHANNEL_INBOX = path.join(dir, 'channel', 'inbox.jsonl');
  process.env.WA_RECEIPT_EMOJI = '👀';
  const { createdSockets } = await import('./fixtures/fake-baileys.js');
  await connect({ reconnect: false, onMessage: () => {} });
  const g = inbound({ chat: GROUP, id: 'G4', participant: ANNA, message: { conversation: 'hej' } });
  await makeOnMessage(allow())(g.record, g.raw);
  const react = createdSockets.at(-1).__sent.at(-1).content.react;
  assert.deepEqual(react, { text: '👀', key: { remoteJid: GROUP, id: 'G4', fromMe: false, participant: ANNA } });
  assert.equal(lines(process.env.WA_CHANNEL_INBOX)[0].receipt, 'placed');
});

// --- quote -------------------------------------------------------------------------------

test('send with quote goes out as a quoted reply; without quote nothing changes; the ack keeps its shape', async () => {
  const dir = home();
  const { createdSockets } = await import('./fixtures/fake-baileys.js');
  await connect({ reconnect: false, onMessage: () => {} });
  const sock = createdSockets.at(-1);
  await handleSendCommand({ type: 'send', jid: GROUP, nonce: 'q1', text: 'Ja', quote: { msgId: '3EB0ABC', participant: ANNA, text: 'Kan ni?' }, echoTimeoutMs: 500 }, loadConfig());
  const sent = sock.__sent.at(-1);
  assert.deepEqual(sent.options, { quoted: { key: { remoteJid: GROUP, id: '3EB0ABC', fromMe: false, participant: ANNA }, message: { conversation: 'Kan ni?' } } });
  await handleSendCommand({ type: 'send', jid: DM, nonce: 'q2', text: 'Nej', quote: { msgId: 'OWN1', fromMe: true }, echoTimeoutMs: 500 }, loadConfig());
  assert.deepEqual(sock.__sent.at(-1).options.quoted, { key: { remoteJid: DM, id: 'OWN1', fromMe: true }, message: { conversation: '' } });
  await handleSendCommand({ type: 'send', jid: DM, nonce: 'q3', text: 'plain', echoTimeoutMs: 500 }, loadConfig());
  assert.equal(sock.__sent.at(-1).options, undefined);
  await handleSendCommand({ type: 'send', jid: DM, nonce: 'q4', text: 'bad', quote: { participant: ANNA }, echoTimeoutMs: 50 }, loadConfig());
  const acks = lines(path.join(dir, 'inbox.jsonl')).filter((r) => r.type === 'send-ack');
  const [a1, , , a4] = acks;
  assert.deepEqual(Object.keys(a1).sort(), ['jid', 'msgId', 'nonce', 'ok', 'ts', 'type', 'verified']);
  assert.equal(a1.ok, true);
  assert.equal(a4.ok, false);
  assert.match(a4.error, /invalid quote/);
});

// --- typing ------------------------------------------------------------------------------

async function typingSetup() {
  const dir = home();
  const { createdSockets } = await import('./fixtures/fake-baileys.js');
  await connect({ reconnect: false, onMessage: () => {} });
  const sock = createdSockets.at(-1);
  const states = (jid) => sock.__presence.filter((p) => p.jid === jid).map((p) => p.state);
  const acks = () => lines(path.join(dir, 'inbox.jsonl')).filter((r) => r.type === 'send-ack');
  return { dir, sock, states, acks };
}
const flush = () => new Promise((r) => setImmediate(r));

test('typing is an outbox type, and is refused outside the allowlist or without canPost', async () => {
  assert.ok(OUTBOX_TYPES.has('typing'));
  home([{ jid: GROUP, name: 'G', canPost: false }]);
  await handleSendCommand({ type: 'typing', jid: GROUP, on: true, nonce: 't0' }, loadConfig());
  await handleSendCommand({ type: 'typing', jid: DM, on: true, nonce: 't0b' }, loadConfig());
  const acks = lines(path.join(process.env.WA_HOME, 'inbox.jsonl'));
  assert.match(acks[0].error, /canPost is false/);
  assert.match(acks[1].error, /not in allowlist/);
  assert.deepEqual(typingJids(), []);
});

test('typing on: composing, refreshed every 10 s; on:false sends paused and clears the timers', async () => {
  const { states, acks } = await typingSetup();
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  await handleSendCommand({ type: 'typing', jid: GROUP, on: true, nonce: 't1' }, loadConfig());
  assert.deepEqual(states(GROUP), ['composing']);
  assert.deepEqual(typingJids(), [GROUP]);
  mock.timers.tick(10000); await flush();
  mock.timers.tick(10000); await flush();
  assert.deepEqual(states(GROUP), ['composing', 'composing', 'composing']);
  await handleSendCommand({ type: 'typing', jid: GROUP, on: false, nonce: 't2' }, loadConfig());
  assert.deepEqual(states(GROUP).at(-1), 'paused');
  assert.deepEqual(typingJids(), []);
  mock.timers.tick(60000); await flush();
  assert.equal(states(GROUP).length, 4, 'no refresh after off');
  const [on, off] = acks();
  assert.equal(on.ok, true); assert.equal(on.typing, true); assert.equal(on.nonce, 't1');
  assert.equal(off.ok, true); assert.equal(off.typing, false);
});

test('typing on twice for one chat keeps one set of timers', async () => {
  const { states } = await typingSetup();
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  await handleSendCommand({ type: 'typing', jid: DM, on: true, nonce: 't3' }, loadConfig());
  await handleSendCommand({ type: 'typing', jid: DM, on: true, nonce: 't4' }, loadConfig());
  mock.timers.tick(10000); await flush();
  assert.deepEqual(states(DM), ['composing', 'composing', 'composing'], 'one refresh, not two');
  await handleSendCommand({ type: 'typing', jid: DM, on: false, nonce: 't5' }, loadConfig());
});

test('typing stops by itself after 180 s with paused', async () => {
  const { states } = await typingSetup();
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  await handleSendCommand({ type: 'typing', jid: GROUP, on: true, nonce: 't6' }, loadConfig());
  mock.timers.tick(179999); await flush();
  assert.deepEqual(typingJids(), [GROUP]);
  mock.timers.tick(1); await flush();
  assert.deepEqual(typingJids(), []);
  assert.equal(states(GROUP).at(-1), 'paused');
  const n = states(GROUP).length;
  mock.timers.tick(60000); await flush();
  assert.equal(states(GROUP).length, n);
});

test('a message sent to the chat stops typing there (paused before the message), not in other chats', async () => {
  const { sock, states } = await typingSetup();
  await handleSendCommand({ type: 'typing', jid: GROUP, on: true, nonce: 't7' }, loadConfig());
  await handleSendCommand({ type: 'typing', jid: DM, on: true, nonce: 't8' }, loadConfig());
  await handleSendCommand({ type: 'send', jid: GROUP, nonce: 's1', text: 'svar', echoTimeoutMs: 500 }, loadConfig());
  assert.deepEqual(states(GROUP), ['composing', 'paused']);
  assert.ok(sock.__sent.at(-1).content.text.endsWith('svar'));
  assert.deepEqual(typingJids(), [DM]);
  await handleSendCommand({ type: 'typing', jid: DM, on: false, nonce: 't9' }, loadConfig());
});

test('typing timers never keep the process alive', () => {
  const dir = home();
  const script = `
    import { connect } from ${JSON.stringify(path.join(__dirname, '..', 'src', 'wa-client.js'))};
    import { handleSendCommand } from ${JSON.stringify(path.join(__dirname, '..', 'src', 'daemon.js'))};
    import { loadConfig } from ${JSON.stringify(path.join(__dirname, '..', 'src', 'config.js'))};
    await connect({ reconnect: false, onMessage: () => {} });
    await handleSendCommand({ type: 'typing', jid: ${JSON.stringify(GROUP)}, on: true, nonce: 'x' }, loadConfig());
    console.log('typing started');
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, WA_HOME: dir, WA_CLIENT_FAKE: FAKE_BAILEYS_PATH },
    timeout: 8000,
    encoding: 'utf8',
  });
  assert.equal(r.error, undefined, `the process did not exit on its own: ${r.error}`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /typing started/);
});
