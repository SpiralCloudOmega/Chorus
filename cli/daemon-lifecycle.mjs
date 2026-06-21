// cli/daemon-lifecycle.mjs
// Background (`-d`) run + lifecycle subcommands (stop/status/restart/logs) for
// `chorus daemon`. Pure Node, cross-platform, NO native dependencies and NO
// `shell:true` — mirrors the platform-gated spawn approach in claude-spawner.mjs
// (POSIX detached process-group leader + unref + stdio→logfile; Windows
// windowsHide, no new console). All IO is injectable so both platform branches
// are unit-testable from a single host.
//
// State files live alongside the credentials in ~/.chorus:
//   pidfile  ~/.chorus/daemon.pid   (the background daemon's pid)
//   logfile  ~/.chorus/daemon.log   (its redirected stdout+stderr)

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Default IO bundle — overridable per-call for tests (no real disk/process). */
function defaultIO() {
  return {
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
    spawn,
    // process.kill with signal 0 is the portable liveness probe (no signal sent).
    kill: (pid, sig) => process.kill(pid, sig),
    platform: process.platform,
    home: homedir(),
  };
}

/** ~/.chorus/daemon.pid */
export function pidFilePath(io = defaultIO()) {
  return join(io.home ?? homedir(), ".chorus", "daemon.pid");
}

/** ~/.chorus/daemon.log */
export function logFilePath(io = defaultIO()) {
  return join(io.home ?? homedir(), ".chorus", "daemon.log");
}

/**
 * Read the recorded pid, or null when absent / unreadable / malformed.
 * @param {object} [io]
 * @returns {number|null}
 */
export function readPid(io = defaultIO()) {
  const path = pidFilePath(io);
  try {
    if (!io.existsSync(path)) return null;
    const raw = io.readFileSync(path, "utf8");
    const pid = Number.parseInt(String(raw).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Is `pid` a live process? Uses signal 0 (sends nothing; throws ESRCH when the
 * pid is gone, EPERM when alive-but-not-ours → still "alive").
 * @param {number} pid @param {object} [io]
 */
export function processAlive(pid, io = defaultIO()) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    io.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

/**
 * Current daemon status from the pidfile.
 * @param {object} [io]
 * @returns {{ running: boolean, pid: number|null, stale: boolean }}
 *   `stale` = a pidfile exists but its pid is dead (left behind by a crash).
 */
export function isRunning(io = defaultIO()) {
  const pid = readPid(io);
  if (pid == null) return { running: false, pid: null, stale: false };
  const alive = processAlive(pid, io);
  return { running: alive, pid, stale: !alive };
}

/** Ensure ~/.chorus exists for the pid/log files. */
function ensureDir(path, io) {
  io.mkdirSync(dirname(path), { recursive: true });
}

/**
 * Spawn the daemon DETACHED in the background. The caller has already completed
 * any interactive preflight (credential completion + yolo confirm) in the
 * foreground, so the child starts non-interactively. stdout+stderr are
 * redirected to the logfile; the child pid is written to the pidfile; the child
 * is unref'd so the parent can exit.
 *
 * Refuses to start a second daemon when a live pid is already recorded (returns
 * `{ started:false, alreadyRunning:true, pid }`). A stale pidfile (dead pid) is
 * overwritten.
 *
 * @param {{ nodePath: string, args: string[], env?: Record<string,string|undefined>, cwd?: string }} spec
 *   `nodePath` (e.g. process.execPath) runs `args` (e.g. ["/path/chorus.mjs","daemon",...]
 *   WITHOUT `-d`). The env should carry the detached marker so the child skips preflight.
 * @param {object} [io]
 * @returns {{ started: boolean, pid?: number, alreadyRunning?: boolean, logFile: string, pidFile: string }}
 */
export function startBackground(spec, io = defaultIO()) {
  const pidFile = pidFilePath(io);
  const logFile = logFilePath(io);

  const status = isRunning(io);
  if (status.running) {
    return { started: false, alreadyRunning: true, pid: status.pid, logFile, pidFile };
  }

  ensureDir(logFile, io);
  // Append so restarts keep history; the child owns the fd after spawn.
  const out = io.openSync(logFile, "a");

  const isWin = (io.platform ?? process.platform) === "win32";
  const child = io.spawn(spec.nodePath, spec.args, {
    cwd: spec.cwd ?? process.cwd(),
    env: { ...(spec.env ?? {}) },
    // POSIX: detached:true makes the child a process-group leader so it survives
    // the parent and the controlling terminal closing. Windows: detached spawns
    // its own process group too; windowsHide prevents a new console window.
    detached: true,
    windowsHide: true,
    // No stdin; stdout+stderr → the logfile fd. shell:false (default) — no shell
    // word-splitting / injection surface (args is an array).
    stdio: ["ignore", out, out],
  });

  // Let the parent exit without waiting on the child (POSIX + Windows).
  child.unref?.();

  ensureDir(pidFile, io);
  io.writeFileSync(pidFile, `${child.pid}\n`, { mode: 0o600 });
  return { started: true, pid: child.pid, logFile, pidFile };
}

/**
 * Stop the recorded background daemon: signal it, then remove the pidfile.
 * @param {object} [io]
 * @returns {{ stopped: boolean, pid: number|null, reason: "stopped"|"not-running"|"stale-cleared"|"error", message: string }}
 */
export function stopDaemon(io = defaultIO()) {
  const pidFile = pidFilePath(io);
  const status = isRunning(io);
  if (status.pid == null) {
    return { stopped: false, pid: null, reason: "not-running", message: "no daemon is running (no pidfile)" };
  }
  if (!status.running) {
    // Stale pidfile — clean it up, report clearly (no silent failure).
    try { io.unlinkSync(pidFile); } catch { /* best-effort */ }
    return { stopped: false, pid: status.pid, reason: "stale-cleared", message: `no live daemon (cleared stale pidfile for pid ${status.pid})` };
  }
  try {
    io.kill(status.pid, "SIGTERM");
  } catch (err) {
    return { stopped: false, pid: status.pid, reason: "error", message: `failed to signal pid ${status.pid}: ${err instanceof Error ? err.message : String(err)}` };
  }
  try { io.unlinkSync(pidFile); } catch { /* best-effort */ }
  return { stopped: true, pid: status.pid, reason: "stopped", message: `stopped daemon (pid ${status.pid})` };
}

/**
 * Read the daemon logfile contents (for `chorus daemon logs`).
 * @param {object} [io]
 * @returns {{ ok: boolean, content?: string, message?: string }}
 */
export function readLog(io = defaultIO()) {
  const logFile = logFilePath(io);
  try {
    if (!io.existsSync(logFile)) return { ok: false, message: `no log file at ${logFile}` };
    return { ok: true, content: io.readFileSync(logFile, "utf8") };
  } catch (err) {
    return { ok: false, message: `could not read ${logFile}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
