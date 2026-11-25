import { describe, expect, it } from "vitest"
import { ConfigError } from "../src/config.js"
import { LISTEN_BACKOFF_MS, listenWithRetry } from "../src/runtime.js"

describe("listen retry", () => {
  it("backs off after a transient failure, resets after success, and stops when aborted", async () => {
    const controller = new AbortController()
    const delays: number[] = []
    let calls = 0
    await listenWithRetry(
      async () => {
        calls += 1
        if (calls === 1 || calls === 3) throw Object.assign(new Error("unavailable"), { status: 502 })
        if (calls >= 4) controller.abort()
      },
      controller.signal,
      async (ms) => {
        delays.push(ms)
      },
      () => 1,
    )
    expect(calls).toBe(4)
    expect(delays).toEqual([LISTEN_BACKOFF_MS, LISTEN_BACKOFF_MS, LISTEN_BACKOFF_MS])
  })

  it("does not retry an auth error", async () => {
    for (const status of [401, 403]) {
      let calls = 0
      let slept = false
      await expect(
        listenWithRetry(
          async () => {
            calls += 1
            throw Object.assign(new Error("denied"), { status })
          },
          new AbortController().signal,
          async () => {
            slept = true
          },
        ),
      ).rejects.toMatchObject({ status })
      expect(calls).toBe(1)
      expect(slept).toBe(false)
    }
  })

  it("treats a clean listen return as a dropped stream", async () => {
    const controller = new AbortController()
    let calls = 0
    await listenWithRetry(
      async () => {
        calls += 1
        if (calls === 2) controller.abort()
      },
      controller.signal,
      async () => {},
    )
    expect(calls).toBe(2)
  })

  it("retries server errors, 425, and broken responses, and stops on a client error", async () => {
    const secret = "listen-secret-body"
    const logs: string[] = []
    const original = process.stdout.write
    process.stdout.write = ((chunk: string | Uint8Array) => {
      logs.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      for (const failure of [
        { status: 500 },
        { status: 425 },
        { code: "invalid_response" },
        { code: "rpc_error" },
      ]) {
        const controller = new AbortController()
        let calls = 0
        await listenWithRetry(
          async () => {
            calls += 1
            if (calls === 1) throw Object.assign(new Error(secret), failure)
            controller.abort()
          },
          controller.signal,
          async () => {},
          () => 0,
        )
        expect(calls).toBe(2)
      }
      let clientCalls = 0
      let slept = false
      await expect(listenWithRetry(
        async () => {
          clientCalls += 1
          throw Object.assign(new Error(secret), { status: 400 })
        },
        new AbortController().signal,
        async () => {
          slept = true
        },
      )).rejects.toMatchObject({ status: 400 })
      expect(clientCalls).toBe(1)
      expect(slept).toBe(false)
    } finally {
      process.stdout.write = original
    }
    const joined = logs.join("")
    expect(joined).toContain("http_500")
    expect(joined).toContain("http_425")
    expect(joined).toContain("invalid_response")
    expect(joined).toContain("rpc_error")
    expect(joined).not.toContain(secret)
  })

  it("does not retry a config error", async () => {
    let slept = false
    await expect(
      listenWithRetry(
        async () => {
          throw new ConfigError("P2A_URL is required")
        },
        new AbortController().signal,
        async () => {
          slept = true
        },
      ),
    ).rejects.toThrow(/P2A_URL/)
    expect(slept).toBe(false)
  })
})
