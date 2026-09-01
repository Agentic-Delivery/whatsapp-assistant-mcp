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
import { connect, appendInbox, sendText, sendDocument, downloadDocument, readNewLines, outboxPath, daemonLogPath, waHome } from './wa-client.js';

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
export function makeOnMessage(allowlist, onSkipped = () => {}) {
  return (record, raw) => {
    if (!allowlist.has(record.chatJid)) {
      onSkipped();
      return Promise.resolve();
    }
    appendInbox(record);
    if (!raw?.message?.documentMessage) return Promise.resolve();
    return downloadDocument(raw, path.join(waHome(), 'downloads'))
      .then((r) => {
        const note = r.path
          ? { ...record, type: 'media-saved', mediaPath: r.path, bytes: r.bytes }
          : { ...record, type: 'media-skipped', reason: r.skipped };
        appendInbox(note);
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
      if (cmd.type === 'send-file') {
        const fs2 = await import('node:fs');
        if (!cmd.path || !fs2.existsSync(cmd.path)) throw new Error(`file not found: ${cmd.path}`);
        const cap = cmd.caption ? (cmd.caption.startsWith(SIG) ? cmd.caption : SIG + cmd.caption) : undefined;
        // The file name is what the recipient's client uses to open the file: a
        // nameless/extension-less document arrives as an unopenable blob even when
        // the bytes are perfect (mimetype derives from the extension). Never fall
        // back to a bare literal — the file's own basename always carries its
        // extension. Both key spellings are accepted; the contract is fileName.
        const fileName = cmd.fileName || cmd.filename || path.basename(cmd.path);
        msgId = await sendDocument(jid, cmd.path, fileName, cap);
      } else {
        const signed = text.startsWith(SIG) ? text : SIG + text;
        msgId = await sendText(jid, signed);
      }
      ack = { ts: Date.now(), type: 'send-ack', nonce, jid, ok: true, msgId };
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
function startOutboxWatcher(config) {
  const outbox = outboxPath();
  fs.mkdirSync(path.dirname(outbox), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(outbox)) fs.writeFileSync(outbox, '', { mode: 0o600 });

  let offset = fs.statSync(outbox).size;
  let draining = false;

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      const { entries, newOffset } = readNewLines(outbox, offset);
      offset = newOffset;
      for (const cmd of entries) {
        if (cmd?.type !== 'send' && cmd?.type !== 'send-file') continue;
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

  const allowlist = new Set(config.chats.map((c) => c.jid));
  console.log(`Loaded ${config.chats.length} allowlisted chat(s) from ${configPath()}`);

  const handleLoggedOut = (err) => {
    console.error(`WhatsApp connection failed: ${err.message}`);
    console.error(`Delete ${path.join(waHome(), 'auth')} and run 'wa-pair' again.`);
    process.exit(1);
  };

  // Messages from chats not on the allowlist are seen (this counter proves it) but
  // deliberately never written to inbox.jsonl -- the allowlist is the blast-radius
  // control, and "not stored" must mean not stored, not "stored somewhere quieter".
  let skippedCount = 0;

  let connection;
  try {
    connection = await connect({
      reconnect: true,
      onMessage: makeOnMessage(allowlist, () => { skippedCount += 1; }),
      onConnection: (update) => {
        if (update.connection === 'open' || update.connection === 'close') {
          logDaemon({ ts: Date.now(), type: 'connection', status: update.connection });
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
  const stopOutboxWatcher = startOutboxWatcher(config);

  const heartbeat = setInterval(() => {
    logDaemon({
      ts: Date.now(),
      type: 'heartbeat',
      chats: config.chats.length,
      skippedNonAllowlisted: skippedCount,
    });
  }, HEARTBEAT_MS);

  const shutdown = () => {
    clearInterval(heartbeat);
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
