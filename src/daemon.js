#!/usr/bin/env node
// Long-running daemon: the only process allowed to hold the WhatsApp connection.
//
// Responsibilities:
//   - load the allowlist and refuse to start if it's empty (fatal, exit 1)
//   - stream inbound messages into inbox.jsonl, but ONLY for allowlisted chats
//   - watch outbox.jsonl for send commands written by the MCP server, perform the
//     actual send, and append a matching ack back into inbox.jsonl
//   - write a heartbeat line to daemon.log every 30s so liveness can be checked
//     without touching the WhatsApp connection itself

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, findChat, configPath } from './config.js';
import { queueTranscription } from './speech.js';
import { connect, appendInbox, sendText, sendDocument, sendImage, sendVoiceNote, checkSendableFile, sendReaction, deleteOwnMessage, downloadDocument, pruneVoiceNotes, hasSavableMedia, awaitEcho, readNewLines, outboxPath, daemonLogPath, waHome, selfIdentities } from './wa-client.js';

const HEARTBEAT_MS = 30000;
const OUTBOX_POLL_MS = 2000;

function logDaemon(record) {
  try {
    fs.mkdirSync(path.dirname(daemonLogPath()), { recursive: true, mode: 0o700 });
    fs.appendFileSync(daemonLogPath(), JSON.stringify(record) + '\n', { mode: 0o600 });
  } catch {
    // Best-effort logging; a log write failure must never crash the daemon.
  }
}

/**
 * The inbound-message policy, as a unit: allowlist gates BOTH the inbox line and
 * any attachment download — not stored must mean not stored, media included.
 * Returns the handler the connection loop calls per (record, raw) pair; the
 * handler returns a promise tests can await (the loop ignores it; all failure
 * paths resolve into inbox records, never throws).
 */
// Knock log: a chat that is NOT allowlisted is never stored — but WHO knocked is
// the bootstrap surface for extending the allowlist from evidence (the group
// catalog does this for groups; DMs had nothing). Records jid + display name +
// time ONLY, never text or media. One line per jid per daemon run.
const knocked = new Set();
export function recordKnock(record) {
  const jid = record?.chatJid;
  if (!jid || knocked.has(jid)) return;
  knocked.add(jid);
  fs.appendFileSync(
    path.join(waHome(), 'knocks.jsonl'),
    JSON.stringify({ ts: Date.now(), chatJid: jid, senderName: record.senderName || null }) + '\n',
  );
}

/** The stored set (readable chats) and the write-only set (canRead:false) of an allowlist config. */
export function splitAllowlist(config) {
  return {
    readable: new Set(config.chats.filter((c) => c.canRead !== false).map((c) => c.jid)),
    writeOnly: new Set(config.chats.filter((c) => c.canRead === false).map((c) => c.jid)),
  };
}

export function makeOnMessage(allowlist, onSkipped = () => {}, speech = {}) {
  return (record, raw) => {
    if (!allowlist.has(record.chatJid)) {
      onSkipped(record);
      return Promise.resolve();
    }
    appendInbox(record);
    if (!hasSavableMedia(raw)) return Promise.resolve();
    return downloadDocument(raw, path.join(waHome(), 'downloads'))
      .then((r) => {
        const note = r.path
          ? { ...record, type: 'media-saved', mediaPath: r.path, bytes: r.bytes, kind: r.kind, mimetype: r.mimetype }
          : { ...record, type: 'media-skipped', reason: r.skipped };
        appendInbox(note);
        // A saved voice note becomes text when a transcribe command is configured: the transcript is appended to
        // the inbox as its own record (so any agent can read what was said) and written next to the audio.
        // r.voiceNote is set by the download from the message type itself, never from a sender-chosen file name.
        if (r.path && r.voiceNote && speech.transcribe) {
          return queueTranscription(speech.transcribe, r.path)
            .then((text) => {
              const rec = { ...record, type: 'transcript', text, mediaPath: r.path };
              try {
                fs.writeFileSync(r.path + '.txt', text + '\n');
              } catch (err) {
                rec.warning = `transcript file not written: ${err?.message || err}`;
              }
              appendInbox(rec);
            })
            .catch((err) => appendInbox({ ...record, type: 'transcript-error', error: String(err?.message || err), mediaPath: r.path }));
        }
      })
      .catch((err) => {
        appendInbox({ ...record, type: 'media-error', error: String(err?.message || err) });
      });
  };
}

/**
 * Handles one outbox "send" command: re-validates the jid against the allowlist
 * (defense in depth -- send_chat_message already checked this before writing the
 * command, but the daemon is the thing that actually touches WhatsApp and must not
 * blindly trust file content), performs the send, and appends a send-ack record
 * carrying the same nonce so the waiting MCP tool call can pick it up.
 */
/** The one list of outbox command types the watcher hands to handleSendCommand. A type handled there but missing here is silently skipped. */
export const OUTBOX_TYPES = new Set(['send', 'send-file', 'send-image', 'send-voice', 'react', 'delete']);

export async function handleSendCommand(cmd, config) {
  const { jid, text, nonce } = cmd;
  let ack;
  const chat = findChat(config, jid);
  if (!chat) {
    ack = { ts: Date.now(), type: 'send-ack', nonce, jid, ok: false, error: `jid not in allowlist: ${jid}` };
  } else if (!chat.canPost) {
    ack = { ts: Date.now(), type: 'send-ack', nonce, jid, ok: false, error: `canPost is false for ${jid}` };
  } else {
    try {
      // MECHANICAL signature: on a shared/personal account the account owner's
      // name is what WhatsApp shows on every message — the ONLY separation
      // between the human and the agent is this marker, so the daemon (the one
      // process that touches WhatsApp) stamps it; no send path can skip it.
      // Applies to text messages AND document captions alike.
      const SIG = process.env.WA_AGENT_SIG || "\u{1F916} ";
      let msgId;
      if (cmd.type === 'react') {
        // {type:'react', jid, nonce, msgId, emoji, fromMe?, participant?} — an empty emoji removes our reaction.
        if (!cmd.msgId) throw new Error('react needs msgId');
        msgId = await sendReaction(jid, { id: cmd.msgId, fromMe: !!cmd.fromMe, participant: cmd.participant }, cmd.emoji ?? '');
        ack = { ts: Date.now(), type: 'send-ack', nonce, jid, ok: true, msgId, reacted: { target: cmd.msgId, emoji: cmd.emoji ?? '' } };
      } else if (cmd.type === 'delete') {
        // {type:'delete', jid, nonce, msgId}: deletes one of OUR OWN earlier messages for everyone.
        // fromMe is forced true inside deleteOwnMessage, so this can never remove another person's message.
        msgId = await deleteOwnMessage(jid, cmd.msgId);
        ack = { ts: Date.now(), type: 'send-ack', nonce, jid, ok: true, msgId, deleted: cmd.msgId };
      } else if (cmd.type === 'send-image') {
        // {type:'send-image', jid, nonce, path, caption?}: a PNG/JPEG sent as an image message (renders inline).
        const { bytes } = checkSendableFile('image', cmd.path);
        const cap = cmd.caption ? (cmd.caption.startsWith(SIG) ? cmd.caption : SIG + cmd.caption) : undefined;
        msgId = await sendImage(jid, cmd.path, cap);
        // Verify what ARRIVED: the echo's imageMessage must carry a real image mimetype and our byte count.
        const echo = await awaitEcho(msgId, cmd.echoTimeoutMs ?? 15000);
        if (echo) {
          const im = echo.message?.imageMessage || {};
          const problems = [];
          if (!im.mimetype || !im.mimetype.startsWith('image/')) problems.push(`mimetype ${im.mimetype || 'missing'}`);
          if (im.fileLength != null && Number(im.fileLength) !== bytes) problems.push(`size ${im.fileLength} != ${bytes}`);
          if (problems.length) throw new Error(`image echoed malformed (${problems.join(', ')}); msgId ${msgId}`);
          ack = { ts: Date.now(), type: 'send-ack', nonce, jid, ok: true, msgId, verified: { mimetype: im.mimetype, bytes: Number(im.fileLength ?? bytes) } };
        } else {
          ack = { ts: Date.now(), type: 'send-ack', nonce, jid, ok: true, msgId, verified: null, warning: 'echo-timeout: delivery unverified' };
        }
      } else if (cmd.type === 'send-voice') {
        // {type:'send-voice', jid, nonce, path}: an Ogg/Opus file sent as a voice note. A voice note has no
        // caption, so the agent marker cannot be stamped on it; the sender should say it is the assistant.
        const { bytes } = checkSendableFile('voice', cmd.path);
        msgId = await sendVoiceNote(jid, cmd.path);
        const echo = await awaitEcho(msgId, cmd.echoTimeoutMs ?? 15000);
        if (echo) {
          const au = echo.message?.audioMessage || {};
          const problems = [];
          if (!au.ptt) problems.push('not a voice note (ptt missing)');
          if (au.fileLength != null && Number(au.fileLength) !== bytes) problems.push(`size ${au.fileLength} != ${bytes}`);
          if (problems.length) throw new Error(`voice note echoed malformed (${problems.join(', ')}); msgId ${msgId}`);
          ack = { ts: Date.now(), type: 'send-ack', nonce, jid, ok: true, msgId, verified: { ptt: true, mimetype: au.mimetype || null, bytes: Number(au.fileLength ?? bytes), seconds: au.seconds ?? null } };
        } else {
          ack = { ts: Date.now(), type: 'send-ack', nonce, jid, ok: true, msgId, verified: null, warning: 'echo-timeout: delivery unverified' };
        }
      } else if (cmd.type === 'send-file') {
        const fs2 = await import('node:fs');
        checkSendableFile('document', cmd.path, cmd.fileName || cmd.filename);
        const cap = cmd.caption ? (cmd.caption.startsWith(SIG) ? cmd.caption : SIG + cmd.caption) : undefined;
        // The file name is what the recipient's client uses to open the file: a
        // nameless/extension-less document arrives as an unopenable blob even when
        // the bytes are perfect (mimetype derives from the extension). Never fall
        // back to a bare literal — the file's own basename always carries its
        // extension. Both key spellings are accepted; the contract is fileName.
        const fileName = cmd.fileName || cmd.filename || path.basename(cmd.path);
        msgId = await sendDocument(jid, cmd.path, fileName, cap);
        // Verify what ARRIVED, not what we attempted: the echo's documentMessage
        // must carry a fileName, a real mimetype and our exact byte count.
        const echo = await awaitEcho(msgId, cmd.echoTimeoutMs ?? 15000);
        if (echo) {
          const d = echo.message?.documentMessage || {};
          const localBytes = fs2.statSync(cmd.path).size;
          const problems = [];
          if (!d.fileName) problems.push('no fileName');
          if (!d.mimetype || d.mimetype === 'application/octet-stream') problems.push(`mimetype ${d.mimetype || 'missing'}`);
          if (d.fileLength != null && Number(d.fileLength) !== localBytes) problems.push(`size ${d.fileLength} != ${localBytes}`);
          if (problems.length) throw new Error(`document echoed malformed (${problems.join(', ')}) — recipients cannot open it; msgId ${msgId}`);
          ack = { ts: Date.now(), type: 'send-ack', nonce, jid, ok: true, msgId, verified: { fileName: d.fileName, mimetype: d.mimetype, bytes: Number(d.fileLength ?? localBytes) } };
        } else {
          ack = { ts: Date.now(), type: 'send-ack', nonce, jid, ok: true, msgId, verified: null, warning: 'echo-timeout: delivery unverified' };
        }
      } else {
        const signed = text.startsWith(SIG) ? text : SIG + text;
        if (cmd.mentions !== undefined && !Array.isArray(cmd.mentions)) throw new Error('invalid mentions: expected an array of jids');
        msgId = await sendText(jid, signed, cmd.mentions ?? []);
        const echo = await awaitEcho(msgId, cmd.echoTimeoutMs ?? 15000);
        const echoed = echo?.message?.conversation ?? echo?.message?.extendedTextMessage?.text ?? null;
        ack = echo
          ? { ts: Date.now(), type: 'send-ack', nonce, jid, ok: true, msgId, verified: { text: echoed === signed } }
          : { ts: Date.now(), type: 'send-ack', nonce, jid, ok: true, msgId, verified: null, warning: 'echo-timeout: delivery unverified' };
      }
    } catch (err) {
      ack = { ts: Date.now(), type: 'send-ack', nonce, jid, ok: false, error: String(err?.message || err) };
    }
  }
  appendInbox(ack);
}

/**
 * Watches outbox.jsonl for new "send" commands via fs.watch, backed by a 2s poll
 * fallback (fs.watch can miss events on some filesystems, and the poll also covers
 * the window before the watch is established). Only ever processes commands
 * appended AFTER the daemon started -- never replays history on restart, which
 * would resend old messages.
 */
/**
 * The outbox offset is snapshotted at PROCESS START, before the WhatsApp
 * connection opens. Snapshotting inside the watcher (which starts after connect)
 * silently swallowed any command appended between "connection open" and the
 * watcher's first read — a send that was never attempted and never acked.
 */
export function snapshotOutboxOffset() {
  const outbox = outboxPath();
  fs.mkdirSync(path.dirname(outbox), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(outbox)) fs.writeFileSync(outbox, '', { mode: 0o600 });
  return fs.statSync(outbox).size;
}

export function startOutboxWatcher(config, startOffset) {
  const outbox = outboxPath();
  fs.mkdirSync(path.dirname(outbox), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(outbox)) fs.writeFileSync(outbox, '', { mode: 0o600 });

  let offset = startOffset ?? fs.statSync(outbox).size;
  let draining = false;

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      const { entries, newOffset } = readNewLines(outbox, offset);
      offset = newOffset;
      for (const cmd of entries) {
        if (!OUTBOX_TYPES.has(cmd?.type)) continue;
        await handleSendCommand(cmd, config);
      }
    } catch (err) {
      logDaemon({ ts: Date.now(), type: 'error', scope: 'outbox', message: String(err?.message || err) });
    } finally {
      draining = false;
    }
  }

  let watcher = null;
  try {
    watcher = fs.watch(outbox, () => {
      drain();
    });
  } catch (err) {
    logDaemon({ ts: Date.now(), type: 'error', scope: 'outbox-watch', message: String(err?.message || err) });
  }
  const interval = setInterval(drain, OUTBOX_POLL_MS);

  return () => {
    if (watcher) watcher.close();
    clearInterval(interval);
  };
}

async function main() {
  const discover = process.env.WA_DISCOVER === '1';
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (!discover) {
      console.error(err.message);
      process.exit(1);
      return;
    }
    // Discover mode: run with an EMPTY allowlist (nothing stored, nothing
    // sendable) purely to write the chat catalog below — the bootstrap for a
    // first config, eliminating any second process on the auth session.
    config = { chats: [] };
    console.log('WA_DISCOVER=1: running with an empty allowlist to catalog chats.');
  }

  // Only readable chats are stored; a write-only chat (canRead:false) is allowlisted for sending only.
  const { readable: allowlist, writeOnly } = splitAllowlist(config);
  console.log(`Loaded ${config.chats.length} allowlisted chat(s) (${writeOnly.size} write-only) from ${configPath()}`);

  const handleLoggedOut = (err) => {
    console.error(`WhatsApp connection failed: ${err.message}`);
    console.error(`Delete ${path.join(waHome(), 'auth')} and run 'wa-pair' again.`);
    process.exit(1);
  };

  // Messages from chats not on the allowlist are seen (this counter proves it) but
  // deliberately never written to inbox.jsonl -- the allowlist is the blast-radius
  // control, and "not stored" must mean not stored, not "stored somewhere quieter".
  let skippedCount = 0;
  // Messages seen in a write-only chat: counted, never stored, never knocked (the chat is known).
  let skippedWriteOnly = 0;

  const outboxStartOffset = snapshotOutboxOffset();
  let connection;
  try {
    connection = await connect({
      reconnect: true,
      onMessage: makeOnMessage(allowlist, (record) => {
        if (writeOnly.has(record.chatJid)) { skippedWriteOnly += 1; return; }
        skippedCount += 1;
        recordKnock(record);
      }, config.speech || {}),
      onConnection: (update) => {
        if (update.connection === 'open' || update.connection === 'close') {
          logDaemon({ ts: Date.now(), type: 'connection', status: update.connection });
          // The identities a mention must match — logged so a missed @-mention is
          // diagnosable from the log (is the LID identity populated live?).
          if (update.connection === 'open') logDaemon({ ts: Date.now(), type: 'identity', selves: selfIdentities() });
        }
      },
      onLoggedOut: handleLoggedOut,
    });
  } catch (err) {
    if (!err.loggedOut) {
      console.error(`WhatsApp connection failed: ${err.message}`);
    }
    process.exit(1);
    return;
  }

  console.log(`Connected as ${connection.jid || 'unknown'}. Daemon running.`);
  // Chat catalog: every participating group, refreshed at each connect — the
  // discovery surface for building/extending the allowlist without a second
  // process ever touching the auth session.
  try {
    const groups = await connection.sock.groupFetchAllParticipating();
    const catalog = Object.entries(groups).map(([id, g]) => ({ jid: id, subject: g.subject, members: (g.participants || []).length }));
    fs.writeFileSync(path.join(waHome(), 'chats-catalog.json'), JSON.stringify(catalog, null, 2));
    console.log(`Cataloged ${catalog.length} group(s) to chats-catalog.json`);
  } catch (err) {
    console.error(`Group catalog failed (non-fatal): ${err?.message || err}`);
  }
  const stopOutboxWatcher = startOutboxWatcher(config, outboxStartOffset);

  // Voice-note retention (config "retention"): at startup and hourly; deletions are logged by file name only.
  const prune = () => {
    try {
      const r = pruneVoiceNotes(path.join(waHome(), 'downloads'), config.retention || {});
      if (r.deleted.length) logDaemon({ ts: Date.now(), type: 'retention', deleted: r.deleted, kept: r.kept, bytes: r.bytes });
    } catch (err) {
      logDaemon({ ts: Date.now(), type: 'retention-error', error: String(err?.message || err) });
    }
  };
  prune();
  const retentionTimer = setInterval(prune, 3600000);

  const heartbeat = setInterval(() => {
    logDaemon({
      ts: Date.now(),
      type: 'heartbeat',
      chats: config.chats.length,
      skippedNonAllowlisted: skippedCount,
      skippedWriteOnly,
    });
  }, HEARTBEAT_MS);

  const shutdown = () => {
    clearInterval(heartbeat);
    clearInterval(retentionTimer);
    stopOutboxWatcher();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Only boot when executed directly (node src/daemon.js) — an import (tests,
// tooling) must get the exports without starting a real WhatsApp connection.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
