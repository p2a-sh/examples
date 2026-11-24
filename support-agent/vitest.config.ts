import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "p2a-sdk": new URL("./test/fake-sdk.ts", import.meta.url).pathname,
    },
  },
})
