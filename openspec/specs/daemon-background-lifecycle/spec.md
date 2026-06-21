# daemon-background-lifecycle Specification

## Purpose
TBD - created by archiving change improve-daemon-cli-ux. Update Purpose after archive.
## Requirements
### Requirement: Background run via `-d` with pidfile and logfile

The CLI SHALL accept `chorus daemon -d` to run the daemon detached in the
background. On a `-d` start the CLI SHALL spawn the long-lived daemon as a
detached child whose stdout/stderr are redirected to a logfile at
`~/.chorus/daemon.log`, SHALL write the child's process id to a pidfile at
`~/.chorus/daemon.pid`, and SHALL return control to the foreground shell. The
implementation SHALL be pure Node with no native-binding dependency and SHALL work
on Linux, macOS, and Windows without relying on `shell:true`. If a daemon already
appears to be running (a live pid in the pidfile), `-d` SHALL NOT start a second
one; it SHALL report the existing instance instead.

#### Scenario: `-d` starts the daemon in the background

- **WHEN** the user runs `chorus daemon -d` with resolvable credentials and a
  recorded yolo ack (or restricted mode)
- **THEN** the daemon runs detached, its output goes to `~/.chorus/daemon.log`, its
  pid is written to `~/.chorus/daemon.pid`, and the foreground shell returns

#### Scenario: `-d` refuses to double-start

- **WHEN** the user runs `chorus daemon -d` while a daemon recorded in
  `~/.chorus/daemon.pid` is still alive
- **THEN** the CLI does not start a second daemon and reports the running instance

### Requirement: Foreground preflight before detaching

The CLI SHALL, on a first `-d` start that still needs interactive credential
completion and/or the yolo TTY confirmation, perform that interaction in the
foreground parent process (which holds the TTY) and persist the resulting
credentials and `yoloAckAt` **before** detaching the background child. The
detached background child SHALL start non-interactively from the persisted
credentials/ack and SHALL NOT attempt to prompt.

#### Scenario: First `-d` run completes confirmation in the foreground

- **WHEN** the user runs `chorus daemon -d` on a TTY with no credentials and/or no
  yolo ack
- **THEN** the foreground parent completes the credential prompts and the yolo
  `y/N` confirmation, persists them, and only then detaches the background child —
  which starts without prompting

### Requirement: Lifecycle subcommands stop / status / restart / logs

The CLI SHALL provide `chorus daemon stop`, `chorus daemon status`,
`chorus daemon restart`, and `chorus daemon logs` operating on the pidfile/logfile
managed by the `-d` path. `stop` SHALL terminate the recorded daemon process and
clean up the pidfile. `status` SHALL report whether the daemon is running (and
basic info such as pid). `restart` SHALL stop any running instance and start a new
detached one. `logs` SHALL display the daemon logfile. Each subcommand SHALL
behave sanely and report visibly when no daemon is running (no silent failure).

#### Scenario: stop terminates the running daemon

- **WHEN** the user runs `chorus daemon stop` while a daemon is running
- **THEN** the recorded process is terminated and the pidfile is removed

#### Scenario: status reports running state

- **WHEN** the user runs `chorus daemon status`
- **THEN** the CLI reports whether a daemon is running and, if so, its pid

#### Scenario: restart cycles the daemon

- **WHEN** the user runs `chorus daemon restart`
- **THEN** any running instance is stopped and a new detached instance is started

#### Scenario: logs shows the daemon output

- **WHEN** the user runs `chorus daemon logs`
- **THEN** the CLI displays the contents of `~/.chorus/daemon.log`

#### Scenario: lifecycle commands report when nothing is running

- **WHEN** the user runs `stop`, `status`, `restart`, or `logs` with no daemon
  running
- **THEN** the CLI reports the absence clearly and does not fail silently

### Requirement: OS auto-start provided as documentation templates only

Boot/login auto-start SHALL be provided as **documentation templates only** — a
launchd `.plist` template (macOS) and a systemd `--user` `.service` template
(Linux) in the README / skill docs that a user can install manually. This change
SHALL NOT generate, install, or manage OS service definitions in code, and SHALL
NOT add Windows Task Scheduler integration.

#### Scenario: Auto-start templates are documented, not code

- **WHEN** a user wants the daemon to start at boot/login
- **THEN** the documentation provides launchd and systemd user-service templates
  to install manually, and the CLI ships no install/uninstall service command

