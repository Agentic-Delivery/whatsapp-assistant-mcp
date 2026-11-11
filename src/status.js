// `/status` (owner, 2026-11-11): a person whose only window is the chat writes `/status` and gets, at once and with no
// model turn, what the factory is doing. The factory's runner writes the report (status.txt, with status.json beside it
// for its `at`); the daemon only reads it and answers with a quoted reply. The `/status` message is never written to any
// inbox: it is a question to the machinery, not to the factory.

import fs from 'node:fs';
import path from 'node:path';

export const STATUS_UNAVAILABLE = 'Status unavailable';
const MAX_TEXT = 4000;

/** True when the whole text, trimmed and in any case, is `/status`. */
export function isStatusCommand(record) {
  return typeof record?.text === 'string' && record.text.trim().toLowerCase() === '/status' && !record.type;
}

/** The report text to send, or a short reason it is unavailable. `now` in ms. */
export function readStatusReport(statusFile, { now = Date.now(), maxAgeMs = 5 * 60_000, chatId = null } = {}) {
  let text;
  try {
    text = fs.readFileSync(statusFile, 'utf8');
  } catch {
    return `${STATUS_UNAVAILABLE}: the factory has not written a report.`;
  }
  let at = null;
  let waiting = [];
  try {
    const json = JSON.parse(fs.readFileSync(path.join(path.dirname(statusFile), 'status.json'), 'utf8'));
    at = Date.parse(json.at);
    // Only the questions asked in THIS chat (review, 2026-11-11): a chat never sees another chat's question.
    if (chatId && Array.isArray(json.waiting)) waiting = json.waiting.filter((w) => w && w.chatId === chatId);
  } catch {
    at = null;
  }
  if (!Number.isFinite(at)) {
    try {
      at = fs.statSync(statusFile).mtimeMs;
    } catch {
      at = null;
    }
  }
  const offline = /^Offline:/m.test(text);
  if (!offline && at !== null && now - at > maxAgeMs) {
    return `${STATUS_UNAVAILABLE}: the factory's last report is ${Math.round((now - at) / 60_000)} minutes old.`;
  }
  let body = text.trim();
  if (waiting.length) body += `\n\nWaiting for your answer:\n${waiting.map((w) => `• since ${w.since}: ${w.question || 'a question'}`).join('\n')}`;
  return body.length > MAX_TEXT ? `${body.slice(0, MAX_TEXT - 1)}…` : body;
}

/** Who may ask: a sender on `users` (compared without device suffix). An empty list means nobody: /status is off. */
export function statusSenderAllowed(users, senderJid) {
  if (!Array.isArray(users) || users.length === 0 || typeof senderJid !== 'string') return false;
  const bare = (j) => j.replace(/:\d+@/, '@');
  return users.map(bare).includes(bare(senderJid));
}
