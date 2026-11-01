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
`false` until you mean it.

`canRead` defaults to `true`. Set `"canRead": false` to make a chat **write-only**: the agent
can post to it but its messages are never stored in `inbox.jsonl`, never downloaded, and no read
tool returns them (`read_chat_messages` refuses it, `poll_chats` and `list_chats` leave it out).
Use it for a channel the agent must report into but must not read, such as an operator's alert
group shared with other conversations. Both flags must be real booleans when present (`"false"` as a
string is refused), and a chat with both false is refused at startup. The daemon picks up a
`canRead` change in the config without a restart (it re-checks the file on the next incoming
message); a change to `canPost` takes effect for sending after a restart. A reply that quotes a
message from a chat the agent may not read keeps the quoted message's id but not its text
(`replyToTextWithheld: true`). Both `wa-daemon` and `wa-mcp` refuse to do anything useful
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

## Verified sends

Every `send`/`send-file`/`send-image`/`send-voice` ack is **echo-verified**: WhatsApp reflects each sent
message back to the daemon, and that echo is exactly what recipients receive. The
ack therefore reports what *arrived*, not what was attempted — `verified:
{fileName, mimetype, bytes}` for documents (the echo must carry a file name, a real
mimetype and the exact byte count, else `ok:false` with the reason), `verified:
{mimetype, bytes}` for images, `verified: {ptt, mimetype, bytes, seconds}` for voice
notes (the echo must be a voice note, not a plain audio file), and `verified: {text:true}`
for text. If no echo arrives within the timeout (default 15 s,
`echoTimeoutMs` per command) the ack stays `ok:true` with `verified:null` and a
`warning: echo-timeout` — a slow echo never fails a real send, but an unverified
delivery is always visible as such.

## Sending files and images

`send_chat_document` sends a file as a document; `send_chat_image` sends a PNG or
JPEG as an image message, so it shows inline in the chat (a screenshot, a rendered
design). Both use the same allowlist and `canPost` gate and the same echo-verified
ack as text; `send_chat_voice_note` sends a voice note. The MCP server checks every file before writing anything to the
outbox, and the daemon checks it again before sending (this applies to raw
`send-file` commands too):

- the path is **absolute** and points to a non-empty file **readable by the daemon's
  user** (the daemon reads it, not the MCP server);
- documents need an accepted extension, because the recipient's client opens the
  file by it: `.pdf .docx .xlsx .pptx .md .txt .csv .json .html .png .jpg .jpeg .gif
  .webp .zip .mp4 .mov .webm .mp3 .m4a .wav`; images must be `.png`, `.jpg` or
  `.jpeg` (the type is taken from the extension, not by inspecting the bytes);
- voice notes must be Ogg/Opus `.ogg` files (like images, the type is taken from the
  extension, not by inspecting the bytes); convert with `ffmpeg -i in.wav -c:a libopus
  -b:a 32k -ac 1 out.ogg`; a voice note has no caption, so the agent marker cannot be
  stamped on it, and the recording itself should make clear it comes from an assistant;
- limits: 100 MB for documents, 16 MB for images and voice notes;
- nothing inside the bridge's own state directory (`~/.whatsapp-assistant`: auth
  keys, inbox, outbox, downloads) can be sent, symlinks included, so a manipulated
  request cannot send the account's session keys out. To forward a downloaded file,
  copy it elsewhere first.

The raw outbox commands, for scripts that run next to the daemon:

| Command | Shape |
|---|---|
| send a text | `{"type":"send", "jid", "nonce", "text", "mentions?", "quote?"}` |
| send a document | `{"type":"send-file", "jid", "nonce", "path", "fileName?", "caption?"}` |
| send an image | `{"type":"send-image", "jid", "nonce", "path", "caption?"}` |
| send a voice note | `{"type":"send-voice", "jid", "nonce", "path"}` (Ogg/Opus `.ogg`) |
| delete one of this account's own messages for everyone | `{"type":"delete", "jid", "nonce", "msgId"}` |
| show or stop "typing…" | `{"type":"typing", "jid", "nonce", "on"}` |
| mark messages read (blue ticks) | `{"type":"read", "jid", "nonce", "msgIds", "participants?"}` |

`read` marks the listed messages read in one call. In a group each message's sender is
taken from `participants` (`{msgId: senderJid}`) or else from the message's record in
`inbox.jsonl`; an id whose sender is unknown is listed in the ack's `errors` and not marked.
It acks `ok:true, read:[ids]`, obeys the allowlist and `canPost`, and leaves typing alone.

`quote: {msgId, participant?, fromMe?, text?}` sends the text as a WhatsApp reply to that
message (in a group, `participant` is the quoted message's sender; `text` only fills the
preview). The ack is the same as for any text.

`typing` with `on:true` shows "typing…" in the chat and keeps it up (refreshed every 10 s)
until `on:false` or 600 s, then the chat shows paused. It is meant to cover a whole turn: a
message sent to that chat pauses it just before the message and resumes it afterwards. It acks `ok:true, typing:<on>` and obeys the allowlist and `canPost`.

`delete` can only remove a message this account sent; it never touches anyone else's.
Its ack (`ok:true, deleted: <msgId>`) means the revoke was sent, not that the id
belonged to one of this account's messages; an id that was not ours is a no-op.

## Receiving files

Incoming **documents, images, videos, audio files and voice notes** from allowlisted
chats are downloaded to `~/.whatsapp-assistant/downloads/<timestamp>-<filename>` (a
document keeps its sanitized name -- it is untrusted remote input -- while other media
is named by type, such as `image.png`, `video.mp4` or `audio.mp3`). Voice notes go to
their own folder, `downloads/voice-notes/<timestamp>-voice-note.ogg`. Size caps: 200 MB for videos, 25 MB for everything else. A saved
voice note can be transcribed by the bridge itself when speech is configured (see "Speech
(optional)" below), or by an agent with any tool it likes.
Each download adds a `media-saved` line to `inbox.jsonl` carrying `mediaPath`, beside the ordinary
`[document: name]` message record; oversize or failed downloads add a
`media-skipped` / `media-error` line instead, so an absent file is always
explained. The allowlist gates downloads exactly as it gates the inbox:
messages from non-allowlisted chats are neither stored nor downloaded.

## Speech (optional)

The bridge can turn incoming voice notes into text and speak text back as voice notes. Both
run locally with open models -- no API keys -- and both are off until you configure them.

**1. Install the default engines** (Python 3.10 to 3.12 -- Kokoro does not support 3.13 yet -- and ffmpeg):

```bash
python3 -m venv ~/.wa-speech
~/.wa-speech/bin/pip install -r tools/requirements-speech.txt
```

Transcription uses [faster-whisper](https://github.com/SYSTRAN/faster-whisper) and runs on a
GPU when one is usable, otherwise on the CPU. Speaking uses
[Kokoro](https://github.com/hexgrad/kokoro), which runs on a normal CPU. The first run of each
downloads its model.

**2. Add a `speech` block to the config** (use absolute paths):

```json
"speech": {
  "transcribe": ["/path/to/.wa-speech/bin/python", "/path/to/whatsapp-assistant-mcp/tools/transcribe.py", "{input}"],
  "speak": ["/path/to/.wa-speech/bin/python", "/path/to/whatsapp-assistant-mcp/tools/speak.py",
            "--text-file", "{textFile}", "--output", "{output}"]
}
```

Restart the daemon and the MCP server after changing the config.

- **Transcribe:** every saved voice note is passed to the command as `{input}`; whatever it
  prints becomes a `type: "transcript"` record in `inbox.jsonl` (with `text` and `mediaPath`)
  and a `.txt` next to the audio. `poll_chats` delivers transcripts like messages. If the
  command fails, a `transcript-error` record says why. Only real voice notes are transcribed
  (never a document, whatever its name), one at a time, each with a 5-minute limit. A voice
  note still waiting when the daemon stops is not transcribed later; its audio stays saved. Options: `--model` (default `small`;
  `large-v3-turbo` is more accurate), `--languages en,de` for the languages you expect: when
  a short clip's language is unsure it is tried in each of them (slower), and the transcript
  is prefixed `[uncertain] ` because a very short or unclear clip can come out as a phrase
  nobody said; a longer clip detected outside the list is transcribed in the first one.
- **Speak:** `speak_voice_note` writes the text to `{textFile}`, runs the command, and sends
  the Ogg/Opus file it wrote to `{output}` as a voice note; the audio is deleted after sending.
  Options: `--voice` (default `af_heart`) and `--lang` (`a` American English, `b` British
  English). The default install speaks English; Kokoro's other languages need extra packages
  (see its README). Each voice note is made in a private temp folder that is deleted
  afterwards, also when the command fails or times out.

Any other engine works too: the commands are plain programs run without a shell, so point
`transcribe` or `speak` at your own script, as long as it keeps the same placeholders.

## Retention

Saved voice notes are recordings of people's voices, which is personal data. An optional
`retention` block in the config makes the daemon delete them at startup and every hour:

```json
"retention": { "voiceNoteDays": 30, "voiceNoteMaxMB": 200 }
```

Only `downloads/voice-notes/` is pruned, and only files named
`<timestamp>-voice-note.<audio extension>` (regular files; links and folders are skipped).
Voice notes older than `voiceNoteDays` are deleted first, then the oldest ones until the
rest fit in `voiceNoteMaxMB`. Transcripts next to them (`*.txt`, `*.srt`, ... -- including
the ones the bridge writes when speech is configured) and the `transcript` records in
`inbox.jsonl` are kept: they are personal data too, so delete them yourself if you do not
need them. Every other download is left alone. Each deletion is logged to `daemon.log` by file name. Without
a `retention` block nothing is ever deleted.

## Tools

| Tool | What it does |
|---|---|
| `list_chats` | Allowlisted chats with jid, name, `canPost`, and a lightweight recent-activity count |
| `read_chat_messages` | Last N stored messages for one allowlisted chat, oldest first -- read from the local inbox log, not a live fetch |
| `send_chat_message` | Sends a text message via the daemon and waits up to 15s for delivery confirmation; requires `canPost: true`. Optional `mentions` (person jids) tag people: the text must contain `@<number>` for each |
| `poll_chats` | Messages that arrived since the last call, grouped by chat jid; the read position is persisted, so each message is returned exactly once |
| `send_chat_document` | Sends a file as a document, with an optional caption, and waits for the echo-verified ack; requires `canPost: true` |
| `send_chat_image` | Sends a PNG or JPEG as an inline image message, with an optional caption, and waits for the echo-verified ack; requires `canPost: true` |
| `send_chat_voice_note` | Sends an Ogg/Opus `.ogg` file as a voice note (plays inline like a recorded message) and waits for the echo-verified ack; requires `canPost: true` |
| `speak_voice_note` | Speaks text (at most 2000 characters, `MAX_SPEAK_CHARS` in `src/speech.js`) with the configured voice and sends it as a voice note; requires `canPost: true` and `speech.speak` (see "Speech") |
| `react_to_message` | Puts an emoji reaction on one message (or removes it with an empty emoji) via the daemon and waits for its ack; requires `canPost: true` |

Every tool validates the jid against the allowlist before touching anything else. An
unknown jid is refused with an error naming the config file; sending additionally
requires `canPost: true`. There is no bulk-send or broadcast tool -- one call sends one
message to one chat.

## Reactions

A reaction is the cheapest signal both directions, and this bridge treats it as a
first-class record and command.

**Inbound.** A reaction someone puts on a message arrives in `inbox.jsonl` as a record
of `type: "reaction"` with `reaction.emoji` and `reaction.targetMsgId`, so an agent can
see that a message was acknowledged without anyone typing.

**Outbound.** `react_to_message` (or a raw `{"type":"react", "jid", "nonce", "msgId",
"emoji", "participant?", "fromMe?"}` line in `outbox.jsonl`) makes the daemon put the
emoji on the target message and ack with `reacted: {target, emoji}`. In a group the
target's sender jid goes in `participant`; an empty `emoji` removes the reaction.

**A convention that works.** When an agent handles messages from real people, react
before or instead of replying, and keep the vocabulary tiny so the meaning is stable:

| Emoji | Meaning |
|---|---|
| 👀 | Seen, being handled |
| 👍 | Acknowledged, no action needed |
| ✅ | Done |

A reaction never replaces an answer that was asked for; it tells the human the message
did not fall on the floor while the answer is being produced.

## Channel inbox (optional)

For a runner that serves several chat platforms through one file, the daemon can also write
every inbound human message as a platform-neutral **line v1** (one JSON object per line). Off
unless set; the native `inbox.jsonl` is unchanged either way.

| Variable | Effect |
|---|---|
| `WA_CHANNEL_INBOX=<path>` | Appends one v1 line per message from a readable allowlisted chat that is not ours and has text (a voice note's transcript counts): `chatId`/`senderId` as `wa:<jid>`, `msgId`, `ts` (when sent), `ingestedAt`, `replyToMsgId`, `attachments` (`[{name, mime, bytes, path}]` once saved) and `receipt`. A reaction by a person is written as `kind:"reaction"` (`msgId` of the reaction, `targetMsgId`, `emoji`, empty when removed) and an edit as `kind:"edit"` (`targetMsgId`, `text`), both with `chatId`, `senderId`, `senderName`, `ts`, `fromMe` and no receipt. Deletions, our own messages and acks are not written. Connection changes are written as `kind:"adapter"` lines with `event` `connected`, `disconnected`, `reconnecting` or `auth-failed`. The directory is created 0700, the file 0600; each line is one append, so several adapters can share the file. |
| `WA_RECEIPT_EMOJI=<emoji>` | With `WA_CHANNEL_INBOX`: reacts with this emoji on each such message as soon as it arrives, before any download or transcription, and records (waiting at most 3 s from arrival) `receipt: "placed"` or `"failed"` on the line (`null` when unset). A failed receipt never holds back the line. |

A message with media is written once its download is done, and a voice note once its
transcript is ready (or has failed), so each message is one line.

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
