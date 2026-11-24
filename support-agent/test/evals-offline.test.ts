import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { caseText, loadCases, runOffline } from "../evals/run.js"

const COUNTS: Record<string, number> = {
  setup: 10,
  concept: 8,
  sdk: 6,
  offtopic: 8,
  proxy: 4,
  inject: 8,
  escalate: 5,
  private: 4,
}

describe("offline evals", () => {
  it("covers every group and passes with a stand-in model", async () => {
    const cases = loadCases()
    expect(cases.length).toBeGreaterThanOrEqual(50)
    const counts = new Map<string, number>()
    for (const item of cases) {
      expect(item.expect).toBeTruthy()
      expect(item.text.length).toBeGreaterThan(0)
      counts.set(item.group, (counts.get(item.group) ?? 0) + 1)
    }
    expect(Object.fromEntries(counts)).toEqual(COUNTS)
    const endpoints = cases.find((item) => item.id === "private-endpoints")
    expect(endpoints?.parts?.length).toBeGreaterThan(1)
    expect(caseText(endpoints!)).not.toBe(endpoints!.text)
    const raw = readFileSync(new URL("../evals/cases.jsonl", import.meta.url), "utf8")
    expect(raw.includes("/" + "internal" + "/")).toBe(false)
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
    expect(readme).not.toMatch(/\bjd\b/i)
    expect(readme.toLowerCase()).not.toContain(["inter", "bot"].join(""))
    expect(readme).not.toContain("/" + "internal" + "/")
    expect(readme).not.toContain("/" + "home" + "/")
    const started = Date.now()
    const { failures } = await runOffline(cases)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(failures).toEqual([])
  })
})