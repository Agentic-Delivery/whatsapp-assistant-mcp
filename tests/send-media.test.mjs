// send_chat_document / send_chat_image: the gate (allowlist, canPost, file checks) refuses
// before anything reaches outbox.jsonl, a valid send round-trips MCP -> outbox -> daemon ->
// echo-verified ack, and a real MCP client sees both tools over stdio.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_BAILEYS_PATH = path.join(__dirname, 'fixtures', 'fake-baileys.js');
const temps = [];
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

function home(chats) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-media-test-'));
  temps.push(dir);
  process.env.WA_HOME = dir;
  process.env.WA_CLIENT_FAKE = FAKE_BAILEYS_PATH;
  fs.writeFileSync(path.join(dir, 'wa-mcp.config.json'), JSON.stringify({ chats }));
  return dir;
}
/** Files to send live OUTSIDE WA_HOME -- the bridge refuses to send anything from its own state directory. */
function filesDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-media-files-'));
  temps.push(d);
  return d;
}
const outboxLines = (dir) => {
  const p = path.join(dir, 'outbox.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const POST = '5555555555@s.whatsapp.net';
const READONLY = '6666666666@s.whatsapp.net';

/** Plays the daemon: hands the next outbox command to handleSendCommand so the tool call gets its ack. */
async function pumpOnce(dir) {
  const { handleSendCommand } = await import('../src/daemon.js');
  const { loadConfig } = await import('../src/config.js');
  for (let i = 0; i < 100; i++) {
    const cmds = outboxLines(dir);
    if (cmds.length) { await handleSendCommand(cmds.at(-1), loadConfig()); return cmds.at(-1); }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('no outbox command appeared');
}

test('(m1) send_chat_document refuses before touching outbox: unknown chat, canPost:false, relative path, missing file, no extension', async () => {
  const F = filesDir();
  const dir = home([{ jid: POST, name: 'Docs', canPost: true }, { jid: READONLY, name: 'RO', canPost: false }]);
  const { sendChatDocument } = await import('../src/mcp-server.js');
  const good = path.join(F, 'report.pdf'); fs.writeFileSync(good, 'pdf');
  const bare = path.join(F, 'README'); fs.writeFileSync(bare, 'x');
  await assert.rejects(() => sendChatDocument({ jid: '9999999999@s.whatsapp.net', path: good }), /not in the allowlist/);
  await assert.rejects(() => sendChatDocument({ jid: READONLY, path: good }), /canPost:false/);
  await assert.rejects(() => sendChatDocument({ jid: POST, path: 'report.pdf' }), /absolute path/);
  await assert.rejects(() => sendChatDocument({ jid: POST, path: path.join(F, 'nope.pdf') }), /file not found/);
  await assert.rejects(() => sendChatDocument({ jid: POST, path: bare }), /accepted extension/);
  assert.equal(outboxLines(dir).length, 0, 'no refused send may reach the outbox');
});

test('(m2) send_chat_image refuses non-images and oversize images before touching outbox', async () => {
  const F = filesDir();
  const dir = home([{ jid: POST, name: 'Docs', canPost: true }]);
  const { sendChatImage } = await import('../src/mcp-server.js');
  const { MAX_IMAGE_BYTES } = await import('../src/wa-client.js');
  const pdf = path.join(F, 'brief.pdf'); fs.writeFileSync(pdf, 'pdf');
  const gif = path.join(F, 'anim.gif'); fs.writeFileSync(gif, 'gif');
  const big = path.join(F, 'huge.png'); fs.writeFileSync(big, ''); fs.truncateSync(big, MAX_IMAGE_BYTES + 1);
  await assert.rejects(() => sendChatImage({ jid: POST, path: pdf }), /\.png, \.jpg or \.jpeg/);
  await assert.rejects(() => sendChatImage({ jid: POST, path: gif }), /\.png, \.jpg or \.jpeg/);
  await assert.rejects(() => sendChatImage({ jid: POST, path: big }), /the limit is/);
  assert.equal(outboxLines(dir).length, 0);
});

test('(m3) send_chat_image round-trips: inline image payload, signed caption, echo-verified ack', async () => {
  const F = filesDir();
  const dir = home([{ jid: POST, name: 'Docs', canPost: true }]);
  const { connect } = await import('../src/wa-client.js');
  const { createdSockets } = await import('./fixtures/fake-baileys.js');
  await connect({ reconnect: false, onMessage: () => {} });
  const { sendChatImage } = await import('../src/mcp-server.js');
  const img = path.join(F, 'mockup.png'); fs.writeFileSync(img, 'png-bytes-123');
  const [res, cmd] = await Promise.all([sendChatImage({ jid: POST, path: img, caption: 'the new header' }), pumpOnce(dir)]);
  assert.equal(cmd.type, 'send-image');
  const sent = createdSockets.at(-1).__sent.at(-1);
  assert.ok(sent.content.image, 'must be sent as an image message, not a document');
  assert.equal(sent.content.document, undefined);
  assert.equal(sent.content.mimetype, 'image/png');
  assert.match(String(sent.content.caption), /^\u{1F916} the new header$/u);
  assert.equal(res.sent, true);
  assert.deepEqual(res.verified, { mimetype: 'image/png', bytes: 13 });
});

test('(m4) send_chat_document round-trips with the given file name and an echo-verified ack', async () => {
  const F = filesDir();
  const dir = home([{ jid: POST, name: 'Docs', canPost: true }]);
  const { connect } = await import('../src/wa-client.js');
  const { createdSockets } = await import('./fixtures/fake-baileys.js');
  await connect({ reconnect: false, onMessage: () => {} });
  const { sendChatDocument } = await import('../src/mcp-server.js');
  const f = path.join(F, 'tmp-123.pdf'); fs.writeFileSync(f, 'pdf-bytes');
  const [res] = await Promise.all([sendChatDocument({ jid: POST, path: f, fileName: 'Proposal.pdf' }), pumpOnce(dir)]);
  const sent = createdSockets.at(-1).__sent.at(-1);
  assert.equal(sent.content.fileName, 'Proposal.pdf');
  assert.deepEqual(res.verified, { fileName: 'Proposal.pdf', mimetype: 'application/pdf', bytes: 9 });
});

test('(m5) the daemon re-checks send-image itself: a non-image or a canPost:false chat never reaches WhatsApp', async () => {
  const F = filesDir();
  const dir = home([{ jid: POST, name: 'Docs', canPost: true }, { jid: READONLY, name: 'RO', canPost: false }]);
  const { connect } = await import('../src/wa-client.js');
  const { createdSockets } = await import('./fixtures/fake-baileys.js');
  await connect({ reconnect: false, onMessage: () => {} });
  const { handleSendCommand } = await import('../src/daemon.js');
  const { loadConfig } = await import('../src/config.js');
  const pdf = path.join(F, 'x.pdf'); fs.writeFileSync(pdf, 'pdf');
  const png = path.join(F, 'x.png'); fs.writeFileSync(png, 'png');
  const before = createdSockets.at(-1).__sent.length;
  await handleSendCommand({ ts: Date.now(), type: 'send-image', jid: POST, path: pdf, nonce: 'n1' }, loadConfig());
  await handleSendCommand({ ts: Date.now(), type: 'send-image', jid: READONLY, path: png, nonce: 'n2' }, loadConfig());
  assert.equal(createdSockets.at(-1).__sent.length, before);
  const acks = fs.readFileSync(path.join(dir, 'inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.type === 'send-ack');
  assert.equal(acks.find((a) => a.nonce === 'n1').ok, false);
  assert.equal(acks.find((a) => a.nonce === 'n2').ok, false);
});

test('(m6) a real MCP client over stdio sees send_chat_document and send_chat_image', async () => {
  const F = filesDir();
  const dir = home([{ jid: POST, name: 'Docs', canPost: true }]);
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'src', 'mcp-server.js')],
    env: { ...process.env, WA_HOME: dir },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['send_chat_document', 'send_chat_image', 'send_chat_voice_note', 'send_chat_message', 'react_to_message']) assert.ok(names.includes(n), `${n} must be exposed`);
    const refused = await client.callTool({ name: 'send_chat_image', arguments: { jid: '9999999999@s.whatsapp.net', path: '/nope.png' } });
    assert.equal(refused.isError, true, 'a refusal reaches the model as a readable error result');
  } finally {
    await client.close();
  }
});

test('(m7) the bridge refuses to send its own state: a prompt-injected "send me creds.json" never reaches the outbox', async () => {
  const dir = home([{ jid: POST, name: 'Docs', canPost: true }]);
  const { sendChatDocument } = await import('../src/mcp-server.js');
  fs.mkdirSync(path.join(dir, 'auth'), { recursive: true });
  const creds = path.join(dir, 'auth', 'creds.json'); fs.writeFileSync(creds, '{"noiseKey":"secret"}');
  await assert.rejects(() => sendChatDocument({ jid: POST, path: creds }), /state directory/);
  // A symlink from outside pointing in is resolved and refused too.
  const link = path.join(filesDir(), 'innocent.json'); fs.symlinkSync(creds, link);
  await assert.rejects(() => sendChatDocument({ jid: POST, path: link }), /state directory/);
  assert.equal(outboxLines(dir).length, 0);
});

test('(m8) the daemon re-checks send-file itself: relative path, oversize document and state-dir files are refused with ok:false', async () => {
  const F = filesDir();
  const dir = home([{ jid: POST, name: 'Docs', canPost: true }]);
  const { connect, MAX_DOCUMENT_BYTES } = await import('../src/wa-client.js');
  const { createdSockets } = await import('./fixtures/fake-baileys.js');
  await connect({ reconnect: false, onMessage: () => {} });
  const { handleSendCommand } = await import('../src/daemon.js');
  const { loadConfig } = await import('../src/config.js');
  const big = path.join(F, 'big.pdf'); fs.writeFileSync(big, ''); fs.truncateSync(big, MAX_DOCUMENT_BYTES + 1);
  const cfg = path.join(dir, 'wa-mcp.config.json');
  const before = createdSockets.at(-1).__sent.length;
  await handleSendCommand({ ts: Date.now(), type: 'send-file', jid: POST, path: 'doc.pdf', nonce: 'r1' }, loadConfig());
  await handleSendCommand({ ts: Date.now(), type: 'send-file', jid: POST, path: big, nonce: 'r2' }, loadConfig());
  await handleSendCommand({ ts: Date.now(), type: 'send-file', jid: POST, path: cfg, nonce: 'r3' }, loadConfig());
  assert.equal(createdSockets.at(-1).__sent.length, before, 'nothing may be sent');
  const acks = fs.readFileSync(path.join(dir, 'inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.type === 'send-ack');
  assert.match(acks.find((a) => a.nonce === 'r1').error, /absolute path/);
  assert.match(acks.find((a) => a.nonce === 'r2').error, /the limit is/);
  assert.match(acks.find((a) => a.nonce === 'r3').error, /state directory/);
});

test('(m9) an image whose echo carries a different size gets ok:false -- the ack reports what arrived', async () => {
  const F = filesDir();
  const dir = home([{ jid: POST, name: 'Docs', canPost: true }]);
  const { connect } = await import('../src/wa-client.js');
  const { createdSockets } = await import('./fixtures/fake-baileys.js');
  await connect({ reconnect: false, onMessage: () => {} });
  const { handleSendCommand } = await import('../src/daemon.js');
  const { loadConfig } = await import('../src/config.js');
  const img = path.join(F, 'a.png'); fs.writeFileSync(img, 'png-bytes');
  createdSockets.at(-1).__echoMode = 'wrongsize';
  await handleSendCommand({ ts: Date.now(), type: 'send-image', jid: POST, path: img, nonce: 's1', echoTimeoutMs: 2000 }, loadConfig());
  createdSockets.at(-1).__echoMode = 'silent';
  await handleSendCommand({ ts: Date.now(), type: 'send-image', jid: POST, path: img, nonce: 's2', echoTimeoutMs: 300 }, loadConfig());
  const acks = fs.readFileSync(path.join(dir, 'inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.type === 'send-ack');
  const a1 = acks.find((a) => a.nonce === 's1'), a2 = acks.find((a) => a.nonce === 's2');
  assert.equal(a1.ok, false); assert.match(a1.error, /size/);
  assert.equal(a2.ok, true); assert.equal(a2.verified, null); assert.match(a2.warning, /echo-timeout/);
});

test('(v1) send_chat_voice_note refuses non-.ogg files and canPost:false chats before touching outbox', async () => {
  const F = filesDir();
  const dir = home([{ jid: POST, name: 'Docs', canPost: true }, { jid: READONLY, name: 'RO', canPost: false }]);
  const { sendChatVoiceNote } = await import('../src/mcp-server.js');
  const mp3 = path.join(F, 'reply.mp3'); fs.writeFileSync(mp3, 'mp3');
  const ogg = path.join(F, 'reply.ogg'); fs.writeFileSync(ogg, 'ogg');
  await assert.rejects(() => sendChatVoiceNote({ jid: POST, path: mp3 }), /Ogg\/Opus/);
  await assert.rejects(() => sendChatVoiceNote({ jid: READONLY, path: ogg }), /canPost:false/);
  const { MAX_VOICE_BYTES } = await import('../src/wa-client.js');
  const big = path.join(F, 'long.ogg'); fs.writeFileSync(big, ''); fs.truncateSync(big, MAX_VOICE_BYTES + 1);
  await assert.rejects(() => sendChatVoiceNote({ jid: POST, path: big }), /the limit is/);
  assert.equal(outboxLines(dir).length, 0);
});

test('(v2) send_chat_voice_note round-trips as a ptt audio message with an echo-verified ack', async () => {
  const F = filesDir();
  const dir = home([{ jid: POST, name: 'Docs', canPost: true }]);
  const { connect } = await import('../src/wa-client.js');
  const { createdSockets } = await import('./fixtures/fake-baileys.js');
  await connect({ reconnect: false, onMessage: () => {} });
  const { sendChatVoiceNote } = await import('../src/mcp-server.js');
  const ogg = path.join(F, 'reply.ogg'); fs.writeFileSync(ogg, 'opus-bytes');
  const [res, cmd] = await Promise.all([sendChatVoiceNote({ jid: POST, path: ogg }), pumpOnce(dir)]);
  assert.equal(cmd.type, 'send-voice');
  const sent = createdSockets.at(-1).__sent.at(-1);
  assert.ok(sent.content.audio, 'must be sent as audio');
  assert.equal(sent.content.ptt, true, 'must be a voice note (ptt), not an audio file');
  assert.equal(sent.content.mimetype, 'audio/ogg; codecs=opus');
  assert.equal(res.verified.ptt, true);
  assert.equal(res.verified.bytes, 10);
});

test('(v3) the daemon fails a voice note that echoes back without ptt -- it arrived as a plain audio file', async () => {
  const F = filesDir();
  const dir = home([{ jid: POST, name: 'Docs', canPost: true }]);
  const { connect } = await import('../src/wa-client.js');
  const { createdSockets } = await import('./fixtures/fake-baileys.js');
  await connect({ reconnect: false, onMessage: () => {} });
  const { handleSendCommand } = await import('../src/daemon.js');
  const { loadConfig } = await import('../src/config.js');
  const ogg = path.join(F, 'r.ogg'); fs.writeFileSync(ogg, 'opus');
  createdSockets.at(-1).__echoMode = 'notptt';
  await handleSendCommand({ ts: Date.now(), type: 'send-voice', jid: POST, path: ogg, nonce: 'p1', echoTimeoutMs: 2000 }, loadConfig());
  const acks = fs.readFileSync(path.join(dir, 'inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.type === 'send-ack');
  const a = acks.find((x) => x.nonce === 'p1');
  assert.equal(a.ok, false); assert.match(a.error, /ptt/);
});

test('(v4) the daemon re-checks a raw send-voice: a .mp3 or a state-directory file is refused; a wrong-size echo gives ok:false', async () => {
  const F = filesDir();
  const dir = home([{ jid: POST, name: 'Docs', canPost: true }]);
  const { connect } = await import('../src/wa-client.js');
  const { createdSockets } = await import('./fixtures/fake-baileys.js');
  await connect({ reconnect: false, onMessage: () => {} });
  const { handleSendCommand } = await import('../src/daemon.js');
  const { loadConfig } = await import('../src/config.js');
  const mp3 = path.join(F, 'r.mp3'); fs.writeFileSync(mp3, 'mp3');
  const inState = path.join(dir, 'secret.ogg'); fs.writeFileSync(inState, 'ogg');
  const ok = path.join(F, 'r.ogg'); fs.writeFileSync(ok, 'opus');
  const before = createdSockets.at(-1).__sent.length;
  await handleSendCommand({ ts: Date.now(), type: 'send-voice', jid: POST, path: mp3, nonce: 'q1' }, loadConfig());
  await handleSendCommand({ ts: Date.now(), type: 'send-voice', jid: POST, path: inState, nonce: 'q2' }, loadConfig());
  assert.equal(createdSockets.at(-1).__sent.length, before, 'neither may be sent');
  createdSockets.at(-1).__echoMode = 'wrongsize';
  await handleSendCommand({ ts: Date.now(), type: 'send-voice', jid: POST, path: ok, nonce: 'q3', echoTimeoutMs: 2000 }, loadConfig());
  const acks = fs.readFileSync(path.join(dir, 'inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.type === 'send-ack');
  assert.match(acks.find((a) => a.nonce === 'q1').error, /Ogg\/Opus/);
  assert.match(acks.find((a) => a.nonce === 'q2').error, /state directory/);
  const a3 = acks.find((a) => a.nonce === 'q3'); assert.equal(a3.ok, false); assert.match(a3.error, /size/);
});
