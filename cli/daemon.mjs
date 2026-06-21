// cli/daemon.mjs
// `chorus daemon` — the assembled client daemon. Wires together:
//   CredentialResolver → ChorusClient (MCP) + SseListener (+ reconnect backfill)
//     → EventRouter → WakeQueue → Waker (LineageResolver + ClaudeSpawner)
// On a task_assigned (and other wake actions) it spawns a local headless Claude
// Code, serialized per DIRECT idea, that acts via the chorus_* MCP tools. The
// Claude session id is the dispatched entity's direct idea uuid (deterministic,
// so a human can `claude --resume <idea-uuid>`); new-vs-resume is decided by
// probing the on-disk transcript — there is no persisted session-id map.
//
// Connection / session / transcript reporting to the server is intentionally
// NOT done here — the no-op UploadHooks reserve those seams for the derived
// observability idea.

import { resolveCredentials, readYoloAck } from "./credentials.mjs";
import { prompt, recordYoloAck, writeLoginFile } from "./login.mjs";
import {
  resolvePermissionMode,
  hasValidAck,
  isAffirmative,
  yoloWarningLine,
  YOLO_CONFIRM_PROMPT,
} from "./daemon-permission-mode.mjs";
import { resolveAgentType } from "./daemon-agent.mjs";
import { formatBanner } from "./daemon-banner.mjs";
import { ChorusClient, validateAndFetchIdentity } from "./chorus-client.mjs";
import { SseListener } from "./sse-listener.mjs";
import { createBackfill } from "./backfill.mjs";
import { EventRouter } from "./event-router.mjs";
import { WakeQueue } from "./wake-queue.mjs";
import { Waker } from "./waker.mjs";
import { LineageResolver } from "./lineage.mjs";
import { ClaudeSpawner, resolveClaudePath } from "./claude-spawner.mjs";
import {
  createExecutionUploadHooks,
  createTranscriptUploadHooks,
  mergeUploadHooks,
} from "./upload-hooks.mjs";
import { WAKE_ACTIONS } from "./prompts.mjs";
import { createInterruptReporter } from "./interrupt-reporter.mjs";
import { createTurnReporter } from "./turn-reporter.mjs";
import { createControlHandler } from "./control-handler.mjs";
import { resolveSigintTimeoutMs } from "./daemon-config.mjs";
import {
  startBackground,
  stopDaemon,
  isRunning,
  readLog,
} from "./daemon-lifecycle.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Env marker set on the detached child so it skips the interactive preflight. */
export const DETACHED_ENV = "CHORUS_DAEMON_DETACHED";

/** Read the chorus CLI version from package.json (best-effort; "?" on failure). */
function readVersion() {
  try {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "?";
  } catch {
    return "?";
  }
}

function defaultLogger() {
  return {
    info: (m) => process.stdout.write(`${m}\n`),
    warn: (m) => process.stderr.write(`${m}\n`),
    error: (m) => process.stderr.write(`${m}\n`),
  };
}

/**
 * Build the fully-wired daemon without starting it. Returned object exposes
 * `start()` / `stop()` and the internal pieces (for integration tests).
 *
 * @param {{ url: string, apiKey: string }} creds
 * @param {{
 *   logger?: any,
 *   mcpClient?: any,
 *   lineage?: any,
 *   fetchImpl?: typeof fetch,
 *   sseListener?: any,
 *   spawner?: any,
 *   cwd?: string,
 *   hooks?: any,
 *   makeSseListener?: (opts: any) => any,
 *   maxConcurrency?: number,
 *   permissionMode?: "chorus"|"yolo",
 *   reportInterrupt?: (entityType: string, entityUuid: string, reason: "user"|"crash") => Promise<void>,
 *   advanceTurn?: (params: { sessionId: string, status: "running"|"ended", entityType?: string|null, entityUuid?: string|null }) => Promise<void>,
 *   sigintTimeoutMs?: number,
 * }} [deps]
 */
export function buildDaemon(creds, deps = {}) {
  const logger = deps.logger ?? defaultLogger();
  const permissionMode = deps.permissionMode ?? "chorus";
  // Per-wake verbose logging (daemon-startup-output), threaded into the Waker.
  // agentType is currently display-only (banner/logs) — the spawn path is
  // claude-code regardless (daemon-agent-selection reserves the slot only).
  const verbose = deps.verbose ?? false;
  // Escalation window for the interrupt killer (子3). Pre-resolved by runDaemon via
  // the layered resolver; falls back to the resolver's default here when not given,
  // so a daemon built directly (integration tests) still gets a sane value.
  const sigintTimeoutMs = deps.sigintTimeoutMs ?? resolveSigintTimeoutMs();
  // Interrupt reporter (子3): REST POST with the daemon's Bearer key (zero new deps),
  // injectable for tests. The waker calls it on an interrupted/crashed exit.
  // connectionState holds the connection uuid learned from the SSE handshake;
  // declared here so the reporter (which needs it to address the execution row)
  // can read it lazily. It is assigned by onConnectionId below.
  /** @type {{ connectionUuid: string|null }} */
  const connectionState = { connectionUuid: null };
  const reportInterrupt =
    deps.reportInterrupt ??
    createInterruptReporter({
      url: creds.url,
      apiKey: creds.apiKey,
      getConnectionUuid: () => connectionState.connectionUuid,
      logger,
      fetchImpl: deps.fetchImpl,
    });
  // Turn-lifecycle reporter (子1 — daemon-session-conversation): REST POST with the
  // daemon's Bearer key (zero new deps), injectable for tests. The waker calls it on a
  // wake's spawn (→ running) and exit (→ ended) to advance the server-side
  // DaemonSessionTurn the notification chokepoint created. Reads the connectionUuid
  // lazily from the same box the SSE handshake fills.
  const advanceTurn =
    deps.advanceTurn ??
    createTurnReporter({
      url: creds.url,
      apiKey: creds.apiKey,
      getConnectionUuid: () => connectionState.connectionUuid,
      logger,
      fetchImpl: deps.fetchImpl,
    });

  const mcpClient =
    deps.mcpClient ?? new ChorusClient({ url: creds.url, apiKey: creds.apiKey, logger });
  // Lineage resolution is a plain REST call (Bearer agent key) per notification —
  // it does not go through the MCP client. (deps.fetchImpl is injectable for tests.)
  const lineage =
    deps.lineage ??
    new LineageResolver({ url: creds.url, apiKey: creds.apiKey, logger, fetchImpl: deps.fetchImpl });
  const spawner = deps.spawner ?? new ClaudeSpawner({ logger, permissionMode });
  const queue = new WakeQueue({ maxConcurrency: deps.maxConcurrency ?? 4, logger });

  // `connectionState` (declared above, next to the reporter) is the mutable box the
  // SSE handshake fills with this daemon's `connection_registered` uuid; the upload
  // hooks, the reporter, and the control handler all read it lazily so construction
  // order doesn't matter. `waker` is assigned just below; the snapshot closure reads
  // it lazily so the hooks can predate it.
  /** @type {Waker|undefined} */
  let waker;

  // Execution-state upload hooks: POST the WakeQueue/waker-derived snapshot to
  // the server on each lifecycle transition. `getSnapshot` reads the waker's
  // per-task registry (which reuses the already-resolved root-idea lineage).
  // Fire-and-forget; failures logged + non-fatal (see upload-hooks.mjs). The
  // hooks share the daemon's existing creds + zero new deps (global fetch).
  // Transcript upload hooks (子1 — daemon-session-conversation): the waker's
  // stream-json consumer (onMessage) and pre-spawn (onSessionStart) feed these,
  // which keep only user/assistant text and batch-POST it to /api/daemon/transcript
  // for the current turn (resolved server-side by the session business key the waker
  // already anchors on). Same zero-dep, fire-and-forget, warn-not-throw contract as
  // the execution hooks; no connectionUuid needed (the agent key + sessionId suffice).
  // The two hook sets are MERGED into the single object the waker takes:
  // onSessionStart/onTranscriptMessage fan out to the transcript hooks,
  // onExecutionChange to the execution hooks.
  const hooks =
    deps.hooks ??
    mergeUploadHooks(
      createExecutionUploadHooks({
        url: creds.url,
        apiKey: creds.apiKey,
        getConnectionUuid: () => connectionState.connectionUuid,
        getSnapshot: () => waker?.buildExecutionSnapshot() ?? [],
        logger,
        fetchImpl: deps.fetchImpl,
      }),
      createTranscriptUploadHooks({
        url: creds.url,
        apiKey: creds.apiKey,
        logger,
        fetchImpl: deps.fetchImpl,
      }),
      { logger }
    );

  // One dedup set shared by the router (live SSE path) and the reconnect
  // backfill, so a notification handled live is never re-woken on reconnect.
  const seen = new Set();
  // cwd: the daemon spawns all wakes in one working directory; the waker uses it
  // BOTH to probe the transcript (new-vs-resume) and to spawn, so they never diverge.
  waker = new Waker({ creds, lineage, spawner, cwd: deps.cwd ?? process.cwd(), hooks, logger, reportInterrupt, advanceTurn, verbose });
  const router = new EventRouter({ mcpClient, waker, queue, wakeActions: WAKE_ACTIONS, seen, logger });

  // Reverse control channel (子3): the control handler verifies a control event
  // against this daemon's own connectionUuid + the running child for the target
  // entity (q1=a double-check), then interrupts the subprocess. It reads the
  // connectionUuid lazily from the same mutable box the SSE handshake fills, so it
  // works regardless of construction order.
  // Resume re-dispatch (子3): a `command:"resume"` control event re-runs the wake
  // for the target entity. It reuses the SAME router/queue path as a normal wake,
  // so serialization-per-direct-idea holds and the spawner's on-disk transcript
  // probe naturally selects `claude --resume` (the session already exists). The
  // synthetic event mirrors the `new_notification` shape the router expects; we
  // fetch the real notification detail lazily inside the router via MCP, so a
  // minimal `{ action: "resource_resumed", entityType, entityUuid }` is enough to
  // re-key and re-spawn. Because resume rides the control channel (not a persisted
  // notification), there is no notificationUuid — the router tolerates a synthetic
  // resume dispatch via the dedicated entrypoint below.
  const redispatchResume = (entityType, entityUuid) => {
    router.dispatchResume?.({ entityType, entityUuid });
  };
  // Origin-only live delivery (子2 — daemon-instruction-injection): a `deliver_turn`
  // control event means the server pinged THIS connection that a SPECIFIC new pending
  // `human_instruction` turn (`turnUuid`) awaits. The control handler forwards that uuid
  // to the connection-scoped pending-turns sweep (exposed as `backfill.pendingTurnsOnly`)
  // so ONLY that one turn is dispatched — never a connection-wide sweep that would also
  // run every other still-pending turn. It shares the same `seen` set as reconnect
  // backfill (a turn runs at most once). Read lazily so it tolerates the construction
  // order (backfill is assigned just after).
  const deliverTurn = (turnUuid) => backfill?.pendingTurnsOnly?.(turnUuid);
  const onControl = createControlHandler({
    waker,
    getConnectionUuid: () => connectionState.connectionUuid,
    sigintTimeoutMs,
    redispatchResume,
    deliverTurn,
    logger,
  });

  // Reconnect backfill re-dispatches notifications missed during a gap, through
  // the SAME router/queue (so serialization holds) and the SAME seen set (so
  // already-handled notifications are skipped). The router marks seen at
  // dispatch; backfill's own pre-check is a cheap early-out.
  // `deliverTurn` (defined above) closes over `backfill` but only invokes it lazily,
  // so a `const` initialized here is safe despite the earlier lexical reference.
  const backfill = createBackfill({
    mcpClient,
    dispatch: (event) => router.dispatch(event),
    seen,
    logger,
    // 子1 — pending-turn backfill: re-derive unstarted turns from the turn table (NOT
    // notifications) for this connection's origin-pinned sessions, so a lost delivery
    // ping never loses an instruction. Shares the same router (dispatchPendingTurn) +
    // seen set so a turn handled live (or by an earlier backfill) is not re-run. Reads
    // the connectionUuid lazily from the SSE-handshake box.
    url: creds.url,
    apiKey: creds.apiKey,
    getConnectionUuid: () => connectionState.connectionUuid,
    dispatchPendingTurn: (turn) => router.dispatchPendingTurn?.(turn),
    fetchImpl: deps.fetchImpl,
  });

  const sseListener =
    deps.sseListener ??
    (deps.makeSseListener ?? ((o) => new SseListener(o)))({
      url: creds.url,
      apiKey: creds.apiKey,
      onEvent: (event) => router.dispatch(event),
      // Capture the connectionUuid the server reports for this stream so the
      // execution-state upload hooks can attribute snapshots to it.
      onConnectionId: (connectionUuid) => {
        connectionState.connectionUuid = connectionUuid;
        logger.info(`[Chorus] registered as connection ${connectionUuid}`);
      },
      // Reverse control channel: a `type:"control"` event is forked here, NEVER to
      // onEvent/router/queue — so it can never spawn a wake (子3).
      onControl,
      onReconnect: backfill,
      logger,
    });

  return {
    mcpClient,
    lineage,
    spawner,
    queue,
    waker,
    router,
    sseListener,
    async start() {
      await hooks.onConnect?.({ host: creds.url });
      await sseListener.connect();
    },
    async stop() {
      sseListener.disconnect?.();
      await mcpClient.disconnect?.();
    },
  };
}

/**
 * Entry point for `chorus daemon`. Resolves credentials, validates them
 * (echoing the agent identity), and runs the daemon until terminated.
 *
 * @param {{ url?: string, apiKey?: string, yolo?: boolean, sigintTimeout?: number|string }} flags
 * @param {{
 *   resolve?: typeof resolveCredentials,
 *   validate?: typeof validateAndFetchIdentity,
 *   build?: typeof buildDaemon,
 *   log?: (m: string) => void,
 *   errLog?: (m: string) => void,
 *   waitForever?: () => Promise<void>,
 *   env?: Record<string, string|undefined>,
 * }} [deps]
 * @returns {Promise<number>}
 */
export async function runDaemon(flags = {}, deps = {}) {
  const resolve = deps.resolve ?? resolveCredentials;
  const validate = deps.validate ?? validateAndFetchIdentity;
  const build = deps.build ?? buildDaemon;
  const log = deps.log ?? ((m) => process.stdout.write(`${m}\n`));
  const errLog = deps.errLog ?? ((m) => process.stderr.write(`${m}\n`));
  const env = deps.env ?? process.env;
  // TTY detection + IO seams (injectable for tests). Default to the real stdin
  // TTY flag and the real prompt / ack helpers.
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
  const askPrompt = deps.prompt ?? prompt;
  const writeCreds = deps.writeLoginFile ?? writeLoginFile;
  const readAck = deps.readYoloAck ?? readYoloAck;
  const recordAck = deps.recordYoloAck ?? recordYoloAck;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const version = deps.version ?? readVersion();
  const findClaude = deps.resolveClaudePath ?? resolveClaudePath;
  const verbose = flags.verbose === true || env.CHORUS_VERBOSE === "1";

  // Resolve the agent backend (default claude-code). An unknown --agent /
  // CHORUS_AGENT is a hard error — no silent fallback (daemon-agent-selection).
  const agentResult = resolveAgentType(flags, env);
  if (!agentResult.ok) {
    errLog(`[Chorus] ${agentResult.error}`);
    return 1;
  }
  const agentType = agentResult.agent;

  // Lifecycle subcommands (stop/status/restart/logs) operate on the pidfile/logfile
  // managed by the `-d` path — they never start the long-lived foreground daemon.
  // `run` falls through to the normal startup below. Injectable lifecycle for tests.
  const lifecycle = deps.lifecycle ?? { startBackground, stopDaemon, isRunning, readLog };
  // The preflight dep bundle — built from the same seams runDaemon resolved, so
  // the detach/restart paths run the SAME (injectable) preflight, not the real
  // implementations. Threaded into startDetached so tests can drive it offline.
  const pfDeps = { flags, env, isTTY, resolve, validate, writeCreds, askPrompt, readAck, recordAck, nowIso, log, errLog };

  const action = flags.action ?? "run";
  if (action !== "run") {
    return handleLifecycleAction(action, { flags, env, log, errLog, lifecycle, pfDeps });
  }

  // `-d` / --detach: complete any interactive preflight in THIS foreground process
  // (which holds the TTY), then spawn the daemon detached and return. The detached
  // child re-enters runDaemon with the DETACHED_ENV marker set, so it skips the
  // preflight prompts. A child run (marker present) falls through to normal startup.
  const isDetachedChild = env[DETACHED_ENV] === "1";
  if (flags.detach && !isDetachedChild) {
    return startDetached({ log, errLog, lifecycle, pfDeps });
  }

  // SIGINT-escalation window for the interrupt killer (子3) — layered:
  //   --sigint-timeout flag > CHORUS_DAEMON_SIGINT_TIMEOUT env > ~/.chorus/daemon.json > 10000.
  const sigintTimeoutMs = resolveSigintTimeoutMs({ sigintTimeout: flags.sigintTimeout }, { env });

  // Foreground preflight: resolve/complete credentials + resolve the permission
  // posture (confirming yolo on a TTY). Reuses the same pfDeps bundle the detach
  // path uses. Returns a numeric exit code on failure, or
  // { creds, identity, permissionMode } on success.
  const pf = await preflight(pfDeps);
  if (typeof pf === "number") return pf;
  const { creds, identity, permissionMode } = pf;

  // Detect the claude executable (non-fatal): the daemon still subscribes when
  // it's missing; a wake surfaces the error visibly when one arrives. The
  // resolved path (or absence) is shown in the banner below.
  const claudePath = findClaude();

  // Boxed startup banner — one screen replacing the scattered [Chorus] lines.
  log(
    formatBanner(
      {
        version,
        url: creds.url,
        agentName: identity.name,
        agentUuid: identity.uuid,
        permissionMode,
        credentialSource: creds.source,
        agentType,
        claudePath,
        connection: "connecting…",
      },
      { isTTY: isTTY && Boolean(process.stdout.isTTY) }
    )
  );
  // The yolo posture is loud even when the banner scrolls past — keep the one-line
  // ⚠ warning on stderr (it also names --chorus-only as the reclaim switch).
  if (permissionMode === "yolo") {
    errLog(`[Chorus] ${yoloWarningLine()}`);
  }

  const daemon = build(creds, {
    logger: { info: log, warn: errLog, error: errLog },
    permissionMode,
    agentType,
    verbose,
    sigintTimeoutMs,
  });

  // Graceful shutdown on signals.
  const shutdown = () => {
    log("[Chorus] shutting down daemon...");
    Promise.resolve(daemon.stop()).finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log(`[Chorus] daemon starting — subscribing to ${creds.url}/api/events/notifications`);
  await daemon.start();
  log("[Chorus] daemon running. Waiting for task dispatches (Ctrl+C to stop).");

  // Keep the process alive for the long-lived SSE subscription.
  await (deps.waitForever ?? (() => new Promise(() => {})))();
  return 0;
}

/**
 * Foreground preflight shared by the normal and `-d` startup paths: resolve or
 * interactively complete credentials, validate identity, and resolve the
 * permission posture (confirming + persisting the yolo ack on a TTY). All the
 * interactive IO lives here so it always runs in a real terminal before any
 * detach. Returns a numeric exit code on failure, or
 * { creds, identity, permissionMode } on success.
 * @returns {Promise<number | { creds: any, identity: any, permissionMode: "yolo"|"chorus" }>}
 */
export async function preflight(ctx) {
  const { flags, env, isTTY, resolve, validate, writeCreds, askPrompt, readAck, recordAck, nowIso, log, errLog } = ctx;

  let creds;
  // `identity` may be pre-filled by interactive completion (it validates as part
  // of completing), so the main validate step is skipped when it's already set.
  let identity = null;
  try {
    creds = resolve(flags);
  } catch (err) {
    // No resolvable credentials. On a TTY, complete them interactively (reusing
    // the `chorus login` masked-prompt → validate → 0600 persist flow). On a
    // non-TTY (systemd / nohup / CI / detached child), preserve the hard error +
    // multi-source hint — never block on a prompt no one can answer.
    if (!isTTY) {
      errLog(err instanceof Error ? err.message : String(err));
      return 1;
    }
    log("[Chorus] no credentials found — completing them interactively (saved for next time).");
    let url = await askPrompt("Chorus URL: ");
    let apiKey = await askPrompt("Chorus API key (cho_...): ", { mask: true });
    url = (url || "").trim();
    apiKey = (apiKey || "").trim();
    if (!url || !apiKey) {
      errLog("[Chorus] both a URL and an API key are required — aborting.");
      return 1;
    }
    try {
      identity = await validate({ url, apiKey });
    } catch (verr) {
      errLog(`[Chorus] credential validation failed: ${verr instanceof Error ? verr.message : String(verr)}`);
      errLog("[Chorus] credentials were NOT saved.");
      return 1;
    }
    writeCreds({ url, apiKey, agentUuid: identity.uuid, agentName: identity.name });
    creds = { url, apiKey, source: "interactive" };
  }
  log(`[Chorus] credentials resolved from: ${creds.source}`);

  if (!identity) {
    try {
      identity = await validate({ url: creds.url, apiKey: creds.apiKey });
    } catch (err) {
      errLog(`[Chorus] credential validation failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  log(`[Chorus] authenticated as ${identity.name} (${identity.uuid})`);

  // Permission posture: default yolo, gated by a one-time TTY confirmation
  // remembered as yoloAckAt. --chorus-only reclaims the restricted posture.
  const decision = resolvePermissionMode(flags, env, { isTTY, hasAck: hasValidAck(readAck()) });
  if (decision.mode === "yolo" && decision.needConfirm) {
    const answer = await askPrompt(YOLO_CONFIRM_PROMPT);
    if (!isAffirmative(answer)) {
      errLog(
        "[Chorus] YOLO not confirmed — not starting. Re-run and confirm, or use " +
          "--chorus-only to start in the restricted (Chorus-tools-only) posture."
      );
      return 1;
    }
    try {
      recordAck(nowIso());
    } catch (err) {
      errLog(`[Chorus] warning: could not persist YOLO acknowledgement: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { creds, identity, permissionMode: decision.mode };
}

/**
 * Dispatch a daemon lifecycle subcommand (stop/status/restart/logs) against the
 * pidfile/logfile-managed background daemon. Each reports clearly when nothing
 * is running (no silent failure). `restart` performs stop-then-detached-start.
 * @returns {Promise<number>} exit code
 */
export async function handleLifecycleAction(action, { flags, env, log, errLog, lifecycle, pfDeps }) {
  if (action === "status") {
    const s = lifecycle.isRunning();
    if (s.running) log(`[Chorus] daemon is running (pid ${s.pid}).`);
    else if (s.stale) log(`[Chorus] daemon is NOT running (stale pidfile for pid ${s.pid}).`);
    else log("[Chorus] daemon is not running.");
    return 0;
  }
  if (action === "logs") {
    const r = lifecycle.readLog();
    if (!r.ok) {
      errLog(`[Chorus] ${r.message}`);
      return 1;
    }
    log(r.content);
    return 0;
  }
  if (action === "stop") {
    const r = lifecycle.stopDaemon();
    (r.stopped ? log : errLog)(`[Chorus] ${r.message}`);
    return r.stopped ? 0 : 1;
  }
  if (action === "restart") {
    const r = lifecycle.stopDaemon();
    log(`[Chorus] ${r.message}`);
    // Start a fresh detached instance regardless of whether one was running.
    return startDetached({ log, errLog, lifecycle, pfDeps, skipPreflight: true });
  }
  errLog(`[Chorus] unknown daemon action: ${action}`);
  return 1;
}

/**
 * `-d` / --detach: run the foreground preflight (in this TTY), then spawn the
 * daemon detached (re-exec self without `-d`, with the DETACHED_ENV marker so
 * the child skips the preflight), write the pidfile, and return. Refuses to
 * double-start when a live daemon is already recorded.
 *
 * `skipPreflight` (used by restart) bypasses the interactive preflight — restart
 * runs non-interactively against already-persisted credentials/ack.
 * @returns {Promise<number>} exit code
 */
export async function startDetached(ctx) {
  const { log, errLog, lifecycle, pfDeps, skipPreflight } = ctx;
  const env = pfDeps.env ?? process.env;

  // Refuse to double-start before doing any interactive work.
  const status = lifecycle.isRunning();
  if (status.running) {
    errLog(`[Chorus] a daemon is already running (pid ${status.pid}). Use 'chorus daemon stop' first.`);
    return 1;
  }

  if (!skipPreflight) {
    // Run the SAME (injectable) preflight as the foreground path, in THIS TTY,
    // before detaching — so credential completion + the yolo y/N confirm happen
    // where a human can answer them.
    const pf = await preflight(pfDeps);
    if (typeof pf === "number") return pf; // preflight failed (e.g. declined yolo)
  }

  // Re-exec this same chorus entry without `-d` (so the child runs the daemon),
  // marking it DETACHED so it skips the interactive preflight.
  const nodePath = process.execPath;
  const scriptArgs = process.argv.slice(1).filter((a) => a !== "-d" && a !== "--detach");
  const result = lifecycle.startBackground({
    nodePath,
    args: scriptArgs,
    env: { ...env, [DETACHED_ENV]: "1" },
    cwd: process.cwd(),
  });

  if (result.alreadyRunning) {
    errLog(`[Chorus] a daemon is already running (pid ${result.pid}).`);
    return 1;
  }
  log(`[Chorus] daemon started in background (pid ${result.pid}).`);
  log(`[Chorus]   logs:  chorus daemon logs   (${result.logFile})`);
  log(`[Chorus]   stop:  chorus daemon stop`);
  return 0;
}
