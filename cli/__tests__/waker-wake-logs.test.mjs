// cli/__tests__/waker-wake-logs.test.mjs
// Covers daemon-startup-output "Per-wake single-line lifecycle logs": arrival,
// spawn (new vs resume + resume hint), completion (duration + exit code), and
// the --verbose detail lines.
import { describe, it, expect, vi } from "vitest";
import { Waker } from "../waker.mjs";

const ROOT_IDEA = "11111111-1111-4111-8111-111111111111";
const DIRECT_IDEA = "22222222-2222-4222-8222-222222222222";
const TASK_NOTIF = { action: "task_assigned", entityType: "task", entityUuid: "33333333-3333-4333-8333-333333333333" };

function makeWaker({ verbose = false, isNew = true, exitCode = 0, infos = [] } = {}) {
  return new Waker({
    creds: { url: "https://c", apiKey: "cho_x" },
    lineage: { resolve: async () => ({ rootIdeaUuid: ROOT_IDEA, directIdeaUuid: DIRECT_IDEA }) },
    spawner: { wake: async ({ onChild }) => { onChild?.({}); return { sessionId: DIRECT_IDEA, exitCode, isNew }; } },
    cwd: "/work/dir",
    logger: { info: (m) => infos.push(m), warn: () => {}, error: () => {} },
    writeMcpConfigFn: vi.fn(() => ({ path: "/tmp/m.json", cleanup: vi.fn() })),
    isNewSessionFn: vi.fn(() => isNew),
    verbose,
  });
}

describe("per-wake lifecycle logs (default verbosity)", () => {
  it("emits arrival, spawn (new + resume hint), and completion (exit + duration) lines", async () => {
    const infos = [];
    const waker = makeWaker({ infos, isNew: true, exitCode: 0 });
    const r = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, r.key, r);
    const out = infos.join("\n");

    // Arrival: action + target entity.
    expect(out).toMatch(/wake: task_assigned → task:33333333/);
    // Spawn: new session + the claude --resume takeover hint.
    expect(out).toMatch(/spawning new session 22222222/);
    expect(out).toContain(`claude --resume ${DIRECT_IDEA}`);
    // Completion: exit code + a duration in ms.
    expect(out).toMatch(/wake done: task:33333333\S* \(exit=0, \d+ms\)/);
  });

  it("says 'resuming' (not 'spawning new') when the transcript already exists", async () => {
    const infos = [];
    const waker = makeWaker({ infos, isNew: false, exitCode: 0 });
    const r = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, r.key, r);
    expect(infos.join("\n")).toMatch(/resuming session 22222222/);
  });

  it("reports a non-zero exit code on the completion line", async () => {
    const infos = [];
    const waker = makeWaker({ infos, exitCode: 2 });
    const r = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, r.key, r);
    expect(infos.join("\n")).toMatch(/wake done: .* \(exit=2, \d+ms\)/);
  });

  it("does NOT emit the verbose detail lines by default", async () => {
    const infos = [];
    const waker = makeWaker({ infos, verbose: false });
    const r = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, r.key, r);
    expect(infos.join("\n")).not.toMatch(/cwd=\/work\/dir/);
  });
});

describe("per-wake lifecycle logs (--verbose)", () => {
  it("adds detail lines (cwd / root / key) when verbose", async () => {
    const infos = [];
    const waker = makeWaker({ infos, verbose: true });
    const r = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, r.key, r);
    const out = infos.join("\n");
    expect(out).toMatch(/cwd=\/work\/dir/);
    expect(out).toContain(ROOT_IDEA);
  });
});
