import { statSync } from "node:fs"
import { join } from "node:path"
import { buildBundle, type BuildRequest, type BuildResult, type BundleFile } from "./bundle.js"
import type { Config } from "./config.js"
import { logLine, type LogLevel } from "./log.js"
import { readJson, writeJsonAtomic } from "./state.js"

const HOUR_MS = 60 * 60 * 1000

export interface BundleHooks {
  build?: (request: BuildRequest) => Promise<BuildResult>
  fetchImpl?: typeof fetch
  now?: () => Date
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  writeLog?: (line: string) => void
}

export function bundleIsStale(stateDir: string, refreshHours: number, now: Date): boolean {
  let mtimeMs: number
  try {
    mtimeMs = statSync(join(stateDir, "bundle.json")).mtimeMs
  } catch {
    return true
  }
  const hours = Number.isFinite(refreshHours) && refreshHours > 0 ? refreshHours : 0
  return now.getTime() - mtimeMs >= hours * HOUR_MS
}

/** Build bundle.json. A failure or a rejected build leaves the previous file in place. */
export async function refreshBundle(config: Config, hooks: BundleHooks = {}): Promise<"written" | "kept"> {
  const previous = readJson<BundleFile>(config.stateDir, "bundle.json")
  const build = hooks.build ?? buildBundle
  try {
    const result = await build({
      sourceUrls: config.sourceUrls,
      docsDirs: config.docsDirs,
      docsInclude: config.docsInclude,
      docsExclude: config.docsExclude,
      docsBaseUrl: config.docsBaseUrl,
      allowedEmails: config.allowedEmails,
      strict: config.bundleStrict,
      previous,
      fetchImpl: hooks.fetchImpl,
      now: hooks.now,
    })
    if (!result.bundle || result.rejected) {
      note(config.logLevel, "bundle_kept_previous", "bundle_rejected", hooks.writeLog)
      return "kept"
    }
    writeJsonAtomic(config.stateDir, "bundle.json", result.bundle)
    for (const warning of result.warnings) {
      logLine("warn", "bundle_chunk_dropped", { skipped: warning.file }, config.logLevel, hooks.writeLog)
    }
    return "written"
  } catch {
    note(config.logLevel, "bundle_refresh", "bundle_build_failed", hooks.writeLog)
    return "kept"
  }
}

export async function ensureBundle(config: Config, hooks: BundleHooks = {}): Promise<void> {
  const now = (hooks.now ?? (() => new Date()))()
  if (!bundleIsStale(config.stateDir, config.bundleRefreshHours, now)) return
  await refreshBundle(config, hooks)
}

/** Rebuild when the file is next due, then again each interval, until `signal` aborts. */
export async function bundleRefreshLoop(config: Config, signal: AbortSignal, hooks: BundleHooks = {}): Promise<void> {
  const sleep = hooks.sleep ?? sleepBackoff
  const interval = Math.max(config.bundleRefreshHours, 0) * HOUR_MS
  if (interval === 0) return
  while (!signal.aborted) {
    const now = (hooks.now ?? (() => new Date()))()
    const remaining = msUntilDue(config.stateDir, config.bundleRefreshHours, now)
    await sleep(remaining === 0 ? interval : remaining, signal)
    if (signal.aborted) return
    await refreshBundle(config, hooks)
  }
}

function msUntilDue(stateDir: string, refreshHours: number, now: Date): number {
  const interval = Math.max(refreshHours, 0) * HOUR_MS
  let mtimeMs: number
  try {
    mtimeMs = statSync(join(stateDir, "bundle.json")).mtimeMs
  } catch {
    return 0
  }
  return Math.max(0, mtimeMs + interval - now.getTime())
}

function note(level: LogLevel, event: string, errorCode: string, write?: (line: string) => void): void {
  logLine("warn", event, { error_code: errorCode }, level, write)
}

function sleepBackoff(ms: number, signal: AbortSignal): Promise<void> {
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
