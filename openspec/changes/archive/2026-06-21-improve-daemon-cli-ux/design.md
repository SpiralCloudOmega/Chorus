# Technical Design: `chorus daemon` CLI UX improvements

## Overview

All changes are CLI-side (`chorus.mjs` + `cli/*.mjs`), zero new runtime
dependencies, zero native bindings, cross-platform (linux/macOS/Windows for the
process bits; OS auto-start is docs-only). The work decomposes into five
independently testable modules plus a shared startup-sequence refactor in
`runDaemon`. Existing service/server code is untouched — no DB, schema, or API
changes.

## Architecture

### Startup sequence (the spine — `runDaemon` in `cli/daemon.mjs`)

The new ordered startup, replacing the current resolve→validate→build flow:

```
runDaemon(flags):
  1. parse: --agent, --chorus-only, --verbose, -d, (sigint-timeout, url, key, yolo)
  2. resolve agent type        → daemon-agent-selection (validate; error on unknown)
  3. if -d and not already-detached child:
        → run FOREGROUND PREFLIGHT (steps 4-6 below) in this TTY parent,
          then re-exec self detached and exit parent (daemon-background-lifecycle)
  4. resolve credentials:
        try resolveCredentials(flags)
        on failure:
          if stdin is a TTY → interactive completion (cli-auth) → writeLoginFile
          else              → hard error + multi-source hint, return 1   (unchanged)
  5. resolve permission mode   → daemon-permission-mode
        default yolo; TTY-first-run confirm + yoloAckAt; non-TTY warn-only
  6. validate credentials (validateAndFetchIdentity) → identity
  7. detect claude install     (resolveClaudePath)   → install status for banner
  8. print BOXED BANNER         → daemon-startup-output
  9. build + start daemon; per-wake logs flow from waker → daemon-startup-output
```

Steps 4–6 are the "foreground preflight": they require a human (prompt + y/N) and
so MUST run before any `-d` detach. The detached child re-enters `runDaemon` with
an internal marker (e.g. `CHORUS_DAEMON_DETACHED=1`) so it skips step 3 and runs
4–9 non-interactively against the now-complete credentials/ack.

### Module map

| Module | New/changed | Responsibility |
|---|---|---|
| `chorus.mjs` | changed | `parseClientFlags` learns `--agent`, `--chorus-only`, `--verbose`, `-d`, and the `stop`/`status`/`restart`/`logs` daemon sub-actions; `--help` fast-path for client subcommands |
| `cli/daemon.mjs` | changed | new startup spine above; credential completion call-out; permission-mode resolution; banner call |
| `cli/daemon-permission-mode.mjs` | new | pure resolver: (flags, env, isTTY, ackState) → `{mode, needConfirm}`; TTY confirm prompt; ack read/write helpers |
| `cli/daemon-banner.mjs` | new | pure `formatBanner(info) → string`; no IO, fully unit-testable |
| `cli/daemon-lifecycle.mjs` | new | `-d` detach, pidfile/logfile, `stop`/`status`/`restart`/`logs` |
| `cli/login.mjs` | changed | `writeLoginFile` accepts optional `yoloAckAt`; overwriting via `chorus login` clears it |
| `cli/credentials.mjs` | changed | read `yoloAckAt` back (ack lives in the same `daemon.json`) |
| `cli/waker.mjs` | changed | emit per-wake single-line lifecycle logs (arrival / spawn new-vs-resume / finish), gated by verbosity |
| `cli/claude-spawner.mjs` | changed (minimal) | accept and thread `agentType` for the banner/log only; spawn still claude-code |

## Data Model / on-disk state

No DB. One persisted-file change: `~/.chorus/daemon.json` gains an optional
`yoloAckAt` (ISO-8601 string) alongside the existing `{url, apiKey, agentUuid,
agentName}`. Backward compatible — absence means "never acked". `chorus login`
rewrites the file and omits `yoloAckAt` (clearing it). pidfile
(`~/.chorus/daemon.pid`) and logfile (`~/.chorus/daemon.log`) are new sibling
files managed by `daemon-lifecycle.mjs`.

`--agent` is **not** persisted to `daemon.json` in this change unless trivial;
the elaboration answer (q9=a) requires "validate / store / banner / error". To
keep `daemon.json` a pure credential file, agent type is resolved per-run from
flag → `CHORUS_AGENT` → default `claude-code`; "store" is satisfied by the
ack/credential file only if a later need arises. (Implementer note: if persistence
is wanted, reuse the same `daemon.json` with an `agent` field — do not introduce a
second config file.)

## Module Contracts (shared conventions across tasks)

- **Logging:** continue the existing `logger = { info, warn, error }` pattern in
  `daemon.mjs` (info→stdout, warn/error→stderr). Per-wake lines use the
  `[Chorus] …` prefix already in use. `--verbose` raises detail; default is one
  line per lifecycle event. No logging library — `process.stdout.write`.
- **TTY detection:** use `process.stdin.isTTY` (and `process.stdout.isTTY` for
  the banner box-drawing fallback). Inject via a `deps`/param seam so tests can
  force TTY vs non-TTY without a real terminal (mirror `runDaemon`'s existing
  `deps` injection style).
- **Pure formatters:** `formatBanner` and the permission-mode resolver take
  plain inputs and return values (string / object) with **no IO**, so they are
  unit-tested directly; the IO (prompt, file write, stdout) lives in thin
  wrappers in `daemon.mjs` / `daemon-lifecycle.mjs`.
- **No silent errors** (project rule): every new failure path logs visibly. A
  failed `-d` detach, a missing pidfile on `stop`, an unwritable ack — all surface
  a clear message and a non-zero exit where appropriate.
- **Reuse, don't reimplement:** credential completion reuses `login.mjs`'s
  `prompt()` + `writeLoginFile()` + `validateAndFetchIdentity`; install detection
  reuses `claude-spawner.mjs`'s `resolveClaudePath()`.

## Implementation Plan (ordered)

1. **Flag/router + per-subcommand help** (`chorus.mjs`) — unblocks every other
   task by giving them their flags; smallest blast radius.
2. **Permission mode + ack** (`daemon-permission-mode.mjs`, `login.mjs`,
   `credentials.mjs`) — the security-relevant core; TTY confirm, non-TTY warn,
   ack persist/clear.
3. **Credential completion on TTY** (`daemon.mjs` + reuse `login.mjs`) — depends
   on the startup-spine refactor; shares the TTY seam with task 2.
4. **Banner + per-wake logs + claude detection + `--agent`**
   (`daemon-banner.mjs`, `waker.mjs`, `claude-spawner.mjs`) — the output layer;
   consumes the resolved mode/agent/identity/install-status from tasks 2–3.
5. **`-d` background lifecycle** (`daemon-lifecycle.mjs`) — depends on the
   foreground-preflight ordering being in place (tasks 2–3), since the parent must
   finish confirm/ack before detaching.
6. **Docs + auto-start templates + design.pen** — depends on all behavior being
   final.

## Risks & Mitigations

- **R1 — default-yolo is a real security change.** A woken Claude gets a full
  shell under the daemon key by default. *Mitigation:* TTY confirm + persisted
  ack, loud non-TTY `⚠`, `--chorus-only` escape hatch, prominent banner + docs.
  The behavior matches the owner's explicit q1=b / q7=c decisions.
- **R2 — `-d` detach loses the TTY needed for confirm.** *Mitigation:* foreground
  preflight before detach (see Architecture); the child never prompts.
- **R3 — cross-platform detach.** POSIX uses `detached:true` + `unref` +
  stdio→logfile; Windows needs `windowsHide` + detached semantics (no new console).
  *Mitigation:* keep `shell:false`, mirror `claude-spawner.mjs`'s existing
  platform-gated spawn; document Windows as best-effort and cover it with
  platform-injected unit tests. Verify spawn flags against Node docs rather than
  memory.
- **R4 — ack staleness / security bypass.** A stale `yoloAckAt` could keep yolo
  after a trust change. *Mitigation:* `chorus login` (credential change) clears
  the ack, forcing re-confirm; ack is per-credential-file, not global.
- **R5 — `--help` fast-path regression.** Changing `chorus.mjs:120` gating risks
  breaking server `--help`. *Mitigation:* unit-test all three (`chorus --help`,
  `chorus daemon --help`, `chorus login --help`) plus bare-server launch.
- **R6 — verify CLI/Node specifics.** Claude Code flags, Node `child_process`
  detached semantics, and launchd/systemd template syntax must be checked against
  official docs (not LLM memory) during implementation.
