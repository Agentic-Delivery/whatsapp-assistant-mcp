// Loads and validates the WhatsApp assistant's chat allowlist.
//
// The allowlist is the whole blast-radius control for this project: every tool in
// mcp-server.js and every inbound message in daemon.js checks a chat's jid against
// it before touching anything. An empty or missing allowlist is a startup error,
// never "allow everything" -- that is almost always a misconfiguration, not intent.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Base directory for all local state: auth keys, config, inbox/outbox, logs. */
export function waHome() {
  return process.env.WA_HOME || path.join(os.homedir(), '.whatsapp-assistant');
}

export function configPath() {
  return path.join(waHome(), 'wa-mcp.config.json');
}

const EXAMPLE_CONFIG = {
  chats: [
    { jid: '1234567890@s.whatsapp.net', name: 'Example contact', canPost: false },
  ],
};

function exampleBlock() {
  return JSON.stringify(EXAMPLE_CONFIG, null, 2);
}

/**
 * Reads and validates ~/.whatsapp-assistant/wa-mcp.config.json (or $WA_HOME
 * equivalent). Throws a helpful, self-contained error -- naming the exact file path
 * and showing the expected shape -- on any of: missing file, invalid JSON, missing
 * "chats" array, empty "chats" array, or a chat entry missing "jid". Never returns a
 * partially-valid config.
 */
export function loadConfig() {
  const file = configPath();

  if (!fs.existsSync(file)) {
    throw new Error(
      `WhatsApp assistant config not found at ${file}\n\n` +
        'Create it with at least one allowlisted chat, e.g.:\n\n' +
        `${exampleBlock()}\n\n` +
        '"canPost" defaults to false when omitted. Only chats listed here are ever read from or sent to.',
    );
  }

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`WhatsApp assistant config at ${file} could not be read: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`WhatsApp assistant config at ${file} is not valid JSON: ${err.message}`);
  }

  const chats = parsed && Array.isArray(parsed.chats) ? parsed.chats : null;
  if (!chats || chats.length === 0) {
    throw new Error(
      `WhatsApp assistant config at ${file} has an empty or missing "chats" allowlist.\n\n` +
        'Add at least one chat, e.g.:\n\n' +
        `${exampleBlock()}\n\n` +
        'Only chats listed here are ever read from or sent to.',
    );
  }

  const seen = new Set();
  const normalized = chats.map((entry, index) => {
    if (!entry || typeof entry.jid !== 'string' || entry.jid.trim() === '') {
      throw new Error(
        `WhatsApp assistant config at ${file}: chats[${index}] is missing a non-empty "jid" string.`,
      );
    }
    const jid = entry.jid.trim();
    if (seen.has(jid)) {
      throw new Error(`WhatsApp assistant config at ${file}: chats contains "${jid}" twice.`);
    }
    seen.add(jid);
    const canPost = entry.canPost === true;
    // canRead defaults to true. canRead:false makes the chat write-only: its incoming messages are
    // never stored and no read tool returns them, but it can still be posted to (e.g. an operator's
    // alert channel that the agent must not read).
    const canRead = entry.canRead !== false;
    if (!canRead && !canPost) {
      throw new Error(
        `WhatsApp assistant config at ${file}: chats[${index}] ("${jid}") has canRead:false and canPost:false, so it can neither be read nor posted to. Remove it or allow one of them.`,
      );
    }
    return {
      jid,
      name: typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : jid,
      canPost,
      canRead,
    };
  });

  return { chats: normalized, retention: parseRetention(parsed.retention, file), speech: parseSpeech(parsed.speech, file) };
}

/**
 * Optional retention for saved voice notes (recordings of people's voices are personal data):
 *   "retention": { "voiceNoteDays": 30, "voiceNoteMaxMB": 200 }
 * Either key may be omitted; with no "retention" block nothing is ever deleted.
 */
function parseRetention(r, file) {
  if (r === undefined || r === null) return { voiceNoteDays: null, voiceNoteMaxMB: null };
  if (typeof r !== 'object' || Array.isArray(r)) throw new Error(`WhatsApp assistant config at ${file}: "retention" must be an object.`);
  const num = (k) => {
    if (r[k] === undefined || r[k] === null) return null;
    if (typeof r[k] !== 'number' || !(r[k] > 0)) throw new Error(`WhatsApp assistant config at ${file}: retention.${k} must be a positive number.`);
    return r[k];
  };
  return { voiceNoteDays: num('voiceNoteDays'), voiceNoteMaxMB: num('voiceNoteMaxMB') };
}

/** Finds an allowlist entry by exact jid match, or null if the jid isn't allowlisted. */
export function findChat(config, jid) {
  if (!jid) return null;
  return config.chats.find((c) => c.jid === jid) || null;
}

/**
 * Optional speech commands (argv arrays, run without a shell):
 *   "speech": {
 *     "transcribe": ["python3", "tools/transcribe.py", "{input}"],
 *     "speak": ["python3", "tools/speak.py", "--text-file", "{textFile}", "--output", "{output}"]
 *   }
 * Either may be omitted; without them voice notes are only saved and no voice can be spoken.
 */
function parseSpeech(sp, file) {
  if (sp === undefined || sp === null) return { transcribe: null, speak: null };
  if (typeof sp !== 'object' || Array.isArray(sp)) throw new Error(`WhatsApp assistant config at ${file}: "speech" must be an object.`);
  for (const k of Object.keys(sp)) {
    if (k !== 'transcribe' && k !== 'speak') throw new Error(`WhatsApp assistant config at ${file}: unknown key speech.${k} (only "transcribe" and "speak" are supported).`);
  }
  const cmd = (k, needs) => {
    if (sp[k] === undefined || sp[k] === null) return null;
    const c = sp[k];
    if (!Array.isArray(c) || c.length === 0 || !c.every((x) => typeof x === 'string' && x !== '')) {
      throw new Error(`WhatsApp assistant config at ${file}: speech.${k} must be a non-empty array of strings (program and arguments).`);
    }
    for (const n of needs) {
      if (!c.some((x) => x.includes(`{${n}}`))) throw new Error(`WhatsApp assistant config at ${file}: speech.${k} must contain the {${n}} placeholder.`);
    }
    return c;
  };
  return { transcribe: cmd('transcribe', ['input']), speak: cmd('speak', ['textFile', 'output']) };
}
