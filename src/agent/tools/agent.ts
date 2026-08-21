/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { Mode } from "../types";
import { getWorkspaceRoot } from "../../context/workspaceUtils";
import { pendingChanges } from "../../stores/pendingChanges";
import { defineTool, type AskQuestionItem, type TodoItem } from "./types";
import {
  getSubagentRunner,
  getQuestionAsker,
  slugify,
  makeDiff,
  firstDiffLine,
} from "./shared";

// ---- TodoWrite ----
export const todoWriteTool = defineTool("TodoWrite", false, async (input, _abortSignal, _callId, ctx) => {
  try {
    if (!ctx) return { output: "error: todo context unavailable" };
    if (!Array.isArray(ctx.todos)) ctx.todos = [];

    // CRITICAL: Normalize incoming items. Models (Mimo, deepseek) send strings
    // instead of objects, or objects missing fields, or use wrong field names.
    // Accept 'todos', 'tasks', 'items', or any array field.
    const raw: any[] = Array.isArray(input?.todos) ? input.todos
      : Array.isArray(input?.tasks) ? input.tasks
      : Array.isArray(input?.items) ? input.items
      : Array.isArray(input) ? input
      : [];
    const incoming: TodoItem[] = raw.map((t, i) => {
      if (typeof t === "string") {
        return { id: `auto_${i}`, content: t, status: "pending" as const };
      }
      if (t && typeof t === "object") {
        return {
          id: t.id || `auto_${i}`,
          content: String(t.content || t.text || t.title || t.name || "unnamed"),
          status: (["pending", "in_progress", "completed", "cancelled"].includes(t.status) ? t.status : "pending") as TodoItem["status"],
        };
      }
      return null;
    }).filter((t): t is TodoItem => t !== null);

    if (incoming.length === 0 && ctx.todos.length === 0) {
      return {
        output: "ERROR: You called TodoWrite with an empty list. You MUST provide actual todo items. " +
          "Example: TodoWrite with todos=[{content: 'Task 1', status: 'pending'}]. " +
          "Do NOT call TodoWrite with an empty todos array.",
      };
    }

    if (input?.merge) {
      const byId = new Map(ctx.todos.map((t) => [t.id || `auto_${ctx.todos.indexOf(t)}`, t]));
      for (const t of incoming) {
        const key = t.id || `gen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        byId.set(key, { ...byId.get(key), ...t, id: key });
      }
      ctx.todos = [...byId.values()];
    } else if (incoming.length > 0) {
      ctx.todos = incoming;
    }

    const render = ctx.todos
      .map((t) => {
        const mark =
          t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : t.status === "cancelled" ? "[-]" : "[ ]";
        return `${mark} ${t.content || "unnamed"}`;
      })
      .join("\n");
    return { output: render || "(no todos)" };
  } catch (e) {
    return { output: `(todos: ${ctx?.todos?.length || 0} items)` };
  }
});

// ---- TodoRead ----
export const todoReadTool = defineTool("TodoRead", false, async (_input, _abortSignal, _callId, ctx) => {
  if (!ctx) return { output: "error: todo context unavailable" };
  if (!ctx.todos.length) {
    return {
      output: "(no todos) IMPORTANT: No todo list exists yet. You MUST call TodoWrite first to create a structured task list before proceeding. Do NOT just describe what you will do — create the todo list now.",
    };
  }
  return { output: ctx.todos.map((t) => `- [${t.status}] ${t.content}`).join("\n") };
});

// ---- AskQuestion (interactive wizard form in the chat UI) ----
export const askQuestionTool = defineTool("AskQuestion", false, async (input, abortSignal, callId, ctx) => {
  const asker = ctx?.askUser ?? getQuestionAsker();
  if (!asker) return { output: "error: cannot ask questions in this context" };

// Cursor shape: questions:[{id, prompt, options:[{id,label}], allow_multiple}], title.
  // Back-compat: also accept {question, options:[string], multiple} and header.
  // Structured inputs: {type: "text"|"textArea"|"number"|"date", required, placeholder}.
  const questions: AskQuestionItem[] = Array.isArray(input?.questions)
    ? input.questions
        .map((q: any) => ({
          question: String(q?.prompt ?? q?.question ?? ""),
          options: Array.isArray(q?.options)
            ? q.options.map((o: any) => (typeof o === "string" ? o : String(o?.label ?? o?.id ?? "")))
            : undefined,
          multiple: !!(q?.allow_multiple ?? q?.multiple),
          type: typeof q?.type === "string" ? (q.type as AskQuestionItem["type"]) : undefined,
          required: q?.required === true,
          placeholder: typeof q?.placeholder === "string" ? q.placeholder : undefined,
        }))
        .filter((q: AskQuestionItem) => q.question)
    : [];
  if (!questions.length) return { output: "error: no questions provided" };

  try {
    const answers = await asker(callId || "", input?.title ?? input?.header ? String(input.title ?? input.header) : undefined, questions, abortSignal);
    const lines = questions.map((q, i) => {
      const a = answers[String(i)] ?? answers[q.question] ?? [];
      return `Q${i + 1}: ${q.question}\nA: ${a.length ? a.join(", ") : "(skipped)"}`;
    });
    return { output: "The user answered:\n\n" + lines.join("\n\n") };
  } catch (e: any) {
    if (e?.name === "AbortError") return { output: "error: cancelled" };
    return { output: "error: " + String(e?.message || e) };
  }
});

// ---- Task (launch a subagent) ----
export const taskTool = defineTool("Task", false, async (input, abortSignal, callId, ctx) => {
  const runner = ctx?.runSubagent ?? getSubagentRunner();
  if (!runner) return { output: "error: subagents are not available" };
  // Read-only subagent types or an explicit readonly flag run in ask mode.
  const roTypes = new Set(["explore", "cursor-guide", "docs-researcher", "code-reviewer", "bugbot", "security-review", "ci-investigator"]);
  const subType = String(input.subagent_type || "");
  const readonly = input.readonly === true || roTypes.has(subType);
  const subName = subType || undefined;
  const fileAttachments = Array.isArray(input.file_attachments)
    ? input.file_attachments.map((f: any) => String(f))
    : undefined;
  const result = await runner(String(input.prompt || ""), readonly, subName, abortSignal, callId, {
    model: input.model ? String(input.model) : undefined,
    runInBackground: input.run_in_background === true,
    description: input.description ? String(input.description) : undefined,
    fileAttachments,
    resume: input.resume ? String(input.resume) : undefined,
    interrupt: input.interrupt === true,
  });
  return { output: result };
});

// ---- SwitchMode ----
export const switchModeTool = defineTool("SwitchMode", false, async (input, _signal, _callId, ctx) => {
  const target = String(input?.target_mode_id ?? "").trim().toLowerCase();
  const allowed = ["plan", "agent", "multitask", "project", "debug"];
  if (!allowed.includes(target)) {
    return { output: `error: target_mode_id must be one of ${allowed.map((m) => `'${m}'`).join(", ")}` };
  }
  if (!ctx?.switchMode) return { output: "error: mode switching is not available in this run" };
  return { output: ctx.switchMode(target as Mode) };
});

// ---- WritePlan (plan mode only) ----
export const writePlanTool = defineTool("WritePlan", false, async (input) => {
  const root = getWorkspaceRoot();
  const dir = path.join(root, ".plans");
  await fs.mkdir(dir, { recursive: true });
  const file = `${slugify(input.title)}.md`;
  const rel = `.plans/${file}`;
  const p = path.join(dir, file);
  const body = `# ${String(input.title || "Plan").trim()}\n\n${String(input.content || "").trim()}\n`;
  let existedBefore = false;
  let original = "";
  try {
    original = await fs.readFile(p, "utf8");
    existedBefore = true;
  } catch {}
  await fs.writeFile(p, body, "utf8");
  pendingChanges.record(rel, original, body, existedBefore);
  return {
    output: `wrote plan to ${rel}`,
    diff: makeDiff(rel, original, body),
    startLine: firstDiffLine(original, body),
  };
});
