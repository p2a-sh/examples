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
export const LISTEN_BACKOFF_MS = 500
export const LISTEN_BACKOFF_MAX_MS = 30_000

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

/** Reconnect until `signal` aborts. A clean listen return is a dropped stream. */
export async function listenWithRetry(
  connect: () => Promise<void>,
  signal: AbortSignal,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = sleepBackoff,
): Promise<void> {
  let delay = LISTEN_BACKOFF_MS
  while (!signal.aborted) {
    let failed = false
    try {
      await connect()
    } catch (err) {
      if (signal.aborted) return
      if (err instanceof ConfigError) throw err
      failed = true
      logLine("warn", "listen_retry", { error_code: "listen_failed" })
    }
    if (signal.aborted) return
    if (!failed) logLine("warn", "listen_retry", { error_code: "listen_ended" })
    await sleep(delay, signal)
    delay = Math.min(delay * 2, LISTEN_BACKOFF_MAX_MS)
  }
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
    logger: { info() {} },
  })
}
