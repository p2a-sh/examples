import { readFileSync } from "node:fs"

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}

export const ENV_KEYS = [
  "P2A_TOKEN",
  "P2A_TOKEN_FILE",
  "P2A_URL",
  "P2A_LISTEN_MODE",
  "LLM_API_KEY",
  "LLM_API_KEY_FILE",
  "OPENCHEAP_API_KEY",
  "OPENCHEAP_API_KEY_FILE",
  "LLM_BASE_URL",
  "LLM_MODEL",
  "LLM_PRICE_IN_PER_M",
  "LLM_PRICE_OUT_PER_M",
  "LLM_TIMEOUT_MS",
  "SOURCE_URLS",
  "DOCS_DIRS",
  "DOCS_INCLUDE",
  "DOCS_EXCLUDE",
  "DOCS_BASE_URL",
  "BUNDLE_STRICT",
  "BUNDLE_REFRESH_HOURS",
  "STATE_DIR",
  "PRODUCT_NAME",
  "ESCALATION_CONTACT",
  "ALLOWED_LINK_PREFIXES",
  "ALLOWED_EMAILS",
  "PROMPT_FILE",
  "ALERT_TO",
  "ALERTS_PER_DAY",
  "DAILY_BUDGET_USD",
  "ENABLED",
  "MAX_INPUT_CHARS",
  "MAX_OUTPUT_TOKENS",
  "MAX_REPLY_CHARS",
  "TOP_K",
  "CONTEXT_TOKENS",
  "MIN_SCORE",
  "MEMORY_TURNS",
  "SENDER_BURST",
  "RELAY_DIDS",
  "SENDER_PER_DAY",
  "OWNER_PER_DAY",
  "CONTEXT_TURNS_PER_DAY",
  "GLOBAL_LLM_PER_DAY",
  "MAX_CONCURRENT",
  "CONNECTION_POLICY",
  "ACCEPTS_PER_DAY",
  "LOG_LEVEL",
  "P2A_SUPPORT_LINEAR_API_KEY",
  "P2A_SUPPORT_LINEAR_API_KEY_FILE",
  "P2A_SUPPORT_LINEAR_TEAM_KEY",
  "P2A_SUPPORT_LINEAR_SHOW_URLS",
  "P2A_SUPPORT_LINEAR_BUG_LABEL",
  "P2A_SUPPORT_LINEAR_FEATURE_LABEL",
  "P2A_SUPPORT_LINEAR_FEEDBACK_LABEL",
  "CLARIFY_MAX_ROUNDS",
  "CLARIFY_TTL_HOURS",
] as const

export interface Config {
  p2aToken?: string
  p2aUrl?: string
  listenMode: "stream" | "poll"
  relayDids: string[]
  llmApiKey?: string
  llmBaseUrl: string
  llmModel: string
  llmPriceInPerM: number
  llmPriceOutPerM: number
  llmTimeoutMs: number
  sourceUrls: string[]
  docsDirs: string[]
  docsInclude: string[]
  docsExclude: string[]
  docsBaseUrl?: string
  bundleStrict: boolean
  bundleRefreshHours: number
  stateDir: string
  productName: string
  escalationContact?: string
  allowedLinkPrefixes: string[]
  allowedEmails: string[]
  promptFile?: string
  alertTo?: string
  alertsPerDay: number
  dailyBudgetUsd: number
  enabled: boolean
  maxInputChars: number
  maxOutputTokens: number
  maxReplyChars: number
  topK: number
  contextTokens: number
  minScore: number
  memoryTurns: number
  senderBurst: number
  senderBurstWindowSeconds: number
  senderPerDay: number
  ownerPerDay: number
  contextTurnsPerDay: number
  globalLlmPerDay: number
  maxConcurrent: number
  connectionPolicy: "accept_capped" | "manual"
  acceptsPerDay: number
  logLevel: "debug" | "info" | "warn" | "error"
  linearApiKey?: string
  linearTeamKey?: string
  linearShowUrls: boolean
  linearBugLabel: string
  linearFeatureLabel: string
  linearFeedbackLabel: string
  linearEnabled: boolean
  clarifyMaxRounds: number
  clarifyTtlHours: number
}

type Env = Record<string, string | undefined>

export function loadConfig(env: Env, options: { requireSecrets?: boolean } = {}): Config {
  const p2aToken = secret(env, "P2A_TOKEN")
  const llmApiKey = secret(env, "LLM_API_KEY", ["OPENCHEAP_API_KEY"])
  if (options.requireSecrets) {
    if (!p2aToken) throw new ConfigError("P2A_TOKEN is required")
    if (!llmApiKey) throw new ConfigError("LLM_API_KEY is required")
  }
  const sourceUrls = csv(env, "SOURCE_URLS")
  for (const url of sourceUrls) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new ConfigError("SOURCE_URLS is invalid")
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new ConfigError("SOURCE_URLS is invalid")
    }
  }
  const docsBaseUrl = optional(env, "DOCS_BASE_URL")
  const escalationContact = optional(env, "ESCALATION_CONTACT")
  const linkRaw = optional(env, "ALLOWED_LINK_PREFIXES")
  const emailRaw = optional(env, "ALLOWED_EMAILS")
  const burst = burstOf(env)
  const policy = optional(env, "CONNECTION_POLICY") ?? "accept_capped"
  if (policy !== "accept_capped" && policy !== "manual") {
    throw new ConfigError("CONNECTION_POLICY is invalid")
  }
  const level = optional(env, "LOG_LEVEL") ?? "info"
  if (level !== "debug" && level !== "info" && level !== "warn" && level !== "error") {
    throw new ConfigError("LOG_LEVEL is invalid")
  }
  const linearApiKey = optionalSecret(env, "P2A_SUPPORT_LINEAR_API_KEY")
  const linearTeamKey = optional(env, "P2A_SUPPORT_LINEAR_TEAM_KEY")
  const linearShowUrls = flag(env, "P2A_SUPPORT_LINEAR_SHOW_URLS", false)
  return {
    p2aToken,
    p2aUrl: optional(env, "P2A_URL"),
    listenMode: listenModeOf(env),
    relayDids: csv(env, "RELAY_DIDS"),
    llmApiKey,
    llmBaseUrl: optional(env, "LLM_BASE_URL") ?? "https://api.opencheap.si/v1",
    llmModel: optional(env, "LLM_MODEL") ?? "deepseek-v4-pro",
    llmPriceInPerM: numberValue(env, "LLM_PRICE_IN_PER_M", 0.06),
    llmPriceOutPerM: numberValue(env, "LLM_PRICE_OUT_PER_M", 0.12),
    llmTimeoutMs: timeoutMs(env),
    sourceUrls,
    docsDirs: csv(env, "DOCS_DIRS", ["./docs"]),
    docsInclude: csv(env, "DOCS_INCLUDE", ["md", "mdx", "txt", "html", "ts", "py"]),
    docsExclude: csv(env, "DOCS_EXCLUDE"),
    docsBaseUrl,
    bundleStrict: flag(env, "BUNDLE_STRICT", false),
    bundleRefreshHours: numberValue(env, "BUNDLE_REFRESH_HOURS", 24),
    stateDir: optional(env, "STATE_DIR") ?? "./state",
    productName: optional(env, "PRODUCT_NAME") ?? "p2a",
    escalationContact,
    allowedLinkPrefixes: linkRaw ? csv(env, "ALLOWED_LINK_PREFIXES") : defaultPrefixes(docsBaseUrl, sourceUrls),
    allowedEmails: emailRaw ? csv(env, "ALLOWED_EMAILS") : escalationContact && escalationContact.includes("@") ? [escalationContact] : [],
    promptFile: optional(env, "PROMPT_FILE"),
    alertTo: optional(env, "ALERT_TO"),
    alertsPerDay: numberValue(env, "ALERTS_PER_DAY", 30),
    dailyBudgetUsd: numberValue(env, "DAILY_BUDGET_USD", 2),
    enabled: flag(env, "ENABLED", true),
    maxInputChars: numberValue(env, "MAX_INPUT_CHARS", 2000),
    maxOutputTokens: numberValue(env, "MAX_OUTPUT_TOKENS", 4000),
    maxReplyChars: numberValue(env, "MAX_REPLY_CHARS", 3500),
    topK: numberValue(env, "TOP_K", 10),
    contextTokens: numberValue(env, "CONTEXT_TOKENS", 3500),
    minScore: numberValue(env, "MIN_SCORE", 2),
    memoryTurns: numberValue(env, "MEMORY_TURNS", 3),
    senderBurst: burst.count,
    senderBurstWindowSeconds: burst.windowSeconds,
    senderPerDay: numberValue(env, "SENDER_PER_DAY", 30),
    ownerPerDay: numberValue(env, "OWNER_PER_DAY", 60),
    contextTurnsPerDay: numberValue(env, "CONTEXT_TURNS_PER_DAY", 20),
    globalLlmPerDay: numberValue(env, "GLOBAL_LLM_PER_DAY", 3000),
    maxConcurrent: numberValue(env, "MAX_CONCURRENT", 4),
    connectionPolicy: policy,
    acceptsPerDay: numberValue(env, "ACCEPTS_PER_DAY", 150),
    logLevel: level,
    linearApiKey,
    linearTeamKey,
    linearShowUrls,
    linearBugLabel: labelName(env, "P2A_SUPPORT_LINEAR_BUG_LABEL", "Bug"),
    linearFeatureLabel: labelName(env, "P2A_SUPPORT_LINEAR_FEATURE_LABEL", "Feature"),
    linearFeedbackLabel: labelName(env, "P2A_SUPPORT_LINEAR_FEEDBACK_LABEL", "Feedback"),
    linearEnabled: Boolean(linearApiKey && linearTeamKey),
    clarifyMaxRounds: boundedInt(env, "CLARIFY_MAX_ROUNDS", 1, 0, 4),
    clarifyTtlHours: boundedInt(env, "CLARIFY_TTL_HOURS", 24, 1, 168),
  }
}

// A missing or empty file disables the feature. It does not fall through to the env value.
function optionalSecret(env: Env, name: string): string | undefined {
  const file = env[`${name}_FILE`]?.trim()
  if (file) {
    try {
      const text = readFileSync(file, "utf8").trim()
      return text ? text : undefined
    } catch {
      return undefined
    }
  }
  const direct = env[name]
  if (direct && direct.trim()) return direct.trim()
  return undefined
}

function secret(env: Env, name: string, aliases: string[] = []): string | undefined {
  const names = [name, ...aliases]
  for (const item of names) {
    const fileKey = `${item}_FILE`
    const file = env[fileKey]
    if (file === undefined || file.trim() === "") continue
    const value = readSecretFile(file.trim(), fileKey)
    if (value !== undefined) return value
  }
  for (const item of names) {
    const direct = env[item]
    if (direct && direct.trim()) return direct.trim()
  }
  return undefined
}

function readSecretFile(path: string, variable: string): string | undefined {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    throw new ConfigError(`${variable} could not be read`)
  }
  if (text.trim() === "") return undefined
  return text.trim()
}

function listenModeOf(env: Env): "stream" | "poll" {
  const value = optional(env, "P2A_LISTEN_MODE") ?? "stream"
  if (value === "stream" || value === "poll") return value
  throw new ConfigError("P2A_LISTEN_MODE is invalid")
}

function labelName(env: Env, name: string, fallback: string): string {
  const value = optional(env, name)
  if (!value) return fallback
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,40}$/.test(value)) throw new ConfigError(`${name} is invalid`)
  return value
}

function optional(env: Env, name: string): string | undefined {
  const value = env[name]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function csv(env: Env, name: string, fallback: string[] = []): string[] {
  const value = optional(env, name)
  if (!value) return fallback
  return value.split(",").map((item) => item.trim()).filter(Boolean)
}

function flag(env: Env, name: string, fallback: boolean): boolean {
  const value = optional(env, name)
  if (!value) return fallback
  const folded = value.toLowerCase()
  if (folded === "1" || folded === "true" || folded === "yes" || folded === "on") return true
  if (folded === "0" || folded === "false" || folded === "no" || folded === "off") return false
  throw new ConfigError(`${name} is invalid`)
}

function timeoutMs(env: Env): number {
  const value = numberValue(env, "LLM_TIMEOUT_MS", 45000)
  if (value < 1000) throw new ConfigError("LLM_TIMEOUT_MS is invalid")
  return value
}

function numberValue(env: Env, name: string, fallback: number): number {
  const value = optional(env, name)
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new ConfigError(`${name} is invalid`)
  return parsed
}

function boundedInt(env: Env, name: string, fallback: number, min: number, max: number): number {
  const value = optional(env, name)
  if (!value) return fallback
  if (!/^\d+$/.test(value)) throw new ConfigError(`${name} is invalid`)
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new ConfigError(`${name} is invalid`)
  return parsed
}

function burstOf(env: Env): { count: number; windowSeconds: number } {
  const value = optional(env, "SENDER_BURST") ?? "6/600s"
  const match = /^(\d+)\/(\d+)s?$/.exec(value)
  if (!match) throw new ConfigError("SENDER_BURST is invalid")
  return { count: Number(match[1]), windowSeconds: Number(match[2]) }
}

function defaultPrefixes(docsBaseUrl: string | undefined, sourceUrls: string[]): string[] {
  const prefixes: string[] = []
  if (docsBaseUrl) prefixes.push(docsBaseUrl)
  for (const url of sourceUrls) {
    const origin = new URL(url).origin + "/"
    if (!prefixes.includes(origin)) prefixes.push(origin)
  }
  return prefixes
}
