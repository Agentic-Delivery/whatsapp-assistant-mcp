// A dependency of the WhatsApp client prints whole session records with
// console.info / console.warn when a session is opened or closed. Those records
// hold private key material, and under a service manager everything the daemon
// prints ends up in the system journal. These tests run the real library call in
// a child process and read what actually reaches stdout and stderr.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = 'FAKE-KEY-MATERIAL-0123456789';

// Every form the marker bytes can take when Node prints a Buffer or a string.
function markerForms() {
  const buf = Buffer.from(MARKER);
  return [MARKER, buf.toString('hex'), buf.toString('base64'), buf.toString('hex').match(/../g).join(' ')];
}

function runChild(setupImport) {
  const script = `
    ${setupImport}
    import { createRequire } from 'node:module';
    const require = createRequire(${JSON.stringify(path.join(ROOT, 'package.json'))});
    const SessionRecord = require('libsignal/src/session_record');
    const key = Buffer.from(${JSON.stringify(MARKER)});
    const session = {
      registrationId: 1,
      currentRatchet: { rootKey: key, ephemeralKeyPair: { pubKey: key, privKey: key } },
      indexInfo: { baseKey: key, closed: -1, used: 1, created: 1, remoteIdentityKey: key },
    };
    const record = new SessionRecord();
    record.setSession(session);
    record.closeSession(session);   // console.info("Closing session:", session)
    record.closeSession(session);   // console.warn("Session already closed", session)
    record.openSession(session);    // console.info("Opening session:", session)
    console.error(new Error('plain failure text'));
    console.log('a plain line', 42);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout + r.stderr;
}

test('without the redaction the library prints key material (the test can go red)', () => {
  const out = runChild('');
  assert.ok(markerForms().some((f) => out.includes(f)), 'expected the unprotected library call to print the session keys');
});

test('installConsoleRedaction keeps the message and drops the object', () => {
  const out = runChild(`import { installConsoleRedaction } from ${JSON.stringify(path.join(ROOT, 'src/console-redact.js'))}; installConsoleRedaction();`);
  for (const form of markerForms()) assert.ok(!out.includes(form), `key material reached the output as: ${form}`);
  assert.ok(!/privKey|rootKey|<Buffer/.test(out), 'a session record field reached the output');
  assert.match(out, /Closing session:/);
  assert.match(out, /Session already closed/);
  assert.match(out, /Opening session:/);
  assert.match(out, /plain failure text/, 'an Error keeps its message');
  assert.match(out, /a plain line 42/, 'strings and numbers pass unchanged');
});

test('the daemon module installs the redaction when it is loaded', () => {
  const out = runChild(`import ${JSON.stringify(path.join(ROOT, 'src/daemon.js'))};`);
  for (const form of markerForms()) assert.ok(!out.includes(form), `key material reached the output as: ${form}`);
  assert.match(out, /Closing session:/);
});

test('console.assert and console.group do not print an object either', () => {
  const out = runChild(`import { installConsoleRedaction } from ${JSON.stringify(path.join(ROOT, 'src/console-redact.js'))}; installConsoleRedaction();
    const k = Buffer.from(${JSON.stringify(MARKER)}); console.assert(false, { privKey: k }); console.group({ privKey: k }); console.groupEnd();`);
  for (const form of markerForms()) assert.ok(!out.includes(form), `key material reached the output as: ${form}`);
});
