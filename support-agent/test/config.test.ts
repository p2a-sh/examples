import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ConfigError, ENV_KEYS, loadConfig } from "../src/config.ts"
import { cli, COMMANDS } from "../src/main.ts"
import { leakKind } from "../src/scan.ts"

const root = new URL("..", import.meta.url)

describe("config", () => {
  it("matches .env.example and hides secret values", () => {
    const source = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8")
    expect(source.includes("process.env")).toBe(false)
    const quoted = new Set([...source.matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((match) => match[1]))
    const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8")
    const listed = new Set(
      example.split("\n").map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1]).filter((item): item is string => Boolean(item)),
    )
    expect([...ENV_KEYS].sort()).toEqual([...listed].sort())
    expect([...quoted].sort()).toEqual([...listed].sort())
    for (const line of example.split("\n")) {
      const value = line.split("=").slice(1).join("=")
      expect(leakKind(value, [])).toBeNull()
    }
  })

  it("requires a token by name and lets a file win unless it is empty", () => {
    expect(() => loadConfig({}, { requireSecrets: true })).toThrow(ConfigError)
    try {
      loadConfig({}, { requireSecrets: true })
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError)
      expect((err as Error).message).toContain("P2A_TOKEN")
      expect((err as Error).message).not.toContain("sekret")
    }
    const dir = mkdtempSync(join(tmpdir(), "support-env-"))
    const file = join(dir, "token")
    writeFileSync(file, "\n")
    expect(loadConfig({ P2A_TOKEN_FILE: file, P2A_TOKEN: "from-env" }).p2aToken).toBe("from-env")
    writeFileSync(file, "from-file\n")
    expect(loadConfig({ P2A_TOKEN_FILE: file, P2A_TOKEN: "from-env" }).p2aToken).toBe("from-file")
    const missing = join(dir, "missing-sentinel-xyz")
    try {
      loadConfig({ P2A_TOKEN_FILE: missing, P2A_TOKEN: "from-env-sentinel" })
      throw new Error("missing file was accepted")
    } catch (err) {
      expect((err as Error).message).toContain("P2A_TOKEN_FILE")
      expect((err as Error).message).not.toContain("sentinel")
      expect((err as Error).message).not.toContain("from-env")
    }
  })

  it("uses defaults and accepts the OpenCheap key alias", () => {
    const config = loadConfig({})
    expect(config.productName).toBe("p2a")
    expect(config.dailyBudgetUsd).toBe(2)
    expect(config.clarifyMaxRounds).toBe(1)
    expect(config.clarifyTtlHours).toBe(24)
    expect(loadConfig({ CLARIFY_MAX_ROUNDS: "0" }).clarifyMaxRounds).toBe(0)
    expect(loadConfig({ CLARIFY_MAX_ROUNDS: "4" }).clarifyMaxRounds).toBe(4)
    expect(loadConfig({ CLARIFY_TTL_HOURS: "1" }).clarifyTtlHours).toBe(1)
    expect(loadConfig({ CLARIFY_TTL_HOURS: "168" }).clarifyTtlHours).toBe(168)
    expect(() => loadConfig({ CLARIFY_MAX_ROUNDS: "5" })).toThrow(/CLARIFY_MAX_ROUNDS/)
    expect(() => loadConfig({ CLARIFY_MAX_ROUNDS: "2.5" })).toThrow(/CLARIFY_MAX_ROUNDS/)
    expect(() => loadConfig({ CLARIFY_TTL_HOURS: "0" })).toThrow(/CLARIFY_TTL_HOURS/)
    expect(() => loadConfig({ CLARIFY_TTL_HOURS: "169" })).toThrow(/CLARIFY_TTL_HOURS/)
    expect(config.listenMode).toBe("stream")
    expect(config.relayDids).toEqual([])
    expect(loadConfig({ P2A_LISTEN_MODE: "poll" }).listenMode).toBe("poll")
    expect(loadConfig({ RELAY_DIDS: "did:example:gateway, did:example:other" }).relayDids).toEqual([
      "did:example:gateway",
      "did:example:other",
    ])
    expect(() => loadConfig({ P2A_LISTEN_MODE: "nope" })).toThrow(/P2A_LISTEN_MODE/)
    expect(config.llmBaseUrl).toBe("https://api.opencheap.si/v1")
    expect(config.llmModel).toBe("deepseek-v4-pro")
    expect(loadConfig({ LLM_BASE_URL: "https://api.example.test/v1", LLM_MODEL: "other-model" }).llmBaseUrl).toBe("https://api.example.test/v1")
    expect(loadConfig({ LLM_BASE_URL: "https://api.example.test/v1", LLM_MODEL: "other-model" }).llmModel).toBe("other-model")
    expect(loadConfig({ OPENCHEAP_API_KEY: "alias-key" }).llmApiKey).toBe("alias-key")
    expect(() => loadConfig({ DAILY_BUDGET_USD: "nope" })).toThrow(/DAILY_BUDGET_USD/)
    expect(() => loadConfig({ LLM_TIMEOUT_MS: "0" })).toThrow(/LLM_TIMEOUT_MS/)
    expect(loadConfig({ LLM_TIMEOUT_MS: "1000" }).llmTimeoutMs).toBe(1000)
  })
})

describe("cli", () => {
  it("names the commands in the readme and exits before secrets on a dry run", async () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
    const commands = [...readme.matchAll(/node dist\/main\.js ([a-z0-9-]+)/g)].map((match) => match[1])
    expect(commands).toEqual(expect.arrayContaining(["build-bundle", "run"]))
    for (const command of commands) expect(COMMANDS).toContain(command)
    expect(await cli(["run"], { DRY_RUN: "1" })).toBe(0)
    const lines: string[] = []
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      expect(await cli(["run"], {})).toBe(1)
    } finally {
      process.stderr.write = write
    }
    expect(lines.join("")).toContain("P2A_TOKEN")
    expect(root.pathname.endsWith("/")).toBe(true)
  })
})
