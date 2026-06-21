# Tasks: improve-daemon-cli-ux

## 1. CLI flag router + per-subcommand help
- [ ] 1.1 Extend `parseClientFlags` in `chorus.mjs` for `--agent`, `--chorus-only`, `--verbose`, `-d`, and the `stop`/`status`/`restart`/`logs` daemon sub-actions
- [ ] 1.2 Add `--help`/`-h` fast-path for `chorus daemon` and `chorus login`; keep bare-server help + bare-server launch intact
- [ ] 1.3 Unit tests for all help paths and flag parsing

## 2. Permission mode + yolo ack
- [ ] 2.1 New `cli/daemon-permission-mode.mjs` pure resolver (flags/env/isTTY/ackState → mode + needConfirm)
- [ ] 2.2 Default→yolo; TTY first-run y/N confirm; non-TTY warn-only; `--chorus-only` reverse switch
- [ ] 2.3 `yoloAckAt` read (`credentials.mjs`) + write (`login.mjs`); `chorus login` clears ack
- [ ] 2.4 Unit tests covering the TTY/non-TTY × ack/no-ack × yolo/chorus-only matrix

## 3. TTY credential completion at daemon start
- [ ] 3.1 Refactor `runDaemon` startup spine; on resolve-failure + TTY, reuse `login.mjs` prompt/validate/writeLoginFile then continue
- [ ] 3.2 Non-TTY preserves the hard error + multi-source hint
- [ ] 3.3 Unit/integration tests for TTY-complete and non-TTY-error paths

## 4. Banner + per-wake logs + claude detection + --agent
- [ ] 4.1 New `cli/daemon-banner.mjs` pure `formatBanner(info)`; integrate into startup
- [ ] 4.2 Per-wake single-line lifecycle logs in `cli/waker.mjs` (arrival / new-vs-resume / finish + duration/exit), `--verbose` detail, resume hint
- [ ] 4.3 `claude` install detection via `resolveClaudePath`, surfaced in banner (non-fatal when missing)
- [ ] 4.4 `--agent`/`CHORUS_AGENT` validate + banner display + unknown-value error; thread agentType to spawner (claude-code only)
- [ ] 4.5 Unit tests for banner formatting (TTY/non-TTY), wake logs, detection, agent validation

## 5. `-d` background lifecycle
- [ ] 5.1 New `cli/daemon-lifecycle.mjs`: detached spawn + pidfile + logfile, cross-platform, no native deps
- [ ] 5.2 Foreground preflight (credential completion + yolo confirm + ack) BEFORE detach; detached child marker skips preflight
- [ ] 5.3 `stop`/`status`/`restart`/`logs` with sane "nothing running" reporting; double-start guard
- [ ] 5.4 Unit tests with platform injection (POSIX + Windows branches)

## 6. Docs, auto-start templates, design.pen
- [ ] 6.1 Update daemon CLI docs + skill files (new flags, banner, `-d` lifecycle, `--agent`, `--chorus-only`)
- [ ] 6.2 Add launchd `.plist` + systemd `--user` `.service` templates (docs only)
- [ ] 6.3 Update `docs/design.pen` for any user-facing CLI output surfaces if applicable
- [ ] 6.4 End-to-end manual verification of the full first-run → background → stop loop
