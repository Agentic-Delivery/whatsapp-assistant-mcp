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
export function readStatusReport(statusFile, { now = Date.now(), maxAgeMs = 5 * 60_000 } = {}) {
  let text;
  try {
    text = fs.readFileSync(statusFile, 'utf8');
  } catch {
    return `${STATUS_UNAVAILABLE}: the factory has not written a report.`;
  }
  let at = null;
  try {
    at = Date.parse(JSON.parse(fs.readFileSync(path.join(path.dirname(statusFile), 'status.json'), 'utf8')).at);
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
  const body = text.trim();
  return body.length > MAX_TEXT ? `${body.slice(0, MAX_TEXT - 1)}…` : body;
}
