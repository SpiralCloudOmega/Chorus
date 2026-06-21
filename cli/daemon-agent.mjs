// cli/daemon-agent.mjs
// Pure resolution + validation of the daemon's `--agent <type>` selection. The
// flag/env exist to RESERVE the extension point for future agent backends
// (e.g. codex); only `claude-code` is implemented in this change. Resolving an
// unknown value is a hard error (no silent fallback). Zero dependencies.

/** The agent backends the daemon recognizes. Only `claude-code` is implemented. */
export const KNOWN_AGENTS = ["claude-code"];

/** The default agent backend when neither --agent nor CHORUS_AGENT is set. */
export const DEFAULT_AGENT = "claude-code";

/**
 * Resolve the agent type from flag → env → default, and validate it.
 * Precedence: explicit `--agent` flag > CHORUS_AGENT env > DEFAULT_AGENT.
 *
 * @param {{ agent?: string }} flags
 * @param {Record<string, string|undefined>} env
 * @returns {{ ok: true, agent: string } | { ok: false, value: string, error: string }}
 *   `ok:false` carries the offending value and a human-actionable error naming
 *   the accepted types — the caller exits non-zero and prints `error`.
 */
export function resolveAgentType(flags, env) {
  const raw =
    (typeof flags.agent === "string" && flags.agent.trim()) ||
    (typeof env.CHORUS_AGENT === "string" && env.CHORUS_AGENT.trim()) ||
    DEFAULT_AGENT;
  if (!KNOWN_AGENTS.includes(raw)) {
    return {
      ok: false,
      value: raw,
      error:
        `Unknown --agent "${raw}". Accepted: ${KNOWN_AGENTS.join(", ")}. ` +
        `(Only ${DEFAULT_AGENT} is implemented; the flag reserves the slot for future agents.)`,
    };
  }
  return { ok: true, agent: raw };
}
