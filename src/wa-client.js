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

/**
 * Download an incoming document attachment to destDir. Transport only — the CALLER
 * (the daemon) owns the allowlist decision; this must never be reached for a chat
 * that is not stored. Size-capped and filename-sanitized: the name is untrusted
 * remote input. Returns { path, filename, bytes } or { skipped } — never throws
 * into the connection loop.
 */
const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const VIDEO_EXT = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/3gpp': '3gp' };
const AUDIO_EXT = { 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/amr': 'amr', 'audio/webm': 'webm' };
const EXT_BY_KIND = { image: IMAGE_EXT, video: VIDEO_EXT, audio: AUDIO_EXT };
/** "audio/ogg; codecs=opus" -> "audio/ogg": WhatsApp mimetypes may carry parameters. */
function baseMimetype(mt) {
  return String(mt || '').split(';')[0].trim().toLowerCase();
}

/**
 * WhatsApp wraps some messages in an envelope whose real content sits one level
 * down in `.message`: a document sent WITH a caption arrives as
 * documentWithCaptionMessage, disappearing/view-once messages as
 * ephemeralMessage / viewOnceMessage*, edits as editedMessage. Without
 * unwrapping, the first key seen is often messageContextInfo and the record
 * is stored as "[messageContextInfo]" — a file a founder sent, silently lost.
 */
const WRAPPER_KEYS = ['documentWithCaptionMessage', 'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'editedMessage'];
export function unwrapMessage(message) {
  let m = message;
  for (let i = 0; i < 4 && m; i++) {
    const k = WRAPPER_KEYS.find((w) => m[w]?.message);
    if (!k) break;
    m = m[k].message;
  }
  return m;
}

/** The media part of a raw message we save: documents, images and videos (not audio/stickers). */
export function mediaPart(rawMsg) {
  const m = unwrapMessage(rawMsg?.message);
  if (m?.documentMessage) return { kind: 'document', part: m.documentMessage };
  if (m?.imageMessage) return { kind: 'image', part: m.imageMessage };
  if (m?.videoMessage) return { kind: 'video', part: m.videoMessage };
  // Voice notes (ptt) and audio files: saved so an agent can transcribe what was said.
  if (m?.audioMessage) return { kind: 'audio', part: m.audioMessage };
  return null;
}

/** Local file name for a saved media part. A document keeps its (sanitized, untrusted) name; images, videos and
 *  audio get kind.ext, and a voice note (ptt) is named voice-note.ext. */
export function mediaFilename(kind, part) {
  if (kind === 'document') return path.basename(String(part.fileName || 'document')).replace(/[^\w.\-]/g, '_').slice(0, 120) || 'document';
  const ext = EXT_BY_KIND[kind]?.[baseMimetype(part.mimetype)] || 'bin';
  const stem = kind === 'audio' && part.ptt ? 'voice-note' : kind;
  return `${stem}.${ext}`;
}

/**
 * Deletes saved voice notes in <downloads>/voice-notes/ (only files named <timestamp>-voice-note.<audio ext>;
 * transcripts, links, folders and every other download are kept):
 * first those older than voiceNoteDays, then the oldest until the rest fit in voiceNoteMaxMB. Returns what it did.
 */
export const VOICE_NOTE_DIR = 'voice-notes';
const VOICE_NOTE_NAME = /^\d+-voice-note\.(ogg|mp3|m4a|aac|wav|amr|webm|bin)$/i;

export function pruneVoiceNotes(downloadsDir, { voiceNoteDays = null, voiceNoteMaxMB = null } = {}, now = Date.now()) {
  const dir = path.join(downloadsDir, VOICE_NOTE_DIR);
  if (!fs.existsSync(dir) || (voiceNoteDays === null && voiceNoteMaxMB === null)) return { deleted: [], kept: 0, bytes: 0 };
  const files = [];
  for (const n of fs.readdirSync(dir)) {
    if (!VOICE_NOTE_NAME.test(n)) continue; // transcripts (*.txt, *.srt, ...) and anything else stay
    try {
      const p = path.join(dir, n);
      const st = fs.lstatSync(p);
      if (st.isFile()) files.push({ p, mtime: st.mtimeMs, size: st.size }); // never follow or delete links/dirs
    } catch { /* vanished or unreadable: skip, never stop the whole run */ }
  }
  files.sort((a, b) => a.mtime - b.mtime);
  const deleted = [];
  let keep = files;
  if (voiceNoteDays !== null) {
    const cutoff = now - voiceNoteDays * 86400000;
    deleted.push(...keep.filter((f) => f.mtime < cutoff));
    keep = keep.filter((f) => f.mtime >= cutoff);
  }
  let bytes = keep.reduce((t, f) => t + f.size, 0);
  if (voiceNoteMaxMB !== null) {
    while (keep.length && bytes > voiceNoteMaxMB * 1024 * 1024) { const f = keep.shift(); bytes -= f.size; deleted.push(f); }
  }
  const removed = [];
  for (const f of deleted) {
    try { fs.rmSync(f.p); removed.push(path.basename(f.p)); } catch { /* not removed: not reported as deleted */ }
  }
  return { deleted: removed, kept: keep.length, bytes };
}

/** Single gate for "should this message's media be saved" — the daemon must use this, never inspect message keys itself. */
export function hasSavableMedia(rawMsg) {
  return !!mediaPart(rawMsg);
}

export async function downloadDocument(rawMsg, destDir, maxBytes) {
  const mp = mediaPart(rawMsg);
  if (!mp) return { skipped: 'not-a-document' };
  const { kind, part } = mp;
  if (maxBytes === undefined) maxBytes = (kind === 'video' ? 200 : 25) * 1024 * 1024;
  const declared = Number(part.fileLength || 0);
  if (declared > maxBytes) return { skipped: `too-large:${declared}` };
  const base = mediaFilename(kind, part);
  // Voice notes get their own folder: retention prunes only there, so no other download can ever match it.
  const dir = kind === 'audio' && part.ptt ? path.join(destDir, VOICE_NOTE_DIR) : destDir;
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${Date.now()}-${base}`);
  const { downloadMediaMessage } = await loadBaileysModule();
  const buf = await downloadMediaMessage(rawMsg, 'buffer', {});
  if (!buf || buf.length === 0) return { skipped: 'empty-download' };
  if (buf.length > maxBytes) return { skipped: `too-large:${buf.length}` };
  fs.writeFileSync(dest, buf);
  return { path: dest, filename: base, bytes: buf.length, kind, mimetype: part.mimetype || null, voiceNote: kind === 'audio' && !!part.ptt };
}

/** Last N inbox.jsonl messages for one chat, oldest first. */
export function readMessages(jid, limit = 30) {
  return tailJsonLines(inboxPath(), limit, (record) => record.chatJid === jid);
}

/**
 * A quoted reply ("reply" in the WhatsApp UI) carries the quoted message inside the
 * sub-message's contextInfo. Without surfacing it, a one-word answer such as
 * "yes" cannot be tied to the question it answers.
 */
export function replyContext(rawMessage) {
  const message = unwrapMessage(rawMessage);
  if (!message) return null;
  const sub = Object.values(message).find((v) => v && typeof v === 'object' && v.contextInfo?.quotedMessage);
  const ci = sub?.contextInfo;
  if (!ci?.quotedMessage) return null;
  return {
    replyToMsgId: ci.stanzaId || null,
    replyToParticipant: ci.participant || null,
    replyToText: extractText(ci.quotedMessage),
  };
}

/** Sends an emoji reaction to a message; empty emoji removes our reaction. Daemon-only. */
export async function sendReaction(jid, targetKey, emoji) {
  if (!sockRef) throw new Error('No active WhatsApp connection. sendReaction() must run inside the daemon process.');
  const key = { remoteJid: jid, id: targetKey.id, fromMe: !!targetKey.fromMe, ...(targetKey.participant ? { participant: targetKey.participant } : {}) };
  const result = await sockRef.sendMessage(jid, { react: { text: emoji || '', key } });
  return result?.key?.id || null;
}

/** Deletes one of OUR OWN messages for everyone (WhatsApp "revoke"). Never touches anyone else's message. Daemon-only. */
export async function deleteOwnMessage(jid, msgId) {
  if (!sockRef) throw new Error('No active WhatsApp connection. deleteOwnMessage() must run inside the daemon process.');
  if (!msgId) throw new Error('delete needs msgId');
  const key = { remoteJid: jid, id: msgId, fromMe: true };
  const result = await sockRef.sendMessage(jid, { delete: key });
  return result?.key?.id || null;
}

export function extractText(rawMessage) {
  const message = unwrapMessage(rawMessage);
  if (!message) return '[unknown]';
  if (typeof message.conversation === 'string') return message.conversation;
  if (typeof message.extendedTextMessage?.text === 'string') return message.extendedTextMessage.text;
  if (message.imageMessage) return message.imageMessage.caption ? message.imageMessage.caption : '[image]';
  if (message.videoMessage) return message.videoMessage.caption ? message.videoMessage.caption : '[video]';
  if (message.documentMessage) {
    const name = message.documentMessage.fileName;
    const label = name ? `[document: ${name}]` : '[document]';
    // A caption is real text a person wrote — an @-mention or an instruction
    // written as a document caption must never be hidden behind the label.
    const cap = message.documentMessage.caption;
    return cap ? `${label} ${cap}` : label;
  }
  if (message.audioMessage) return message.audioMessage.ptt ? '[voice note]' : '[audio]';
  if (message.stickerMessage) return '[sticker]';
  if (message.contactMessage) return '[contact]';
  if (message.locationMessage) return '[location]';
  if (message.reactionMessage) return '[reaction]';
  const type = Object.keys(message).find((k) => !PROTOCOL_ONLY_KEYS.has(k)) || Object.keys(message)[0];
  return type ? `[${type}]` : '[unknown]';
}

let sockRef = null;

// Echo verification: WhatsApp reflects every message we send back to us as a
// fromMe upsert. That echo is what recipients actually receive — a document
// that echoes without fileName/mimetype arrives unopenable even when our bytes
// were perfect. Senders await the echo (bounded) so the ack can state what
// arrived, not just what was attempted.
const pendingEchoes = new Map();
export function awaitEcho(msgId, timeoutMs = 15000) {
  if (!msgId) return Promise.resolve(null);
  return new Promise((resolve) => {
    const t = setTimeout(() => { pendingEchoes.delete(msgId); resolve(null); }, timeoutMs);
    pendingEchoes.set(msgId, (raw) => { clearTimeout(t); pendingEchoes.delete(msgId); resolve(raw); });
  });
}
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

/** A jid without its device suffix (`46…:1@s.whatsapp.net` → `46…@s.whatsapp.net`). */
function bareJid(jid) {
  return typeof jid === 'string' ? jid.replace(/:\d+@/, '@') : null;
}

/**
 * True when the message @-mentions THIS account. WhatsApp puts mentions in the
 * sub-message's contextInfo.mentionedJid, addressed by phone jid OR by LID
 * depending on the sender's account — so both of our identities are matched,
 * never the rendered "@number" text (which differs under LID addressing).
 */
export function selfIdentities() {
  return [sockRef?.user?.id, sockRef?.user?.lid].map(bareJid).filter(Boolean);
}

/** Every jid the message @-mentions (device suffix stripped), across all sub-messages. */
function mentionedJids(rawMessage) {
  const message = unwrapMessage(rawMessage);
  const out = [];
  for (const sub of Object.values(message || {})) {
    const mentioned = sub?.contextInfo?.mentionedJid;
    if (Array.isArray(mentioned)) for (const j of mentioned) { const b = bareJid(j); if (b && !out.includes(b)) out.push(b); }
  }
  return out;
}

function mentionsMe(message) {
  const selves = selfIdentities();
  return selves.length > 0 && mentionedJids(message).some((j) => selves.includes(j));
}

// Sub-message keys that carry no human content on their own (key rotation,
// device metadata). A message made only of these is protocol, not a record.
const PROTOCOL_ONLY_KEYS = new Set(['senderKeyDistributionMessage', 'messageContextInfo', 'protocolMessage']);

export function extractMessageRecords(payload) {
  const out = [];
  for (const m of payload?.messages || []) {
    if (!m.message || !m.key) continue; // e.g. receipts
    // An edit arrives as protocolMessage(type MESSAGE_EDIT) carrying editedMessage —
    // real human content, so it is never treated as protocol-only.
    const edited = m.message.protocolMessage?.editedMessage;
    if (!edited && Object.keys(m.message).every((k) => PROTOCOL_ONLY_KEYS.has(k))) continue; // key rotation etc.
    const chatJid = m.key.remoteJid;
    if (!chatJid) continue;
    const fromMe = !!m.key.fromMe;
    const senderJid = fromMe ? sockRef?.user?.id || chatJid : m.key.participant || chatJid;
    const cached = chatCache.get(chatJid);
    const body = edited || m.message;
    const record = {
      ts: Date.now(),
      chatJid,
      chatName: cached?.name || null,
      senderJid,
      senderName: m.pushName || cached?.name || null,
      fromMe,
      text: extractText(body),
      msgId: m.key.id || null,
      mentionedMe: !fromMe && mentionsMe(body),
      mentionedJids: mentionedJids(body),
    };
    if (edited) record.editOfMsgId = m.message.protocolMessage?.key?.id || null;
    // Reactions are records too: "<sender> reacted 👍 to <msg>" is a real signal.
    const react = unwrapMessage(m.message)?.reactionMessage;
    if (react) {
      record.type = 'reaction';
      record.reaction = { emoji: react.text || '', targetMsgId: react.key?.id || null, targetFromMe: !!react.key?.fromMe, removed: !react.text };
      record.text = react.text ? `[reaction ${react.text}]` : '[reaction removed]';
    }
    const rc = replyContext(body);
    if (rc) Object.assign(record, rc);
    // An edit on current WhatsApp arrives as secretEncryptedMessage, encrypted with the
    // edited message's own secret. This Baileys version cannot decrypt it; we keep the
    // target key and the field names (never the payload) so the edit can at least be
    // attributed and the sender asked to resend.
    const sec = m.message.secretEncryptedMessage;
    if (sec) {
      record.type = 'secret-encrypted';
      record.targetMsgId = sec.targetMessageKey?.id || null;
      record.innerKeys = Object.keys(sec);
      record.text = record.targetMsgId ? `[edit of ${record.targetMsgId} - encrypted, cannot be read]` : '[secretEncryptedMessage]';
    }
    // An unrecognised type keeps its raw key list so the next such message can be diagnosed, not guessed.
    if (/^\[[A-Za-z]+\]$/.test(record.text) && !record.type && !['[image]','[video]','[document]','[audio]','[voice note]','[sticker]','[contact]','[location]','[unknown]'].includes(record.text)) {
      record.rawKeys = Object.keys(m.message);
    }
    // The raw Baileys message rides BESIDE the JSON-clean record (a pair, never a
    // field): the daemon needs it to download attachments AFTER its allowlist
    // decision — policy lives there, transport here.
    out.push({ record, raw: m });
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

/** A mention is a person's jid; the text must carry "@<number>" for it to show as a tag. */
const MENTION_JID = /^\d{5,20}@(s\.whatsapp\.net|lid)$/;

/** Sends a text message through the live connection, tagging `mentions`. Throws if nothing is connected. */
export async function sendText(jid, text, mentions = []) {
  if (!sockRef) {
    throw new Error('No active WhatsApp connection. sendText() must run inside the daemon process.');
  }
  const bad = mentions.filter((m) => typeof m !== 'string' || !MENTION_JID.test(m));
  if (bad.length) throw new Error(`invalid mention jid: ${bad.join(', ')}`);
  const missing = mentions.filter((m) => !new RegExp(`@${m.split('@')[0]}(?!\\d)`).test(text));
  if (missing.length) throw new Error(`text lacks @<number> for mention: ${missing.join(', ')}`);
  const result = await sockRef.sendMessage(jid, mentions.length ? { text, mentions } : { text });
  return result?.key?.id || null;
}

/** Sends a document from a local file path. Caption is optional. Same one-connection
 *  rule as sendText: only the daemon process may call this. */
// The recipient's client opens a document by its mimetype; octet-stream shows a
// generic blob. Map the extensions this assistant actually sends.
const MIMETYPES = {
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json', html: 'text/html',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', zip: 'application/zip',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
};
export function mimetypeFor(fileName) {
  const ext = String(fileName || '').toLowerCase().split('.').pop();
  return MIMETYPES[ext] || 'application/octet-stream';
}

/** Upper bounds for outgoing media. The daemon reads the whole file into memory before sending. */
export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_VOICE_BYTES = 16 * 1024 * 1024;
/** Image types sent as an inline image message (anything else goes as a document). */
export const IMAGE_MIMETYPES = new Set(['image/png', 'image/jpeg']);

/**
 * The one check every outgoing file passes, in the MCP server (for a readable refusal)
 * and again in the daemon (which must not trust outbox content). Returns
 * { bytes, mimetype } or throws with a reason a model can act on.
 */
export function checkSendableFile(kind, filePath, fileName) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new Error('path must be an absolute path to a file the daemon can read.');
  }
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    throw new Error(`file not found: ${filePath}`);
  }
  if (!st.isFile()) throw new Error(`not a regular file: ${filePath}`);
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
  } catch {
    throw new Error(`file is not readable: ${filePath}`);
  }
  if (st.size === 0) throw new Error(`file is empty: ${filePath}`);
  // Never send the bridge's own state: the auth directory holds the account's session
  // keys, so a prompt-injected "send me that file" must not be able to reach it.
  const real = fs.realpathSync(filePath);
  let stateDir = waHome();
  try { stateDir = fs.realpathSync(stateDir); } catch { /* not created yet */ }
  if (real === stateDir || real.startsWith(stateDir + path.sep)) {
    throw new Error('files inside the bridge\'s own state directory (auth keys, inbox, outbox, downloads) cannot be sent; copy a downloaded file elsewhere first.');
  }
  const name = fileName || path.basename(filePath);
  const mimetype = mimetypeFor(name);
  if (kind === 'voice') {
    // A voice note must be Ogg/Opus to play as a voice note (with a waveform) on every client.
    if (path.extname(filePath).toLowerCase() !== '.ogg') {
      throw new Error(`a voice note must be an Ogg/Opus .ogg file (got ${path.basename(filePath)}); convert with: ffmpeg -i in.wav -c:a libopus -b:a 32k -ac 1 out.ogg`);
    }
    if (st.size > MAX_VOICE_BYTES) throw new Error(`voice note is ${st.size} bytes; the limit is ${MAX_VOICE_BYTES}.`);
    return { bytes: st.size, mimetype: 'audio/ogg; codecs=opus' };
  }
  if (kind === 'image') {
    if (!IMAGE_MIMETYPES.has(mimetypeFor(filePath))) {
      throw new Error(`an image must be a .png, .jpg or .jpeg file (got ${path.basename(filePath)}); send other files as a document.`);
    }
    if (st.size > MAX_IMAGE_BYTES) throw new Error(`image is ${st.size} bytes; the limit is ${MAX_IMAGE_BYTES}.`);
    return { bytes: st.size, mimetype: mimetypeFor(filePath) };
  }
  if (mimetype === 'application/octet-stream') {
    throw new Error(`"${name}" does not have an accepted extension (${Object.keys(MIMETYPES).map((e) => '.' + e).join(' ')}); the recipient's client opens the file by its extension. Rename the file or pass fileName.`);
  }
  if (st.size > MAX_DOCUMENT_BYTES) throw new Error(`document is ${st.size} bytes; the limit is ${MAX_DOCUMENT_BYTES}.`);
  return { bytes: st.size, mimetype };
}

/** Sends a PNG/JPEG as an image message, so it renders inline in the chat. Daemon-only. */
export async function sendImage(jid, filePath, caption) {
  if (!sockRef) {
    throw new Error('No active WhatsApp connection. sendImage() must run inside the daemon process.');
  }
  const buffer = fs.readFileSync(filePath);
  const result = await sockRef.sendMessage(jid, {
    image: buffer,
    mimetype: mimetypeFor(filePath),
    ...(caption ? { caption } : {}),
  });
  return result?.key?.id || null;
}

/** Sends an Ogg/Opus file as a voice note (ptt), so it plays inline like a recorded message. Daemon-only. */
export async function sendVoiceNote(jid, filePath) {
  if (!sockRef) {
    throw new Error('No active WhatsApp connection. sendVoiceNote() must run inside the daemon process.');
  }
  const buffer = fs.readFileSync(filePath);
  const result = await sockRef.sendMessage(jid, { audio: buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true });
  return result?.key?.id || null;
}

export async function sendDocument(jid, filePath, fileName, caption) {
  if (!sockRef) {
    throw new Error('No active WhatsApp connection. sendDocument() must run inside the daemon process.');
  }
  const buffer = fs.readFileSync(filePath);
  const result = await sockRef.sendMessage(jid, {
    document: buffer,
    mimetype: mimetypeFor(fileName),
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
        for (const { record, raw } of extractMessageRecords(payload)) {
          if (raw?.key?.fromMe && pendingEchoes.has(raw.key.id)) pendingEchoes.get(raw.key.id)(raw);
          try {
            onMessage(record, raw);
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
