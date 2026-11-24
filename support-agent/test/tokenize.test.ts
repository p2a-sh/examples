import { describe, expect, it } from "vitest"
import { tokenize } from "../src/bm25.js"

describe("tokenize", () => {
  it("indexes tool names whole and by part", () => {
    expect(tokenize("call p2a_check_new")).toEqual(["call", "p2a_check_new", "p2a", "check", "new"])
  })

  it("keeps agent addresses whole", () => {
    expect(tokenize("support@p2a")).toEqual(["support@p2a"])
  })
})
