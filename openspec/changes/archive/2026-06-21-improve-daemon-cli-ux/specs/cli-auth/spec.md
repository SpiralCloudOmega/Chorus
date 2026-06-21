# cli-auth Specification (delta)

## ADDED Requirements

### Requirement: Interactive credential completion at daemon start (TTY only)

The daemon SHALL, when it cannot resolve a complete `url` + `cho_` API key pair
from the layered sources (flags → env → `~/.chorus/daemon.json` → plugin
fallback) **and** standard input is a TTY, NOT fail with the hard error.
Instead it SHALL run the same interactive completion flow as `chorus login` —
prompting for the server URL and a **masked** API key, validating them against
the server by fetching the authenticated agent identity, and on success
persisting `{ url, apiKey, agentUuid, agentName }` to `~/.chorus/daemon.json`
with owner-only permissions — and then SHALL continue daemon startup using the
just-completed credentials. The completion flow SHALL reuse the existing
`chorus login` masked-prompt, validate, and persist logic rather than
reimplementing it. On validation failure during completion, the daemon SHALL NOT
write the file and SHALL exit non-zero.

When credentials cannot be resolved and standard input is **not** a TTY
(systemd / nohup / CI / background), the daemon SHALL preserve the existing
behavior: it SHALL NOT prompt or block, and SHALL emit the single
human-actionable multi-source error and exit non-zero.

#### Scenario: TTY start with no credentials completes interactively

- **WHEN** the user runs `chorus daemon` on a TTY with no resolvable credentials
- **THEN** the daemon prompts for URL and a masked API key, validates them, writes
  `~/.chorus/daemon.json` (owner-only) on success, and continues starting up
  without requiring a separate `chorus login` run

#### Scenario: Masked entry during daemon completion

- **WHEN** the daemon prompts interactively for the API key during start-time
  completion
- **THEN** the typed key is not echoed to the terminal

#### Scenario: Non-TTY start with no credentials errors without blocking

- **WHEN** `chorus daemon` starts with no resolvable credentials and stdin is not
  a TTY
- **THEN** the daemon does not prompt, emits the multi-source actionable error,
  and exits non-zero — it never blocks waiting on input no one can provide

#### Scenario: Failed validation during completion writes nothing

- **WHEN** the user completes credentials interactively at daemon start but the
  key fails server validation
- **THEN** the daemon reports the failure, does not create or overwrite
  `~/.chorus/daemon.json`, and exits non-zero
