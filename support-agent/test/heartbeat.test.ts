import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { healthFresh, startHeartbeat } from "../src/health.js"

describe("health heartbeat", () => {
  afterEach(() => vi.useRealTimers())

  it("refreshes health.json on an interval and stops when cleared", () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), "hb-"))
    try {
      const stop = startHeartbeat(dir, () => new Date(), 30_000)
      expect(existsSync(join(dir, "health.json"))).toBe(false)
      vi.advanceTimersByTime(30_000)
      expect(healthFresh(dir)).toBe(true)
      stop()
      rmSync(join(dir, "health.json"))
      vi.advanceTimersByTime(90_000)
      expect(existsSync(join(dir, "health.json"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not refresh health while a listen retry is unresolved", () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), "hb-"))
    try {
      const gate = { quietUntil: Date.now() + 90_000 }
      const stop = startHeartbeat(dir, () => new Date(), 30_000, gate)
      vi.advanceTimersByTime(30_000)
      expect(existsSync(join(dir, "health.json"))).toBe(false)
      gate.quietUntil = 0
      vi.advanceTimersByTime(30_000)
      expect(healthFresh(dir)).toBe(true)
      stop()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
