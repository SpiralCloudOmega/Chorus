// cli/daemon-permission-mode.mjs
// Pure resolution of the daemon's permission posture for the woken agent, plus
// the ack (acknowledgement) read/write helpers. The DEFAULT is now `yolo`
// (full autonomy) — reversing the prior `chorus`-only default — gated by a
// one-time TTY confirmation that is remembered in ~/.chorus/daemon.json.
//
// This module is PURE: `resolvePermissionMode` does no IO and returns a
// decision object; the prompt / file-write / stdout live in thin wrappers in
// daemon.mjs. Zero dependencies — ships in the npm package alongside chorus.mjs.

/**
 * @typedef {"yolo"|"chorus"} PermissionMode
 *   "yolo"   → woken agent gets full autonomy (--dangerously-skip-permissions).
 *   "chorus" → restricted: only mcp__chorus__* tools (no Bash / file edits).
 */

/**
 * @typedef {Object} PermissionDecision
 * @property {PermissionMode} mode        The resolved posture.
 * @property {boolean} needConfirm        True iff the caller must obtain an
 *   interactive TTY y/N confirmation AND persist an ack before starting yolo.
 * @property {boolean} warnUnattended     True iff yolo is starting on a non-TTY
 *   (unattended) — the caller must emit exactly one prominent ⚠ warning line.
 */

/**
 * Resolve the permission posture from the layered inputs. Precedence:
 *   1. Explicit restricted request (`--chorus-only` / CHORUS_CHORUS_ONLY=1) wins
 *      outright → `chorus`, never needs confirmation.
 *   2. Otherwise the posture is `yolo` (the new default; `--yolo` /
 *      CHORUS_YOLO=1 select it too, but it is also the no-flag default).
 *   3. For yolo, the gate depends on the terminal:
 *        - TTY + a valid recorded ack  → start, no prompt.
 *        - TTY + no ack                → needConfirm (prompt y/N, then persist).
 *        - non-TTY                     → start directly, warnUnattended.
 *
 * `CHORUS_YOLO=0`/`"false"` is treated as an explicit opt-OUT of yolo (→
 * `chorus`), symmetric with the `=1`/`"true"` opt-in, so the existing env knob
 * keeps working after the default flip.
 *
 * @param {{ yolo?: boolean, chorusOnly?: boolean }} flags
 * @param {Record<string, string|undefined>} env
 * @param {{ isTTY: boolean, hasAck: boolean }} ctx
 * @returns {PermissionDecision}
 */
export function resolvePermissionMode(flags, env, ctx) {
  const envChorusOnly = env.CHORUS_CHORUS_ONLY === "1" || env.CHORUS_CHORUS_ONLY === "true";
  const envYoloOff = env.CHORUS_YOLO === "0" || env.CHORUS_YOLO === "false";

  // 1. Explicit restricted request wins — flag, env, or an explicit CHORUS_YOLO opt-out.
  if (flags.chorusOnly || envChorusOnly || envYoloOff) {
    return { mode: "chorus", needConfirm: false, warnUnattended: false };
  }

  // 2 & 3. Default + explicit yolo both resolve to yolo; gate on terminal/ack.
  if (ctx.isTTY) {
    return { mode: "yolo", needConfirm: !ctx.hasAck, warnUnattended: false };
  }
  return { mode: "yolo", needConfirm: false, warnUnattended: true };
}

/**
 * Is a recorded ack value valid (i.e. should it suppress the TTY prompt)? An
 * ack is the ISO-8601 timestamp written when the user confirmed yolo. Any
 * non-empty string counts; absent/blank does not.
 * @param {unknown} yoloAckAt
 * @returns {boolean}
 */
export function hasValidAck(yoloAckAt) {
  return typeof yoloAckAt === "string" && yoloAckAt.trim().length > 0;
}

/**
 * Interpret a raw y/N answer. Only an explicit yes (`y` / `yes`, case- and
 * whitespace-insensitive) confirms; everything else (including empty / Enter)
 * is a decline — the safe default for a permission escalation.
 * @param {string} answer
 * @returns {boolean}
 */
export function isAffirmative(answer) {
  if (typeof answer !== "string") return false;
  const a = answer.trim().toLowerCase();
  return a === "y" || a === "yes";
}

/** The one-time confirmation prompt shown on a TTY before first yolo start. */
export const YOLO_CONFIRM_PROMPT =
  "Start the daemon in YOLO mode? The woken agent will have FULL autonomy " +
  "(Bash, file writes, any command) under this daemon's API key. [y/N]: ";

/**
 * The prominent warning shown whenever yolo is active. Names `--chorus-only` as
 * the reclaim switch (required by the spec). Used both for the unattended
 * non-TTY path and after an interactive confirm.
 * @returns {string}
 */
export function yoloWarningLine() {
  return (
    "⚠ PERMISSION MODE: YOLO — the woken agent has FULL autonomy (Bash, file writes, " +
    "any command) under this daemon's API key. Run only in a trusted/sandboxed " +
    "environment. Reclaim the restricted posture with --chorus-only (or CHORUS_CHORUS_ONLY=1)."
  );
}
