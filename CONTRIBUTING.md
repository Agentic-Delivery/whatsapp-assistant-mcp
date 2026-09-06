# Contributing

Thanks for helping improve the bridge. A few house rules keep the repo clean and safe to share.

## Ground rules

- **English only** in code, comments, commit messages and test fixtures.
- **No real identities anywhere.** Test fixtures use placeholder names (Alice, Bob) and obviously fake
  numbers such as `100000000000001@lid` or `15550000001`. Never paste a real phone number, LID, group
  jid, email address or chat excerpt into code, tests, issues or commit messages.
- **No secrets, no private state.** `auth-info/`, `creds.json`, `config.json`, `inbox.jsonl`, `outbox.jsonl`
  and `.env` are ignored on purpose. If you find one tracked, that is a bug.
- **Describe the mechanism, not the incident.** A commit says what the code does now and why that is
  correct, never who reported it or in which chat.

## Workflow

1. Add or extend a test in `tests/` for every behaviour change (`npm test` runs the suite).
2. Keep commits small and focused; the message states the behaviour, not the diary.
3. Open a pull request. CI must be green.

## Reporting a security issue

Do not open a public issue for a vulnerability. Contact the maintainers privately via the profile
of the repository owner.
