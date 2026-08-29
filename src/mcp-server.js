#!/usr/bin/env node
// Stdio MCP server (name: whatsapp-assistant). Exposes four tools: list_chats,
// read_chat_messages, send_chat_message, poll_chats.
//
// This process NEVER opens its own Baileys connection -- Baileys refuses a second
// simultaneous connection against the same auth session, and the daemon (src/daemon.js)
// already holds the one connection this project is allowed to have. Reads come from
// inbox.jsonl (so this works even when WhatsApp is briefly unreachable); sends are
// handed off to the daemon via outbox.jsonl and confirmed by waiting for an ack.
//
// The tool logic below is exported as plain functions so it can be exercised directly
// from tests without going through the stdio transport. The SDK wiring at the bottom
// only runs when this file is the actual process entry point (see isEntryPoint), so
// importing this module -- from a test, or anywhere else -- never starts the server.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { configPath, findChat, loadConfig } from './config.js';
import { appendOutboxCommand, cursorPath, inboxPath, readMessages, readNewLines, tailJsonLines } from './wa-client.js';

const SEND_ACK_TIMEOUT_MS = 15000;
const SEND_ACK_POLL_MS = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readCursor() {
  const p = cursorPath();
  if (!fs.existsSync(p)) return { offset: 0 };
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { offset: Number.isFinite(data.offset) ? data.offset : 0 };
  } catch {
    return { offset: 0 };
  }
}

function writeCursor(cursor) {
  fs.mkdirSync(path.dirname(cursorPath()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(cursorPath(), JSON.stringify(cursor), { mode: 0o600 });
}

/**
 * list_chats: the allowlisted chats (jid, name, canPost) annotated with how many of
 * the last 50 real (non-protocol) inbox.jsonl entries -- across ALL chats combined --
 * belong to each one. A lightweight recent-activity signal, not a full per-chat count.
 */
export async function listChats() {
  const config = loadConfig();
  const recent = tailJsonLines(inboxPath(), 50, (r) => !r.type);
  const counts = new Map();
  for (const r of recent) {
    counts.set(r.chatJid, (counts.get(r.chatJid) || 0) + 1);
  }
  return {
    chats: config.chats.map((c) => ({
      jid: c.jid,
      name: c.name,
      canPost: c.canPost,
      recentMessageCount: counts.get(c.jid) || 0,
    })),
  };
}

/** read_chat_messages: last `limit` inbox.jsonl lines for one allowlisted chat. */
export async function readChatMessages({ jid, limit = 30 }) {
  const config = loadConfig();
  if (!findChat(config, jid)) {
    throw new Error(`"${jid}" is not in the allowlist. Add it to ${configPath()} first.`);
  }
  return { jid, messages: readMessages(jid, limit) };
}

/** Polls inbox.jsonl (from the current EOF onward) for a send-ack matching `nonce`. */
async function waitForAck(nonce, timeoutMs) {
  const inbox = inboxPath();
  let offset = fs.existsSync(inbox) ? fs.statSync(inbox).size : 0;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const { entries, newOffset } = readNewLines(inbox, offset);
    offset = newOffset;
    for (const entry of entries) {
      if (entry?.type === 'send-ack' && entry.nonce === nonce) return entry;
    }
    if (Date.now() >= deadline) return null;
    await sleep(SEND_ACK_POLL_MS);
  }
}

/**
 * send_chat_message: validates the jid is allowlisted AND canPost is true BEFORE
 * touching anything else, then hands off to the daemon via outbox.jsonl and waits
 * (max 15s) for the matching send-ack in inbox.jsonl. Never calls Baileys directly --
 * only the daemon does that.
 */
export async function sendChatMessage({ jid, text }) {
  const config = loadConfig();
  const chat = findChat(config, jid);
  if (!chat) {
    throw new Error(`"${jid}" is not in the allowlist. Add it to ${configPath()} before sending.`);
  }
  if (!chat.canPost) {
    throw new Error(`"${jid}" (${chat.name}) has canPost:false in ${configPath()}. Set canPost:true to allow sending.`);
  }
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('text must be a non-empty string.');
  }

  const nonce = crypto.randomUUID();
  appendOutboxCommand({ ts: Date.now(), type: 'send', jid, text, nonce });

  const ack = await waitForAck(nonce, SEND_ACK_TIMEOUT_MS);
  if (!ack) {
    throw new Error(
      `Timed out waiting ${SEND_ACK_TIMEOUT_MS / 1000}s for the daemon to send the message. Is 'wa-daemon' running?`,
    );
  }
  if (!ack.ok) {
    throw new Error(`Send failed: ${ack.error || 'unknown error'}`);
  }
  return { sent: true, msgId: ack.msgId };
}

/**
 * poll_chats: drains inbox.jsonl entries newer than the persisted cursor (advancing
 * it), grouped by chat jid. Protocol bookkeeping lines (send-ack) carry a "type"
 * field and are skipped here -- send_chat_message already resolves those directly.
 */
export async function pollChats() {
  const cursor = readCursor();
  const { entries, newOffset } = readNewLines(inboxPath(), cursor.offset);
  writeCursor({ offset: newOffset });

  const grouped = {};
  for (const entry of entries) {
    if (entry?.type) continue;
    const jid = entry.chatJid || 'unknown';
    if (!grouped[jid]) grouped[jid] = [];
    grouped[jid].push(entry);
  }
  return grouped;
}

function textResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(err) {
  return {
    content: [{ type: 'text', text: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }],
    isError: true,
  };
}

/** Every tool failure -- including an allowlist refusal -- reaches the model as a
 *  readable text result with isError:true, never a transport-level error, so the
 *  model can read why it was refused and stop instead of retrying blindly. */
function guard(fn) {
  return async (args) => {
    try {
      return textResult(await fn(args));
    } catch (err) {
      return errorResult(err);
    }
  };
}

export function buildServer() {
  const server = new McpServer(
    { name: 'whatsapp-assistant', version: '0.1.0' },
    {
      instructions:
        'Reads and posts in a fixed allowlist of WhatsApp chats via a background daemon. Only ' +
        'chats returned by list_chats can be used; any other jid is refused. Sending requires ' +
        'canPost:true for that chat. Messages you post are visible to real people immediately ' +
        'and cannot be unsent through this server.',
    },
  );

  server.registerTool(
    'list_chats',
    {
      title: 'List allowed WhatsApp chats',
      description:
        'Lists the WhatsApp chats this server may touch: jid, display name, whether sending is ' +
        'allowed (canPost), and a lightweight recent-activity count. Never lists any other chat.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(() => listChats()),
  );

  server.registerTool(
    'read_chat_messages',
    {
      title: 'Read WhatsApp chat messages',
      description:
        'Reads the last N stored messages for one allowlisted chat, oldest first. Messages come ' +
        'from the local inbox log, not a live WhatsApp fetch, so this works even when WhatsApp is ' +
        'briefly unreachable.',
      inputSchema: {
        jid: z.string().describe('WhatsApp chat jid, must be on the allowlist'),
        limit: z.number().int().min(1).max(500).optional().describe('Max messages, default 30'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(({ jid, limit }) => readChatMessages({ jid, limit: limit ?? 30 })),
  );

  server.registerTool(
    'send_chat_message',
    {
      title: 'Send a WhatsApp chat message',
      description:
        'Sends a text message to an allowlisted chat that has canPost enabled. Handed off to the ' +
        'background daemon -- the only process holding the WhatsApp connection -- and waits up to ' +
        '15s for delivery confirmation. Real people read this immediately; it cannot be unsent.',
      inputSchema: {
        jid: z.string().describe('WhatsApp chat jid, must be allowlisted with canPost: true'),
        text: z.string().min(1).describe('Message text to send'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    guard(({ jid, text }) => sendChatMessage({ jid, text })),
  );

  server.registerTool(
    'poll_chats',
    {
      title: 'Poll for new WhatsApp messages',
      description:
        'Drains messages that arrived since the last poll_chats call, grouped by chat jid. The ' +
        'read position is persisted, so each message is returned exactly once across calls.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(() => pollChats()),
  );

  return server;
}

async function main() {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  // stdout is the MCP transport. Anything human-readable goes to stderr or it corrupts the protocol.
  process.stderr.write('whatsapp-assistant-mcp ready (stdio)\n');
}

const isEntryPoint = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntryPoint) {
  main().catch((err) => {
    process.stderr.write(`whatsapp-assistant-mcp failed to start: ${err.message}\n`);
    process.exit(1);
  });
}
