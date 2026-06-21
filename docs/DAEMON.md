# Chorus Daemon (`chorus daemon`)

The Chorus daemon is a local, long-lived client. It connects to a remote Chorus
server, subscribes to the agent notification stream, and wakes a local headless
Claude Code on task dispatch — so an assigned agent can act on work even when no
one is at a terminal.

```bash
npx @chorus-aidlc/chorus daemon        # foreground
npx @chorus-aidlc/chorus daemon -d     # background (detached)
```

See `chorus daemon --help` and `chorus login --help` for the full flag list.

---

## Credentials

The daemon resolves the server URL + `cho_` API key in this precedence (first
complete pair wins):

1. `--url` / `--api-key` flags
2. `CHORUS_URL` / `CHORUS_API_KEY` environment variables
3. `~/.chorus/daemon.json` (written by `chorus login`)
4. Claude Code plugin config (`~/.claude/settings.json` → `env`)

**Interactive completion (TTY only).** If no source yields credentials **and**
stdin is a terminal, `chorus daemon` no longer hard-fails — it prompts for the
URL and a masked API key, validates them against the server, saves them to
`~/.chorus/daemon.json` (mode `0600`), and continues starting up. You do not need
a separate `chorus login` run.

**Non-interactive (systemd / nohup / CI).** When stdin is **not** a TTY and no
credentials resolve, the daemon prints the actionable multi-source error and
exits non-zero — it never blocks waiting on a prompt no one can answer. Provide
credentials via env or `chorus login` (on a terminal) first.

---

## Permission mode (default: YOLO)

The woken agent's permission posture determines what it may do:

| Mode | What the woken agent may do | How to select |
|------|------------------------------|----------------|
| **`yolo`** (default) | Full autonomy — Bash, file writes, any command, under the daemon's API key (`--dangerously-skip-permissions`) | default; `--yolo`; `CHORUS_YOLO=1` |
| `chorus-only` | Chorus MCP tools only (comment / claim / report / status) — no Bash, no file edits | `--chorus-only`; `CHORUS_CHORUS_ONLY=1` |

> ⚠ **YOLO is the default** because the daemon exists to do real code-writing
> AI-DLC work. A woken agent gets a full shell under your API key. Run the daemon
> only in a trusted / sandboxed environment.

**First-run confirmation (TTY).** The first time the daemon would start in YOLO
on a terminal, it asks for a one-time `y/N` confirmation and remembers your
answer as `yoloAckAt` in `~/.chorus/daemon.json`. Subsequent starts don't
re-prompt. Running `chorus login` (a credential change) clears the acknowledgement,
so you confirm once more after switching key/URL.

**Unattended (non-TTY).** When YOLO starts on a non-terminal (systemd / nohup /
CI / the detached `-d` child), it runs directly and prints one prominent `⚠`
warning line — no confirmation is possible or required. To keep an unattended
daemon restricted, pass `--chorus-only` (or set `CHORUS_CHORUS_ONLY=1`).

---

## Startup banner & logging

On start the daemon prints a boxed banner summarizing: server URL, agent identity
(name + uuid), permission mode (YOLO highlighted), credential **source** (never
the raw key), connection state, `claude` install status / path, the chorus
version, and the active agent type. On a non-TTY stream the banner degrades to
plain `label: value` lines.

**`claude` detection.** The banner reports whether the `claude` executable was
found (and its path), reusing the same PATH resolution the wakes use (including
the Windows `claude.cmd` shim and the `CHORUS_CLAUDE_PATH` override). A missing
`claude` does **not** block startup — the daemon still subscribes, and a wake
surfaces the missing-binary error when one arrives.

**Per-wake logs.** Each wake emits one compact line per lifecycle event:

```
[Chorus] ▶ wake: task_assigned → task:<uuid>
[Chorus] spawning new session <idea-uuid> — take over with: claude --resume <idea-uuid>
[Chorus] ✓ wake done: task:<uuid> (exit=0, 1234ms)
```

The `claude --resume <idea-uuid>` hint lets you attach to the session from the
daemon's working directory. Pass `--verbose` (or `CHORUS_VERBOSE=1`) for extra
per-wake detail.

---

## Agent backend (`--agent`)

`--agent <type>` (env `CHORUS_AGENT`) selects which local agent backend the
daemon wakes. The default — and currently the only implemented backend — is
`claude-code`. An unknown value is a hard error (no silent fallback):

```bash
chorus daemon --agent claude-code   # explicit (same as default)
chorus daemon --agent codex         # error: only claude-code is implemented
```

The flag reserves the extension point for future backends; it does not change
how `claude-code` is spawned.

---

## Background mode & lifecycle

Run the daemon detached in the background and manage it with lifecycle
subcommands. All of this is pure Node — no native dependencies, cross-platform.

```bash
chorus daemon -d          # start detached: pidfile + logfile, foreground returns
chorus daemon status      # is it running? (+ pid)
chorus daemon logs        # show ~/.chorus/daemon.log
chorus daemon restart     # stop (if running) then start a fresh detached instance
chorus daemon stop        # terminate the recorded daemon and remove the pidfile
```

- Background state lives in `~/.chorus/daemon.pid` and `~/.chorus/daemon.log`.
- `-d` refuses to start a second daemon when a live one is already recorded.
- **First-run `-d` on a terminal** completes the credential prompts and the YOLO
  `y/N` confirmation in the **foreground** parent (which holds the TTY) and
  persists them *before* detaching — so the detached child never hits an
  interactive prompt.
- Every lifecycle subcommand reports clearly when no daemon is running (it never
  fails silently).

---

## Auto-start on boot / login (manual setup)

Chorus does **not** install OS services for you. To start the daemon
automatically, install one of the templates below by hand. (Windows: use Task
Scheduler to run `chorus daemon` at logon — not templated here.)

> Pre-authorize YOLO before enabling auto-start: run `chorus daemon` once on a
> terminal and confirm the `y/N` prompt (persists `yoloAckAt`), **or** set
> `--chorus-only` in the template to keep the unattended daemon restricted.
> Replace `/usr/local/bin/chorus` with your actual install path (`which chorus`).

### macOS — launchd LaunchAgent

Save as `~/Library/LaunchAgents/dev.chorus.daemon.plist`, then
`launchctl load ~/Library/LaunchAgents/dev.chorus.daemon.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.chorus.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/chorus</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/chorus-daemon.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/chorus-daemon.log</string>
</dict>
</plist>
```

Unload with `launchctl unload ~/Library/LaunchAgents/dev.chorus.daemon.plist`.

### Linux — systemd user service

Save as `~/.config/systemd/user/chorus-daemon.service`, then
`systemctl --user enable --now chorus-daemon`:

```ini
[Unit]
Description=Chorus daemon
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/chorus daemon
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

To keep the service running after you log out:
`loginctl enable-linger "$USER"`. Stop/disable with
`systemctl --user disable --now chorus-daemon`. Logs: `journalctl --user -u chorus-daemon`.

---

## Quick reference

| Need | Command / setting |
|------|-------------------|
| Start (foreground) | `chorus daemon` |
| Start (background) | `chorus daemon -d` |
| Stop / status / logs / restart | `chorus daemon stop` / `status` / `logs` / `restart` |
| Restrict the woken agent | `--chorus-only` / `CHORUS_CHORUS_ONLY=1` |
| Force full autonomy | `--yolo` / `CHORUS_YOLO=1` (also the default) |
| Verbose per-wake logs | `--verbose` / `CHORUS_VERBOSE=1` |
| Choose agent backend | `--agent claude-code` / `CHORUS_AGENT` |
| Point at a `claude` binary | `CHORUS_CLAUDE_PATH=/path/to/claude` |
| Save credentials | `chorus login` (or interactive on first `chorus daemon`) |
| Per-subcommand help | `chorus daemon --help`, `chorus login --help` |
