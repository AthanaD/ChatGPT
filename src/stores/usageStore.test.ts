import { beforeEach, expect, it, vi } from "vitest";
vi.mock("vscode", () => ({}));
import { getUsage, initUsage, recordUsage, resetUsage } from "./usageStore";
beforeEach(async () => {
  const state = new Map();
  initUsage({ globalState: { get: (key: string) => structuredClone(state.get(key)), update: async (key: string, value: unknown) => {
    await new Promise(resolve => setTimeout(resolve, 1)); state.set(key, structuredClone(value));
  } } } as any);
  await resetUsage();
});
it("preserves concurrent parent/child/summary traffic and counts each streaming request once", async () => {
  await Promise.all([
    recordUsage("parent", 20, 1, { requestId: "p", cachedReadTokens: 10 }),
    recordUsage("parent", 0, 9, { requestId: "p" }),
    recordUsage("child", 5, 2, { requestId: "c", cachedWriteTokens: 3 }),
    recordUsage("parent", 7, 3, { requestId: "summary" }),
  ]);
  expect(getUsage().parent).toMatchObject({ promptTokens: 27, completionTokens: 13, requests: 2, cachedReadTokens: 10 });
  expect(getUsage().child).toMatchObject({ promptTokens: 5, completionTokens: 2, requests: 1, cachedWriteTokens: 3 });
});
