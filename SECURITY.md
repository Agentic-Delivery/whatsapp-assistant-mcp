# Security

## Reporting a vulnerability

Please report security issues privately using
[GitHub Security Advisories](https://github.com/Agentic-Delivery/whatsapp-assistant-mcp/security/advisories/new)
for this repository, rather than opening a public issue. This lets us investigate and
ship a fix before the details are public.

## Supported versions

This project is pre-1.0 (`0.x`). There is no version support matrix yet -- fixes land on
the latest release.

## What NOT to include in a report (or in any public issue)

- Never paste the contents of `~/.whatsapp-assistant/auth/`, or any single file from it.
  That directory holds live session credentials -- anyone who reads it can act as the
  paired WhatsApp account.
- Never paste `inbox.jsonl`, `outbox.jsonl`, or any real message content, chat name, or
  jid. Describe the shape of the problem instead (e.g. "a malformed inbox line crashes
  X" rather than pasting the line itself).

A description of the bug, the code path involved, and a minimal reproduction built from
fake/placeholder data is enough for us to act on.
