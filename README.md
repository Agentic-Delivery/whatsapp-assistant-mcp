<!--
  Mascot artwork for this repo lands via the company visual-identity pipeline.
  Once docs/assets/mascot.png exists, drop the HTML comment markers around the
  block below.

<p align="center"><img src="docs/assets/mascot.png" width="160" alt="whatsapp-assistant-mcp mascot"/></p>
-->

# whatsapp-assistant-mcp

*A stdio MCP server that lets a Claude Code agent read and post in a fixed allowlist of WhatsApp chats.*

[![CI](https://github.com/Agentic-Delivery/whatsapp-assistant-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Agentic-Delivery/whatsapp-assistant-mcp/actions/workflows/ci.yml)
[![License: Elastic-2.0](https://img.shields.io/badge/license-Elastic--2.0-blue.svg)](LICENSE)

A stdio MCP server plus a small background daemon that holds the actual WhatsApp
connection. A strict chat allowlist is the only thing standing between "an agent with a
WhatsApp connection" and "an agent that can message anyone," and it is a startup error
to run without one. Same design lineage as its Microsoft Teams sibling -- see
[Related project](#related-project).

Plain JS, ESM, no build step. Node 20+.

## Why

- **Allowlist-first safety** -- every tool call and every inbound message is checked
  against a fixed chat allowlist before anything else happens. An empty or missing
  allowlist is a startup error, never "allow everything."
- **One WhatsApp connection, ever** -- Baileys (the WhatsApp library this project uses)
  refuses a second simultaneous connection on the same auth session, so exactly one
  process (`wa-daemon`) is ever allowed to hold it; everything else talks to that
  process, never to WhatsApp directly.
- **A file-based inbox/outbox protocol** -- the MCP server and the daemon are separate
  processes that never share memory. They hand messages to each other through
  append-only JSONL files (`inbox.jsonl`, `outbox.jsonl`), so either side can restart
  independently without losing state.
- **A mechanical signature, not a suggestion** -- every outgoing message is prefixed
  with a robot marker (🤖) before it leaves the daemon, so on a shared or personal
  account, anyone reading the chat can tell a message came from the assistant, not the
  human.

## Quickstart

Requires Node.js 20+.

```bash
git clone https://github.com/Agentic-Delivery/whatsapp-assistant-mcp.git
cd whatsapp-assistant-mcp
npm ci
```

### 1. Pair

Prefer a code instead of scanning a QR:

```bash
node src/pair.js --code 15551234567   # international format, digits only
```

or scan the printed QR code with WhatsApp: **Settings > Linked Devices > Link a
Device**:

```bash
node src/pair.js
```

On success this prints `PAIRED as <jid>` and exits. Auth state is saved under
`~/.whatsapp-assistant/auth/` (`chmod 700`). See [Troubleshooting](#troubleshooting) if
the code seems to hang for a moment, or the connection closes and reopens right after --
both are normal.

### 2. Create the allowlist

```bash
mkdir -p ~/.whatsapp-assistant
cp wa-mcp.config.example.json ~/.whatsapp-assistant/wa-mcp.config.json
```

Edit it and replace the placeholder jids with real ones -- individual chats end in
`@s.whatsapp.net`, groups end in `@g.us`. `canPost` defaults to (and should stay)
`false` until you mean it. Both `wa-daemon` and `wa-mcp` refuse to do anything useful
with an empty or missing allowlist.

### 3. Run the daemon

```bash
nohup node src/daemon.js >> ~/.whatsapp-assistant/daemon.out.log 2>&1 &
```

It reconnects automatically on drops. If the session gets logged out (revoked from the
phone, etc.) it exits and tells you to delete the auth directory and re-pair. See
[Autostart](#autostart) to run it as a proper service instead of `nohup`.

### 4. Register the MCP server

Run this from inside your clone, so the path resolves to wherever you actually put it --
never hardcode a home directory:

```bash
claude mcp add whatsapp-assistant -- node "$(pwd)/src/mcp-server.js"
```

## Autostart

To have `wa-daemon` survive reboots and terminal closures, run it as a systemd **user**
service instead of `nohup`.

`~/.config/systemd/user/wa-daemon.service`:

```ini
[Unit]
Description=whatsapp-assistant-mcp background daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/whatsapp-assistant-mcp
ExecStart=/usr/bin/env node src/daemon.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

`%h` expands to your home directory. If you cloned this repo somewhere other than
directly under `$HOME`, edit `WorkingDirectory` to match your actual path first. Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now wa-daemon.service
loginctl enable-linger "$USER"   # keep it running after you log out
```

**Under WSL**, user services need systemd turned on first. Add to `/etc/wsl.conf`:

```ini
[boot]
systemd=true
```

then restart WSL (`wsl --shutdown`, from Windows) before the `systemctl --user`
commands above will work.

## Architecture

```
   WhatsApp  (Baileys, exactly one socket)
       |
       v
 +--------------+
 |  wa-daemon   |----- creds.json + keys, atomic tmp+rename writes
 +--------------+      ~/.whatsapp-assistant/auth/
   |          ^
 append     watch + drain
   v          |
inbox.jsonl  outbox.jsonl
   ^          |
   |          v
 +--------------+
 |   wa-mcp     |  <-- stdio -->  Claude Code / any MCP client
 +--------------+
```

Baileys refuses a second simultaneous connection on the same auth session, so exactly
one process -- `wa-daemon` -- is ever allowed to hold it. `wa-mcp` never opens its own
connection: it reads `inbox.jsonl` for history (which keeps working even while WhatsApp
is briefly unreachable) and hands off sends to the daemon through `outbox.jsonl`,
waiting for an acknowledgement.

This isn't just a "the library says so" rule. A second process racing the first for the
same session doesn't just fail to connect -- it can corrupt `creds.json` mid-write,
which is a real failure class this project hit during development and has since closed
by construction: see [`src/atomic-auth.js`](src/atomic-auth.js). Every auth-state write
goes through a temp-file-then-rename on the same directory, so a crash at any instant
leaves either the fully-old file or the fully-new one, never a half-written one. A
session lock held by a process that's no longer alive is detected and taken over
automatically; a lock held by a live process is refused rather than raced.

## Tools

| Tool | What it does |
|---|---|
| `list_chats` | Allowlisted chats with jid, name, `canPost`, and a lightweight recent-activity count |
| `read_chat_messages` | Last N stored messages for one allowlisted chat, oldest first -- read from the local inbox log, not a live fetch |
| `send_chat_message` | Sends a text message via the daemon and waits up to 15s for delivery confirmation; requires `canPost: true` |
| `poll_chats` | Messages that arrived since the last call, grouped by chat jid; the read position is persisted, so each message is returned exactly once |

Every tool validates the jid against the allowlist before touching anything else. An
unknown jid is refused with an error naming the config file; sending additionally
requires `canPost: true`. There is no bulk-send or broadcast tool -- one call sends one
message to one chat.

## Troubleshooting

Four failure modes came up repeatedly during development. All four are already handled
by the code -- this section explains what you're seeing and why it's fine.

**A pairing code seems to hang for a few seconds.** `--code` only requests a pairing
code once the socket signals it's ready, and only after presenting a real desktop
browser signature -- WhatsApp's server closes the connection immediately if it sees the
library's default signature on this flow. A short pause here is that handshake
completing, not a hang.

**The connection closes with status 515 right after you enter the code (or scan the
QR), then immediately reconnects.** This is expected: it's WhatsApp's own protocol
telling the client "pairing configured, restart the connection now," not a failure.
`wa-pair` and `wa-daemon` both honor it automatically, bounded to a few restarts so a
genuine connection flap can't loop forever.

**"Another WhatsApp process (pid N) holds the session -- refusing a second
connection."** Exactly one process may ever hold the Baileys auth session. Check `ps`
for a stray `node` process before assuming anything is broken -- a previous `wa-daemon`
or `wa-pair` may still be running. If the holder is no longer alive, the next attempt
clears the stale lock automatically. The lock lives at
`~/.whatsapp-assistant/session.lock`.

**A torn or empty `auth/creds.json`.** Historically, a process exiting mid-write could
truncate this file; the next reader would see "unregistered" and attempt to re-pair,
which invalidates the real phone link. This is now prevented by construction (see
[Architecture](#architecture)) -- every auth write goes tmp-then-rename, so the file is
never observed half-written. If you somehow still end up with an empty or corrupt
`creds.json`, treat it like a real logout: delete `~/.whatsapp-assistant/auth` and run
`wa-pair` again.

**"Not paired (creds absent or unregistered). Run 'node src/pair.js --code
<number>' first."** You'll see this from `wa-daemon` (or anything other than
`wa-pair`) when there's no valid paired session yet. Registration is deliberately
`wa-pair`'s job alone -- any other entry point that finds unregistered auth state stops
rather than trying to register itself, because a blind registration attempt from the
wrong place is exactly what invalidates a real phone link when state was lost or torn.
Run `wa-pair` first, then start the daemon.

## Security & Terms of Service

- Auth keys and the message store live **only** under `~/.whatsapp-assistant`
  (directory `chmod 700`, files written `0600`) -- never inside this repo, never
  committed. Treat that directory like a credential: anyone who can read it can act as
  your WhatsApp account.
- The chat allowlist in `wa-mcp.config.json` is the blast-radius control. It is
  deliberately a startup error to run with an empty one. Only add chats you actually
  want an agent to read from or post into, and leave `canPost` off until you mean it.
- This tool never bulk-sends. There is no broadcast tool and no batch-send path --
  every send is one explicit call to one chat.
- Automating a personal WhatsApp account through this consumer protocol is against
  WhatsApp's Terms of Service. Use a dedicated number you're prepared to lose, or
  accept that risk knowingly -- this project does not make that call for you.

## Related project

[`teams-assistant-mcp`](https://github.com/Agentic-Delivery/teams-assistant-mcp) is the
Microsoft Teams sibling of this project: same design lineage -- a fixed chat allowlist
as the only blast-radius control, a single background process holding the one real
connection, and no bulk-send path.

## License

[Elastic License 2.0](LICENSE). Free to use, copy, modify, and adapt for your own
organization, including commercially. You may not sell it or offer it to others as a
hosted or managed product.
