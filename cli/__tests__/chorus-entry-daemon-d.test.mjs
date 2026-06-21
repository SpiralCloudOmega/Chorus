// cli/__tests__/chorus-entry-daemon-d.test.mjs
// Regression: `chorus daemon -d` must NOT crash with a TypeError. The daemon's
// `-d` (detach) collides with the server's `-d`/--data-dir short alias; the
// server-config line `resolve(getArg("--data-dir","-d"))` used to run even for
// subcommands and threw `resolve(true)` on the same tick (ERR_INVALID_ARG_TYPE)
// before the daemon could detach. This drives the REAL chorus.mjs argv entry
// (unit tests that call runDaemon directly cannot catch this).
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ENTRY = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "chorus.mjs");

/** Run `node chorus.mjs <args>` with creds cleared + a throwaway HOME; capture output. */
function runEntry(args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY, ...args], {
      env: {
        ...process.env,
        CHORUS_URL: "",
        CHORUS_API_KEY: "",
        HOME: "/tmp/chorus-entry-test-home",
        // ensure the plugin-config fallback can't resolve either
        CHORUS_DAEMON_HEADLESS: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

describe("chorus daemon -d entry (regression)", () => {
  it("does not crash with a TypeError / ERR_INVALID_ARG_TYPE", async () => {
    const { out } = await runEntry(["daemon", "-d"]);
    expect(out).not.toMatch(/ERR_INVALID_ARG_TYPE/);
    expect(out).not.toMatch(/TypeError/);
    // It should reach the daemon's own no-credentials path instead.
    expect(out).toMatch(/Could not resolve Chorus credentials|credentials/i);
  }, 20000);

  it("`chorus daemon --detach` behaves the same as `-d`", async () => {
    const { out } = await runEntry(["daemon", "--detach"]);
    expect(out).not.toMatch(/ERR_INVALID_ARG_TYPE|TypeError/);
    expect(out).toMatch(/Could not resolve Chorus credentials|credentials/i);
  }, 20000);
});
