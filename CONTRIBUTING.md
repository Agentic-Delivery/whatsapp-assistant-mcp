# Contributing

## Dev setup

```bash
git clone https://github.com/Agentic-Delivery/whatsapp-assistant-mcp.git
cd whatsapp-assistant-mcp
npm ci
npm test
```

No build step -- plain JS, ESM, Node 20+.

## Tests never touch a real WhatsApp connection

`src/wa-client.js` loads `@whiskeysockets/baileys` unless the `WA_CLIENT_FAKE`
environment variable points at a stand-in module exporting the same shape (default
export = socket factory, plus `useMultiFileAuthState` and `DisconnectReason` named
exports). The test suite (`tests/smoke.test.mjs`) sets this to
`tests/fixtures/fake-baileys.js` before exercising `connect()`, so no test -- existing
or new -- ever opens a real network connection or touches a real phone's session. Any
test that needs new connection-level behavior should extend the fake, never skip the
seam and call Baileys for real.

Every test also points `WA_HOME` at its own temporary directory, never
`~/.whatsapp-assistant`, so tests can't collide with (or corrupt) a real local session.

## Commit style

Small, focused commits. A one-line summary in the imperative mood (`fix: ...`,
`feat: ...`, `docs: ...`, `test: ...`, `chore: ...`), with a body explaining *why* when
it isn't obvious from the diff alone.

## Before opening a PR

- `npm test` is green.
- `node --check <file>` is clean on every JS file you touched.
- New behavior has a test; bug fixes have a test that fails before the fix and passes
  after it.
- No secrets, phone numbers, or real chat/group identifiers in code, tests, fixtures, or
  commit messages -- see [SECURITY.md](SECURITY.md).
