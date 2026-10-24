#!/usr/bin/env node
// Stdio MCP server (name: whatsapp-assistant). Exposes nine tools: list_chats,
// read_chat_messages, poll_chats, send_chat_message, send_chat_document,
// send_chat_image, send_chat_voice_note, speak_voice_note and react_to_message.
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
import { MAX_SPEAK_CHARS, removeSpokenFile, speakToFile } from './speech.js';
import { appendOutboxCommand, checkSendableFile, cursorPath, inboxPath, readMessages, readNewLines, tailJsonLines } from './wa-client.js';

const SEND_ACK_TIMEOUT_MS = 15000;
const SEND_ACK_POLL_MS = 200;
// A file has to upload before WhatsApp echoes it back, so file sends wait longer for the ack.
const FILE_ACK_TIMEOUT_MS = 90000;

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
export async function sendChatMessage({ jid, text, mentions = [] }) {
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
  appendOutboxCommand({ ts: Date.now(), type: 'send', jid, text, nonce, ...(mentions.length ? { mentions } : {}) });

  const ack = await waitForAck(nonce, SEND_ACK_TIMEOUT_MS);
  if (!ack) {
    throw new Error(
      `Timed out waiting ${SEND_ACK_TIMEOUT_MS / 1000}s for the daemon to send the message. Is 'wa-daemon' running?`,
    );
  }
  if (!ack.ok) {
    throw new Error(`Send failed: ${ack.error || 'unknown error'}`);
  }
  // Surface what ARRIVED, not just that the attempt was acked: the daemon's
  // echo verification (or its absence) travels with the tool result.
  return { sent: true, msgId: ack.msgId, verified: ack.verified ?? null, ...(ack.warning ? { warning: ack.warning } : {}) };
}

/** The allowlist + canPost gate every sending tool shares. */
function postableChat(jid, verb) {
  const config = loadConfig();
  const chat = findChat(config, jid);
  if (!chat) {
    throw new Error(`"${jid}" is not in the allowlist. Add it to ${configPath()} before ${verb}.`);
  }
  if (!chat.canPost) {
    throw new Error(`"${jid}" (${chat.name}) has canPost:false in ${configPath()}. Set canPost:true to allow sending.`);
  }
  return chat;
}

async function sendFileCommand(command, what) {
  const nonce = crypto.randomUUID();
  appendOutboxCommand({ ts: Date.now(), nonce, ...command });
  const ack = await waitForAck(nonce, FILE_ACK_TIMEOUT_MS);
  if (!ack) {
    throw new Error(`Timed out waiting ${FILE_ACK_TIMEOUT_MS / 1000}s for the daemon to send the ${what}. Is 'wa-daemon' running?`);
  }
  if (!ack.ok) {
    throw new Error(`Send failed: ${ack.error || 'unknown error'}`);
  }
  return { sent: true, msgId: ack.msgId, verified: ack.verified ?? null, ...(ack.warning ? { warning: ack.warning } : {}) };
}

/**
 * send_chat_document: sends a file as a document to an allowlisted chat with canPost
 * enabled. The daemon reads the file itself, so path must be absolute and readable by
 * the daemon's user. The file name (default: the file's own name) must carry a real
 * extension -- it is what the recipient's client uses to open the file.
 */
export async function sendChatDocument({ jid, path: filePath, fileName, caption }) {
  postableChat(jid, 'sending');
  checkSendableFile('document', filePath, fileName);
  return sendFileCommand({ type: 'send-file', jid, path: filePath, ...(fileName ? { fileName } : {}), ...(caption ? { caption } : {}) }, 'document');
}

/**
 * send_chat_image: sends a PNG or JPEG as an image message, so it renders inline in
 * the chat (a screenshot, a rendered design) instead of arriving as a file.
 */
export async function sendChatImage({ jid, path: filePath, caption }) {
  postableChat(jid, 'sending');
  checkSendableFile('image', filePath);
  return sendFileCommand({ type: 'send-image', jid, path: filePath, ...(caption ? { caption } : {}) }, 'image');
}

/**
 * send_chat_voice_note: sends an Ogg/Opus file as a voice note, so it plays inline like a
 * recorded message. Voice notes carry no caption, so the agent marker cannot be stamped on
 * them -- the audio itself should say who is speaking.
 */
export async function sendChatVoiceNote({ jid, path: filePath }) {
  postableChat(jid, 'sending');
  checkSendableFile('voice', filePath);
  return sendFileCommand({ type: 'send-voice', jid, path: filePath }, 'voice note');
}

/**
 * speak_voice_note: turns text into a voice note with the configured speak command (speech.speak) and sends it.
 * The generated audio lives in the system temp directory only until the send is acked, then it is deleted.
 */
export async function speakVoiceNote({ jid, text }) {
  postableChat(jid, 'sending');
  if (typeof text !== 'string' || text.trim() === '') throw new Error('text must be a non-empty string.');
  if (text.length > MAX_SPEAK_CHARS) throw new Error(`text is ${text.length} characters; a voice note is limited to ${MAX_SPEAK_CHARS}.`);
  const { speech } = loadConfig();
  if (!speech?.speak) {
    throw new Error(`speech.speak is not configured in ${configPath()}; see "Speech" in the README to set up a voice.`);
  }
  const file = await speakToFile(speech.speak, text.trim());
  try {
    checkSendableFile('voice', file);
    return await sendFileCommand({ type: 'send-voice', jid, path: file }, 'voice note');
  } finally {
    removeSpokenFile(file);
  }
}

/**
 * react_to_message: puts an emoji reaction on one message in an allowlisted chat
 * (canPost required, same as sending), handed off to the daemon via outbox.jsonl
 * and confirmed by its ack. An empty emoji removes this account's reaction.
 * In a group the target's sender must be given as participant so WhatsApp can
 * address the right message; fromMe marks a message this account sent itself.
 */
export async function reactToMessage({ jid, msgId, emoji, participant, fromMe }) {
  const config = loadConfig();
  const chat = findChat(config, jid);
  if (!chat) {
    throw new Error(`"${jid}" is not in the allowlist. Add it to ${configPath()} before reacting.`);
  }
  if (!chat.canPost) {
    throw new Error(`"${jid}" (${chat.name}) has canPost:false in ${configPath()}. Set canPost:true to allow reactions.`);
  }
  if (typeof msgId !== 'string' || msgId.trim() === '') {
    throw new Error('msgId must be a non-empty string.');
  }
  if (typeof emoji !== 'string') {
    throw new Error('emoji must be a string (empty string removes the reaction).');
  }

  const nonce = crypto.randomUUID();
  appendOutboxCommand({
    ts: Date.now(),
    type: 'react',
    jid,
    nonce,
    msgId,
    emoji,
    ...(participant ? { participant } : {}),
    ...(fromMe ? { fromMe: true } : {}),
  });

  const ack = await waitForAck(nonce, SEND_ACK_TIMEOUT_MS);
  if (!ack) {
    throw new Error(
      `Timed out waiting ${SEND_ACK_TIMEOUT_MS / 1000}s for the daemon to send the reaction. Is 'wa-daemon' running?`,
    );
  }
  if (!ack.ok) {
    throw new Error(`Reaction failed: ${ack.error || 'unknown error'}`);
  }
  return { reacted: true, target: msgId, emoji, ...(ack.warning ? { warning: ack.warning } : {}) };
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
    // Protocol bookkeeping (send-acks, media notes) is skipped; a voice-note transcript is content, so it stays.
    if (entry?.type && entry.type !== 'transcript') continue;
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
        mentions: z.array(z.string()).optional().describe(
          'Person jids to tag (<number>@s.whatsapp.net or <number>@lid); the text must contain "@<number>" for each, ' +
          'or the daemon refuses the send'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    guard(({ jid, text, mentions }) => sendChatMessage({ jid, text, mentions: mentions ?? [] })),
  );

  server.registerTool(
    'send_chat_document',
    {
      title: 'Send a file to a WhatsApp chat',
      description:
        'Sends a file as a document to an allowlisted chat that has canPost enabled, with an ' +
        'optional caption. The daemon reads the file, so path must be absolute and readable by ' +
        'the daemon\'s user; the file name needs a real extension (.pdf, .docx, ...) and the file ' +
        'must be at most 100 MB. Waits for the delivery to be confirmed. Real people read this ' +
        'immediately; it cannot be unsent.',
      inputSchema: {
        jid: z.string().describe('WhatsApp chat jid, must be allowlisted with canPost: true'),
        path: z.string().min(1).describe('Absolute path to the file'),
        fileName: z.string().optional().describe('Name the recipient sees, with extension; default: the file\'s own name'),
        caption: z.string().optional().describe('Optional text shown with the file'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    guard(({ jid, path: filePath, fileName, caption }) => sendChatDocument({ jid, path: filePath, fileName, caption })),
  );

  server.registerTool(
    'send_chat_image',
    {
      title: 'Send an image to a WhatsApp chat',
      description:
        'Sends a PNG or JPEG as an image message, so it shows inline in the chat (use ' +
        'send_chat_document for other files), to an allowlisted chat that has canPost enabled, ' +
        'with an optional caption. path must be absolute and readable by the daemon\'s user; at ' +
        'most 16 MB. Waits for the delivery to be confirmed. Real people see this immediately; ' +
        'it cannot be unsent.',
      inputSchema: {
        jid: z.string().describe('WhatsApp chat jid, must be allowlisted with canPost: true'),
        path: z.string().min(1).describe('Absolute path to a .png, .jpg or .jpeg file'),
        caption: z.string().optional().describe('Optional text shown under the image'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    guard(({ jid, path: filePath, caption }) => sendChatImage({ jid, path: filePath, caption })),
  );

  server.registerTool(
    'send_chat_voice_note',
    {
      title: 'Send a voice note to a WhatsApp chat',
      description:
        'Sends an Ogg/Opus .ogg file as a voice note (plays inline like a recorded message) to an ' +
        'allowlisted chat that has canPost enabled. Voice notes have no caption and cannot carry the ' +
        'agent marker, so the recording itself should make clear it comes from an assistant. path must ' +
        'be absolute and readable by the daemon\'s user; at most 16 MB. Waits for the delivery to be ' +
        'confirmed. Real people hear this immediately; it cannot be unsent.',
      inputSchema: {
        jid: z.string().describe('WhatsApp chat jid, must be allowlisted with canPost: true'),
        path: z.string().min(1).describe('Absolute path to an Ogg/Opus .ogg file'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    guard(({ jid, path: filePath }) => sendChatVoiceNote({ jid, path: filePath })),
  );

  server.registerTool(
    'speak_voice_note',
    {
      title: 'Speak text as a WhatsApp voice note',
      description:
        'Turns text into speech with the locally configured voice (speech.speak in the config) and sends it ' +
        `as a voice note to an allowlisted chat that has canPost enabled. At most ${MAX_SPEAK_CHARS} characters. A voice ` +
        'note cannot carry the agent marker, so the spoken text should make clear it comes from an ' +
        'assistant. Fails with a setup hint when no voice is configured. Real people hear this immediately; ' +
        'it cannot be unsent.',
      inputSchema: {
        jid: z.string().describe('WhatsApp chat jid, must be allowlisted with canPost: true'),
        text: z.string().min(1).max(MAX_SPEAK_CHARS).describe(`What to say, at most ${MAX_SPEAK_CHARS} characters`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    guard(({ jid, text }) => speakVoiceNote({ jid, text })),
  );

  server.registerTool(
    'react_to_message',
    {
      title: 'React to a WhatsApp message with an emoji',
      description:
        'Puts one emoji reaction on a message in an allowlisted chat with canPost enabled -- the ' +
        'lightweight way to acknowledge a message without posting text. Handed off to the daemon ' +
        'and confirmed by its ack. An empty emoji removes this account\'s reaction. In a group, ' +
        'pass the target message\'s sender jid as participant.',
      inputSchema: {
        jid: z.string().describe('WhatsApp chat jid, must be allowlisted with canPost: true'),
        msgId: z.string().min(1).describe('Id of the message to react to (from poll_chats or read_chat_messages)'),
        emoji: z.string().describe('The reaction emoji; empty string removes the reaction'),
        participant: z.string().optional().describe('Sender jid of the target message (needed in groups)'),
        fromMe: z.boolean().optional().describe('True if the target message was sent by this account'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    guard(({ jid, msgId, emoji, participant, fromMe }) => reactToMessage({ jid, msgId, emoji, participant, fromMe })),
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
  // Exit through process.exit on a stop signal, so exit handlers run (speech.js stops a running voice engine
  // and deletes its temp folder there).
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
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
