import { readJson } from "./state.js"
import type { BundleFile } from "./bundle.js"
import { bundleRefreshLoop, ensureBundle } from "./bundle-refresh.js"
import { dispatchAlert, loadAlerts, saveAlerts, type AlertInfo, type AlertState } from "./alerts.js"
import { decideConnection, loadConnections, saveConnections, type ConnectionState } from "./connections.js"
import { ConfigError, loadConfig, type Config } from "./config.js"
import { startHeartbeat, touchHealth } from "./health.js"
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

const TRANSIENT_HTTP = new Set([408, 429, 502, 503, 504])
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
  if (status !== undefined && TRANSIENT_HTTP.has(status)) return status === 429 ? "rate_limited" : `http_${status}`
  const code = stringField(err, "code")
  if (code === "unauthorized" || code === "forbidden") return undefined
  if (code === "rate_limited") return "rate_limited"
  if (code === "network") return "network"
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
  const match = /^poll_retry (http_(?:408|502|503|504)|network|timeout|connection|rate_limited)$/.exec(line)
  return match?.[1] ?? "poll_retry"
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
  const mode = env.P2A_LISTEN_MODE === "poll" ? "poll" : "stream"
  const now = deps?.now ?? (() => new Date())
  const turn = loadTurnState(config.stateDir, now())
  const listenOnce = async (agent: SupportAgent) => {
    const wired = await wireSupport(config, { agent, fetchImpl: deps?.fetchImpl, now, turn })
    touchHealth(config.stateDir, now())
    const stopHeartbeat = startHeartbeat(config.stateDir, now)
    try {
      await agent.listen({ mode, signal })
    } finally {
      stopHeartbeat()
      saveConnections(config.stateDir, wired.connections)
      saveAlerts(config.stateDir, wired.alerts)
      touchHealth(config.stateDir, now())
    }
  }
  try {
    await ensureBundle(config, { fetchImpl: deps?.fetchImpl, now })
    void bundleRefreshLoop(config, signal, { fetchImpl: deps?.fetchImpl, now }).catch(() => {
      logLine("warn", "bundle_refresh", { error_code: "bundle_build_failed" }, config.logLevel)
    })
    if (deps?.agent) {
      const agent = deps.agent
      const wired = await wireSupport(config, { agent, fetchImpl: deps.fetchImpl, now, turn })
      await listenWithRetry(async () => {
        touchHealth(config.stateDir, now())
        const stopHeartbeat = startHeartbeat(config.stateDir, now)
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
    if (!deps?.signal) {
      controller.abort()
      process.off("SIGTERM", stop)
      process.off("SIGINT", stop)
    }
  }
}

export async function wireSupport(config: Config, deps: RuntimeDeps): Promise<{ turn: TurnState; connections: ConnectionState; alerts: AlertState }> {
  const now = deps.now ?? (() => new Date())
  const turn = deps.turn ?? loadTurnState(config.stateDir, now())
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
      fetchImpl: deps.fetchImpl,
      bundle: readJson<BundleFile>(config.stateDir, "bundle.json"),
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
    touchHealth(config.stateDir, now())
    saveConnections(config.stateDir, connections)
    saveAlerts(config.stateDir, alerts)
    return result.text
  })

  deps.agent.onConnectionRequest(async (req) => {
    const decision = decideConnection({
      owner: req.owner ?? "",
      now: now(),
      stateDir: config.stateDir,
      policy: config.connectionPolicy,
      acceptsPerDay: config.acceptsPerDay,
      state: connections,
    })
    if (decision.action === "accept" || decision.action === "block") {
      await deps.agent.respondConnection(req.linkId, decision.action)
    }
    if (decision.alert) await raise(config, alerts, now(), deps.agent, { kind: "connection_cap" })
    saveConnections(config.stateDir, connections)
    saveAlerts(config.stateDir, alerts)
  })

  return { turn, connections, alerts }
}

async function raise(config: Config, state: AlertState, now: Date, agent: SupportAgent, info: AlertInfo): Promise<void> {
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
  saveAlerts(config.stateDir, state)
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
      info() {},
      warn(line: string) {
        logLine("warn", "poll_retry", { error_code: pollWarnCode(line) }, config.logLevel)
      },
    },
  })
}
