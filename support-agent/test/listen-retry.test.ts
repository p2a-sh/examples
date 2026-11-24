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
