/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { Step, WireContentPart, WireMessage, CacheControl } from "./types";
import { economizeHistoryHard, lastRealUserIndex, stepTokens, stepsTokens } from "./contextEconomy";

export { stepTokens, stepsTokens };

const EPHEMERAL: CacheControl = { type: "ephemeral" };

/**
 * Fit the model copy, preserving the original/current requests and the latest
 * complete tool exchange first, then other recent groups. Old assistant prose
 * and edit payloads must not displace the observation the model is answering.
 * Oversized pinned content is explicitly shortened only as a last resort.
 *
 * `overheadTokens` must cover everything that rides along outside the steps —
 * system prompt *and* tool schemas. Counting only the system prompt made this
 * "guaranteed fit" pass overshoot the real window by the schema block (10k+).
 */
export function fitStepsToBudget(steps: Step[], overheadTokens: number, budgetTokens: number): Step[] {
  const budget = Math.floor(budgetTokens - overheadTokens);
  if (budget <= 0) return [];

  const work = [...steps];
  economizeHistoryHard(work);
  const groups = groupSteps(work);
  if (stepsTokens(groups.flat()) <= budget) return groups.flat();

  const first = work.find((s) => s.kind === "user" && !s.synthetic);
  const live = work[lastRealUserIndex(work)];
  const anchors = new Set([first, live].filter((s): s is Step => !!s && s.kind === "user"));
  const pinned = groups.filter((g) => anchors.has(g[0]));
  const newestFirst = [...groups].reverse();
  const latestTools = newestFirst.find((g) => g[0].kind === "assistant" && g[0].calls.length > 0);
  const latest = latestTools || newestFirst.find((g) => !anchors.has(g[0]));
  // Reserve useful space for the latest observation even if an attached file or
  // unusually long request otherwise consumes the entire window.
  const reserve = latest ? Math.min(stepsTokens(latest), Math.floor(budget / 2)) : 0;
  const keep = new Map<Step[], Step[]>();
  let remaining = budget;
  let anchorBudget = budget - reserve;
  for (let i = pinned.length - 1; i >= 0; i--) {
    const group = pinned[i];
    const olderCost = stepsTokens(pinned.slice(0, i).flat());
    const allowance = i > 0
      ? anchorBudget - Math.min(olderCost, Math.floor(anchorBudget / 3))
      : anchorBudget;
    const fitted = shrinkGroup(group, allowance);
    if (!fitted) continue;
    keep.set(group, fitted);
    const cost = stepsTokens(fitted);
    anchorBudget -= cost;
    remaining -= cost;
  }

  if (latest) {
    const fitted = shrinkGroup(latest, remaining);
    if (fitted) {
      keep.set(latest, fitted);
      remaining -= stepsTokens(fitted);
    }
  }
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    if (keep.has(group) || anchors.has(group[0])) continue;
    const cost = stepsTokens(group);
    if (cost > remaining) continue;
    keep.set(group, group);
    remaining -= cost;
  }
  return groups.flatMap((group) => keep.get(group) || []);
}

/** Keep call/result pairs contiguous, including when a system note was interleaved. */
function groupSteps(steps: Step[]): Step[][] {
  const groups: Step[][] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind === "assistant" && s.calls?.length) {
      const ids = new Set(s.calls.map((c) => c.id));
      const results = new Map<string, Step>();
      const notes: Step[] = [];
      while (i + 1 < steps.length) {
        const next = steps[i + 1];
        if (next.kind === "user" && next.synthetic) notes.push(next);
        else if (next.kind === "tool-result" && ids.has(next.callId)) results.set(next.callId, next);
        else break;
        i++;
      }
      // Interrupted historical exchanges can contain unanswered calls. Never
      // send those calls (or unrelated results) to a provider on the next turn.
      const calls = s.calls.filter((call) => results.has(call.id));
      if (calls.length) {
        groups.push([
          calls.length === s.calls.length ? s : { ...s, calls },
          ...calls.map((call) => results.get(call.id)!),
        ]);
      } else if (s.text) {
        groups.push([{ ...s, calls: [] }]);
      }
      for (const note of notes) groups.push([note]);
    } else if (s.kind === "tool-result") {
      // Result whose call already fell outside this slice — never send it alone.
      continue;
    } else {
      groups.push([s]);
    }
  }
  return groups;
}

const OMITTED = "[omitted]";

/** Unlike display clipping, the omission marker counts toward the hard cap. */
function clipToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const available = Math.max(0, maxChars - OMITTED.length);
  const head = Math.ceil(available * 0.6);
  const tail = available - head;
  return `${text.slice(0, head)}${OMITTED}${tail ? text.slice(-tail) : ""}`;
}

/** Emergency model-copy reduction; the full transcript remains untouched. */
function shrinkGroup(group: Step[], budget: number): Step[] | undefined {
  if (stepsTokens(group) <= budget) return group;
  let omitImages = false;
  const compact = (cap: number): Step[] => group.map((s) => {
    if (s.kind === "user") {
      let text = s.text;
      const attachments = (s.attachments || []).flatMap((a) => {
        if (a.kind === "image" && omitImages) {
          text += `\n[Image attachment ${a.name} omitted to fit context]`;
          return [];
        }
        return [a.kind === "image" ? a : { ...a, data: clipToBudget(a.data, cap) }];
      });
      return { ...s, text: clipToBudget(text, cap), attachments };
    }
    if (s.kind === "assistant") {
      return {
        ...s,
        text: clipToBudget(s.text, cap),
        calls: s.calls.map((call) => ({
          ...call,
          // A signature must not be replayed with rewritten arguments.
          thoughtSignature: call.arguments.length <= cap ? call.thoughtSignature : undefined,
          // Historical calls are never replayed. Use valid JSON with an explicit
          // marker instead of slicing JSON halfway through a string escape.
          arguments: call.arguments.length <= cap
            ? call.arguments
            : JSON.stringify({ _context_omitted: clipToBudget(call.arguments, cap) }),
        })),
      };
    }
    const output = s.output + (s.image && omitImages ? "\n[Tool image omitted to fit context]" : "");
    return { ...s, output: clipToBudget(output, cap), image: omitImages ? undefined : s.image };
  });
  let best = compact(0);
  if (stepsTokens(best) > budget) {
    omitImages = true;
    best = compact(0);
  }
  if (stepsTokens(best) > budget) return undefined;
  let low = 0;
  let high = Math.max(0, budget * 4);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = compact(mid);
    if (stepsTokens(candidate) <= budget) {
      best = candidate;
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/**
 * Split history for auto-compaction: `tail` = the most recent steps that fit
 * `keepTokens`, in complete call groups. The latest group is indivisible, so it
 * may exceed the target; the request fitting pass enforces the final budget.
 * Original/current user requests are also retained in the tail even when they
 * are in the summarized prefix. This deliberate overlap preserves the actual
 * request in a long single-turn run without retaining every tool call since it.
 */
export function splitForCompaction(steps: Step[], keepTokens: number): { prefix: Step[]; tail: Step[] } {
  const groups = groupSteps(steps);
  const first = steps.find((s) => s.kind === "user" && !s.synthetic);
  const live = steps[lastRealUserIndex(steps)];
  const anchors = new Set([first, live].filter((s): s is Step => !!s && s.kind === "user"));
  const pinnedTokens = stepsTokens([...anchors]);
  // A trailing reminder must not push the observation it describes into the
  // summary while leaving only that reminder in the recent tail.
  let requiredCut = groups.length - 1;
  for (let i = groups.length - 1; i >= 0; i--) {
    if (anchors.has(groups[i][0])) break;
    const s = groups[i][0];
    if (s.kind === "assistant" && s.calls.length) { requiredCut = i; break; }
  }
  let used = 0;
  let cut = groups.length;
  for (let i = groups.length - 1; i >= 0; i--) {
    const t = anchors.has(groups[i][0]) ? 0 : stepsTokens(groups[i]);
    if (i < requiredCut && pinnedTokens + used + t > keepTokens) break;
    used += t;
    cut = i;
  }
  const prefix = groups.slice(0, cut).flat();
  const tail = [...prefix.filter((s) => anchors.has(s)), ...groups.slice(cut).flat()];
  return { prefix, tail };
}

/** Serialize steps to plain text for the summarizer (dump bodies truncated; todos/edits kept). */
export function stepsToTranscript(steps: Step[]): string {
  const out: string[] = [];
  const keepFull = new Set([
    "TodoWrite", "TodoRead", "Task", "AskQuestion", "SwitchMode", "WritePlan",
    "StrReplace", "Write", "Delete", "EditNotebook",
  ]);
  for (const s of steps) {
    if (s.kind === "user") {
      out.push(`## ${s.synthetic ? "System note" : "User"}\n${s.text}`);
    } else if (s.kind === "assistant") {
      // Prefer generated output text over thinking (thinking is UI-only anyway).
      if (s.text) out.push(`## Assistant\n${s.text}`);
      for (const c of s.calls || []) {
        const args = c.arguments || "";
        const cap = keepFull.has(c.name) ? 800 : 200;
        out.push(`## Assistant tool call: ${c.name}\n${args.slice(0, cap)}`);
      }
    } else {
      // Errors are what the agent was reacting to — never clip them to a stub.
      const cap = keepFull.has(s.name) ? 2000 : s.status === "error" ? 900 : 300;
      out.push(`## Tool result (${s.name}${s.status === "error" ? ", failed" : ""})\n${clip(s.output || "", cap)}`);
    }
  }
  return out.join("\n\n");
}

/** Keep both ends of a long value — the tail usually carries the conclusion. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil(max * 0.55);
  const tail = max - head;
  return `${s.slice(0, head)}\n…[${s.length - max} chars omitted]…\n${s.slice(-tail)}`;
}

export interface CursorContextBlocks {
  /** <user_info> + <rules> + <agent_skills> */
  userInfo: string;
  /** <open_and_recently_viewed_files> + <active_selection> */
  openFiles: string;
  /** Mode-specific reminder appended right after the live <user_query>. */
  reminder?: string;
  /**
   * Durable run record (todos, files changed, action log). Sent as the last
   * message so it is always current and never inside the cached prefix.
   */
  taskState?: string;
  /** Stable per-run timestamp. A fresh Date each step would invalidate the
   *  cached query block on every model call within the run. */
  timestamp?: string;
}

/**
 * Build provider messages with stable cacheable context blocks:
 * - system as a single cached text block
 * - the CURRENT (last) user turn is split into the cached context blocks
 *   (userInfo, openFiles) followed by a cached <timestamp>+<user_query> block,
 *   so unchanged context can be reused across model calls.
 */
export function buildMessages(system: string, steps: Step[], ctx?: CursorContextBlocks): WireMessage[] {
  const out: WireMessage[] = [
    { role: "system", content: [{ type: "text", text: system, cache_control: EPHEMERAL }] },
  ];

  // The live context blocks belong to the user's actual request — never to a
  // loop-injected system note, which would hide the request from <user_query>
  // and move the cached blocks on every nudge.
  const lastUserIdx = steps.length ? lastRealUserIndex(steps) : -1;
  // Cache breakpoint for the stable history prefix: the last user-role message
  // before the live turn (a compaction summary or system note). Assistant/tool
  // messages can't carry one through the Anthropic converter.
  let prefixAnchorIdx = -1;
  for (let i = lastUserIdx - 1; i >= 0; i--) {
    if (steps[i].kind === "user") { prefixAnchorIdx = i; break; }
  }

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind === "user") {
      const images = (s.attachments || []).filter((a) => a.kind === "image");
      const texts = (s.attachments || []).filter((a) => a.kind === "text");
      let textContent = s.text;
      for (const t of texts) {
        textContent += `\n\n<attached_file name="${t.name}">\n${t.data}\n</attached_file>`;
      }

      // System notes are tagged so the model never mistakes them for the user.
      if (s.synthetic) {
        textContent = `<system_reminder>\n${textContent}\n</system_reminder>`;
      }

      const isLive = i === lastUserIdx && !!ctx;
      const parts: WireContentPart[] = [];

      if (isLive) {
        if (ctx!.userInfo) {
          parts.push({ type: "text", text: ctx!.userInfo, cache_control: EPHEMERAL });
        }
        if (ctx!.openFiles) {
          parts.push({ type: "text", text: ctx!.openFiles, cache_control: EPHEMERAL });
        }
        parts.push({
          type: "text",
          text: `<timestamp>\n${ctx!.timestamp || new Date().toLocaleString()}\n</timestamp>\n<user_query>\n${textContent}\n</user_query>${ctx!.reminder ? `\n${ctx!.reminder}` : ""}`,
          cache_control: EPHEMERAL,
        });
        for (const img of images) {
          parts.push({ type: "image_url", image_url: { url: img.data } });
        }
        out.push({ role: "user", content: parts });
      } else if (images.length) {
        parts.push({ type: "text", text: textContent || "(see attached images)" });
        for (const img of images) {
          parts.push({ type: "image_url", image_url: { url: img.data } });
        }
        out.push({ role: "user", content: parts });
      } else if (i === prefixAnchorIdx) {
        out.push({ role: "user", content: [{ type: "text", text: textContent, cache_control: EPHEMERAL }] });
      } else {
        out.push({ role: "user", content: textContent });
      }
    } else if (s.kind === "assistant") {
      const msg: WireMessage = { role: "assistant", content: s.text || null };
      // Opaque Responses state survives UI-thinking removal and context fitting.
      // Each provider serializer decides whether the originating identity matches.
      if (s.responsesReasoning) msg.responsesReasoning = s.responsesReasoning;
      if (s.calls && s.calls.length) {
        msg.tool_calls = s.calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments || "{}" },
          ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}),
        }));
      }
      out.push(msg);
    } else {
      // Tool result. If it carries an image, send the content as an array
      // (text + image_url); provider.ts renders an Anthropic image block for
      // Anthropic and a trailing user image message for OpenAI.
      if (s.image) {
        const dataUrl = `data:${s.image.mime};base64,${s.image.base64}`;
        out.push({
          role: "tool",
          tool_call_id: s.callId,
          content: [
            { type: "text", text: s.output || "(image)" },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        });
      } else {
        out.push({ role: "tool", tool_call_id: s.callId, content: s.output });
      }
    }
  }
  // Durable state last: maximum recency, outside every cache breakpoint, and it
  // costs the same few hundred tokens however long the run has been.
  if (ctx?.taskState) {
    out.push({ role: "user", content: [{ type: "text", text: ctx.taskState }] });
  }
  return out;
}
