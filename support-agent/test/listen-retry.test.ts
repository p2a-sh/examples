import { describe, expect, it } from "vitest"
import { ConfigError } from "../src/config.js"
import { LISTEN_BACKOFF_MS, listenWithRetry } from "../src/runtime.js"

describe("listen retry", () => {
  it("backs off after a failed connect and stops when aborted", async () => {
    const controller = new AbortController()
    const delays: number[] = []
    let calls = 0
    await listenWithRetry(
      async () => {
        calls += 1
        if (calls < 3) throw new Error("unavailable")
        controller.abort()
      },
      controller.signal,
      async (ms) => {
        delays.push(ms)
      },
    )
    expect(calls).toBe(3)
    expect(delays).toEqual([LISTEN_BACKOFF_MS, LISTEN_BACKOFF_MS * 2])
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
