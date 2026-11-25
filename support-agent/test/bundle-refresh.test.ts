import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { BUNDLE_REJECT_RETRY_MS, bundleRefreshLoop, ensureBundle, refreshBundle } from "../src/bundle-refresh.js"
import type { BuildResult } from "../src/bundle.js"
import { loadConfig } from "../src/config.js"

const SECRET = "bundle-build-error-detail"

function built(version: string): BuildResult {
  return {
    bundle: {
      version,
      builderVersion: "1",
      builtAt: "2026-01-01T00:00:00.000Z",
      sources: [],
      chunks: [],
    },
    rejected: false,
    paused: false,
    alert: false,
    warnings: [],
    dropped: 0,
  }
}

describe("bundle refresh", () => {
  it("builds a missing or stale bundle, keeps the old file when the build fails, and rebuilds on the interval", async () => {
    expect(loadConfig({}).bundleRefreshHours).toBe(24)
    const dir = mkdtempSync(join(tmpdir(), "bundle-refresh-"))
    const config = loadConfig({
      STATE_DIR: dir,
      DOCS_DIRS: dir,
      SOURCE_URLS: "",
      BUNDLE_REFRESH_HOURS: "24",
      LOG_LEVEL: "info",
    })
    const lines: string[] = []
    let calls = 0
    const build = async () => {
      calls += 1
      if (calls === 3) throw new Error(`fetch failed ${SECRET}`)
      return built(calls === 1 ? "first" : "second")
    }
    const hooks = { build, writeLog: (line: string) => lines.push(line) }

    await ensureBundle(config, hooks)
    expect(calls).toBe(1)
    expect(JSON.parse(readFileSync(join(dir, "bundle.json"), "utf8")).version).toBe("first")

    await ensureBundle(config, hooks)
    expect(calls).toBe(1)

    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000)
    utimesSync(join(dir, "bundle.json"), stale, stale)
    await ensureBundle(config, hooks)
    expect(calls).toBe(2)
    expect(JSON.parse(readFileSync(join(dir, "bundle.json"), "utf8")).version).toBe("second")

    const kept = await refreshBundle(config, hooks)
    expect(kept).toBe("kept")
    expect(JSON.parse(readFileSync(join(dir, "bundle.json"), "utf8")).version).toBe("second")
    const rejected = await refreshBundle(config, {
      ...hooks,
      build: async () => ({ ...built("rejected-new"), rejected: true }),
    })
    expect(rejected).toBe("kept")
    expect(JSON.parse(readFileSync(join(dir, "bundle.json"), "utf8")).version).toBe("second")
    const logged = lines.join("\n")
    expect(logged).toContain("bundle_build_failed")
    expect(logged).toContain("bundle_kept_previous")
    expect(logged).toContain("bundle_rejected")
    expect(logged).not.toContain("bundle_rejected_no_previous")
    expect(logged).not.toContain(SECRET)
    expect(logged).not.toContain("rejected-new")

    const empty = mkdtempSync(join(tmpdir(), "bundle-empty-"))
    const emptyConfig = loadConfig({
      STATE_DIR: empty,
      DOCS_DIRS: empty,
      SOURCE_URLS: "",
      LOG_LEVEL: "info",
    })
    const emptyLines: string[] = []
    let alerted = 0
    const leaked = ["wh", "sec_", "A".repeat(16)].join("")
    const keptEmpty = await refreshBundle(emptyConfig, {
      writeLog: (line) => emptyLines.push(line),
      onRejected: async () => {
        alerted += 1
      },
      build: async () => ({
        ...built("nope"),
        bundle: null,
        rejected: true,
        paused: true,
        alert: true,
        rejectedPath: "sdk/typescript/src/wake.ts",
        warnings: [{ file: "sdk/typescript/src/wake.ts" }],
      }),
    })
    expect(keptEmpty).toBe("kept")
    expect(alerted).toBe(1)
    const emptyLog = emptyLines.join("\n")
    expect(emptyLog).toContain("bundle_rejected_no_previous")
    expect(emptyLog).toContain("sdk/typescript/src/wake.ts")
    expect(emptyLog).not.toContain(leaked)
    expect(emptyLog).not.toContain("bundle_kept_previous")

    const controller = new AbortController()
    const delays: number[] = []
    await bundleRefreshLoop(config, controller.signal, {
      sleep: async (ms) => {
        delays.push(ms)
      },
      build: async () => {
        controller.abort()
        return built("third")
      },
    })
    expect(delays).toHaveLength(1)
    expect(delays[0]).toBeGreaterThan(23 * 60 * 60 * 1000)
    expect(delays[0]).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
    expect(JSON.parse(readFileSync(join(dir, "bundle.json"), "utf8")).version).toBe("third")
  })

  it("retries a stale rejected bundle in minutes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bundle-refresh-"))
    writeFileSync(join(dir, "bundle.json"), JSON.stringify(built("old").bundle))
    const old = new Date("2020-01-01T00:00:00Z")
    utimesSync(join(dir, "bundle.json"), old, old)
    const config = loadConfig({
      STATE_DIR: dir,
      DOCS_DIRS: dir,
      SOURCE_URLS: "",
      BUNDLE_REFRESH_HOURS: "24",
      LOG_LEVEL: "error",
    })
    const controller = new AbortController()
    const delays: number[] = []
    await bundleRefreshLoop(config, controller.signal, {
      sleep: async (ms) => {
        delays.push(ms)
      },
      build: async () => {
        controller.abort()
        return { ...built("nope"), bundle: null, rejected: true, paused: true, alert: true, warnings: [] }
      },
    })
    expect(delays).toEqual([BUNDLE_REJECT_RETRY_MS])
  })
})
