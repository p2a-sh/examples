import { describe, expect, it } from "vitest"
import { leakKind } from "../src/scan.js"

function joined(parts: string[]): string {
  return parts.join("")
}

describe("secret scan", () => {
  it("ignores a bare prefix and still matches a real secret body", () => {
    const wh = joined(["wh", "sec_"])
    const gh = joined(["gh", "p_"])
    const begin = joined(["-----", "BEGIN"])
    const xox = joined(["xox", "b-"])
    expect(leakKind(wh, [])).toBeNull()
    expect(leakKind(gh, [])).toBeNull()
    expect(leakKind(begin, [])).toBeNull()
    expect(leakKind(xox, [])).toBeNull()
    expect(leakKind(wh + "A".repeat(16), [])).toBe("secret")
    expect(leakKind(gh + "a".repeat(20), [])).toBe("secret")
    expect(leakKind(`${begin} PRIVATE KEY-----`, [])).toBe("secret")
    expect(leakKind(`${begin} RSA PRIVATE KEY-----`, [])).toBe("secret")
    expect(leakKind(xox + "1".repeat(10), [])).toBe("secret")
  })
})
