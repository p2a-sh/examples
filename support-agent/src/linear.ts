import { createHash } from "node:crypto"
import type { Config } from "./config.js"
import { utcDay } from "./limits.js"
import { completeChat } from "./llm.js"
import { withKey } from "./locks.js"
import { logLine } from "./log.js"
import {
  linearCappedText,
  linearCreatedText,
  linearDuplicateText,
  linearFailedText,
  linearNeedsInfoText,
  linearTrackedText,
  linearUnusableText,
} from "./replies.js"
import { redactSecrets } from "./scan.js"
import { readJson, writeJsonAtomic } from "./state.js"

export const LINEAR_ENDPOINT = "https://api.linear.app/graphql"
export const LINEAR_DAILY_CAP = 20
export const LINEAR_DEDUPE_MS = 24 * 60 * 60 * 1000

const IDENTIFIER = /^[A-Z][A-Z0-9]+-\d+$/
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const DID = /\bdid:[a-z0-9]+:[a-z0-9._:-]+/gi
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const PHONE = /(?:\+\d{1,3}[\s-])?(?:\(\d{3}\)|\d{3})[\s-]\d{3}[\s-]\d{4}\b/g
const NAME = /\b[Mm]y name is\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g

const SEARCH_QUERY = `query SearchOpen($term: String!, $team: String!) {
  searchIssues(
    term: $term
    first: 5
    filter: {
      team: { key: { eq: $team } }
      state: { type: { nin: ["completed", "canceled"] } }
    }
  ) {
    nodes { id identifier title description url }
  }
}`

const TEAM_QUERY = `query TeamByKey($key: String!) {
  teams(filter: { key: { eq: $key } }, first: 1) {
    nodes { id }
  }
}`

const LABEL_QUERY = `query BugLabel {
  issueLabels(filter: { name: { eqIgnoreCase: "Bug" } }, first: 5) {
    nodes { id name }
  }
}`

const NEEDS_INFO_LABEL_QUERY = `query NeedsInfoLabel {
  issueLabels(filter: { name: { eqIgnoreCase: "needs-info" } }, first: 5) {
    nodes { id name }
  }
}`

const COMMENT_QUERY = `mutation Comment($id: String!, $body: String!) {
  commentCreate(input: { issueId: $id, body: $body }) {
    success
  }
}`

const CREATE_QUERY = `mutation Create($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier title description url }
  }
}`

export interface LinearIssue {
  id: string
  identifier: string
  title: string
  description: string
  url: string
}

export interface LinearClient {
  searchOpen(term: string): Promise<LinearIssue[]>
  comment(issueId: string, body: string): Promise<void>
  create(title: string, description: string, options?: { needsInfo?: boolean }): Promise<LinearIssue>
}

export type FileAction = "commented" | "created" | "duplicate" | "capped" | "unusable" | "failed"

export interface FileResult {
  text: string
  action: FileAction
  judged: boolean
  identifier?: string
}

type Judge = (summary: string, issues: LinearIssue[]) => Promise<string | null>

interface SeenReport {
  sender: string
  hash: string
  identifier: string
  url?: string
  at: number
}

interface LinearState {
  day: string
  created: number
  seen: SeenReport[]
}

interface RawIssue {
  id?: string
  identifier?: string
  title?: string
  description?: string | null
  url?: string | null
}

const DESCRIPTION_MAX = 2500
const RUBRIC_NAMES = ["surface", "action", "expected", "actual", "repro", "scope"]

export function cleanSummary(text: string): string {
  const cleaned = redactSecrets(text)
    .replace(EMAIL, "[redacted]")
    .replace(DID, "[redacted]")
    .replace(UUID, "[redacted]")
    .replace(PHONE, "[redacted]")
    .replace(NAME, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "[redacted]")
    .replace(/\b(?:password|passwd|secret|api[_ ]key|token|key)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
  if (cleaned.length <= 500) return cleaned
  return `${cleaned.slice(0, 499).trimEnd()}…`
}

export function issueTitle(summary: string): string {
  const sentence = summary.split(/(?<=[.!?])\s/)[0] ?? summary
  if (sentence.length <= 80) return sentence
  const cut = sentence.slice(0, 80)
  const space = cut.lastIndexOf(" ")
  const base = space > 40 ? cut.slice(0, space) : cut.slice(0, 79)
  return `${base.trimEnd()}…`
}

export function createLinearClient(config: Config, fetchImpl: typeof fetch = fetch): LinearClient {
  const key = config.linearApiKey ?? ""
  const team = config.linearTeamKey ?? ""
  let teamId: string | undefined
  let bugLabelId: string | null | undefined
  let needsInfoLabelId: string | null | undefined

  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let response: Response
    try {
      response = await fetchImpl(LINEAR_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: key,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(15000),
      })
    } catch {
      throw new Error("linear_failed")
    }
    if (!response.ok) throw new Error("linear_failed")
    let payload: { data?: T; errors?: unknown[] }
    try {
      payload = (await response.json()) as { data?: T; errors?: unknown[] }
    } catch {
      throw new Error("linear_failed")
    }
    if (payload.errors?.length || payload.data === undefined) throw new Error("linear_failed")
    return payload.data
  }

  async function cachedLabel(
    query: string,
    expected: string,
    read: () => string | null | undefined,
    write: (id: string | null) => void,
  ): Promise<string | null> {
    const current = read()
    if (current !== undefined) return current
    try {
      const data = await gql<{ issueLabels?: { nodes?: { id?: string; name?: string }[] } }>(query, {})
      const found = (data.issueLabels?.nodes ?? []).find((node) => node.name?.toLowerCase() === expected)
      const id = found?.id ?? null
      write(id)
      return id
    } catch {
      // A lookup failure still opens the issue, and the next create tries the label again.
      return null
    }
  }

  return {
    async searchOpen(term: string): Promise<LinearIssue[]> {
      const data = await gql<{ searchIssues?: { nodes?: RawIssue[] } }>(SEARCH_QUERY, { term, team })
      return (data.searchIssues?.nodes ?? []).flatMap((node) => {
        const issue = asIssue(node)
        return issue ? [issue] : []
      })
    },
    async comment(issueId: string, body: string): Promise<void> {
      const data = await gql<{ commentCreate?: { success?: boolean } }>(COMMENT_QUERY, { id: issueId, body })
      if (!data.commentCreate?.success) throw new Error("linear_failed")
    },
    async create(title: string, description: string, options?: { needsInfo?: boolean }): Promise<LinearIssue> {
      if (!teamId) {
        const data = await gql<{ teams?: { nodes?: { id?: string }[] } }>(TEAM_QUERY, { key: team })
        teamId = data.teams?.nodes?.[0]?.id
        if (!teamId) throw new Error("linear_failed")
      }
      const labels: string[] = []
      const bug = await cachedLabel(LABEL_QUERY, "bug", () => bugLabelId, (id) => {
        bugLabelId = id
      })
      if (bug) labels.push(bug)
      if (options?.needsInfo) {
        const needs = await cachedLabel(NEEDS_INFO_LABEL_QUERY, "needs-info", () => needsInfoLabelId, (id) => {
          needsInfoLabelId = id
        })
        if (needs) labels.push(needs)
      }
      const input: Record<string, unknown> = { teamId, title, description }
      if (labels.length > 0) input.labelIds = labels
      const data = await gql<{ issueCreate?: { success?: boolean; issue?: RawIssue } }>(CREATE_QUERY, { input })
      const issue = data.issueCreate?.success ? asIssue(data.issueCreate.issue ?? {}) : null
      if (!issue) throw new Error("linear_failed")
      return issue
    },
  }
}

export async function judgeWithModel(
  config: Config,
  summary: string,
  issues: LinearIssue[],
  fetchImpl?: typeof fetch,
): Promise<string | null> {
  if (!config.llmApiKey || issues.length === 0) throw new Error("linear_failed")
  const allowed = new Set(issues.map((issue) => issue.identifier))
  const list = issues
    .map((issue) => `${issue.identifier}: ${oneLine(issue.title)}\n${oneLine(issue.description)}`)
    .join("\n\n")
  const completion = await completeChat({
    primary: {
      baseUrl: config.llmBaseUrl,
      model: config.llmModel,
      apiKey: config.llmApiKey,
      timeoutMs: config.llmTimeoutMs,
      maxOutputTokens: 1500,
    },
    messages: [
      {
        role: "system",
        content:
          'You match a support report to an open issue. Reply with JSON only: {"identifier":null} when none is the same problem, or {"identifier":"ID"} using an identifier from the list.',
      },
      { role: "user", content: `Report:\n${summary}\n\nOpen issues:\n${list}` },
    ],
    fetchImpl,
    logLevel: config.logLevel,
  })
  if (completion.errorCode) throw new Error("linear_failed")
  const parsed = parseJudge(completion.text, allowed)
  if (parsed === "bad") throw new Error("linear_failed")
  if (parsed === "none") return null
  return parsed
}

export function fileBugReport(input: {
  config: Config
  did: string
  now: Date
  client: LinearClient
  judge: Judge
  message?: string
  summary?: string
  facts?: string[]
  missing?: string[]
  needsInfo?: boolean
  meterJudge?: boolean
}): Promise<FileResult> {
  return withKey("linear", () => fileBugReportInner(input))
}

async function fileBugReportInner(input: {
  config: Config
  did: string
  now: Date
  client: LinearClient
  judge: Judge
  message?: string
  summary?: string
  facts?: string[]
  missing?: string[]
  needsInfo?: boolean
  meterJudge?: boolean
}): Promise<FileResult> {
  const facts = input.facts && input.facts.length > 0 ? input.facts : input.message ? [input.message] : []
  const summary = cleanSummary(input.summary ?? facts[0] ?? "")
  const description = reportDescription(facts.length > 0 ? facts : [summary], input.missing ?? [])
  const needsInfo = input.needsInfo === true
  const pack = (text: string, action: FileAction, judged: boolean, identifier?: string): FileResult => {
    const shown = needsInfo && (action === "created" || action === "commented" || action === "duplicate")
      ? linearNeedsInfoText(text)
      : text
    return { text: shown, action, judged, identifier }
  }
  if (!usable(summary)) return pack(linearUnusableText(input.config), "unusable", false)
  const state = loadState(input.config.stateDir, input.now)
  const hash = reportHash(summary)
  const sender = senderKey(input.did)
  const prior = state.seen.find((item) => item.sender === sender && item.hash === hash)
  if (prior && IDENTIFIER.test(prior.identifier)) {
    saveState(input.config.stateDir, state)
    return pack(linearDuplicateText(input.config, prior.identifier, prior.url), "duplicate", false, prior.identifier)
  }
  let candidates: LinearIssue[] = []
  try {
    candidates = (await input.client.searchOpen(searchTerm(summary))).slice(0, 5)
  } catch {
    fail(input.config, "search")
    return pack(linearFailedText(input.config), "failed", false)
  }
  let judged = false
  let match: string | null = null
  if (candidates.length > 0 && input.meterJudge !== false) {
    judged = true
    try {
      match = await input.judge(summary, candidates)
    } catch {
      // A judge failure must not open a second issue for a problem we could not compare.
      fail(input.config, "judge")
      return pack(linearFailedText(input.config), "failed", true)
    }
    if (match && !candidates.some((issue) => issue.identifier === match)) {
      fail(input.config, "judge")
      return pack(linearFailedText(input.config), "failed", true)
    }
  }
  const matched = match ? candidates.find((issue) => issue.identifier === match) : undefined
  if (matched) {
    try {
      await input.client.comment(matched.id, description)
    } catch {
      fail(input.config, "comment")
      return pack(linearFailedText(input.config), "failed", judged)
    }
    remember(state, sender, hash, matched, input.now)
    saveState(input.config.stateDir, state)
    return pack(linearTrackedText(input.config, matched.identifier, matched.url), "commented", judged, matched.identifier)
  }
  if (state.created >= LINEAR_DAILY_CAP) {
    saveState(input.config.stateDir, state)
    return pack(linearCappedText(input.config), "capped", judged)
  }
  let created: LinearIssue
  try {
    created = await input.client.create(issueTitle(summary), description, needsInfo ? { needsInfo: true } : undefined)
  } catch {
    fail(input.config, "create")
    return pack(linearFailedText(input.config), "failed", judged)
  }
  if (!IDENTIFIER.test(created.identifier)) {
    state.created += 1
    saveState(input.config.stateDir, state)
    fail(input.config, "create")
    return pack(linearFailedText(input.config), "failed", judged)
  }
  state.created += 1
  remember(state, sender, hash, created, input.now)
  saveState(input.config.stateDir, state)
  return pack(linearCreatedText(input.config, created.identifier, created.url), "created", judged, created.identifier)
}

function reportDescription(facts: string[], missing: string[]): string {
  const lines = facts.map((fact) => cleanSummary(fact)).filter((fact) => fact.length > 0)
  const known = missing.filter((item) => RUBRIC_NAMES.includes(item))
  if (known.length > 0) lines.push(`Missing: ${known.join(", ")}`)
  const text = lines.join("\n")
  if (text.length <= DESCRIPTION_MAX) return text
  return `${text.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`
}

function remember(state: LinearState, sender: string, hash: string, issue: LinearIssue, now: Date): void {
  state.seen.push({
    sender,
    hash,
    identifier: issue.identifier,
    url: issue.url || undefined,
    at: now.getTime(),
  })
}

function fail(config: Config, stage: string): void {
  logLine("warn", "linear_failed", { error_code: "linear_failed", category: stage }, config.logLevel)
}

function usable(summary: string): boolean {
  return summary.replace(/\[redacted\]/g, "").replace(/[^A-Za-z]/g, "").length >= 8
}

function searchTerm(summary: string): string {
  const words = summary
    .replace(/\[redacted\]/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 2)
    .slice(0, 8)
  return words.join(" ") || summary.slice(0, 80)
}

function reportHash(summary: string): string {
  const norm = summary.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()
  return createHash("sha256").update(norm).digest("hex")
}

export function senderKey(did: string): string {
  return createHash("sha256").update(did).digest("hex")
}

function loadState(dir: string, now: Date): LinearState {
  const day = utcDay(now)
  const raw = readJson<LinearState>(dir, "linear.json")
  const seen = (Array.isArray(raw?.seen) ? raw.seen : []).filter((item) => {
    return item && typeof item.identifier === "string" && typeof item.at === "number" && item.at >= now.getTime() - LINEAR_DEDUPE_MS
  })
  if (!raw || raw.day !== day) return { day, created: 0, seen }
  return { day, created: Number.isFinite(raw.created) ? raw.created : 0, seen }
}

function saveState(dir: string, state: LinearState): void {
  writeJsonAtomic(dir, "linear.json", state)
}

function asIssue(node: RawIssue): LinearIssue | null {
  if (!node.id || !node.identifier) return null
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title ?? "",
    description: node.description ?? "",
    url: node.url ?? "",
  }
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length <= 240 ? line : `${line.slice(0, 239).trimEnd()}…`
}

function parseJudge(text: string, allowed: Set<string>): string | "none" | "bad" {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return "bad"
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return "bad"
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("identifier" in parsed)) return "bad"
  const identifier = (parsed as { identifier?: unknown }).identifier
  if (identifier === null) return "none"
  if (typeof identifier === "string" && allowed.has(identifier)) return identifier
  return "bad"
}
