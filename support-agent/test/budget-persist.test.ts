import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { loadConfig, type Config } from "../src/config.js"
import { runSupport, wireSupport, type SupportAgent, type SupportConnection, type SupportRequest } from "../src/runtime.js"
import { rollBudget } from "../src/budget.js"
import { emptyTurnState, handleTurn, loadTurnState } from "../src/turn.js"

const NOW = new Date("2026-11-23T12:00:00.000Z")
const YESTERDAY = "2026-11-22"
const TODAY = "2026-11-23"

function folder(): string {
  return mkdtempSync(join(tmpdir(), "p2a-budget-"))
}

function config(stateDir: string, extra: Record<string, string> = {}): Config {
  return loadConfig({
    STATE_DIR: stateDir,
    LLM_API_KEY: "local-test-key",
    ESCALATION_CONTACT: "info@p2a.sh",
    ALLOWED_EMAILS: "info@p2a.sh",
    LOG_LEVEL: "error",
    SENDER_PER_DAY: "1",
    ...extra,
  })
}

function recordingFetch(content = "See the guide.") {
  const calls: string[] = []
  const fetchImpl: typeof fetch = async () => {
    calls.push("called")
    return new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200 })
  }
  return { calls, fetchImpl }
}

class FakeAgent implements SupportAgent {
  private requestHandler?: (req: SupportRequest) => Promise<string | void> | string | void

  onRequest(handler: (req: SupportRequest) => Promise<string | void> | string | void): void {
    this.requestHandler = handler
  }

  onConnectionRequest(_handler: (req: SupportConnection) => Promise<void> | void): void {}

  async resolve(): Promise<Record<string, unknown>> {
    return { owner: "friendly" }
  }

  async respondConnection(): Promise<unknown> {
    return { ok: true }
  }

  async send(): Promise<unknown> {
    return { ok: true }
  }

  async listen(): Promise<void> {}

  request(req: SupportRequest): Promise<string | void> | string | void {
    return this.requestHandler?.(req) ?? ""
  }
}

function writeState(dir: string, budget: Record<string, unknown>, counters: Record<string, unknown>): void {
  writeFileSync(join(dir, "budget.json"), JSON.stringify(budget))
  writeFileSync(join(dir, "counters.json"), JSON.stringify(counters))
}

function savedCounters(dir: string): { daily?: Record<string, { day: string; count: number }> } {
  return JSON.parse(readFileSync(join(dir, "counters.json"), "utf8"))
}

describe("support budget persistence", () => {
  it("loads today's dollar budget, llm cap, and sender and owner counts", async () => {
    const dir = folder()
    writeState(dir, {
      day: TODAY,
      spent: 1.5,
      reserved: 0.25,
      llmCalls: 4,
      alerted50: true,
      alerted80: false,
      paused: false,
      operatorUnpaused: false,
    }, {
      llm_calls: 4,
      injection_leak: 2,
      daily: {
        "sender:did:aw:sender": { day: TODAY, count: 1 },
        "owner:friendly": { day: TODAY, count: 3 },
      },
    })
    const state = loadTurnState(dir, NOW)
    expect(state.budget.day).toBe(TODAY)
    expect(state.budget.spent).toBe(1.5)
    expect(state.budget.reserved).toBe(0)
    expect(state.budget.llmCalls).toBe(4)
    expect(state.budget.alerted50).toBe(true)
    expect(state.injectionLeaks).toBe(2)
    expect(state.buckets.daily.get("sender:did:aw:sender")).toEqual({ day: TODAY, count: 1 })
    expect(state.buckets.daily.get("owner:friendly")).toEqual({ day: TODAY, count: 3 })
    expect(JSON.stringify(savedCounters(dir))).not.toContain("@")

    const { calls, fetchImpl } = recordingFetch()
    const limited = await handleTurn({
      config: config(dir),
      state,
      message: "how does p2a work",
      did: "did:aw:sender",
      owner: "friendly",
      contextId: "ctx-1",
      now: NOW,
      fetchImpl,
    })
    expect(limited.reason).toBe("limited")
    expect(calls).toHaveLength(0)

    const fresh = loadTurnState(dir, NOW)
    expect(fresh.budget.llmCalls).toBe(4)
    expect(fresh.buckets.daily.get("sender:did:aw:sender")?.count).toBe(1)
    const capped = await handleTurn({
      config: config(dir, { SENDER_PER_DAY: "30", GLOBAL_LLM_PER_DAY: "4", DAILY_BUDGET_USD: "10" }),
      state: fresh,
      message: "how does p2a work",
      did: "did:aw:other",
      owner: "other",
      contextId: "ctx-2",
      now: NOW,
      fetchImpl,
    })
    expect(capped.reason).toBe("paused")
    expect(calls).toHaveLength(0)
  })

  it("rolls a previous UTC day and clears a budget pause", async () => {
    const dir = folder()
    writeState(dir, {
      day: YESTERDAY,
      spent: 2,
      reserved: 0.4,
      llmCalls: 9,
      alerted50: true,
      alerted80: true,
      paused: true,
      operatorUnpaused: false,
    }, {
      llm_calls: 9,
      injection_leak: 1,
      daily: {
        "sender:did:aw:sender": { day: YESTERDAY, count: 30 },
        "owner:friendly": { day: YESTERDAY, count: 30 },
        "sender:ada@example.com": { day: YESTERDAY, count: 4 },
      },
    })
    writeFileSync(join(dir, "PAUSED"), "budget\n")
    const state = loadTurnState(dir, NOW)
    expect(state.budget.day).toBe(TODAY)
    expect(state.budget.spent).toBe(0)
    expect(state.budget.reserved).toBe(0)
    expect(state.budget.llmCalls).toBe(0)
    expect(state.budget.paused).toBe(false)
    expect(state.buckets.daily.size).toBe(0)
    expect(existsSync(join(dir, "PAUSED"))).toBe(false)
    const disk = readFileSync(join(dir, "budget.json"), "utf8") + readFileSync(join(dir, "counters.json"), "utf8")
    expect(disk).not.toContain("ada@example.com")
    expect(disk).not.toContain("@")

    const { calls, fetchImpl } = recordingFetch()
    const resumed = await handleTurn({
      config: config(dir, { SENDER_PER_DAY: "30", DAILY_BUDGET_USD: "2" }),
      state,
      message: "how does p2a work",
      did: "did:aw:sender",
      owner: "friendly",
      contextId: "ctx-1",
      now: NOW,
      fetchImpl,
    })
    expect(resumed.reason).toBe("answer")
    expect(calls).toHaveLength(1)
    expect(readdirSync(dir).some((name) => name.endsWith(".tmp"))).toBe(false)
    const counters = savedCounters(dir)
    expect(counters.daily?.["sender:did:aw:sender"]).toEqual({ day: TODAY, count: 1 })
    expect(counters.daily?.["owner:friendly"]).toEqual({ day: TODAY, count: 1 })
  })

  it("does not roll the budget backward when a call crosses midnight", async () => {
    const dir = folder()
    const cfg = config(dir)
    let now = new Date("2026-11-23T23:59:59.000Z")
    const state = emptyTurnState(now)
    state.budget.spent = 0.5
    state.buckets.daily.set("sender:did:aw:other", { day: "2026-11-24", count: 2 })
    const fetchImpl: typeof fetch = async () => {
      now = new Date("2026-11-24T00:00:02.000Z")
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "See the guide." } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200 })
    }
    const result = await handleTurn({
      config: cfg,
      state,
      message: "how does p2a work",
      did: "did:aw:sender",
      owner: "owner",
      contextId: "ctx-1",
      now,
      clock: () => now,
      fetchImpl,
    })
    expect(result.reason).toBe("answer")
    expect(state.budget.day).toBe("2026-11-24")
    expect(state.budget.spent).toBeLessThan(0.5)
    expect(state.budget.spent).toBeGreaterThan(0)
    expect(state.buckets.daily.get("sender:did:aw:other")).toEqual({ day: "2026-11-24", count: 2 })
    const saved = JSON.parse(readFileSync(join(dir, "counters.json"), "utf8")) as {
      daily?: Record<string, { day: string; count: number }>
    }
    expect(saved.daily?.["sender:did:aw:other"]).toEqual({ day: "2026-11-24", count: 2 })
    const reloaded = loadTurnState(dir, new Date("2026-11-23T23:59:59.000Z"))
    expect(reloaded.buckets.daily.get("sender:did:aw:other")).toEqual({ day: "2026-11-24", count: 2 })
    const rolled = emptyTurnState(new Date("2026-11-24T01:00:00.000Z"))
    rolled.budget.spent = 1
    rolled.budget.paused = true
    rollBudget(rolled.budget, new Date("2026-11-23T23:00:00.000Z"))
    expect(rolled.budget.day).toBe("2026-11-24")
    expect(rolled.budget.spent).toBe(1)
    expect(rolled.budget.paused).toBe(true)
  })

  it("returns the stored reply for the same request without another model call", async () => {
    const dir = folder()
    const { calls, fetchImpl } = recordingFetch("See the guide.")
    const cfg = config(dir)
    const state = emptyTurnState(NOW)
    const ask = (requestId: string, message: string, current = state) => handleTurn({
      config: cfg,
      state: current,
      message,
      did: "did:aw:sender",
      owner: "ada",
      contextId: "c",
      requestId,
      now: NOW,
      fetchImpl,
    })
    const first = await ask("req-1", "how does p2a work")
    expect([...state.buckets.daily.keys()]).toContain("context:did:aw:sender:c")
    const replay = await ask("req-1", "different text")
    expect(replay.text).toBe(first.text)
    expect(calls).toHaveLength(1)
    const other = await ask("req-2", "how does p2a work")
    expect(other.reason).toBe("limited")
    expect(calls).toHaveLength(1)
    const restored = loadTurnState(dir, NOW)
    const again = await ask("req-1", "again", restored)
    expect(again.text).toBe(first.text)
    expect(calls).toHaveLength(1)
  })

  it("drops burst timestamps outside the sender window", () => {
    const dir = folder()
    const now = NOW.getTime()
    writeFileSync(join(dir, "counters.json"), JSON.stringify({
      bursts: { "did:did:aw:sender": [now - 60_000, now - 2 * 60 * 60 * 1000] },
    }))
    const state = loadTurnState(dir, NOW, 600_000)
    expect(state.buckets.bursts.get("did:did:aw:sender")).toEqual([now - 60_000])
  })

  it("keeps an operator pause across the day change", () => {
    const dir = folder()
    writeState(dir, {
      day: YESTERDAY,
      spent: 2,
      reserved: 0,
      llmCalls: 1,
      alerted50: false,
      alerted80: false,
      paused: true,
      operatorUnpaused: false,
    }, { llm_calls: 1, injection_leak: 0, daily: {} })
    writeFileSync(join(dir, "PAUSED"), "hold\n")
    const state = loadTurnState(dir, NOW)
    expect(state.budget.paused).toBe(false)
    expect(state.budget.spent).toBe(0)
    expect(readFileSync(join(dir, "PAUSED"), "utf8").trim()).toBe("hold")
  })

  it("reloads the saved sender limit on startup and keeps it across reconnect", async () => {
    const dir = folder()
    const cfg = config(dir, {
      P2A_TOKEN: "token-sentinel",
      P2A_URL: "https://p2a.sh",
      DOCS_DIRS: dir,
      SOURCE_URLS: "",
    })
    const { fetchImpl } = recordingFetch()
    const first = new FakeAgent()
    const turn = loadTurnState(dir, NOW)
    await wireSupport(cfg, { agent: first, now: () => NOW, fetchImpl, turn })
    const opened = await first.request({
      text: "please translate this into french",
      contextId: "ctx-1",
      sender: { did: "did:aw:sender", address: "ada@example.com" },
    })
    expect(opened).toContain("I only answer questions about using p2a")
    expect(readFileSync(join(dir, "counters.json"), "utf8")).not.toContain("ada@example.com")
    expect(readFileSync(join(dir, "counters.json"), "utf8")).not.toContain("@")

    const restarted = new FakeAgent()
    await wireSupport(cfg, { agent: restarted, now: () => NOW, fetchImpl })
    const afterRestart = await restarted.request({
      text: "please translate this into french",
      contextId: "ctx-1",
      sender: { did: "did:aw:sender", address: "ada@example.com" },
    })
    expect(afterRestart).toContain("support limit")

    const reconnected = new FakeAgent()
    await wireSupport(cfg, { agent: reconnected, now: () => NOW, fetchImpl, turn })
    const afterReconnect = await reconnected.request({
      text: "how does p2a work",
      contextId: "ctx-9",
      sender: { did: "did:aw:sender" },
    })
    expect(afterReconnect).toContain("support limit")

    const controller = new AbortController()
    controller.abort()
    const booted = new FakeAgent()
    await runSupport({
      P2A_TOKEN: "token-sentinel",
      P2A_URL: "https://p2a.sh",
      LLM_API_KEY: "local-test-key",
      STATE_DIR: dir,
      SENDER_PER_DAY: "1",
      LOG_LEVEL: "error",
      DOCS_DIRS: dir,
      ESCALATION_CONTACT: "info@p2a.sh",
    }, { agent: booted, signal: controller.signal, now: () => NOW, fetchImpl })
    const fromBoot = await booted.request({
      text: "how does p2a work",
      contextId: "ctx-3",
      sender: { did: "did:aw:sender" },
    })
    expect(fromBoot).toContain("support limit")
  })

  it("keeps an in-memory owner limit when the owner key is not written to disk", async () => {
    const dir = folder()
    const cfg = config(dir, { SENDER_PER_DAY: "30", OWNER_PER_DAY: "1" })
    const state = loadTurnState(dir, NOW)
    const { fetchImpl } = recordingFetch()
    const ask = () => handleTurn({
      config: cfg,
      state,
      message: "please translate this into french",
      did: "did:aw:sender",
      owner: "ada@example.com",
      contextId: "ctx-1",
      now: NOW,
      fetchImpl,
    })
    const first = await ask()
    const second = await ask()
    expect(first.reason).toBe("off_topic")
    expect(second.reason).toBe("limited")
    const counters = readFileSync(join(dir, "counters.json"), "utf8")
    expect(counters).not.toContain("ada@example.com")
    expect(counters).not.toContain("@")
    expect(state.buckets.daily.get("owner:ada@example.com")?.count).toBe(1)
  })
})
