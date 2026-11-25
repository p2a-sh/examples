import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { isBugReport, reportKind } from "../src/classify.js"
import { loadConfig, type Config } from "../src/config.js"
import {
  LINEAR_DAILY_CAP,
  LINEAR_DEDUPE_MS,
  LINEAR_ENDPOINT,
  cleanSummary,
  createLinearClient,
  fileBugReport,
  formatIssueTitle,
  linearClientFor,
  issueTitle,
  judgeWithModel,
  type LinearClient,
  type LinearIssue,
} from "../src/linear.js"
import { emptyTurnState, handleTurn } from "../src/turn.js"

const NOW = new Date("2026-11-23T12:00:00.000Z")
const KEY = "test-linear-key"
const SECRET = ["sk-", "abcdefghijklmnop"].join("")

function folder(): string {
  return mkdtempSync(join(tmpdir(), "p2a-linear-"))
}

function config(stateDir: string, extra: Record<string, string> = {}): Config {
  return loadConfig({
    STATE_DIR: stateDir,
    LLM_API_KEY: "local-test-key",
    ESCALATION_CONTACT: "info@p2a.sh",
    ALLOWED_EMAILS: "info@p2a.sh",
    LOG_LEVEL: "error",
    P2A_SUPPORT_LINEAR_API_KEY: KEY,
    P2A_SUPPORT_LINEAR_TEAM_KEY: "P2A",
    ...extra,
  })
}

function issue(identifier: string): LinearIssue {
  return {
    id: `id-${identifier}`,
    identifier,
    title: "SDK connect fails",
    description: "connect returns an error",
    url: `https://example.test/${identifier}`,
  }
}

function scripted(options: {
  issues?: LinearIssue[]
  failSearch?: boolean
  created?: string
} = {}): { client: LinearClient; calls: { op: string; text: string; title?: string }[] } {
  const calls: { op: string; text: string; title?: string }[] = []
  let created = 0
  const client: LinearClient = {
    async searchOpen(term) {
      calls.push({ op: "search", text: term })
      if (options.failSearch) throw new Error("linear_failed")
      return options.issues ?? []
    },
    async comment(_id, body) {
      calls.push({ op: "comment", text: body })
    },
    async create(title, description) {
      calls.push({ op: "create", text: description, title })
      created += 1
      const identifier = options.created ?? `SUP-${created}`
      return { id: `iss-${created}`, identifier, title, description, url: `https://example.test/${identifier}` }
    },
  }
  return { client, calls }
}

const judgeMatch = async (_summary: string, issues: LinearIssue[]) => issues[0]?.identifier ?? null
const judgeNone = async () => null

describe("linear config", () => {
  it("stays off when the key file is missing, empty, or the team is unset", () => {
    const dir = folder()
    expect(loadConfig({ P2A_SUPPORT_LINEAR_TEAM_KEY: "SUP" }).linearEnabled).toBe(false)
    expect(loadConfig({ P2A_SUPPORT_LINEAR_API_KEY: KEY }).linearEnabled).toBe(false)
    const file = join(dir, "linear-key")
    writeFileSync(file, "\n")
    const empty = loadConfig({
      P2A_SUPPORT_LINEAR_API_KEY_FILE: file,
      P2A_SUPPORT_LINEAR_API_KEY: "direct-should-not-win",
      P2A_SUPPORT_LINEAR_TEAM_KEY: "SUP",
    })
    expect(empty.linearEnabled).toBe(false)
    expect(empty.linearApiKey).toBeUndefined()
    writeFileSync(file, "from-file\n")
    const filled = loadConfig({
      P2A_SUPPORT_LINEAR_API_KEY_FILE: file,
      P2A_SUPPORT_LINEAR_API_KEY: "direct-should-not-win",
      P2A_SUPPORT_LINEAR_TEAM_KEY: "SUP",
    })
    expect(filled.linearEnabled).toBe(true)
    expect(filled.linearApiKey).toBe("from-file")
    expect(filled.linearShowUrls).toBe(false)
    const missing = loadConfig({
      P2A_SUPPORT_LINEAR_API_KEY_FILE: join(dir, "absent"),
      P2A_SUPPORT_LINEAR_API_KEY: "direct-should-not-win",
      P2A_SUPPORT_LINEAR_TEAM_KEY: "SUP",
    })
    expect(missing.linearEnabled).toBe(false)
    expect(missing.linearApiKey).toBeUndefined()
    expect(loadConfig({
      P2A_SUPPORT_LINEAR_API_KEY: KEY,
      P2A_SUPPORT_LINEAR_TEAM_KEY: "SUP",
      P2A_SUPPORT_LINEAR_SHOW_URLS: "1",
    }).linearShowUrls).toBe(true)
    const labels = loadConfig({})
    expect(labels.linearBugLabel).toBe("Bug")
    expect(labels.linearFeatureLabel).toBe("Feature")
    expect(labels.linearFeedbackLabel).toBe("Feedback")
    expect(loadConfig({ P2A_SUPPORT_LINEAR_FEATURE_LABEL: "Enhancement" }).linearFeatureLabel).toBe("Enhancement")
    expect(() => loadConfig({ P2A_SUPPORT_LINEAR_BUG_LABEL: "bad/name" })).toThrow(/P2A_SUPPORT_LINEAR_BUG_LABEL/)
  })
})

describe("bug reports", () => {
  it("recognizes a product failure and leaves how-to questions alone", () => {
    expect(isBugReport("the p2a sdk is broken")).toBe(true)
    expect(isBugReport("connect is not working")).toBe(true)
    expect(isBugReport("I have a problem with the wake call")).toBe(true)
    expect(isBugReport("how do I report a bug in p2a")).toBe(false)
    expect(isBugReport("how can I fix a broken connection")).toBe(false)
    expect(isBugReport("where is the install guide")).toBe(false)
    expect(reportKind("the connect button crashes in p2a")).toBe("bug")
    expect(reportKind("the p2a sdk is broken")).toBe("bug")
    expect(reportKind("please add an export button to the dashboard")).toBe("feature")
    expect(reportKind("I have a suggestion for the wake call")).toBe("feature")
    expect(reportKind("feedback: the inbox stays empty")).toBe("feedback")
    expect(reportKind("this feedback on search")).toBe("feedback")
    expect(reportKind("feedback: the connect button crashes")).toBe("bug")
  })

  it("strips emails, secrets, and other personal details from the summary", () => {
    const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJ1c2VyIn0", "c2lnbmF0dXJlMTIz"].join(".")
    const assigned = "access_token=abcdef refresh_token=ghijkl x_api_key=mnopqr"
    const summary = cleanSummary(
      `the p2a sdk is broken for did:aw:sender email ada@example.com phone 415-555-1212 id 11111111-1111-4111-8111-111111111111 My name is Ada Lovelace Bearer ${SECRET} token=${SECRET} ${assigned} ${jwt} from 203.0.113.44`,
    )
    expect(summary).toContain("broken")
    expect(summary).toContain("[redacted]")
    expect(summary).not.toContain("ada@example.com")
    expect(summary).not.toContain(SECRET)
    expect(summary).not.toContain("did:aw:sender")
    expect(summary).not.toContain("415-555-1212")
    expect(summary).not.toContain("11111111-1111-4111-8111-111111111111")
    expect(summary).not.toContain("Ada Lovelace")
    expect(summary).not.toContain("abcdef")
    expect(summary).not.toContain("ghijkl")
    expect(summary).not.toContain("mnopqr")
    expect(summary).not.toContain("eyJhbGci")
    expect(summary).not.toContain("203.0.113.44")
    expect(cleanSummary("the p2a token command is broken when I connect")).toContain("token command")
    expect(issueTitle(summary).length).toBeLessThanOrEqual(70)
  })

  it("builds a short title with one kind prefix and no sender line", () => {
    const raw = "From agent@example (test, safe to close): Bug: the agents page returns a 500 when opened"
    expect(issueTitle(raw)).toBe("the agents page returns a 500 when opened")
    expect(formatIssueTitle("bug", raw)).toBe("Bug: the agents page returns a 500 when opened")
    expect(formatIssueTitle("bug", raw)).not.toContain("agent@example")
    expect(formatIssueTitle("bug", raw)).not.toContain("From ")
    expect(formatIssueTitle("feature", "Feature request: please add an export button")).toBe("Feature: please add an export button")
    expect(formatIssueTitle("feedback", "Hi, Feedback: the inbox stays empty")).toBe("Feedback: the inbox stays empty")
    expect(formatIssueTitle("bug", "Bug: Bug: the connect button crashes")).toBe("Bug: the connect button crashes")
    expect(formatIssueTitle("bug", "Hello, From [redacted] (testing): the connect button crashes")).toBe("Bug: the connect button crashes")
    expect(formatIssueTitle("bug", "the p2a sdk is broken when I connect", "Bug: agents page returns 500")).toBe("Bug: agents page returns 500")
    expect(formatIssueTitle("bug", "the p2a sdk is broken when I connect", "see ada@example.com")).toBe("Bug: the p2a sdk is broken when I connect")
    const long = `From agent@example (test, safe to close): Bug: ${"the agents page returns a 500 ".repeat(8)}`
    expect(formatIssueTitle("bug", long).length).toBeLessThanOrEqual(70)
    expect(formatIssueTitle("feedback", long).length).toBeLessThanOrEqual(70)
    expect(formatIssueTitle("bug", long).startsWith("Bug: the agents page returns")).toBe(true)
    expect(formatIssueTitle("bug", long)).not.toContain("agent@example")
    expect(formatIssueTitle("feedback", long).startsWith("Feedback: ")).toBe(true)
  })
})

describe("filing", () => {
  it("comments on a similar open issue and keeps personal details out of the comment", async () => {
    const dir = folder()
    const { client, calls } = scripted({ issues: [issue("SUP-12")] })
    const message = `the p2a sdk is broken for did:aw:sender email ada@example.com phone 415-555-1212 Bearer ${SECRET}`
    const result = await fileBugReport({
      config: config(dir),
      did: "did:aw:sender",
      message,
      now: NOW,
      client,
      judge: judgeMatch,
    })
    expect(result.action).toBe("commented")
    expect(result.identifier).toBe("SUP-12")
    expect(result.text).toContain("SUP-12")
    expect(result.text).toContain("already tracked")
    expect(result.text).not.toContain("http")
    expect(calls.map((call) => call.op)).toEqual(["search", "comment"])
    const comment = calls[1]?.text ?? ""
    expect(comment).toBe(cleanSummary(message))
    expect(comment).not.toContain("ada@example.com")
    expect(comment).not.toContain(SECRET)
    expect(comment).not.toContain("did:aw:sender")
    const saved = readFileSync(join(dir, "linear.json"), "utf8")
    expect(saved).not.toContain("ada@example.com")
    expect(saved).not.toContain(SECRET)
    expect(saved).not.toContain("did:aw:sender")
    expect(saved).not.toContain(message)
  })

  it("creates an issue when nothing open matches, and adds a url only when configured", async () => {
    const dir = folder()
    const hidden = scripted()
    const created = await fileBugReport({
      config: config(dir),
      did: "did:aw:sender",
      message: "the p2a sdk is broken when I connect",
      now: NOW,
      client: hidden.client,
      judge: async () => {
        throw new Error("judge should not run without candidates")
      },
    })
    expect(created.action).toBe("created")
    expect(created.identifier).toBe("SUP-1")
    expect(created.text).toBe("I opened SUP-1 as a bug.")
    expect(created.judged).toBe(false)
    expect(hidden.calls[1]?.title).toBe(`Bug: ${issueTitle(cleanSummary("the p2a sdk is broken when I connect"))}`)
    expect(hidden.calls[1]?.title?.length).toBeLessThanOrEqual(70)
    expect(hidden.calls[1]?.text).not.toContain("did:aw:sender")

    const shown = scripted()
    const visible = await fileBugReport({
      config: config(folder(), { P2A_SUPPORT_LINEAR_SHOW_URLS: "1" }),
      did: "did:aw:other",
      message: "the p2a sdk is broken when I connect",
      now: NOW,
      client: shown.client,
      judge: judgeNone,
    })
    expect(visible.text).toContain("https://example.test/SUP-1")
  })

  it("uses a clean model title and otherwise the stripped report", async () => {
    const message = "From agent@example (test, safe to close): Bug: the agents page returns a 500"
    const suggested = scripted()
    const withModel = await fileBugReport({
      config: config(folder()),
      did: "did:aw:sender",
      message,
      suggestedTitle: "dashboard returns 500",
      now: NOW,
      client: suggested.client,
      judge: judgeNone,
    })
    expect(withModel.action).toBe("created")
    expect(suggested.calls[1]?.title).toBe("Bug: dashboard returns 500")
    expect(suggested.calls[1]?.text).toContain("agents page")
    const plain = scripted()
    await fileBugReport({
      config: config(folder()),
      did: "did:aw:other",
      message,
      now: NOW,
      client: plain.client,
      judge: judgeNone,
    })
    expect(plain.calls[1]?.title).toBe("Bug: the agents page returns a 500")
    expect(plain.calls[1]?.title).not.toContain("agent@example")
    expect(plain.calls[1]?.text).toContain("the agents page returns a 500")
  })

  it("does not file the same summary from the same sender twice in 24 hours", async () => {
    const dir = folder()
    const { client, calls } = scripted()
    const input = {
      config: config(dir),
      did: "did:aw:sender",
      message: "the p2a sdk is broken when I connect",
      client,
      judge: judgeNone,
    }
    const first = await fileBugReport({ ...input, now: NOW })
    const again = await fileBugReport({ ...input, now: new Date(NOW.getTime() + 23 * 60 * 60 * 1000) })
    expect(again.action).toBe("duplicate")
    expect(again.identifier).toBe(first.identifier)
    expect(again.text).not.toContain("added the new report")
    expect(calls.filter((call) => call.op === "create")).toHaveLength(1)
    expect(calls.filter((call) => call.op === "search")).toHaveLength(1)

    const other = scripted()
    const secondSender = await fileBugReport({
      ...input,
      config: config(dir),
      did: "did:aw:other",
      now: NOW,
      client: other.client,
    })
    expect(secondSender.action).toBe("created")

    const later = await fileBugReport({
      ...input,
      now: new Date(NOW.getTime() + LINEAR_DEDUPE_MS + 60_000),
    })
    expect(later.action).toBe("created")
    expect(later.identifier).not.toBe(first.identifier)
  })

  it("caps new issues at 20 a day and still comments on an open match", async () => {
    expect(LINEAR_DAILY_CAP).toBe(20)
    const dir = folder()
    const { client, calls } = scripted()
    for (let index = 0; index < LINEAR_DAILY_CAP; index += 1) {
      const result = await fileBugReport({
        config: config(dir),
        did: "did:aw:sender",
        message: `the p2a sdk is broken case ${index}`,
        now: NOW,
        client,
        judge: judgeNone,
      })
      expect(result.action).toBe("created")
    }
    const capped = await fileBugReport({
      config: config(dir),
      did: "did:aw:sender",
      message: "the p2a sdk is broken case overflow",
      now: NOW,
      client,
      judge: judgeNone,
    })
    expect(capped.action).toBe("capped")
    expect(capped.text).not.toContain("http")
    expect(capped.text).toContain("info@p2a.sh")
    expect(calls.filter((call) => call.op === "create")).toHaveLength(LINEAR_DAILY_CAP)

    const matched = scripted({ issues: [issue("SUP-4")] })
    const comment = await fileBugReport({
      config: config(dir),
      did: "did:aw:sender",
      message: "the p2a sdk is broken in another way",
      now: NOW,
      client: matched.client,
      judge: judgeMatch,
    })
    expect(comment.action).toBe("commented")
    expect(comment.identifier).toBe("SUP-4")
    expect(matched.calls.map((call) => call.op)).toEqual(["search", "comment"])
  })

  it("does not create when search or the judge fails", async () => {
    const dir = folder()
    const broken = scripted({ failSearch: true })
    const failed = await fileBugReport({
      config: config(dir),
      did: "did:aw:sender",
      message: "the p2a sdk is broken when I connect",
      now: NOW,
      client: broken.client,
      judge: judgeNone,
    })
    expect(failed.action).toBe("failed")
    expect(failed.text).not.toContain("http")
    expect(broken.calls.map((call) => call.op)).toEqual(["search"])

    const unsure = scripted({ issues: [issue("SUP-3")] })
    const judged = await fileBugReport({
      config: config(dir),
      did: "did:aw:sender",
      message: "the p2a wake call is broken",
      now: NOW,
      client: unsure.client,
      judge: async () => {
        throw new Error("linear_failed")
      },
    })
    expect(judged.action).toBe("failed")
    expect(judged.judged).toBe(true)
    expect(unsure.calls.map((call) => call.op)).toEqual(["search"])

    const invented = scripted({ issues: [issue("SUP-3")] })
    const hallucinated = await fileBugReport({
      config: config(dir),
      did: "did:aw:sender",
      message: "the p2a alias command is broken",
      now: NOW,
      client: invented.client,
      judge: async () => "SUP-99",
    })
    expect(hallucinated.action).toBe("failed")
    expect(invented.calls.map((call) => call.op)).toEqual(["search"])
  })
})

describe("linear client", () => {
  it("searches open issues and creates with the Bug label when it exists", async () => {
    const seen: { query: string; variables: Record<string, unknown>; authorization: string; body: string }[] = []
    const fetchImpl: typeof fetch = async (url, init) => {
      const headers = new Headers(init?.headers)
      const raw = String(init?.body ?? "{}")
      const parsed = JSON.parse(raw) as { query?: string; variables?: Record<string, unknown> }
      seen.push({
        query: parsed.query ?? "",
        variables: parsed.variables ?? {},
        authorization: headers.get("authorization") ?? "",
        body: raw,
      })
      expect(String(url)).toBe(LINEAR_ENDPOINT)
      const query = parsed.query ?? ""
      if (query.includes("searchIssues")) {
        return new Response(JSON.stringify({
          data: {
            searchIssues: {
              nodes: [{ id: "iss-1", identifier: "SUP-12", title: "SDK connect fails", description: "details", url: "https://example.test/SUP-12" }],
            },
          },
        }), { status: 200 })
      }
      if (query.includes("commentCreate")) {
        return new Response(JSON.stringify({ data: { commentCreate: { success: true } } }), { status: 200 })
      }
      if (query.includes("teams(")) {
        return new Response(JSON.stringify({ data: { teams: { nodes: [{ id: "team-1" }] } } }), { status: 200 })
      }
      if (query.includes("issueLabels")) {
        return new Response(JSON.stringify({ data: { issueLabels: { nodes: [{ id: "lab-1", name: "Bug" }] } } }), { status: 200 })
      }
      if (query.includes("issueCreate")) {
        return new Response(JSON.stringify({
          data: { issueCreate: { success: true, issue: { id: "iss-9", identifier: "SUP-9", title: "t", description: "d", url: "https://example.test/SUP-9" } } },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ errors: [{ message: KEY }] }), { status: 200 })
    }
    const client = createLinearClient(config(folder()), fetchImpl)
    const found = await client.searchOpen("p2a sdk broken")
    expect(found[0]?.identifier).toBe("SUP-12")
    const search = seen[0]
    expect(search?.query).toContain("searchIssues")
    expect(search?.query).toContain('nin: ["completed", "canceled"]')
    expect(search?.query).not.toContain("cancelled")
    expect(search?.variables.team).toBe("P2A")
    expect(search?.variables.term).toBe("p2a sdk broken")
    expect(search?.authorization).toBe(KEY)
    expect(search?.authorization.startsWith("Bearer ")).toBe(false)
    expect(search?.body).not.toContain(KEY)
    await client.comment("iss-1", "the p2a sdk is broken")
    expect(seen.at(-1)?.variables).toEqual({ id: "iss-1", body: "the p2a sdk is broken" })
    const created = await client.create("SDK connect fails", "the p2a sdk is broken")
    expect(created.identifier).toBe("SUP-9")
    const create = seen.find((call) => call.query.includes("issueCreate"))
    expect(create?.variables.input).toEqual({
      teamId: "team-1",
      title: "SDK connect fails",
      description: "the p2a sdk is broken",
      labelIds: ["lab-1"],
    })
    const labelQuery = seen.find((call) => call.query.includes("issueLabels"))
    expect(labelQuery?.query).toContain("eqIgnoreCase: $name")
    expect(labelQuery?.query).toContain("team: { key: { eq: $team } }")
    expect(labelQuery?.query).toContain("team: { null: true }")
    expect(labelQuery?.variables.name).toBe("Bug")
    expect(labelQuery?.variables.team).toBe("P2A")
  })

  it("uses a workspace label when the team has none, and prefers the team label when both exist", async () => {
    const created: string[][] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as { query?: string; variables?: { name?: string; input?: { labelIds?: string[] } } }
      const query = parsed.query ?? ""
      const name = parsed.variables?.name?.toLowerCase() ?? ""
      if (query.includes("teams(")) {
        return new Response(JSON.stringify({ data: { teams: { nodes: [{ id: "team-1" }] } } }), { status: 200 })
      }
      if (query.includes("issueLabels")) {
        const nodes = name === "bug"
          ? [{ id: "ws-bug", name: "BUG", team: null }]
          : name === "feature"
            ? [
                { id: "ws-feature", name: "Feature", team: null },
                { id: "team-feature", name: "feature", team: { key: "P2A" } },
              ]
            : name === "feedback"
              ? [{ id: "team-feedback", name: "Feedback", team: { key: "P2A" } }]
              : name === "needs-info"
                ? [{ id: "team-need", name: "Needs-Info", team: { key: "P2A" } }]
                : []
        return new Response(JSON.stringify({ data: { issueLabels: { nodes } } }), { status: 200 })
      }
      if (query.includes("issueCreate")) {
        created.push(parsed.variables?.input?.labelIds ?? [])
        return new Response(JSON.stringify({
          data: { issueCreate: { success: true, issue: { id: "iss-1", identifier: "SUP-1", title: "t", description: "d", url: "" } } },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ errors: [{ message: "unexpected" }] }), { status: 200 })
    }
    const client = createLinearClient(config(folder()), fetchImpl)
    await client.create("bug", "the p2a sdk is broken", { label: "Bug" })
    await client.create("feature", "please add an export", { label: "Feature" })
    await client.create("feedback", "feedback: the inbox stays empty", { label: "Feedback", needsInfo: true })
    expect(created).toEqual([["ws-bug"], ["team-feature"], ["team-feedback", "team-need"]])
  })

  it("omits the label when it does not exist and hides upstream errors", async () => {
    const calls: { query: string; variables: Record<string, unknown> }[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as { query?: string; variables?: Record<string, unknown> }
      const query = parsed.query ?? ""
      calls.push({ query, variables: parsed.variables ?? {} })
      if (query.includes("teams(")) {
        return new Response(JSON.stringify({ data: { teams: { nodes: [{ id: "team-1" }] } } }), { status: 200 })
      }
      if (query.includes("issueLabels")) {
        return new Response(JSON.stringify({ data: { issueLabels: { nodes: [] } } }), { status: 200 })
      }
      if (query.includes("issueCreate")) {
        return new Response(JSON.stringify({
          data: { issueCreate: { success: true, issue: { id: "iss-2", identifier: "SUP-2", title: "t", description: "d", url: "" } } },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ errors: [{ message: KEY }] }), { status: 200 })
    }
    const client = createLinearClient(config(folder()), fetchImpl)
    await client.create("title", "the p2a sdk is broken")
    const input = calls.find((call) => call.query.includes("issueCreate"))?.variables.input as { labelIds?: string[] }
    expect(input.labelIds).toBeUndefined()

    let creates = 0
    const retrying = createLinearClient(config(folder()), async (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as { query?: string }
      const query = parsed.query ?? ""
      if (query.includes("teams(")) {
        return new Response(JSON.stringify({ data: { teams: { nodes: [{ id: "team-1" }] } } }), { status: 200 })
      }
      if (query.includes("issueLabels")) {
        return new Response(JSON.stringify({ data: { issueLabels: { nodes: [{ id: "lab-foreign", name: "Bug" }] } } }), { status: 200 })
      }
      if (query.includes("issueCreate")) {
        creates += 1
        if (creates === 1) {
          return new Response(JSON.stringify({
            errors: [{ message: "labelIds are not in this team", extensions: { validationErrors: [{ path: ["labelIds"] }] } }],
          }), { status: 200 })
        }
        return new Response(JSON.stringify({
          data: { issueCreate: { success: true, issue: { id: "iss-3", identifier: "SUP-3", title: "t", description: "d", url: "" } } },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ errors: [{ message: KEY }] }), { status: 200 })
    })
    const retried = await retrying.create("title", "the p2a sdk is broken")
    expect(retried.identifier).toBe("SUP-3")
    expect(creates).toBe(2)
    const failing = createLinearClient(config(folder()), async () => new Response(JSON.stringify({ errors: [{ message: KEY }] }), { status: 200 }))
    try {
      await failing.searchOpen("p2a")
      throw new Error("error response was accepted")
    } catch (err) {
      expect((err as Error).message).toBe("linear_failed")
      expect((err as Error).message).not.toContain(KEY)
    }
  })
})

describe("judge budget", () => {
  it("charges the duplicate judge against the daily budget", async () => {
    const dir = folder()
    const cfg = config(dir)
    const state = emptyTurnState(NOW)
    const caps: number[] = []
    const fetchImpl: typeof fetch = async (url, init) => {
      const target = String(url)
      const body = String(init?.body ?? "{}")
      if (target.includes("api.linear.app")) {
        const query = (JSON.parse(body) as { query?: string }).query ?? ""
        if (query.includes("searchIssues")) {
          return new Response(JSON.stringify({
            data: { searchIssues: { nodes: [{ id: "iss-1", identifier: "SUP-1", title: "SDK connect fails", description: "details", url: "" }] } },
          }), { status: 200 })
        }
        if (query.includes("teams(")) {
          return new Response(JSON.stringify({ data: { teams: { nodes: [{ id: "team-1" }] } } }), { status: 200 })
        }
        if (query.includes("issueLabels")) {
          return new Response(JSON.stringify({ data: { issueLabels: { nodes: [] } } }), { status: 200 })
        }
        if (query.includes("issueCreate")) {
          return new Response(JSON.stringify({
            data: { issueCreate: { success: true, issue: { id: "iss-9", identifier: "SUP-9", title: "t", description: "d", url: "" } } },
          }), { status: 200 })
        }
        return new Response(JSON.stringify({ errors: [{ message: "linear_failed" }] }), { status: 200 })
      }
      const parsed = JSON.parse(body) as { max_tokens?: number; messages?: { content?: string }[] }
      const system = parsed.messages?.[0]?.content ?? ""
      if (system.includes("match a support report")) caps.push(parsed.max_tokens ?? 0)
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "{\"identifier\":null}" } }],
        usage: { prompt_tokens: 20, completion_tokens: 8 },
      }), { status: 200 })
    }
    const result = await handleTurn({
      config: cfg,
      state,
      message: "the p2a sdk is broken when I connect",
      did: "did:aw:sender",
      senderDid: "did:aw:sender",
      owner: "ada",
      contextId: "c1",
      now: NOW,
      fetchImpl,
    })
    expect(result.reason).toBe("answer")
    expect(caps).toEqual([cfg.maxOutputTokens])
    expect(state.budget.llmCalls).toBeGreaterThan(0)
    expect(state.budget.spent).toBeGreaterThan(0)
    expect(state.budget.reserved).toBe(0)
  })
})

describe("judge", () => {
  it("accepts only an identifier from the candidate list", async () => {
    const cfg = config(folder())
    const issues = [issue("SUP-1"), issue("SUP-2")]
    const fetchImpl = (content: string, status = 200): typeof fetch => async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { temperature?: number; max_tokens?: number; tools?: unknown }
      expect(body.temperature).toBe(0.2)
      expect(body.max_tokens).toBe(cfg.maxOutputTokens)
      expect(body.tools).toBeUndefined()
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }), { status })
    }
    await expect(judgeWithModel(cfg, "the p2a sdk is broken", issues, fetchImpl('{"identifier":"SUP-2"}'))).resolves.toBe("SUP-2")
    await expect(judgeWithModel(cfg, "the p2a sdk is broken", issues, fetchImpl('```json\n{"identifier":null}\n```'))).resolves.toBeNull()
    await expect(judgeWithModel(cfg, "the p2a sdk is broken", issues, fetchImpl('{"identifier":"SUP-99"}'))).rejects.toThrow("linear_failed")
    await expect(judgeWithModel(cfg, "the p2a sdk is broken", issues, fetchImpl("nope", 500))).rejects.toThrow("linear_failed")
  })
})

describe("turn wiring", () => {
  it("files a product bug and leaves other messages on the existing path", async () => {
    const dir = folder()
    const filed = scripted({ issues: [issue("SUP-12")] })
    const network: typeof fetch = async () => {
      throw new Error("network")
    }
    const bug = await handleTurn({
      config: config(dir),
      state: emptyTurnState(NOW),
      message: "the p2a sdk is broken when I connect",
      did: "did:aw:sender",
      owner: "ada",
      contextId: "c1",
      now: NOW,
      linear: filed.client,
      judge: judgeMatch,
      fetchImpl: network,
    })
    expect(bug.reason).toBe("answer")
    expect(bug.text).toContain("SUP-12")
    expect(bug.text).not.toContain("http")
    expect(bug.llmCalls).toBe(1)
    expect(filed.calls.map((call) => call.op)).toEqual(["search", "comment"])

    const idle = scripted()
    const answer = payloadFetch("Install the SDK from the guide.")
    const howto = await handleTurn({
      config: config(dir),
      state: emptyTurnState(NOW),
      message: "how do I install the p2a sdk",
      did: "did:aw:sender",
      owner: "ada",
      contextId: "c2",
      now: NOW,
      linear: idle.client,
      fetchImpl: answer.fetchImpl,
    })
    expect(howto.reason).toBe("answer")
    expect(howto.text).toContain("Install the SDK")
    expect(idle.calls).toEqual([])

    const off = scripted()
    const python = await handleTurn({
      config: config(dir),
      state: emptyTurnState(NOW),
      message: "the python scraper is broken",
      did: "did:aw:sender",
      owner: "ada",
      contextId: "c3",
      now: NOW,
      linear: off.client,
      fetchImpl: network,
    })
    expect(python.reason).toBe("off_topic")
    expect(off.calls).toEqual([])

    const security = scripted()
    const xss = await handleTurn({
      config: config(dir),
      state: emptyTurnState(NOW),
      message: "there is an xss in p2a",
      did: "did:aw:sender",
      owner: "ada",
      contextId: "c4",
      now: NOW,
      linear: security.client,
      fetchImpl: network,
    })
    expect(xss.reason).toBe("escalate")
    expect(xss.category).toBe("security")
    expect(security.calls).toEqual([])

    const disabled = scripted()
    const plain = payloadFetch("Try the connect guide.")
    const without = await handleTurn({
      config: loadConfig({ STATE_DIR: dir, LLM_API_KEY: "local-test-key", LOG_LEVEL: "error" }),
      state: emptyTurnState(NOW),
      message: "the p2a sdk is broken when I connect",
      did: "did:aw:sender",
      owner: "ada",
      contextId: "c5",
      now: NOW,
      linear: disabled.client,
      fetchImpl: plain.fetchImpl,
    })
    expect(without.text).toContain("connect guide")
    expect(disabled.calls).toEqual([])

    writeFileSync(join(dir, "PAUSED"), "hold\n")
    const pausedClient = scripted()
    const paused = await handleTurn({
      config: config(dir),
      state: emptyTurnState(NOW),
      message: "the p2a sdk is broken when I connect",
      did: "did:aw:sender",
      owner: "ada",
      contextId: "c6",
      now: NOW,
      linear: pausedClient.client,
      fetchImpl: network,
    })
    expect(paused.reason).toBe("paused")
    expect(pausedClient.calls).toEqual([])
  })
})

describe("linear retries", () => {
  it("adopts an issue created during a timed-out create instead of opening another", async () => {
    const dir = folder()
    const secret = "timeout-secret-body"
    const logs: string[] = []
    const original = process.stdout.write
    process.stdout.write = ((chunk: string | Uint8Array) => {
      logs.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    let creates = 0
    let searches = 0
    const title = "the p2a sdk is broken"
    try {
      const fetchImpl: typeof fetch = async (_url, init) => {
        const query = (JSON.parse(String(init?.body ?? "{}")) as { query?: string }).query ?? ""
        if (query.includes("teams(")) return json({ data: { teams: { nodes: [{ id: "team-1" }] } } })
        if (query.includes("issueLabels")) return json({ data: { issueLabels: { nodes: [] } } })
        if (query.includes("searchIssues")) {
          searches += 1
          if (searches < 3) return json({ data: { searchIssues: { nodes: [] } } })
          return json({
            data: {
              searchIssues: {
                nodes: [{ id: "iss-1", identifier: "SUP-9", title: `Bug: ${title}`, description: "d", url: "https://example.test/SUP-9" }],
              },
            },
          })
        }
        if (query.includes("issueCreate")) {
          creates += 1
          throw Object.assign(new Error(secret), { name: "TimeoutError" })
        }
        return json({ data: {} })
      }
      const cfg = config(dir, { LOG_LEVEL: "warn" })
      const client = createLinearClient(cfg, fetchImpl)
      const first = await fileBugReport({
        config: cfg,
        did: "did:aw:sender",
        message: title,
        now: NOW,
        client,
        judge: judgeNone,
      })
      expect(first.action).toBe("failed")
      expect(creates).toBe(1)
      const second = await fileBugReport({
        config: cfg,
        did: "did:aw:sender",
        message: title,
        now: NOW,
        client,
        judge: judgeNone,
      })
      expect(second.action).toBe("duplicate")
      expect(second.identifier).toBe("SUP-9")
      expect(creates).toBe(1)
    } finally {
      process.stdout.write = original
    }
    expect(logs.join("")).not.toContain(secret)
  })

  it("logs a graphql error code and not the message", async () => {
    const dir = folder()
    const secret = "graphql-secret-body"
    const logs: string[] = []
    const original = process.stdout.write
    process.stdout.write = ((chunk: string | Uint8Array) => {
      logs.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      const fetchImpl: typeof fetch = async (_url, init) => {
        const query = (JSON.parse(String(init?.body ?? "{}")) as { query?: string }).query ?? ""
        if (query.includes("teams(")) return json({ data: { teams: { nodes: [{ id: "team-1" }] } } })
        if (query.includes("issueLabels")) return json({ data: { issueLabels: { nodes: [] } } })
        if (query.includes("issueCreate")) {
          return json({ errors: [{ message: secret, extensions: { code: "INVALID_INPUT" } }] })
        }
        return json({ data: { searchIssues: { nodes: [] } } })
      }
      const cfg = config(dir, { LOG_LEVEL: "warn" })
      const filed = await fileBugReport({
        config: cfg,
        did: "did:aw:sender",
        message: "the p2a sdk is broken",
        now: NOW,
        client: createLinearClient(cfg, fetchImpl),
        judge: judgeNone,
      })
      expect(filed.action).toBe("failed")
    } finally {
      process.stdout.write = original
    }
    const joined = logs.join("")
    expect(joined).toContain("INVALID_INPUT")
    expect(joined).toContain("\"status\":200")
    expect(joined).not.toContain(secret)
  })

  it("caps comments separately from new issues", async () => {
    const dir = folder()
    const { client, calls } = scripted({ issues: [issue("SUP-4")] })
    for (let n = 0; n < LINEAR_DAILY_CAP; n += 1) {
      const filed = await fileBugReport({
        config: config(dir),
        did: "did:aw:sender",
        message: `the p2a sdk is broken case ${n}`,
        now: NOW,
        client,
        judge: judgeMatch,
      })
      expect(filed.action).toBe("commented")
    }
    const extra = await fileBugReport({
      config: config(dir),
      did: "did:aw:sender",
      message: "the p2a sdk is broken case extra",
      now: NOW,
      client,
      judge: judgeMatch,
    })
    expect(extra.action).toBe("capped")
    expect(calls.filter((call) => call.op === "comment")).toHaveLength(LINEAR_DAILY_CAP)
    const created = await fileBugReport({
      config: config(dir),
      did: "did:aw:sender",
      message: "the p2a sdk is broken somewhere else",
      now: NOW,
      client,
      judge: judgeNone,
    })
    expect(created.action).toBe("created")
  })

  it("reuses one linear client for the same fetch function", async () => {
    let teams = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      const query = (JSON.parse(String(init?.body ?? "{}")) as { query?: string }).query ?? ""
      if (query.includes("teams(")) {
        teams += 1
        return json({ data: { teams: { nodes: [{ id: "team-1" }] } } })
      }
      if (query.includes("issueLabels")) return json({ data: { issueLabels: { nodes: [] } } })
      if (query.includes("issueCreate")) {
        return json({
          data: { issueCreate: { success: true, issue: { id: "iss-1", identifier: "SUP-1", title: "t", description: "d", url: "" } } },
        })
      }
      return json({ data: {} })
    }
    const cfg = config(folder())
    const first = linearClientFor(cfg, fetchImpl)
    const second = linearClientFor(cfg, fetchImpl)
    expect(second).toBe(first)
    await first.create("one", "the p2a sdk is broken")
    await second.create("two", "the p2a sdk is broken")
    expect(teams).toBe(1)
  })
})

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

function payloadFetch(content: string): { fetchImpl: typeof fetch } {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    choices: [{ finish_reason: "stop", message: { content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }), { status: 200 })
  return { fetchImpl }
}
