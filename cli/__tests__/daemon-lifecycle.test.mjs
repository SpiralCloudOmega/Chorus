// cli/__tests__/daemon-lifecycle.test.mjs
// Covers daemon-background-lifecycle: -d detach (pidfile/logfile, double-start
// guard, POSIX+Windows spawn opts) and stop/status/logs. All IO injected.
import { describe, it, expect, vi } from "vitest";
import {
  startBackground,
  stopDaemon,
  isRunning,
  readPid,
  processAlive,
  readLog,
} from "../daemon-lifecycle.mjs";

/** A fake IO over an in-memory file map + controllable process table. */
function fakeIO({ files = {}, alivePids = new Set(), platform = "linux", spawnPid = 4242 } = {}) {
  const spawnCalls = [];
  return {
    _files: files,
    _spawnCalls: spawnCalls,
    existsSync: (p) => p in files,
    readFileSync: (p) => {
      if (!(p in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[p];
    },
    writeFileSync: (p, c) => { files[p] = c; },
    unlinkSync: (p) => { delete files[p]; },
    mkdirSync: () => {},
    openSync: () => 7, // fake fd
    spawn: (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      return { pid: spawnPid, unref: () => {} };
    },
    kill: (pid, sig) => {
      if (!alivePids.has(pid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      return true;
    },
    platform,
    home: "/home/u",
  };
}

const PID = "/home/u/.chorus/daemon.pid";
const LOG = "/home/u/.chorus/daemon.log";

describe("readPid / processAlive / isRunning", () => {
  it("readPid parses a valid pid, null on absent/garbage", () => {
    expect(readPid(fakeIO({ files: { [PID]: "4242\n" } }))).toBe(4242);
    expect(readPid(fakeIO({ files: {} }))).toBeNull();
    expect(readPid(fakeIO({ files: { [PID]: "notapid" } }))).toBeNull();
  });

  it("processAlive: signal-0 alive vs ESRCH dead vs EPERM alive", () => {
    expect(processAlive(10, fakeIO({ alivePids: new Set([10]) }))).toBe(true);
    expect(processAlive(11, fakeIO({ alivePids: new Set() }))).toBe(false);
    const epermIO = { kill: () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); } };
    expect(processAlive(12, epermIO)).toBe(true);
  });

  it("isRunning distinguishes running / stale / absent", () => {
    expect(isRunning(fakeIO({ files: { [PID]: "10" }, alivePids: new Set([10]) }))).toEqual({ running: true, pid: 10, stale: false });
    expect(isRunning(fakeIO({ files: { [PID]: "10" }, alivePids: new Set() }))).toEqual({ running: false, pid: 10, stale: true });
    expect(isRunning(fakeIO({ files: {} }))).toEqual({ running: false, pid: null, stale: false });
  });
});

describe("startBackground", () => {
  it("spawns detached, writes the pidfile, returns started", () => {
    const io = fakeIO({ files: {}, spawnPid: 999 });
    const r = startBackground({ nodePath: "/usr/bin/node", args: ["/x/chorus.mjs", "daemon"], env: { A: "1" } }, io);
    expect(r).toMatchObject({ started: true, pid: 999 });
    expect(io._files[PID]).toBe("999\n");
    const opts = io._spawnCalls[0].opts;
    expect(opts.detached).toBe(true);
    expect(opts.windowsHide).toBe(true);
    expect(opts.stdio[0]).toBe("ignore");
    expect(opts.shell).toBeUndefined(); // never shell:true
  });

  it("refuses to double-start when a live pid is recorded", () => {
    const io = fakeIO({ files: { [PID]: "10" }, alivePids: new Set([10]) });
    const r = startBackground({ nodePath: "node", args: [] }, io);
    expect(r).toMatchObject({ started: false, alreadyRunning: true, pid: 10 });
    expect(io._spawnCalls).toHaveLength(0);
  });

  it("overwrites a stale pidfile (dead pid) and starts", () => {
    const io = fakeIO({ files: { [PID]: "10" }, alivePids: new Set(), spawnPid: 50 });
    const r = startBackground({ nodePath: "node", args: [] }, io);
    expect(r.started).toBe(true);
    expect(io._files[PID]).toBe("50\n");
  });

  it("works for the Windows platform branch (no shell, windowsHide)", () => {
    const io = fakeIO({ files: {}, platform: "win32", spawnPid: 7 });
    const r = startBackground({ nodePath: "node.exe", args: ["chorus.mjs", "daemon"] }, io);
    expect(r.started).toBe(true);
    expect(io._spawnCalls[0].opts.windowsHide).toBe(true);
    expect(io._spawnCalls[0].opts.detached).toBe(true);
  });
});

describe("stopDaemon", () => {
  it("signals a live daemon and removes the pidfile", () => {
    const io = fakeIO({ files: { [PID]: "10" }, alivePids: new Set([10]) });
    const r = stopDaemon(io);
    expect(r).toMatchObject({ stopped: true, pid: 10, reason: "stopped" });
    expect(PID in io._files).toBe(false);
  });

  it("reports clearly when nothing is running (no pidfile)", () => {
    const r = stopDaemon(fakeIO({ files: {} }));
    expect(r).toMatchObject({ stopped: false, reason: "not-running" });
    expect(r.message).toMatch(/no daemon/i);
  });

  it("clears a stale pidfile and reports it", () => {
    const io = fakeIO({ files: { [PID]: "10" }, alivePids: new Set() });
    const r = stopDaemon(io);
    expect(r.reason).toBe("stale-cleared");
    expect(PID in io._files).toBe(false);
  });
});

describe("readLog", () => {
  it("returns content when the log exists", () => {
    const r = readLog(fakeIO({ files: { [LOG]: "hello log" } }));
    expect(r).toEqual({ ok: true, content: "hello log" });
  });
  it("reports clearly when no log file exists (no silent failure)", () => {
    const r = readLog(fakeIO({ files: {} }));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no log file/i);
  });
});
