/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { ModelParams } from "./types";

/** Models that take the `effort` param as a stable feature (no beta header). */
const ANTHROPIC_EFFORT_STABLE = /claude-(opus-4-[678]|opus-5|sonnet-4-6|sonnet-5|fable-5|mythos)/i;
/** Opus 4.5 needs the effort beta header + manual thinking budget. */
const ANTHROPIC_EFFORT_BETA = /claude-opus-4-5/i;
/** Models that support adaptive thinking (no budget_tokens). */
const ANTHROPIC_ADAPTIVE = /claude-(opus-4-[678]|opus-5|sonnet-4-6|sonnet-5|fable-5|mythos)/i;
/** Models that reject manual `thinking:{type:enabled,budget_tokens}` with a 400.
 * Per docs: Opus 5, Opus 4.8/4.7, Sonnet 5, Fable 5, Mythos 5 → adaptive only. */
const ANTHROPIC_NO_MANUAL = /claude-(opus-4-[78]|opus-5|sonnet-5|fable-5|mythos)/i;
/** Opus 5 rejects `thinking:{type:disabled}` when effort is xhigh/max (400). */
const ANTHROPIC_DISABLE_NEEDS_LOW_EFFORT = /claude-opus-5/i;
/** Fable 5 / Mythos 5: thinking is always on — `disabled` returns 400 at any effort. */
const ANTHROPIC_NO_DISABLE = /claude-(fable-5|mythos)/i;
/** Models where 1M context is the default (no context-1m beta header needed). */
const ANTHROPIC_NATIVE_1M = /claude-(opus-4-[678]|opus-5|sonnet-4-6|sonnet-5|fable-5|mythos)/i;

/** Whether the retired context-1m beta header is still useful for this model. */
export function needsContext1mBeta(model: string): boolean {
  return !ANTHROPIC_NATIVE_1M.test(model);
}

/**
 * Apply Anthropic thinking + effort to a request body, returning any beta flags
 * to add to the `anthropic-beta` header. Centralizes the per-model rules:
 *  - effort → `output_config.effort` (low/medium/high/xhigh/max)
 *  - 4.6+ → adaptive thinking (no budget); Opus 4.5 → manual budget + beta header
 */
export function applyAnthropicReasoning(
  body: Record<string, unknown>,
  model: string,
  maxTokens: number,
  params?: ModelParams,
): string[] {
  const betas: string[] = [];
  let mode = params?.thinking; // "disabled" | "adaptive" | "enabled" | undefined
  let effort = params?.reasoningEffort;

  // Fable/Mythos reject thinking:{disabled} entirely — coerce to adaptive.
  if (mode === "disabled" && ANTHROPIC_NO_DISABLE.test(model)) {
    mode = "adaptive";
  }

  // Opus 5 rejects thinking:{disabled} above `high` effort. Clamp rather than
  // sending a request we know will 400.
  if (mode === "disabled" && effort && ANTHROPIC_DISABLE_NEEDS_LOW_EFFORT.test(model)
    && (effort === "xhigh" || effort === "max")) {
    effort = "high";
  }

  if (effort && (ANTHROPIC_EFFORT_STABLE.test(model) || ANTHROPIC_EFFORT_BETA.test(model))) {
    body.output_config = { effort };
    if (ANTHROPIC_EFFORT_BETA.test(model)) betas.push("effort-2025-11-24");
  }

  // Thinking is on by default from Opus 5 onward, so opting out has to be explicit.
  if (mode === "disabled" && ANTHROPIC_DISABLE_NEEDS_LOW_EFFORT.test(model)) {
    body.thinking = { type: "disabled" };
  }

  if (mode && mode !== "disabled") {
    const canAdaptive = ANTHROPIC_ADAPTIVE.test(model);
    const canManual = !ANTHROPIC_NO_MANUAL.test(model);
    // Manual mode only where the API still accepts it AND the user asked for it
    // (or the model can't do adaptive, e.g. Haiku 4.5 / older Claude 4).
    const useManual = canManual && (mode === "enabled" || !canAdaptive);
    if (useManual) {
      // `thinking.enabled` requires budget_tokens; scale it by effort.
      const frac = { low: 0.15, medium: 0.3, high: 0.5, xhigh: 0.7, max: 0.85 }[effort ?? "high"] ?? 0.5;
      body.thinking = { type: "enabled", budget_tokens: Math.max(1024, Math.floor(maxTokens * frac)) };
      body.temperature = 1; // required when manual thinking is enabled
    } else {
      // Adaptive-only models (Opus 5/4.8/4.7, Sonnet 5, Fable 5, Mythos): the model
      // decides when/how much to think; effort steers depth. No budget_tokens.
      // `display` defaults to "omitted" → thinking happens but blocks come back
      // empty; ask for "summarized" so summaries stream.
      body.thinking = { type: "adaptive", display: "summarized" };
    }
  }
  return betas;
}

