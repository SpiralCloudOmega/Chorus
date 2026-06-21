// cli/__tests__/daemon-permission-wiring.test.mjs
// Covers the runDaemon wiring of daemon-permission-mode: TTY confirm (yes/no),
// ack-skips-prompt, non-TTY warn-only, and the permissionMode threaded into
// build(). Also covers recordYoloAck (preserve creds) and login clearing the ack.
import { describe, it, expect, vi } from "vitest";
import { runDaemon } from "../daemon.mjs";
import { recordYoloAck, writeLoginFile } from "../login.mjs";

/** Minimal happy-path deps; per-test overrides merge on top. */
function baseDeps(over = {}) {
  return {
    resolve: () => ({ url: "u", apiKey: "cho_x", source: "env" }),
    validate: async () => ({ uuid: "agent-1", name: "Daemon Bot" }),
    build: vi.fn(() => ({ async start() {}, async stop() {} })),
    log: () => {},
    errLog: () => {},
    waitForever: async () => {},
    readYoloAck: () => null,
    recordYoloAck: vi.fn(),
    nowIso: () => "2026-06-21T12:00:00.000Z",
    ...over,
  };
}

describe("runDaemon — default yolo posture threading", () => {
  it("non-TTY default start runs yolo, warns once, no prompt, build gets permissionMode:yolo", async () => {
    const errs = [];
    const build = vi.fn(() => ({ async start() {}, async stop() {} }));
    const askPrompt = vi.fn();
    const code = await runDaemon(
      {},
      baseDeps({ isTTY: false, errLog: (m) => errs.push(m), build, prompt: askPrompt })
    );
    expect(code).toBe(0);
    expect(askPrompt).not.toHaveBeenCalled();
    expect(build.mock.calls[0][1].permissionMode).toBe("yolo");
    const warnings = errs.filter((m) => m.includes("YOLO"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("--chorus-only");
  });

  it("--chorus-only forces restricted, no warning, build gets permissionMode:chorus", async () => {
    const build = vi.fn(() => ({ async start() {}, async stop() {} }));
    const errs = [];
    const code = await runDaemon(
      { chorusOnly: true },
      baseDeps({ isTTY: false, build, errLog: (m) => errs.push(m) })
    );
    expect(code).toBe(0);
    expect(build.mock.calls[0][1].permissionMode).toBe("chorus");
    expect(errs.join("")).not.toContain("YOLO");
  });
});

describe("runDaemon — TTY confirm gate", () => {
  it("TTY no-ack prompts y/N; 'y' persists ack, warns, and starts yolo", async () => {
    const recordAck = vi.fn();
    const askPrompt = vi.fn(async () => "y");
    const build = vi.fn(() => ({ async start() {}, async stop() {} }));
    const code = await runDaemon(
      {},
      baseDeps({ isTTY: true, readYoloAck: () => null, recordYoloAck: recordAck, prompt: askPrompt, build })
    );
    expect(code).toBe(0);
    expect(askPrompt).toHaveBeenCalledOnce();
    expect(recordAck).toHaveBeenCalledWith("2026-06-21T12:00:00.000Z");
    expect(build.mock.calls[0][1].permissionMode).toBe("yolo");
  });

  it("TTY no-ack with a declined prompt aborts (code 1), no ack, no build", async () => {
    const recordAck = vi.fn();
    const build = vi.fn(() => ({ async start() {}, async stop() {} }));
    const errs = [];
    const code = await runDaemon(
      {},
      baseDeps({
        isTTY: true,
        readYoloAck: () => null,
        recordYoloAck: recordAck,
        prompt: async () => "n",
        build,
        errLog: (m) => errs.push(m),
      })
    );
    expect(code).toBe(1);
    expect(recordAck).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(errs.join("")).toContain("--chorus-only");
  });

  it("TTY WITH a valid recorded ack does not prompt and starts yolo", async () => {
    const askPrompt = vi.fn();
    const build = vi.fn(() => ({ async start() {}, async stop() {} }));
    const code = await runDaemon(
      {},
      baseDeps({
        isTTY: true,
        readYoloAck: () => "2026-06-20T00:00:00.000Z",
        prompt: askPrompt,
        build,
      })
    );
    expect(code).toBe(0);
    expect(askPrompt).not.toHaveBeenCalled();
    expect(build.mock.calls[0][1].permissionMode).toBe("yolo");
  });
});

describe("recordYoloAck — preserves credentials, adds ack", () => {
  it("merges yoloAckAt into the existing file without touching creds", () => {
    const existing = { url: "u", apiKey: "cho_x", agentUuid: "a", agentName: "n" };
    let written;
    const path = recordYoloAck("2026-06-21T12:00:00.000Z", {
      path: "/p/daemon.json",
      read: () => JSON.stringify(existing),
      write: (data, deps) => {
        written = data;
        return deps.path;
      },
    });
    expect(path).toBe("/p/daemon.json");
    expect(written).toEqual({ ...existing, yoloAckAt: "2026-06-21T12:00:00.000Z" });
  });
});

describe("runDaemon — --agent validation", () => {
  it("unknown --agent errors non-zero before resolving credentials (no silent fallback)", async () => {
    const resolve = vi.fn();
    const build = vi.fn();
    const errs = [];
    const code = await runDaemon(
      { agent: "codex" },
      baseDeps({ resolve, build, errLog: (m) => errs.push(m) })
    );
    expect(code).toBe(1);
    expect(resolve).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(errs.join("")).toContain("codex");
    expect(errs.join("")).toContain("claude-code");
  });

  it("a known --agent threads agentType into build()", async () => {
    const build = vi.fn(() => ({ async start() {}, async stop() {} }));
    const code = await runDaemon(
      { agent: "claude-code" },
      baseDeps({ isTTY: false, build })
    );
    expect(code).toBe(0);
    expect(build.mock.calls[0][1].agentType).toBe("claude-code");
  });
});

describe("writeLoginFile — a re-login clears any prior ack", () => {
  it("writing fresh credentials omits yoloAckAt (login data carries none)", () => {
    let body;
    writeLoginFile(
      { url: "u2", apiKey: "cho_y", agentUuid: "a2", agentName: "n2" },
      { path: "/p", mkdir: () => {}, write: (_p, c) => (body = c) }
    );
    const parsed = JSON.parse(body);
    expect(parsed).not.toHaveProperty("yoloAckAt");
    expect(parsed).toEqual({ url: "u2", apiKey: "cho_y", agentUuid: "a2", agentName: "n2" });
  });
});
