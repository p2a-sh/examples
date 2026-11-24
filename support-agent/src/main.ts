import { writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { buildBundle, type BundleFile } from "./bundle.js"
import { ConfigError, loadConfig } from "./config.js"
import { runLive } from "./eval.js"
import { healthFresh } from "./health.js"
import { runSupport } from "./runtime.js"
import { logLine } from "./log.js"
import { readJson, writeJsonAtomic } from "./state.js"

export const COMMANDS = ["run", "build-bundle", "stats", "eval", "health"] as const

export async function cli(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  if (env.DRY_RUN === "1") return 0
  const [command, ...rest] = argv
  if (!command || command === "help" || command === "--help") {
    process.stdout.write("commands: " + COMMANDS.join(" ") + "\n")
    return command ? 0 : 1
  }
  try {
    if (command === "build-bundle") return await buildBundleCommand(rest, env)
    if (command === "health") return healthCommand(env)
    if (command === "stats") return statsCommand(env)
    if (command === "run") return await runCommand(env)
    if (command === "eval") return await evalCommand(env)
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(err.message + "\n")
      return 1
    }
    logLine("error", "command_failed", { error_code: "command_failed" })
    return 1
  }
  process.stderr.write("unknown command\n")
  return 1
}

async function buildBundleCommand(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  const config = loadConfig(env)
  const out = flag(argv, "--out")
  const previous = readJson<BundleFile>(config.stateDir, "bundle.json")
  const result = await buildBundle({
    sourceUrls: config.sourceUrls,
    docsDirs: config.docsDirs,
    docsInclude: config.docsInclude,
    docsExclude: config.docsExclude,
    docsBaseUrl: config.docsBaseUrl,
    allowedEmails: config.allowedEmails,
    strict: config.bundleStrict,
    previous,
  })
  if (result.rejected && !result.bundle) {
    logLine("error", "bundle_rejected", { error_code: "bundle_rejected" }, config.logLevel)
    return 1
  }
  if (!result.bundle) return 1
  if (out) writeFileSync(out, JSON.stringify(result.bundle))
  else writeJsonAtomic(config.stateDir, "bundle.json", result.bundle)
  if (result.rejected) {
    logLine("warn", "bundle_kept_previous", { error_code: "bundle_rejected" }, config.logLevel)
    return 1
  }
  for (const warning of result.warnings) {
    logLine("warn", "bundle_chunk_dropped", { skipped: warning.file }, config.logLevel)
  }
  return 0
}

function healthCommand(env: Record<string, string | undefined>): number {
  const config = loadConfig(env)
  return healthFresh(config.stateDir) ? 0 : 1
}

function statsCommand(env: Record<string, string | undefined>): number {
  const config = loadConfig(env)
  const counters = readJson<Record<string, number>>(config.stateDir, "counters.json") ?? {}
  process.stdout.write(JSON.stringify(counters) + "\n")
  return 0
}

async function runCommand(env: Record<string, string | undefined>): Promise<number> {
  await runSupport(env)
  return 0
}

function evalCommand(env: Record<string, string | undefined>): Promise<number> {
  return runLive(env)
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index < 0) return undefined
  return argv[index + 1]
}

const invoked = process.argv[1]
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  cli(process.argv.slice(2), process.env).then((code) => {
    process.exit(code)
  })
}
