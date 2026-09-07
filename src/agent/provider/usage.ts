import type { ProviderEvent } from "../types";

/** Most streaming APIs report cumulative counters; emit each billed token once. */
export class UsageTracker {
  private prompt = 0;
  private completion = 0;
  private cachedRead = 0;
  update(prompt: unknown, completion: unknown, cachedRead?: unknown): Extract<ProviderEvent, { type: "usage" }> | undefined {
    const next = (value: unknown, before: number) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.max(value, before) : before;
    const p = next(prompt, this.prompt);
    const c = next(completion, this.completion);
    const r = next(cachedRead, this.cachedRead);
    if (p === this.prompt && c === this.completion && r === this.cachedRead) return undefined;
    const event = { type: "usage" as const, promptTokens: p - this.prompt, completionTokens: c - this.completion, promptTokensTotal: p, completionTokensTotal: c, ...(r > this.cachedRead ? { cachedReadTokens: r - this.cachedRead } : {}) };
    this.prompt = p;
    this.completion = c;
    this.cachedRead = r;
    return event;
  }
}
