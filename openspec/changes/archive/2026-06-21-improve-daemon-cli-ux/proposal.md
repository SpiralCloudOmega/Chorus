# Proposal: Improve `chorus daemon` CLI interaction & output

## Why

`chorus daemon` is the local long-lived client: it connects to a remote Chorus
server, subscribes to the agent notification stream, and wakes a local headless
Claude Code on task dispatch. Three rough edges hurt first-run and day-to-day
operation (all confirmed against the current `cli/` source):

1. **Missing credentials = hard error, no interactive completion.**
   `resolveCredentials()` (`cli/credentials.mjs:80`) layers flags → env →
   `~/.chorus/daemon.json` → plugin fallback, and **throws** when no layer yields
   a complete pair (`credentials.mjs:130`). `runDaemon` catches it and returns 1
   (`cli/daemon.mjs:293-298`). The masked-input + validate + 0600 persist logic
   already exists in `chorus login` (`cli/login.mjs` `prompt()` / `writeLoginFile()`),
   but the daemon start path does not reuse it — the capability exists, the
   wiring doesn't.

2. **Default permission mode is `chorus-only`, not `yolo`.** `daemon.mjs:285-286`
   sets `permissionMode = yolo ? "yolo" : "chorus"`, defaulting to `chorus`: the
   woken Claude can only call Chorus MCP tools, not Bash / file edits
   (`claude-spawner.mjs` `buildArgs` adds `--allowedTools mcp__chorus__*`). Real
   code-writing AI-DLC requires an explicit `--yolo` / `CHORUS_YOLO=1` today.

3. **Thin output, no per-wake visibility.** Startup prints scattered
   `[Chorus] …` lines (`daemon.mjs:299-347`); there is **no per-wake dispatch
   log** — a task arriving, Claude spawning (new vs resume), and the run finishing
   are invisible (only the interrupt / crash paths log). An operator watching the
   terminal cannot tell whether the daemon is working, or on which idea/task.

## What Changes

Scope locked through three elaboration rounds (idea `6db3784f`); final owner
confirmation in-thread. Each item cites the elaboration decision it implements.

- **Interactive credential completion at daemon start, TTY only (q3=a).** When
  the daemon cannot resolve `url+key` **and** stdin is a TTY, it reuses
  `login.mjs`'s masked prompt → `validateAndFetchIdentity` → `writeLoginFile`
  (`~/.chorus/daemon.json`, 0600), then continues startup. **Non-TTY**
  (systemd / nohup / CI) keeps the current hard error + multi-source hint — it
  MUST NOT block on a prompt no one can answer.

- **Default permission mode flips to `yolo` (q1=b, q7=c, q8=a).**
  - Default is now `yolo`.
  - **TTY first run** (yolo, no prior ack): require one `y/N` confirmation, then
    persist `yoloAckAt` into `~/.chorus/daemon.json`; subsequent starts with a
    valid ack skip the prompt.
  - **Non-TTY** (unattended): run `yolo` directly with one loud `⚠` warning line;
    no extra switch required.
  - `chorus login` overwriting credentials clears `yoloAckAt` → re-confirm once
    after a key/URL change.

- **Reverse "restricted" switch (q2=b).** `--chorus-only` (env
  `CHORUS_CHORUS_ONLY=1`) returns to the restricted posture (only
  `mcp__chorus__*` tools). yolo startup prints a prominent warning explaining how
  to use it to reclaim permission.

- **Boxed startup banner enriched (q5=a, q10 "丰富 banner 信息", q12=d display).**
  One screen summarizing: server URL, agent identity (name + uuid), permission
  mode (yolo **highlighted**), credential source, connection state, `claude`
  install status / path, **chorus version**, and **agent type** (`claude-code`).
  Per the owner: **no credential masking** (q10 a dropped) — the banner shows the
  credential *source*, not the key.

- **Per-wake single-line lifecycle logs (q4=a).** Default one compact line per
  lifecycle event (task/instruction arrival with idea/task identity, Claude spawn
  new-vs-resume, finish with duration / exit code); detail behind an opt-in
  `--verbose`. Surface the hidden "`claude --resume <idea-uuid>` to take over"
  capability in the log.

- **`claude` installation detection at startup (owner: "检测一下 claude 有没有安装").**
  Elevate the current one-line PATH `warn` into a clear install / detection
  result shown in the banner. **Not** included (owner): a `--claude-path` flag or
  `CHORUS_CLAUDE_PATH` env addition (q10 b dropped) — detection only, reusing the
  existing `resolveClaudePath()`.

- **`--agent` reservation, single backend (q9=a).** Add `--agent <type>`
  (default `claude-code`) + `CHORUS_AGENT`: validate the value, persist it,
  display it in the banner, and error on an unknown value. The spawn path still
  implements **only** `claude-code` — this reserves the extension point for future
  agents (e.g. codex) without building a new backend.

- **Per-subcommand `--help` (q6).** `chorus daemon --help` / `chorus login --help`
  currently fall through and try to start the daemon (`chorus.mjs:120` skips the
  help fast-path for subcommands; `parseClientFlags` ignores `--help`). Add
  dedicated help for the client subcommands.

- **`-d` background lifecycle, full set (q11=a).** `chorus daemon -d` detaches
  into the background (pidfile `~/.chorus/daemon.pid`, logfile
  `~/.chorus/daemon.log`), plus `chorus daemon stop` / `status` / `restart` /
  `logs`. Pure Node, cross-platform, **no native dependencies** (multica route).
  **Interaction:** on a first `-d` run the foreground parent (which still has the
  TTY) completes credential completion + the yolo `y/N` confirm and writes the
  ack **before** detaching; the detached child starts non-interactively from the
  now-ready credentials/ack.

- **OS boot auto-start = documentation only (q12=d).** Provide launchd `.plist`
  and systemd `--user` `.service` **templates** in the README / skill docs for
  users to install manually. **No** install/uninstall code, **no** Windows Task
  Scheduler integration (openclaw's ~2–3.5k-line subsystem was costed and
  explicitly declined for this idea).

- **Docs.** Update `docs/MCP_TOOLS.md` (n/a — no new MCP tools) and the daemon
  CLI docs / skill files for the new flags, banner, `-d` lifecycle, `--agent`,
  `--chorus-only`, and the auto-start templates.

## Capabilities

### Modified Capabilities

- `cli-auth`: add a requirement for daemon-start interactive credential
  completion on a TTY (non-TTY error path preserved).

### New Capabilities

- `daemon-permission-mode`: default-yolo posture, TTY first-run confirmation +
  `yoloAckAt` persistence, non-TTY direct-yolo with warning, `--chorus-only`
  reverse switch, login-clears-ack.
- `daemon-startup-output`: boxed startup banner, per-wake single-line lifecycle
  logs (+ `--verbose`), `claude` install detection, resume hint, per-subcommand
  `--help`.
- `daemon-agent-selection`: `--agent` / `CHORUS_AGENT` reservation with
  validation, persistence, banner display, unknown-value error; single
  `claude-code` backend.
- `daemon-background-lifecycle`: `-d` detached run + pidfile/logfile,
  `stop`/`status`/`restart`/`logs`, foreground-preflight-before-detach, and
  documented (code-free) OS auto-start templates.

## Impact

- **Affected code:** `chorus.mjs` (subcommand router, flag parsing, help),
  `cli/daemon.mjs` (startup, permission resolution, banner, credential
  completion), `cli/login.mjs` (ack-aware write, reuse of prompt), new
  `cli/daemon-banner.mjs` + `cli/daemon-lifecycle.mjs`, `cli/waker.mjs` (per-wake
  logs), `cli/claude-spawner.mjs` (agent-type plumb-through only).
- **Behavior change (security-relevant):** the default permission posture of a
  woken Claude changes from restricted to full autonomy. Mitigated by the TTY
  confirm + ack, the loud non-TTY warning, and the `--chorus-only` reverse
  switch. Documented prominently.
- **No new runtime dependencies; no native bindings** (cross-platform npm
  constraint upheld).
- **No DB / schema / API changes.** This is entirely CLI-side.
