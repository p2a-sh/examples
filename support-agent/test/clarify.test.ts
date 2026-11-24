import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { fileable, heuristicPresent } from "../src/clarify.js"
import { loadConfig, type Config } from "../src/config.js"
import { createLinearClient, fileBugReport, senderKey, type LinearClient, type LinearIssue } from "../src/linear.js"
import { activeLockCount, withKey } from "../src/locks.js"
import { LOG_FIELDS, logLine } from "../src/log.js"
import { PENDING_CAP, PENDING_FILE, type PendingReport } from "../src/pending.js"
import { clarifyQuestionText } from "../src/replies.js"
import { wireSupport, type SupportAgent, type SupportRequest } from "../src/runtime.js"
import { emptyTurnState, handleTurn } from "../src/turn.js"
import type { AgentRequest } from "./fake-sdk.js"

const NOW = new Date("2026-11-24T12:00:00.000Z")
const ALPHA = "zephyralpha"
const BETA = "quasarbeta"
const DID_A = "did:example:zephyr"
const DID_B = "did:example:quasar"
const ROOT = new URL("..", import.meta.url)

function folder(): string {
  return mkdtempSync(join(tmpdir(), "p2a-clarify-"))
}

function config(stateDir: string, extra: Record<string, string> = {}): Config {
  return loadConfig({
    STATE_DIR: stateDir,
    LLM_API_KEY: "local-test-key",
    ESCALATION_CONTACT: "info@p2a.sh",
    LOG_LEVEL: "info",
    P2A_SUPPORT_LINEAR_API_KEY: "test-linear-key",
    P2A_SUPPORT_LINEAR_TEAM_KEY: "P2A",
    ...extra,
  })
}

function chat(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: "stop", message: { content } }],
    usage: { prompt_tokens: 20, completion_tokens: 20 },
  }), { status: 200 })
}

function model(): { fetchImpl: typeof fetch; bodies: string[] } {
  const bodies: string[] = []
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = String(init?.body ?? "")
    bodies.push(body)
    const parsed = JSON.parse(body) as { max_tokens?: number; messages?: { role: string; content: string }[] }
    const system = parsed.messages?.find((item) => item.role === "system")?.content ?? ""
    const user = parsed.messages?.find((item) => item.role === "user")?.content ?? ""
    if (system.includes("enough detail")) {
      if (parsed.max_tokens !== 1500) throw new Error("clarify tokens")
      const ready = user.includes("error 418") && user.includes("should")
      const content = ready
        ? JSON.stringify({
            present: ["surface", "action", "expected", "actual", "repro"],
            missing: ["scope"],
            question: "Which client were you using?",
          })
        : JSON.stringify({
            present: ["surface"],
            missing: ["action", "expected", "actual", "repro", "scope"],
            question: "What happened, and what did you expect?",
          })
      return chat(content)
    }
    if (parsed.max_tokens !== 1500) throw new Error("judge tokens")
    return chat(JSON.stringify({ identifier: user.includes(BETA) ? "SUP-2" : null }))
  }
  return { fetchImpl, bodies }
}

function tracker(): { client: LinearClient; calls: { op: string; text: string; title?: string; needsInfo?: boolean }[] } {
  const calls: { op: string; text: string; title?: string; needsInfo?: boolean }[] = []
  let created = 0
  const client: LinearClient = {
    async searchOpen(term) {
      calls.push({ op: "search", text: term })
      if (!term.includes(BETA)) return []
      return [{
        id: "iss-2",
        identifier: "SUP-2",
        title: "Connect fails",
        description: "open issue",
        url: "https://example.test/SUP-2",
      }]
    },
    async comment(_id, body) {
      calls.push({ op: "comment", text: body })
    },
    async create(title, description, options) {
      calls.push({ op: "create", text: description, title, needsInfo: options?.needsInfo === true })
      created += 1
      const identifier = `SUP-${created}`
      return { id: `iss-${created}`, identifier, title, description, url: `https://example.test/${identifier}` }
    },
  }
  return { client, calls }
}

function pending(dir: string): { entries: PendingReport[] } {
  return JSON.parse(readFileSync(join(dir, PENDING_FILE), "utf8")) as { entries: PendingReport[] }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe("locks", () => {
  it("serializes one key, runs other keys together, and drops idle keys", async () => {
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstEntered = false
    const first = withKey("same", async () => {
      firstEntered = true
      await gate
      return "first"
    })
    await flush()
    let secondStarted = false
    const second = withKey("same", async () => {
      secondStarted = true
      return "second"
    })
    expect(firstEntered).toBe(true)
    expect(secondStarted).toBe(false)
    let otherRan = false
    const other = withKey("other", async () => {
      otherRan = true
      return "other"
    })
    expect(await other).toBe("other")
    expect(otherRan).toBe(true)
    expect(secondStarted).toBe(false)
    releaseFirst()
    expect(await first).toBe("first")
    expect(await second).toBe("second")
    await flush()
    expect(activeLockCount()).toBe(0)
  })
})

describe("clarify config and rubric", () => {
  it("bounds the clarification settings", () => {
    expect(loadConfig({}).clarifyMaxRounds).toBe(2)
    expect(loadConfig({}).clarifyTtlHours).toBe(24)
    expect(loadConfig({ CLARIFY_MAX_ROUNDS: "0" }).clarifyMaxRounds).toBe(0)
    expect(loadConfig({ CLARIFY_TTL_HOURS: "168" }).clarifyTtlHours).toBe(168)
    expect(() => loadConfig({ CLARIFY_MAX_ROUNDS: "5" })).toThrow(/CLARIFY_MAX_ROUNDS/)
    expect(() => loadConfig({ CLARIFY_TTL_HOURS: "0" })).toThrow(/CLARIFY_TTL_HOURS/)
  })

  it("files only when surface, actual, and two more fields are present", () => {
    const present = heuristicPresent("the settings page always fails to save with error 500 and should reconnect")
    expect(present).toEqual(expect.arrayContaining(["surface", "actual", "expected", "repro"]))
    expect(fileable(present)).toBe(true)
    expect(fileable(["surface", "actual"])).toBe(false)
    expect(fileable(["action", "expected", "repro", "scope"])).toBe(false)
    const question = clarifyQuestionText(["surface", "actual", "repro"])
    expect(question).toContain("page")
    expect(question).toContain("happened")
    expect(question).not.toContain("steps")
    expect(question).not.toMatch(/https?:/)
  })

  it("drops fields that are not on the log allowlist", () => {
    const lines: string[] = []
    const hash = createHash("sha256").update(DID_A).digest("hex")
    logLine("info", "clarify_asked", {
      count: 1,
      category: "missing:2",
      did: DID_A,
      requestId: "req-secret-value",
      text: ALPHA,
      email: "ada@example.com",
      hash,
    }, "info", (line) => lines.push(line))
    const record = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>
    expect(Object.keys(record).sort()).toEqual(["category", "count", "event", "level", "ts"])
    expect(lines[0]).not.toContain(DID_A)
    expect(lines[0]).not.toContain(ALPHA)
    expect(lines[0]).not.toContain(hash)
    expect(lines[0]).not.toContain("req-secret-value")
    expect(lines[0]).not.toContain("ada@example.com")
    for (const key of Object.keys(record)) expect(LOG_FIELDS).toContain(key)
  })
})

describe("clarifying a report", () => {
  it("keeps two relayed conversations apart when they share the gateway DID", async () => {
    const dir = folder()
    const cfg = config(dir)
    const { fetchImpl } = model()
    const { client, calls } = tracker()
    const gateway = "did:example:gateway"
    const send = (contextId: string, message: string, requestId: string) => handleTurn({
      config: cfg,
      state: emptyTurnState(NOW),
      message,
      did: gateway,
      senderDid: gateway,
      requestId,
      owner: "owner",
      contextId,
      now: NOW,
      linear: client,
      fetchImpl,
    })
    await send("ctx-one", `the p2a sdk is broken ${ALPHA}`, "req-gw-1")
    await send("ctx-two", `the p2a sdk is broken ${BETA}`, "req-gw-2")
    const entries = pending(dir).entries
    expect(entries).toHaveLength(2)
    expect(entries.find((entry) => entry.facts.join(" ").includes(ALPHA))?.facts.join(" ")).not.toContain(BETA)
    expect(calls.filter((call) => call.op === "create")).toEqual([])
  })

  it("keeps two senders apart, replays a question, and files needs-info at the round cap", async () => {
    const dir = folder()
    const cfg = config(dir)
    const { fetchImpl, bodies } = model()
    const { client, calls } = tracker()
    const logs: string[] = []
    const original = process.stdout.write
    process.stdout.write = ((chunk: string | Uint8Array) => {
      logs.push(String(chunk))
      return original.call(process.stdout, chunk)
    }) as typeof process.stdout.write
    const send = (did: string, message: string, requestId: string) => handleTurn({
      config: cfg,
      state: emptyTurnState(NOW),
      message,
      did,
      senderDid: did,
      requestId,
      owner: "owner",
      contextId: did,
      now: NOW,
      linear: client,
      fetchImpl,
    })
    try {
      const a1 = await send(DID_A, `the p2a sdk is broken ${ALPHA}`, "req-zephyr-1")
      expect(a1.reason).toBe("answer")
      expect(a1.text).toBe("What happened, and what did you expect?")
      expect(calls).toEqual([])
      const saved = pending(dir)
      expect(saved.entries).toHaveLength(1)
      expect(saved.entries[0]?.key).toBe(senderKey(DID_A))
      expect(saved.entries[0]?.state).toBe("asking")
      expect(saved.entries[0]?.facts.join("\n")).toContain(ALPHA)
      expect(JSON.stringify(saved)).not.toContain(DID_A)
      expect(JSON.stringify(saved)).not.toContain(BETA)

      const replay = await send(DID_A, `ignore this ${ALPHA} replay`, "req-zephyr-1")
      expect(replay.text).toBe(a1.text)
      expect(bodies).toHaveLength(1)
      expect(calls).toEqual([])
      expect(pending(dir).entries[0]?.facts).toEqual(saved.entries[0]?.facts)

      const b1 = await send(DID_B, `the p2a tool is broken ${BETA}`, "req-quasar-1")
      expect(b1.text).toBe("What happened, and what did you expect?")
      expect(b1.text).not.toContain(ALPHA)
      const both = pending(dir)
      const entryA = both.entries.find((entry) => entry.key === senderKey(DID_A))
      const entryB = both.entries.find((entry) => entry.key === senderKey(DID_B))
      expect(entryA?.facts.join("\n")).toContain(ALPHA)
      expect(entryA?.facts.join("\n")).not.toContain(BETA)
      expect(entryB?.facts.join("\n")).toContain(BETA)
      expect(entryB?.facts.join("\n")).not.toContain(ALPHA)

      const a2 = await send(DID_A, `the p2a sdk is still broken ${ALPHA}`, "req-zephyr-2")
      expect(a2.text).toBe("What happened, and what did you expect?")
      expect(a2.text).not.toContain(BETA)
      expect(calls).toEqual([])

      const beforeB = calls.length
      const b2 = await send(
        DID_B,
        `the settings page always fails with error 418 and should reconnect ${BETA}`,
        "req-quasar-2",
      )
      expect(b2.text).toContain("SUP-2")
      expect(b2.text).not.toContain("needs-info")
      expect(b2.text).not.toContain(ALPHA)
      const bCalls = calls.slice(beforeB)
      expect(bCalls.map((call) => call.op)).toEqual(["search", "comment"])
      expect(bCalls.every((call) => !call.text.includes(ALPHA))).toBe(true)
      expect(bCalls.some((call) => call.text.includes(BETA))).toBe(true)

      const beforeA = calls.length
      const a3 = await send(DID_A, `the p2a sdk is broken again ${ALPHA}`, "req-zephyr-3")
      expect(a3.text).toContain("needs-info")
      expect(a3.text).toContain("SUP-1")
      expect(a3.text).not.toContain(BETA)
      const aCalls = calls.slice(beforeA)
      expect(aCalls.map((call) => call.op)).toEqual(["search", "create"])
      expect(aCalls[1]?.needsInfo).toBe(true)
      expect(aCalls.every((call) => !call.text.includes(BETA))).toBe(true)
      expect(aCalls.some((call) => call.text.includes(ALPHA))).toBe(true)
      expect(aCalls.some((call) => call.text.includes("Missing:"))).toBe(true)
    } finally {
      process.stdout.write = original
    }

    for (const body of bodies) {
      const hasAlpha = body.includes(ALPHA)
      const hasBeta = body.includes(BETA)
      expect(hasAlpha && hasBeta).toBe(false)
    }
    const joined = logs.join("")
    expect(joined).not.toContain(ALPHA)
    expect(joined).not.toContain(BETA)
    expect(joined).not.toContain(DID_A)
    expect(joined).not.toContain(DID_B)
    expect(joined).not.toContain(senderKey(DID_A))
    expect(joined).not.toContain(senderKey(DID_B))
    expect(joined).not.toContain("req-zephyr")
    expect(joined).not.toContain("req-quasar")
    expect(joined).toContain("clarify_asked")
    expect(joined).toContain("clarify_filed")
    expect(joined).toContain("clarify_idempotent")
    for (const line of joined.split("\n")) {
      if (!line.startsWith("{")) continue
      const record = JSON.parse(line) as Record<string, unknown>
      for (const key of Object.keys(record)) expect(LOG_FIELDS).toContain(key)
      if (String(record.event).startsWith("clarify_")) {
        expect(record.category === "needs_info" || /^missing:\d+$/.test(String(record.category))).toBe(true)
        expect(typeof record.count).toBe("number")
      }
    }
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  it("drops an expired asking report instead of filing it", async () => {
    const dir = folder()
    const did = "did:example:expired"
    const phrase = "expiredphraseunique"
    const { fetchImpl } = model()
    const { client, calls } = tracker()
    await handleTurn({
      config: config(dir),
      state: emptyTurnState(NOW),
      message: "the p2a sdk is broken at first",
      did,
      senderDid: did,
      requestId: "req-expire-1",
      owner: "owner",
      contextId: did,
      now: NOW,
      linear: client,
      fetchImpl,
    })
    const file = pending(dir)
    const entry = file.entries[0]
    if (!entry) throw new Error("missing pending entry")
    entry.updatedAt = NOW.getTime() - 25 * 60 * 60 * 1000
    entry.facts = [phrase]
    writeFileSync(join(dir, PENDING_FILE), JSON.stringify(file))
    const logs: string[] = []
    const original = process.stdout.write
    process.stdout.write = ((chunk: string | Uint8Array) => {
      logs.push(String(chunk))
      return original.call(process.stdout, chunk)
    }) as typeof process.stdout.write
    const bodies: string[] = []
    try {
      const result = await handleTurn({
        config: config(dir),
        state: emptyTurnState(NOW),
        message: "hello p2a",
        did,
        senderDid: did,
        requestId: "req-expire-2",
        owner: "owner",
        contextId: "fresh",
        now: NOW,
        linear: client,
        fetchImpl: async (_url, init) => {
          const body = String(init?.body ?? "")
          bodies.push(body)
          if (body.includes(phrase)) throw new Error("expired fact leaked")
          return chat("See the guide.")
        },
      })
      expect(result.text).toContain("guide")
    } finally {
      process.stdout.write = original
    }
    expect(calls).toEqual([])
    expect(bodies.every((body) => !body.includes(phrase))).toBe(true)
    expect(JSON.stringify(pending(dir))).not.toContain(phrase)
    const joined = logs.join("")
    expect(joined).toContain("clarify_expired")
    expect(joined).not.toContain(phrase)
    expect(joined).not.toContain(did)
    expect(joined).not.toContain(senderKey(did))
  })

  it("keeps a filed report for a day, then drops it", async () => {
    const dir = folder()
    const did = "did:example:oldfiled"
    const phrase = "oldfiledphrase"
    const entry: PendingReport = {
      key: senderKey(did),
      requestIds: ["req-old"],
      facts: [phrase],
      missing: ["actual"],
      rounds: 1,
      createdAt: NOW.getTime() - 60 * 60 * 1000,
      updatedAt: NOW.getTime() - 60 * 60 * 1000,
      state: "filed",
      identifier: "SUP-9",
      lastReply: { requestId: "req-old", outcome: "filed", text: "I opened SUP-9 for this." },
    }
    const write = (ageMs: number) => {
      entry.updatedAt = NOW.getTime() - ageMs
      writeFileSync(join(dir, PENDING_FILE), JSON.stringify({ entries: [entry] }))
    }
    write(60 * 60 * 1000)
    const { fetchImpl, bodies } = model()
    const { client, calls } = tracker()
    const again = await handleTurn({
      config: config(dir),
      state: emptyTurnState(NOW),
      message: `the p2a sdk is broken ${ALPHA}`,
      did,
      senderDid: did,
      requestId: "req-old",
      owner: "owner",
      contextId: did,
      now: NOW,
      linear: client,
      fetchImpl,
    })
    expect(again.text).toBe("I opened SUP-9 for this.")
    expect(calls).toEqual([])
    expect(bodies).toEqual([])
    write(30 * 60 * 60 * 1000)
    const fresh = await handleTurn({
      config: config(dir),
      state: emptyTurnState(NOW),
      message: `the p2a sdk is broken ${ALPHA}`,
      did,
      senderDid: did,
      requestId: "req-old",
      owner: "owner",
      contextId: did,
      now: NOW,
      linear: client,
      fetchImpl,
    })
    expect(fresh.text).toBe("What happened, and what did you expect?")
    const facts = pending(dir).entries[0]?.facts.join("\n") ?? ""
    expect(facts).toContain(ALPHA)
    expect(facts).not.toContain(phrase)
    expect(bodies.every((body) => !body.includes(phrase))).toBe(true)
  })

  it("does not open a pending report when the sender DID is missing", async () => {
    const dir = folder()
    const { client, calls } = tracker()
    const result = await handleTurn({
      config: config(dir),
      state: emptyTurnState(NOW),
      message: "the p2a sdk is broken when I connect",
      did: "unknown",
      owner: "owner",
      contextId: "missing-did",
      now: NOW,
      linear: client,
      fetchImpl: async () => {
        throw new Error("fetch")
      },
    })
    expect(result.text).toContain("SUP-1")
    expect(calls.map((call) => call.op)).toEqual(["search", "create"])
    expect(existsSync(join(dir, PENDING_FILE))).toBe(false)
  })

  it("uses the heuristic when the model budget is closed", async () => {
    const dir = folder()
    const { client, calls } = tracker()
    writeFileSync(join(dir, "PAUSED"), "hold\n")
    const asked = await handleTurn({
      config: config(dir),
      state: emptyTurnState(NOW),
      message: "the p2a sdk is broken somewhere",
      did: DID_A,
      senderDid: DID_A,
      requestId: "req-paused",
      owner: "owner",
      contextId: "paused-ask",
      now: NOW,
      linear: client,
      fetchImpl: async () => {
        throw new Error("fetch")
      },
    })
    expect(asked.reason).toBe("answer")
    expect(asked.text).not.toContain("paused")
    expect(asked.llmCalls).toBe(0)
    expect(calls).toEqual([])

    const capped = await handleTurn({
      config: config(folder(), { GLOBAL_LLM_PER_DAY: "0" }),
      state: emptyTurnState(NOW),
      message: "the p2a sdk is broken somewhere",
      did: DID_B,
      senderDid: DID_B,
      owner: "owner",
      contextId: DID_B,
      now: NOW,
      linear: client,
      fetchImpl: async () => {
        throw new Error("fetch")
      },
    })
    expect(capped.text).not.toContain("paused")
    expect(capped.llmCalls).toBe(0)
    expect(calls).toEqual([])
  })

  it("files a needs-info report when the sender skips, and a complete one from the heuristic", async () => {
    const dir = folder()
    const { client, calls } = tracker()
    writeFileSync(join(dir, "PAUSED"), "hold\n")
    const skipped = await handleTurn({
      config: config(dir),
      state: emptyTurnState(NOW),
      message: "the p2a sdk is broken and I don't know",
      did: DID_A,
      senderDid: DID_A,
      owner: "owner",
      contextId: "skip",
      now: NOW,
      linear: client,
      fetchImpl: async () => {
        throw new Error("fetch")
      },
    })
    expect(skipped.text).toContain("needs-info")
    expect(calls.at(-1)?.op).toBe("create")
    expect(calls.at(-1)?.needsInfo).toBe(true)

    const ready = tracker()
    const filed = await handleTurn({
      config: config(dir),
      state: emptyTurnState(NOW),
      message: "the settings page always fails to save with error 500 and should reconnect on p2a",
      did: DID_B,
      senderDid: DID_B,
      owner: "owner",
      contextId: "ready",
      now: NOW,
      linear: ready.client,
      fetchImpl: async () => {
        throw new Error("fetch")
      },
    })
    expect(filed.text).toContain("SUP-1")
    expect(filed.text).not.toContain("needs-info")
    expect(ready.calls.map((call) => call.op)).toEqual(["search", "create"])
    expect(ready.calls[1]?.needsInfo).toBe(false)
  })

  it("answers a how-to question without touching the open report", async () => {
    const dir = folder()
    const { fetchImpl } = model()
    const { client, calls } = tracker()
    const cfg = config(dir)
    await handleTurn({
      config: cfg,
      state: emptyTurnState(NOW),
      message: `the p2a sdk is broken ${ALPHA}`,
      did: DID_A,
      senderDid: DID_A,
      requestId: "req-how-1",
      owner: "owner",
      contextId: DID_A,
      now: NOW,
      linear: client,
      fetchImpl,
    })
    const before = readFileSync(join(dir, PENDING_FILE), "utf8")
    const answer = await handleTurn({
      config: cfg,
      state: emptyTurnState(NOW),
      message: "how do I install the p2a sdk",
      did: DID_A,
      senderDid: DID_A,
      requestId: "req-how-2",
      owner: "owner",
      contextId: "howto",
      now: NOW,
      linear: client,
      fetchImpl: async () => chat("Install the SDK from the guide."),
    })
    expect(answer.text).toContain("Install the SDK")
    expect(calls).toEqual([])
    expect(readFileSync(join(dir, PENDING_FILE), "utf8")).toBe(before)
    expect(before).not.toContain("install the p2a sdk")
  })

  it("files immediately once the pending cap is reached", async () => {
    const dir = folder()
    const parked = "parkedphrase"
    const entries: PendingReport[] = []
    for (let index = 0; index < PENDING_CAP; index += 1) {
      entries.push({
        key: senderKey(`did:example:parked-${index}`),
        requestIds: [],
        facts: [`the p2a sdk is broken ${parked}`],
        missing: ["actual"],
        rounds: 1,
        createdAt: NOW.getTime(),
        updatedAt: NOW.getTime(),
        state: "asking",
      })
    }
    writeFileSync(join(dir, PENDING_FILE), JSON.stringify({ entries }))
    const { client, calls } = tracker()
    writeFileSync(join(dir, "PAUSED"), "hold\n")
    const result = await handleTurn({
      config: config(dir),
      state: emptyTurnState(NOW),
      message: "the p2a sdk is broken capsenderphrase",
      did: "did:example:cap",
      senderDid: "did:example:cap",
      owner: "owner",
      contextId: "cap",
      now: NOW,
      linear: client,
      fetchImpl: async () => {
        throw new Error("fetch")
      },
    })
    expect(result.text).toContain("needs-info")
    expect(calls.map((call) => call.op)).toEqual(["search", "create"])
    expect(calls[1]?.text).toContain("capsenderphrase")
    expect(calls[1]?.text).not.toContain(parked)
    const stored = pending(dir)
    expect(stored.entries).toHaveLength(PENDING_CAP)
    expect(JSON.stringify(stored)).not.toContain("capsenderphrase")
    expect(stored.entries.some((entry) => entry.key === senderKey("did:example:cap"))).toBe(false)
  })

  it("passes requestId through the runtime and replays the same reply", async () => {
    const dir = folder()
    const { fetchImpl, bodies } = model()
    const request: AgentRequest = {
      text: `the p2a sdk is broken ${ALPHA}`,
      contextId: "wire",
      requestId: "req-wire-1",
      sender: { did: DID_A },
    }
    const agent = new WireAgent()
    await wireSupport(config(dir), { agent, fetchImpl, now: () => NOW })
    const first = await agent.request(request)
    const second = await agent.request({ ...request, text: "a different follow up" })
    expect(second).toBe(first)
    expect(bodies).toHaveLength(1)
    expect(String(first)).not.toContain(BETA)
  })
})

describe("needs-info filing", () => {
  it("looks up the label without creating one, and only on create", async () => {
    const source = readFileSync(new URL("../src/linear.ts", import.meta.url), "utf8")
    expect(source.includes("labelCreate")).toBe(false)
    expect(source.includes("issueLabelCreate")).toBe(false)
    const seen: { query: string; input?: unknown }[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as { query?: string; variables?: { input?: unknown } }
      const query = parsed.query ?? ""
      seen.push({ query, input: parsed.variables?.input })
      if (query.includes("teams(")) {
        return new Response(JSON.stringify({ data: { teams: { nodes: [{ id: "team-1" }] } } }), { status: 200 })
      }
      if (query.includes("needs-info")) {
        return new Response(JSON.stringify({ data: { issueLabels: { nodes: [{ id: "lab-need", name: "Needs-Info" }] } } }), { status: 200 })
      }
      if (query.includes("issueLabels")) {
        return new Response(JSON.stringify({ data: { issueLabels: { nodes: [{ id: "lab-bug", name: "Bug" }] } } }), { status: 200 })
      }
      if (query.includes("issueCreate")) {
        return new Response(JSON.stringify({
          data: { issueCreate: { success: true, issue: { id: "iss-1", identifier: "SUP-1", title: "t", description: "d", url: "" } } },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ errors: [{ message: "nope" }] }), { status: 200 })
    }
    const dir = folder()
    const client = createLinearClient(config(dir), fetchImpl)
    await client.create("title", "the p2a sdk is broken")
    expect(seen.some((call) => call.query.includes("needs-info"))).toBe(false)
    expect(seen.find((call) => call.query.includes("issueCreate"))?.input).toEqual({
      teamId: "team-1",
      title: "title",
      description: "the p2a sdk is broken",
      labelIds: ["lab-bug"],
    })
    seen.length = 0
    await client.create("title", "the p2a sdk is broken", { needsInfo: true })
    const created = seen.find((call) => call.query.includes("issueCreate"))
    expect(created?.input).toEqual({
      teamId: "team-1",
      title: "title",
      description: "the p2a sdk is broken",
      labelIds: ["lab-bug", "lab-need"],
    })
    expect(seen.filter((call) => call.query.includes("Bug"))).toHaveLength(0)
    seen.length = 0
    await client.create("title", "again", { needsInfo: true })
    expect(seen.filter((call) => call.query.includes("issueLabels"))).toHaveLength(0)

    const issue: LinearIssue = {
      id: "iss-2",
      identifier: "SUP-2",
      title: "Connect fails",
      description: "open issue",
      url: "",
    }
    const commented = tracker()
    commented.client.searchOpen = async (term) => {
      commented.calls.push({ op: "search", text: term })
      return [issue]
    }
    const result = await fileBugReport({
      config: config(folder()),
      did: DID_A,
      summary: "the p2a sdk is broken on the settings page",
      facts: ["the p2a sdk is broken on the settings page", "it returns error 500"],
      missing: ["expected", "repro"],
      needsInfo: true,
      now: NOW,
      client: commented.client,
      judge: async () => "SUP-2",
    })
    expect(result.action).toBe("commented")
    expect(result.text).toContain("needs-info")
    expect(commented.calls.map((call) => call.op)).toEqual(["search", "comment"])
    expect(commented.calls[1]?.text).toContain("Missing: expected, repro")
    expect(commented.calls[1]?.text).toContain("error 500")

    const longFact = `broken ${"word ".repeat(80)}`
    const huge = tracker()
    const capped = await fileBugReport({
      config: config(folder()),
      did: DID_B,
      summary: longFact,
      facts: [longFact, longFact, longFact, longFact, longFact, longFact],
      missing: ["scope"],
      needsInfo: false,
      now: NOW,
      client: huge.client,
      judge: async () => null,
    })
    expect(capped.action).toBe("created")
    expect((huge.calls[1]?.text.length ?? 0) <= 2500).toBe(true)
  })
})

describe("public example", () => {
  it("does not mention internal server paths", () => {
    const files = [...walk(new URL("src/", ROOT)), new URL("README.md", ROOT).pathname]
    const banned = ["server", "/src/aweb"].join("")
    for (const file of files) {
      const text = readFileSync(file, "utf8")
      expect(text.includes(banned)).toBe(false)
      expect(text.includes(["dep", "loy/support"].join(""))).toBe(false)
    }
  })
})

class WireAgent implements SupportAgent {
  private handler?: (req: SupportRequest) => Promise<string | void> | string | void
  onRequest(handler: (req: SupportRequest) => Promise<string | void> | string | void): void {
    this.handler = handler
  }
  onConnectionRequest(): void {}
  async resolve(): Promise<Record<string, unknown>> {
    return { owner: "owner" }
  }
  async respondConnection(): Promise<unknown> {
    return {}
  }
  async send(): Promise<unknown> {
    return {}
  }
  async listen(): Promise<void> {}
  request(req: SupportRequest): Promise<string | void> | string | void {
    if (!this.handler) return ""
    return this.handler(req)
  }
}

function walk(dir: URL): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir.pathname, name)
    if (statSync(path).isDirectory()) found.push(...walk(new URL(`${name}/`, dir)))
    else if (name.endsWith(".ts") || name.endsWith(".md")) found.push(path)
  }
  return found
}
