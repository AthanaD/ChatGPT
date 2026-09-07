import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "webview-ui/**/*.test.tsx"],
    exclude: ["src/test/**"],
    globals: true,
    environment: "node",
  },
});
