# daemon-agent-selection Specification

## Purpose
TBD - created by archiving change improve-daemon-cli-ux. Update Purpose after archive.
## Requirements
### Requirement: `--agent` selection with single implemented backend

The daemon SHALL accept an `--agent <type>` flag and a `CHORUS_AGENT` environment
variable selecting which local agent backend to wake, defaulting to
`claude-code`. The daemon SHALL validate the resolved value against the set of
known agent types and SHALL reject an unknown value with a clear, non-zero error
naming the accepted values (it SHALL NOT silently fall back). The resolved agent
type SHALL be displayed in the startup banner. In this change the spawn path SHALL
implement **only** the `claude-code` backend; the flag/env exist to reserve the
extension point for future backends (e.g. codex) without implementing them now.
Selecting `claude-code` (explicitly or by default) SHALL behave exactly as the
current daemon spawn.

#### Scenario: Default agent type is claude-code

- **WHEN** the user runs `chorus daemon` with no `--agent` flag and no
  `CHORUS_AGENT` env
- **THEN** the resolved agent type is `claude-code`, shown in the banner, and the
  daemon wakes a local Claude Code subprocess as before

#### Scenario: Explicit claude-code is accepted

- **WHEN** the user runs `chorus daemon --agent claude-code` (or sets
  `CHORUS_AGENT=claude-code`)
- **THEN** the daemon accepts it, displays it in the banner, and wakes Claude Code
  normally

#### Scenario: Unknown agent type is rejected visibly

- **WHEN** the user passes `--agent <unknown>` (or sets `CHORUS_AGENT` to an
  unknown value)
- **THEN** the daemon exits non-zero with a clear error naming the accepted agent
  types and does not start, rather than silently falling back to a default

