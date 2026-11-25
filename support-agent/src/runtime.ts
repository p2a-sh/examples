import { bundleRefreshLoop, ensureBundle } from "./bundle-refresh.js"
import { dispatchAlert, loadAlerts, saveAlerts, type AlertInfo, type AlertState } from "./alerts.js"
import { decideConnection, loadConnections, saveConnections, type ConnectionState } from "./connections.js"
import { ConfigError, loadConfig, type Config } from "./config.js"
import { HEALTH_INTERVAL_MS, HEALTH_QUIET_MS, startHeartbeat, touchHealth, type HealthGate } from "./health.js"
import { logLine } from "./log.js"
import { handleTurn, loadTurnState, type TurnState } from "./turn.js"

export interface SupportAgent {
  onRequest(handler: (req: SupportRequest) => Promise<string | void> | string | void): void
  onConnectionRequest(handler: (req: SupportConnection) => Promise<void> | void): void
  resolve(target: string): Promise<Record<string, unknown>>
  respondConnection(linkId: string, action: "accept" | "decline" | "block"): Promise<unknown>
  send(to: string, text: string): Promise<unknown>
  listen(options: { mode?: "stream" | "poll"; signal?: AbortSignal }): Promise<void>
}

export interface SupportRequest {
  text?: string
  contextId?: string
  requestId?: string
  sender?: { did?: string; address?: string }
}

export interface SupportConnection {
  linkId: string
  owner?: string
  text?: string
}

export interface RuntimeDeps {
  agent: SupportAgent
  fetchImpl?: typeof fetch
  now?: () => Date
  turn?: TurnState
}

const OWNERS = 5_000
const OWNER_TTL_MS = 60 * 60 * 1000
export const LISTEN_BACKOFF_MS = 1_000
export const LISTEN_BACKOFF_MAX_MS = 30_000

const TRANSIENT_HTTP = new Set([408, 425, 429])
// Shared by the listen logger, the heartbeat, and request handling. A poll retry holds it so a stuck reconnect is not reported as healthy.
const healthGate: HealthGate = { quietUntil: 0 }
const CONNECTION_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT",
])

export function sleepBackoff(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener("abort", finish, { once: true })
  })
}

/** Retry transient listen failures until `signal` aborts. Auth and other failures propagate. */
export async function listenWithRetry(
  connect: () => Promise<void>,
  signal: AbortSignal,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = sleepBackoff,
  random: () => number = Math.random,
): Promise<void> {
  let delay = LISTEN_BACKOFF_MS
  while (!signal.aborted) {
    let failed = false
    try {
      await connect()
      delay = LISTEN_BACKOFF_MS
    } catch (err) {
      if (signal.aborted) return
      const code = transientListenCode(err)
      if (!code) throw err
      failed = true
      logLine("warn", "listen_retry", { error_code: code })
    }
    if (signal.aborted) return
    if (!failed) logLine("warn", "listen_retry", { error_code: "listen_ended" })
    await sleep(listenDelay(delay, random()), signal)
    if (failed) delay = Math.min(delay * 2, LISTEN_BACKOFF_MAX_MS)
  }
}

function listenDelay(base: number, random: number): number {
  const unit = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0
  return Math.round(base * (0.5 + unit * 0.5))
}

function transientListenCode(err: unknown): string | undefined {
  if (err instanceof ConfigError) return undefined
  const status = numberField(err, "status")
  if (status === 401 || status === 403) return undefined
  if (status === 429 || (status !== undefined && (TRANSIENT_HTTP.has(status) || status >= 500))) {
    return status === 429 ? "rate_limited" : `http_${status}`
  }
  const code = stringField(err, "code")
  if (code === "unauthorized" || code === "forbidden") return undefined
  if (code === "rate_limited") return "rate_limited"
  if (code === "network" || code === "invalid_response" || code === "rpc_error") return code
  const cause = err && typeof err === "object" ? (err as { cause?: unknown }).cause : undefined
  const causeCode = stringField(cause, "code")
  if (CONNECTION_CODES.has(code) || CONNECTION_CODES.has(causeCode)) {
    return code === "ETIMEDOUT" || causeCode === "ETIMEDOUT" ? "timeout" : "connection"
  }
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "ConnectTimeoutError" || err.name === "HeadersTimeoutError")) {
    return "timeout"
  }
  if (err instanceof Error && err.name === "AuthError") return undefined
  return undefined
}

function numberField(err: unknown, key: string): number | undefined {
  if (!err || typeof err !== "object") return undefined
  const value = (err as Record<string, unknown>)[key]
  return typeof value === "number" && Number.isInteger(value) ? value : undefined
}

function stringField(err: unknown, key: string): string {
  if (!err || typeof err !== "object") return ""
  const value = (err as Record<string, unknown>)[key]
  return typeof value === "string" ? value : ""
}

function pollWarnCode(line: string): string {
  const match = /^poll_retry (http_\d{3}|network|timeout|connection|rate_limited|invalid_response|rpc_error)$/.exec(line)
  const code = match?.[1]
  if (!code) return "poll_retry"
  if (code.startsWith("http_")) {
    const status = Number(code.slice(5))
    if (status === 401 || status === 403) return "poll_retry"
    if (!(status === 408 || status === 425 || status === 429 || status >= 500)) return "poll_retry"
  }
  return code
}

export async function runSupport(env: Record<string, string | undefined>, deps?: Partial<RuntimeDeps> & { signal?: AbortSignal }): Promise<void> {
  const config = loadConfig(env, { requireSecrets: true })
  if (!config.p2aUrl) throw new ConfigError("P2A_URL is required")
  const controller = new AbortController()
  const signal = deps?.signal ?? controller.signal
  const stop = () => controller.abort()
  if (!deps?.signal) {
    process.once("SIGTERM", stop)
    process.once("SIGINT", stop)
  }
  const mode = config.listenMode
  const now = deps?.now ?? (() => new Date())
  const turn = loadTurnState(config.stateDir, now(), config.senderBurstWindowSeconds * 1000)
  const pendingAlerts: AlertInfo[] = []
  let deliverAlert: ((info: AlertInfo) => Promise<void>) | undefined
  const pushAlert = async (info: AlertInfo): Promise<void> => {
    if (!deliverAlert) {
      pendingAlerts.push(info)
      return
    }
    await deliverAlert(info)
  }
  const bindAlerts = (alerts: AlertState, agent: SupportAgent) => {
    deliverAlert = (info) => raise(config, alerts, now(), agent, info)
  }
  const flushAlerts = async () => {
    if (!deliverAlert) return
    const queued = pendingAlerts.splice(0)
    for (const info of queued) await deliverAlert(info)
  }
  const bundleHooks = {
    fetchImpl: deps?.fetchImpl,
    now,
    onRejected: () => pushAlert({ kind: "bundle_rejected" }),
  }
  const listenOnce = async (agent: SupportAgent) => {
    const wired = await wireSupport(config, { agent, fetchImpl: deps?.fetchImpl, now, turn })
    bindAlerts(wired.alerts, agent)
    await flushAlerts()
    touchHealth(config.stateDir, now())
    const stopHeartbeat = startHeartbeat(config.stateDir, now, HEALTH_INTERVAL_MS, healthGate)
    try {
      await agent.listen({ mode, signal })
    } finally {
      stopHeartbeat()
      saveConnections(config.stateDir, wired.connections)
      saveAlerts(config.stateDir, wired.alerts)
      touchHealth(config.stateDir, now())
    }
  }
  const onRejection = (reason: unknown) => {
    logLine("error", "unhandled_rejection", { error_code: rejectionCode(reason) }, config.logLevel)
  }
  process.on("unhandledRejection", onRejection)
  try {
    await ensureBundle(config, bundleHooks)
    void bundleRefreshLoop(config, signal, bundleHooks).catch(() => {
      logLine("warn", "bundle_refresh", { error_code: "bundle_build_failed" }, config.logLevel)
    })
    if (deps?.agent) {
      const agent = deps.agent
      const wired = await wireSupport(config, { agent, fetchImpl: deps.fetchImpl, now, turn })
      bindAlerts(wired.alerts, agent)
      await flushAlerts()
      await listenWithRetry(async () => {
        touchHealth(config.stateDir, now())
        const stopHeartbeat = startHeartbeat(config.stateDir, now, HEALTH_INTERVAL_MS, healthGate)
        try {
          await agent.listen({ mode, signal })
        } finally {
          stopHeartbeat()
          saveConnections(config.stateDir, wired.connections)
          saveAlerts(config.stateDir, wired.alerts)
          touchHealth(config.stateDir, now())
        }
      }, signal)
    } else {
      await listenWithRetry(async () => {
        const agent = await loadAgent(config, deps?.fetchImpl)
        await listenOnce(agent)
      }, signal)
    }
  } finally {
    process.off("unhandledRejection", onRejection)
    if (!deps?.signal) {
      controller.abort()
      process.off("SIGTERM", stop)
      process.off("SIGINT", stop)
    }
  }
}

export async function wireSupport(config: Config, deps: RuntimeDeps): Promise<{ turn: TurnState; connections: ConnectionState; alerts: AlertState }> {
  const now = deps.now ?? (() => new Date())
  const turn = deps.turn ?? loadTurnState(config.stateDir, now(), config.senderBurstWindowSeconds * 1000)
  const connections = loadConnections(config.stateDir, now())
  const alerts = loadAlerts(config.stateDir, now())
  const owners = new Map<string, { owner: string; at: number }>()
  deps.agent.onRequest(async (req) => {
    const senderDid = req.sender?.did?.trim() || undefined
    const did = senderDid || "unknown"
    const owner = await ownerFor(deps.agent, did, owners, now().getTime())
    const result = await handleTurn({
      config,
      state: turn,
      message: req.text ?? "",
      did,
      senderDid,
      requestId: req.requestId?.trim() || undefined,
      owner,
      contextId: req.contextId || did,
      now: now(),
      clock: now,
      fetchImpl: deps.fetchImpl,
      onEvent: (event) => {
        if (event === "budget_50" || event === "budget_80") {
          void raise(config, alerts, now(), deps.agent, { kind: event })
        }
      },
    })
    if (result.category) {
      await raise(config, alerts, now(), deps.agent, {
        kind: "escalate",
        category: result.category,
        address: req.sender?.address || did,
      })
    }
    healthGate.quietUntil = 0
    touchHealth(config.stateDir, now())
    saveConnections(config.stateDir, connections)
    saveAlerts(config.stateDir, alerts)
    return result.text
  })

  deps.agent.onConnectionRequest(async (req) => {
    let accepted = false
    try {
      const decision = decideConnection({
        owner: req.owner ?? "",
        now: now(),
        stateDir: config.stateDir,
        policy: config.connectionPolicy,
        acceptsPerDay: config.acceptsPerDay,
        enabled: config.enabled,
        state: connections,
      })
      accepted = decision.action === "accept"
      if (decision.action === "accept" || decision.action === "block") {
        await deps.agent.respondConnection(req.linkId, decision.action)
      }
      if (decision.alert) await raise(config, alerts, now(), deps.agent, { kind: "connection_cap" })
    } catch {
      if (accepted) connections.accepts = Math.max(0, connections.accepts - 1)
      logLine("warn", "connection_failed", { error_code: "connection_failed" }, config.logLevel)
    }
    try {
      saveConnections(config.stateDir, connections)
      saveAlerts(config.stateDir, alerts)
    } catch {
      logLine("warn", "connection_failed", { error_code: "connection_failed" }, config.logLevel)
    }
  })

  return { turn, connections, alerts }
}

async function raise(config: Config, state: AlertState, now: Date, agent: SupportAgent, info: AlertInfo): Promise<void> {
  try {
    await dispatchAlert({
      info,
      now,
      state,
      alertTo: config.alertTo,
      alertsPerDay: config.alertsPerDay,
      logLevel: config.logLevel,
      send: async (to, text) => {
        await agent.send(to, text)
      },
    })
  } catch {
    logLine("warn", "alert_failed", { error_code: "alert_failed" }, config.logLevel)
  }
  try {
    saveAlerts(config.stateDir, state)
  } catch {
    logLine("warn", "alert_failed", { error_code: "alert_failed" }, config.logLevel)
  }
}

function rejectionCode(reason: unknown): string {
  const code = stringField(reason, "code")
  if (/^[a-z0-9_]{1,40}$/.test(code)) return code
  return "unhandled_rejection"
}

async function ownerFor(agent: SupportAgent, did: string, owners: Map<string, { owner: string; at: number }>, at: number): Promise<string> {
  const cached = owners.get(did)
  if (cached && at - cached.at < OWNER_TTL_MS) return cached.owner
  try {
    const card = await agent.resolve(did)
    const owner = ownerName(card) || did
    if (owners.size >= OWNERS) owners.clear()
    owners.set(did, { owner, at })
    return owner
  } catch {
    return did
  }
}

function ownerName(card: Record<string, unknown>): string {
  const owner = card.owner
  if (typeof owner === "string" && owner.trim()) return owner.trim().toLowerCase()
  const address = card.address
  if (typeof address === "string" && address.includes("@")) return address.split("@")[1]?.trim().toLowerCase() ?? ""
  return ""
}

async function loadAgent(config: Config, fetchImpl?: typeof fetch): Promise<SupportAgent> {
  // The package name is a value so typecheck works before p2a-sdk is installed.
  const specifier = "p2a-sdk"
  const loaded = (await import(specifier)) as { P2AAgent: new (options: Record<string, unknown>) => SupportAgent }
  return new loaded.P2AAgent({
    token: config.p2aToken,
    url: config.p2aUrl,
    maxConcurrent: config.maxConcurrent,
    fetchImpl,
    logger: {
      info(line: string) {
        if (!line.includes("outcome=")) return
        healthGate.quietUntil = 0
        touchHealth(config.stateDir, new Date())
      },
      warn(line: string) {
        healthGate.quietUntil = Date.now() + HEALTH_QUIET_MS
        logLine("warn", "poll_retry", { error_code: pollWarnCode(line) }, config.logLevel)
      },
    },
  })
}
