// Shared Baileys connection + the on-disk file protocol.
//
// This module owns the ONE WhatsApp socket the whole project is allowed to have
// open (Baileys refuses a second simultaneous connection against the same auth
// session) plus the JSONL files that let the stdio MCP server talk to whichever
// process actually holds that socket (the daemon).
//
// Only connect() touches Baileys or the network. Everything else here is plain file
// I/O with no top-level side effects, so importing this module is always safe --
// including from mcp-server.js, which must NEVER open its own Baileys connection.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pino from 'pino';
import { waHome } from './config.js';
import { useAtomicAuthState } from './atomic-auth.js';

const CHUNK_SIZE = 64 * 1024;
const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024; // 5MB
const RECONNECT_DELAY_MS = 2000;

export { waHome };

export function authDir() {
  return path.join(waHome(), 'auth');
}

export function inboxPath() {
  return path.join(waHome(), 'inbox.jsonl');
}

export function outboxPath() {
  return path.join(waHome(), 'outbox.jsonl');
}

export function cursorPath() {
  return path.join(waHome(), 'cursor.json');
}

export function daemonLogPath() {
  return path.join(waHome(), 'daemon.log');
}

export function baileysLogPath() {
  return path.join(waHome(), 'baileys.log');
}

/**
 * Creates ~/.whatsapp-assistant (and its auth/ subdirectory) with owner-only
 * permissions. Auth keys and message history live only here, never in the repo.
 */
export function ensureWaHome() {
  const home = waHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(home, 0o700);
  } catch {
    // best-effort on filesystems that don't support chmod
  }
  fs.mkdirSync(authDir(), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(authDir(), 0o700);
  } catch {
    // same as above
  }
}

function appendJsonLine(filePath, obj) {
  ensureWaHome();
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', { mode: 0o600 });
}

/** Appends one message/ack record as a JSON line to inbox.jsonl. */
export function appendInbox(record) {
  appendJsonLine(inboxPath(), record);
}

/** Appends one send command as a JSON line to outbox.jsonl. */
export function appendOutboxCommand(cmd) {
  appendJsonLine(outboxPath(), cmd);
}

/**
 * Parses complete JSON lines out of `lines`, returning up to `limit` records
 * matching `predicate`, walked from the end backwards and returned in ascending
 * (oldest-first) order. Malformed or blank lines are skipped rather than thrown on.
 */
function linesToRecords(lines, limit, predicate) {
  const matches = [];
  for (let i = lines.length - 1; i >= 0 && matches.length < limit; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (predicate(record)) matches.unshift(record);
  }
  return matches;
}

/**
 * Returns up to `limit` records matching `predicate` from the END of a JSONL file,
 * in chronological order. Files at or under 5MB are read whole (simple, and fast
 * enough); larger files are read backwards in fixed-size chunks so a huge inbox
 * never gets fully loaded into memory just to answer "give me the last 30".
 */
export function tailJsonLines(filePath, limit, predicate = () => true) {
  if (!fs.existsSync(filePath)) return [];
  const stat = fs.statSync(filePath);
  if (stat.size === 0) return [];

  if (stat.size <= LARGE_FILE_THRESHOLD) {
    const content = fs.readFileSync(filePath, 'utf8');
    return linesToRecords(content.split('\n'), limit, predicate);
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    let position = stat.size;
    let pending = '';
    let confirmedLines = [];
    let result = [];

    while (position > 0) {
      const readSize = Math.min(CHUNK_SIZE, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      fs.readSync(fd, chunk, 0, readSize, position);
      pending = chunk.toString('utf8') + pending;

      const parts = pending.split('\n');
      pending = position > 0 ? parts.shift() : '';
      confirmedLines = parts.concat(confirmedLines);

      result = linesToRecords(confirmedLines, limit, predicate);
      if (result.length >= limit) break;
    }
    return result;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Reads whatever complete JSON lines were appended to `filePath` after byte
 * `offset`. A trailing partial line (a write still in flight) is left unread and
 * excluded from the returned offset, so the caller never skips it on the next call.
 * Generic enough to drive both inbox polling (mcp-server, persisted cursor) and
 * outbox watching (daemon, in-memory offset).
 */
export function readNewLines(filePath, offset) {
  if (!fs.existsSync(filePath)) return { entries: [], newOffset: offset };
  const stat = fs.statSync(filePath);
  let start = offset;
  if (start > stat.size || start < 0) start = 0; // file was rotated/truncated; restart defensively

  if (start >= stat.size) return { entries: [], newOffset: start };

  const fd = fs.openSync(filePath, 'r');
  let buf;
  try {
    const len = stat.size - start;
    buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
  } finally {
    fs.closeSync(fd);
  }

  const lastNewline = buf.lastIndexOf(0x0a); // '\n', byte-exact even with multi-byte UTF-8 text
  if (lastNewline === -1) return { entries: [], newOffset: start };

  const text = buf.subarray(0, lastNewline).toString('utf8');
  const newOffset = start + lastNewline + 1;

  const entries = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // skip malformed line rather than lose the whole batch
    }
  }
  return { entries, newOffset };
}

/** Last N inbox.jsonl messages for one chat, oldest first. */
export function readMessages(jid, limit = 30) {
  return tailJsonLines(inboxPath(), limit, (record) => record.chatJid === jid);
}

function extractText(message) {
  if (!message) return '[unknown]';
  if (typeof message.conversation === 'string') return message.conversation;
  if (typeof message.extendedTextMessage?.text === 'string') return message.extendedTextMessage.text;
  if (message.imageMessage) return message.imageMessage.caption ? message.imageMessage.caption : '[image]';
  if (message.videoMessage) return message.videoMessage.caption ? message.videoMessage.caption : '[video]';
  if (message.documentMessage) {
    const name = message.documentMessage.fileName;
    return name ? `[document: ${name}]` : '[document]';
  }
  if (message.audioMessage) return message.audioMessage.ptt ? '[voice note]' : '[audio]';
  if (message.stickerMessage) return '[sticker]';
  if (message.contactMessage) return '[contact]';
  if (message.locationMessage) return '[location]';
  if (message.reactionMessage) return '[reaction]';
  const [type] = Object.keys(message);
  return type ? `[${type}]` : '[unknown]';
}

let sockRef = null;
const chatCache = new Map();

function upsertChat(chat) {
  if (!chat || !chat.id) return;
  const prev = chatCache.get(chat.id) || { jid: chat.id, name: null };
  const name = chat.name || chat.subject || prev.name || null;
  chatCache.set(chat.id, { jid: chat.id, name });
}

function upsertContactName(contact) {
  if (!contact || !contact.id) return;
  const prev = chatCache.get(contact.id) || { jid: contact.id, name: null };
  const name = contact.name || contact.notify || contact.verifiedName || prev.name || null;
  chatCache.set(contact.id, { jid: contact.id, name });
}

function extractMessageRecords(payload) {
  const out = [];
  for (const m of payload?.messages || []) {
    if (!m.message || !m.key) continue; // e.g. protocol-only entries (reactions, receipts)
    const chatJid = m.key.remoteJid;
    if (!chatJid) continue;
    const fromMe = !!m.key.fromMe;
    const senderJid = fromMe ? sockRef?.user?.id || chatJid : m.key.participant || chatJid;
    const cached = chatCache.get(chatJid);
    out.push({
      ts: Date.now(),
      chatJid,
      chatName: cached?.name || null,
      senderJid,
      senderName: m.pushName || cached?.name || null,
      fromMe,
      text: extractText(m.message),
      msgId: m.key.id || null,
    });
  }
  return out;
}

/**
 * Loads the makeWASocket module. Set WA_CLIENT_FAKE to the path of a module
 * exporting the same shape (default export = socket factory, plus
 * useMultiFileAuthState/DisconnectReason named exports) to run against a stub
 * instead of a real WhatsApp connection -- this is how the test suite proves the
 * message/allowlist/outbox logic without ever touching the network.
 */
async function loadBaileysModule() {
  if (process.env.WA_CLIENT_FAKE) {
    const fakePath = path.resolve(process.env.WA_CLIENT_FAKE);
    return import(pathToFileURL(fakePath).href);
  }
  return import('@whiskeysockets/baileys');
}

/**
 * Returns the currently known chats (jid + best-known name), built up from
 * chats.upsert / chats.update / contacts.upsert events seen since the process
 * started. Empty before a connection has synced anything.
 */
export function listChats() {
  return [...chatCache.values()];
}

/** Sends a text message through the live connection. Throws if nothing is connected. */
export async function sendText(jid, text) {
  if (!sockRef) {
    throw new Error('No active WhatsApp connection. sendText() must run inside the daemon process.');
  }
  const result = await sockRef.sendMessage(jid, { text });
  return result?.key?.id || null;
}

/** Sends a document from a local file path. Caption is optional. Same one-connection
 *  rule as sendText: only the daemon process may call this. */
export async function sendDocument(jid, filePath, fileName, caption) {
  if (!sockRef) {
    throw new Error('No active WhatsApp connection. sendDocument() must run inside the daemon process.');
  }
  const buffer = fs.readFileSync(filePath);
  const result = await sockRef.sendMessage(jid, {
    document: buffer,
    mimetype: fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
    fileName,
    ...(caption ? { caption } : {}),
  });
  return result?.key?.id || null;
}

/**
 * Establishes the one shared Baileys connection.
 *
 * Resolves once the connection first reaches "open", with `{ sock, jid }`. From then
 * on the module keeps a reconnect loop running in the background (unless
 * `reconnect: false`) -- callers never see individual reconnects, they just keep
 * calling sendText()/listChats() against whatever socket is currently live.
 *
 * `onLoggedOut` fires any time a close is caused by an invalidated session
 * (DisconnectReason.loggedOut), whether that happens before or long after the
 * initial open -- reconnecting after a real logout would just spin forever
 * presenting dead QR codes, so the loop stops and the caller decides what to do
 * (typically: exit and tell the operator to re-pair).
 */
// Exactly ONE process may hold the Baileys auth session — two concurrent
// sockets on one auth dir corrupt creds.json (observed live: an empty file
// after a pair ghost raced a one-off). Atomic mkdir is the lock; a stale
// holder (dead pid) is taken over.
import { mkdirSync, rmSync } from 'node:fs';
export function acquireSessionLock() {
  const lockDir = path.join(waHome(), 'session.lock');
  const pidFile = path.join(lockDir, 'pid');
  try {
    mkdirSync(lockDir);
  } catch {
    let holder = 0;
    try { holder = parseInt(fs.readFileSync(pidFile, 'utf8'), 10); } catch { /* unreadable */ }
    let alive = false;
    if (holder > 0) { try { process.kill(holder, 0); alive = true; } catch { alive = false; } }
    if (alive) throw new Error(`Another WhatsApp process (pid ${holder}) holds the session — refusing a second connection on one auth.`);
    try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* already gone */ }
    mkdirSync(lockDir);
  }
  fs.writeFileSync(pidFile, String(process.pid));
  const release = () => { try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* gone */ } };
  process.on('exit', release);
  return release;
}

export async function connect(opts = {}) {
  const {
    reconnect = true,
    phoneNumber = null,
    onMessage = () => {},
    onQr = () => {},
    onPairingCode = () => {},
    onConnection = () => {},
    onLoggedOut = () => {},
  } = opts;

  ensureWaHome();
  acquireSessionLock();
  const baileys = await loadBaileysModule();
  const makeWASocket = baileys.default;
  const { DisconnectReason } = baileys;

  // Baileys is chatty by default; this keeps it off stdout/stderr (which would
  // corrupt the MCP stdio protocol and clutter a daemon's terminal) and into a file
  // instead, so it's silenced from the console without being thrown away. Written
  // synchronously: ensureWaHome() above already created the directory, so there's
  // no async mkdir/open to race against, and a background daemon shutting down on
  // SIGTERM must not depend on a log stream finishing an async flush first.
  const logger = pino({ level: 'info' }, pino.destination({ dest: baileysLogPath(), sync: true }));

  const { state, saveCreds } = await useAtomicAuthState(authDir(), baileys);
  // Registration is wa-pair's exclusive privilege: any other entry point that
  // finds unregistered creds must STOP — a blind re-registration attempt is
  // what invalidates the phone link when state was lost or torn.
  if (!phoneNumber && state.creds?.registered !== true) {
    const err = new Error("Not paired (creds absent or unregistered). Run 'node src/pair.js --code <number>' first.");
    err.loggedOut = true;
    throw err;
  }
  let pairingRequested = false;
  const MAX_PROTOCOL_RESTARTS = 3;
  let protocolRestarts = 0;

  return new Promise((resolve, reject) => {
    let settled = false;

    const startSocket = () => {
      const sock = makeWASocket({
        auth: state,
        logger,
        markOnlineOnConnect: false,
        // The pairing-code flow (requestPairingCode) is only served to a real
        // desktop-browser signature; the library default is rejected with an
        // immediate close. Applied ONLY for phone-number pairing.
        ...(phoneNumber ? { browser: baileys.Browsers.ubuntu('Chrome') } : {}),
      });
      sockRef = sock;

      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('chats.upsert', (chats) => {
        for (const c of chats || []) upsertChat(c);
      });
      sock.ev.on('chats.update', (updates) => {
        for (const c of updates || []) upsertChat(c);
      });
      sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of contacts || []) upsertContactName(c);
      });

      sock.ev.on('messages.upsert', (payload) => {
        for (const record of extractMessageRecords(payload)) {
          try {
            onMessage(record);
          } catch {
            // A handler bug must never take down the connection loop.
          }
        }
      });

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) onQr(qr);

        if (phoneNumber && qr && !pairingRequested && state.creds?.registered !== true) {
          pairingRequested = true;
          try {
            const pairingCode = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
            onPairingCode(pairingCode);
          } catch (err) {
            if (!settled) {
              settled = true;
              reject(err);
            }
            return;
          }
        }

        if (connection === 'open') {
          onConnection(update);
          if (!settled) {
            settled = true;
            resolve({ sock, jid: sock.user?.id || state.creds?.me?.id || null });
          }
        } else if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const loggedOut = statusCode === DisconnectReason?.loggedOut;
          onConnection(update);

          if (loggedOut) {
            const err = new Error('WhatsApp session logged out. Delete the auth directory and run wa-pair again.');
            err.loggedOut = true;
            onLoggedOut(err);
            if (!settled) {
              settled = true;
              reject(err);
            }
            return;
          }

          // A close carrying restartRequired — or any close right after the
          // pairing was configured (creds now registered) — is the PROTOCOL's
          // own "reconnect now", not a failure: Baileys logs "pairing
          // configured successfully, expect to restart the connection". Honour
          // it even in one-shot (pair) mode, bounded so a genuine flap cannot
          // loop forever.
          const restartRequired = statusCode === DisconnectReason?.restartRequired
            || (state.creds?.registered === true && !settled);
          if (restartRequired && protocolRestarts < MAX_PROTOCOL_RESTARTS) {
            protocolRestarts += 1;
            setTimeout(startSocket, RECONNECT_DELAY_MS);
          } else if (reconnect) {
            setTimeout(startSocket, RECONNECT_DELAY_MS);
          } else if (!settled) {
            settled = true;
            reject(new Error('Connection closed before the initial handshake completed.'));
          }
        }
      });
    };

    startSocket();
  });
}
