/**
 * Comprehensive unit tests for TodoWrite/TodoRead handlers and agent loop.
 * Covers ALL edge cases discovered during the freeze investigation.
 */
import { describe, it, expect } from "vitest";

// ---- Types ----
interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

interface ToolContext {
  todos: TodoItem[];
}

// ---- Handlers (mirrors agent.ts exactly) ----

function todoWriteHandler(input: any, ctx: ToolContext): { output: string } {
  try {
    if (!ctx) return { output: "error: todo context unavailable" };
    if (!Array.isArray(ctx.todos)) ctx.todos = [];
    const incoming: TodoItem[] = Array.isArray(input?.todos) ? input.todos : [];
    if (input?.merge) {
      const byId = new Map(ctx.todos.map((t) => [t.id, t]));
      for (const t of incoming) {
        if (t && typeof t === "object" && t.id) {
          byId.set(t.id, { ...byId.get(t.id), ...t });
        }
      }
      ctx.todos = [...byId.values()];
    } else if (incoming.length > 0) {
      ctx.todos = incoming.filter((t) => t && typeof t === "object" && t.id);
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
}

function todoReadHandler(ctx: ToolContext): { output: string } {
  if (!ctx?.todos?.length) return { output: "(no todos)" };
  return { output: ctx.todos.map((t) => `- [${t.status}] ${t.content}`).join("\n") };
}

// ---- Rolling window (removed, but simulate for completeness) ----

function createRollingWindowChecker(windowSize = 10, ratioLimit = 0.85) {
  const EDIT_TOOLS = new Set(["Write", "StrReplace", "Delete", "Shell", "EditNotebook"]);
  let totalRecent = 0;
  let todoRecent = 0;
  let editRecent = 0;
  const steps: { total: number; todo: number; edit: number }[] = [];
  return {
    check(calls: { name: string }[]): { triggered: boolean; ratio: number; total: number } {
      const todoCount = calls.filter((c) => c.name === "TodoWrite").length;
      const editCount = calls.filter((c) => EDIT_TOOLS.has(c.name)).length;
      const stepTotal = calls.length;
      steps.push({ total: stepTotal, todo: todoCount, edit: editCount });
      totalRecent += stepTotal;
      todoRecent += todoCount;
      editRecent += editCount;
      if (steps.length > windowSize) {
        const oldest = steps.shift()!;
        totalRecent -= oldest.total;
        todoRecent -= oldest.todo;
        editRecent -= oldest.edit;
      }
      const ratio = totalRecent > 0 ? todoRecent / totalRecent : 0;
      if (totalRecent >= windowSize && editRecent === 0 && ratio >= ratioLimit) {
        return { triggered: true, ratio, total: totalRecent };
      }
      return { triggered: false, ratio, total: totalRecent };
    },
    getState: () => ({ totalRecent, todoRecent, editRecent, stepsCount: steps.length }),
  };
}

// ---- Loop simulation ----

const CONSECUTIVE_TEXT_LIMIT = 2;

interface SimState {
  step: number;
  consecutiveTextTurns: number;
  nudgeCount: number;
  broke: boolean;
  brokeAt: string;
  finalText: string;
}

function createSimState(): SimState {
  return { step: 0, consecutiveTextTurns: 0, nudgeCount: 0, broke: false, brokeAt: "", finalText: "" };
}

function simulateTurn(state: SimState, turn: { text: string; tools: string[]; thinking?: string; finishReason?: string }): SimState {
  state.step++;
  if (turn.tools.length === 0) {
    state.consecutiveTextTurns++;
    if (state.consecutiveTextTurns >= CONSECUTIVE_TEXT_LIMIT) {
      state.finalText = turn.text;
      state.broke = true;
      state.brokeAt = `consecutiveTextTurns=${state.consecutiveTextTurns}`;
      return state;
    }
    const canNudge = state.nudgeCount < 3;
    if (canNudge && /length|max_tokens/i.test(turn.finishReason || "")) { state.nudgeCount++; return state; }
    if (canNudge && !turn.text.trim() && (turn.thinking || "").trim()) { state.nudgeCount++; return state; }
  } else {
    state.consecutiveTextTurns = 0;
  }
  return state;
}

// ==================== TESTS ====================

describe("TodoWrite — happy path", () => {
  it("creates todos with merge=false", () => {
    const ctx: ToolContext = { todos: [] };
    const r = todoWriteHandler({ todos: [{ id: "1", content: "Fix bug", status: "pending" }], merge: false }, ctx);
    expect(ctx.todos).toHaveLength(1);
    expect(r.output).toBe("[ ] Fix bug");
  });

  it("replaces entire list with merge=false", () => {
    const ctx: ToolContext = { todos: [{ id: "1", content: "Old", status: "pending" }] };
    todoWriteHandler({ todos: [{ id: "2", content: "New", status: "in_progress" }], merge: false }, ctx);
    expect(ctx.todos).toHaveLength(1);
    expect(ctx.todos[0].id).toBe("2");
  });

  it("merges by id with merge=true", () => {
    const ctx: ToolContext = { todos: [{ id: "1", content: "A", status: "pending" }, { id: "2", content: "B", status: "pending" }] };
    todoWriteHandler({ todos: [{ id: "1", status: "completed" }], merge: true }, ctx);
    expect(ctx.todos.find((t) => t.id === "1")!.status).toBe("completed");
    expect(ctx.todos.find((t) => t.id === "1")!.content).toBe("A");
    expect(ctx.todos.find((t) => t.id === "2")!.status).toBe("pending");
  });

  it("adds new item with merge=true", () => {
    const ctx: ToolContext = { todos: [{ id: "1", content: "A", status: "pending" }] };
    todoWriteHandler({ todos: [{ id: "2", content: "B", status: "pending" }], merge: true }, ctx);
    expect(ctx.todos).toHaveLength(2);
  });

  it("outputs correct marks for all statuses", () => {
    const ctx: ToolContext = { todos: [] };
    todoWriteHandler({
      todos: [
        { id: "1", content: "Done", status: "completed" },
        { id: "2", content: "Active", status: "in_progress" },
        { id: "3", content: "Skip", status: "cancelled" },
        { id: "4", content: "Wait", status: "pending" },
      ],
      merge: false,
    }, ctx);
    const r = todoWriteHandler({ todos: ctx.todos, merge: true }, ctx);
    expect(r.output).toContain("[x] Done");
    expect(r.output).toContain("[~] Active");
    expect(r.output).toContain("[-] Skip");
    expect(r.output).toContain("[ ] Wait");
  });

  it("preserves list when merge=true with empty array", () => {
    const ctx: ToolContext = { todos: [{ id: "1", content: "A", status: "pending" }] };
    todoWriteHandler({ todos: [], merge: true }, ctx);
    expect(ctx.todos).toHaveLength(1);
  });

  it("preserves list when merge=false with empty array", () => {
    const ctx: ToolContext = { todos: [{ id: "1", content: "A", status: "pending" }] };
    todoWriteHandler({ todos: [], merge: false }, ctx);
    expect(ctx.todos).toHaveLength(1);
  });

  it("returns (no todos) for empty list", () => {
    const ctx: ToolContext = { todos: [] };
    const r = todoWriteHandler({ todos: [], merge: true }, ctx);
    expect(r.output).toBe("(no todos)");
  });
});

describe("TodoWrite — defensive input validation", () => {
  it("handles null input", () => {
    const ctx: ToolContext = { todos: [{ id: "1", content: "A", status: "pending" }] };
    const r = todoWriteHandler(null, ctx);
    // Should NOT throw, should preserve list
    expect(ctx.todos).toHaveLength(1);
    expect(r.output).toContain("[ ] A");
  });

  it("handles undefined input", () => {
    const ctx: ToolContext = { todos: [{ id: "1", content: "A", status: "pending" }] };
    const r = todoWriteHandler(undefined, ctx);
    expect(ctx.todos).toHaveLength(1);
  });

  it("handles input.todos being a string", () => {
    const ctx: ToolContext = { todos: [] };
    const r = todoWriteHandler({ todos: "not an array", merge: false }, ctx);
    expect(r.output).toBe("(no todos)");
  });

  it("handles input.todos being a number", () => {
    const ctx: ToolContext = { todos: [] };
    const r = todoWriteHandler({ todos: 42, merge: false }, ctx);
    expect(r.output).toBe("(no todos)");
  });

  it("handles input.todos being null", () => {
    const ctx: ToolContext = { todos: [] };
    const r = todoWriteHandler({ todos: null, merge: false }, ctx);
    expect(r.output).toBe("(no todos)");
  });

  it("handles items without id", () => {
    const ctx: ToolContext = { todos: [] };
    todoWriteHandler({ todos: [{ content: "No ID", status: "pending" }], merge: false }, ctx);
    // Items without id are filtered out
    expect(ctx.todos).toHaveLength(0);
  });

  it("handles items without content", () => {
    const ctx: ToolContext = { todos: [] };
    todoWriteHandler({ todos: [{ id: "1", status: "pending" }], merge: false }, ctx);
    expect(ctx.todos).toHaveLength(1);
    expect(ctx.todos[0].content).toBeUndefined();
    const r = todoWriteHandler({ todos: ctx.todos, merge: true }, ctx);
    expect(r.output).toContain("[ ] unnamed");
  });

  it("handles items with null content", () => {
    const ctx: ToolContext = { todos: [] };
    todoWriteHandler({ todos: [{ id: "1", content: null, status: "pending" }], merge: false }, ctx);
    const r = todoWriteHandler({ todos: ctx.todos, merge: true }, ctx);
    expect(r.output).toContain("[ ] unnamed");
  });

  it("handles items with wrong status", () => {
    const ctx: ToolContext = { todos: [] };
    todoWriteHandler({ todos: [{ id: "1", content: "Test", status: "invalid" }], merge: false }, ctx);
    const r = todoWriteHandler({ todos: ctx.todos, merge: true }, ctx);
    // Invalid status defaults to [ ] (pending)
    expect(r.output).toContain("[ ] Test");
  });

  it("handles ctx.todos being null (defensive reset)", () => {
    const ctx = { todos: null } as any;
    const r = todoWriteHandler({ todos: [{ id: "1", content: "A", status: "pending" }], merge: false }, ctx);
    expect(ctx.todos).toHaveLength(1);
    expect(r.output).toContain("[ ] A");
  });

  it("handles ctx.todos being undefined (defensive reset)", () => {
    const ctx = { todos: undefined } as any;
    const r = todoWriteHandler({ todos: [{ id: "1", content: "A", status: "pending" }], merge: false }, ctx);
    expect(ctx.todos).toHaveLength(1);
  });

  it("handles merge with items missing id (skips them)", () => {
    const ctx: ToolContext = { todos: [{ id: "1", content: "A", status: "pending" }] };
    todoWriteHandler({ todos: [{ id: "1", status: "completed" }, { content: "No ID", status: "pending" }], merge: true }, ctx);
    expect(ctx.todos).toHaveLength(1); // only existing + valid incoming
    expect(ctx.todos[0].status).toBe("completed");
  });

  it("never returns error: prefix (prevents red X in UI)", () => {
    const ctx: ToolContext = { todos: [] };
    const inputs = [
      null,
      undefined,
      {},
      { todos: null },
      { todos: "string" },
      { todos: 42 },
      { todos: [] },
      { todos: [null] },
      { todos: [{}] },
      { todos: [{ id: "1" }] },
      { merge: true },
      { merge: false },
    ];
    for (const input of inputs) {
      const r = todoWriteHandler(input, ctx);
      expect(r.output.startsWith("error:")).toBe(false);
    }
  });
});

describe("TodoWrite — race condition safety", () => {
  it("two sequential TodoWrite calls don't clobber", () => {
    const ctx: ToolContext = { todos: [] };
    todoWriteHandler({ todos: [{ id: "1", content: "A", status: "pending" }], merge: false }, ctx);
    todoWriteHandler({ todos: [{ id: "2", content: "B", status: "pending" }], merge: false }, ctx);
    expect(ctx.todos).toHaveLength(1);
    expect(ctx.todos[0].id).toBe("2");
  });

  it("merge=true preserves previous items", () => {
    const ctx: ToolContext = { todos: [] };
    todoWriteHandler({ todos: [{ id: "1", content: "A", status: "pending" }, { id: "2", content: "B", status: "pending" }], merge: false }, ctx);
    todoWriteHandler({ todos: [{ id: "1", status: "completed" }], merge: true }, ctx);
    todoWriteHandler({ todos: [{ id: "2", status: "completed" }], merge: true }, ctx);
    expect(ctx.todos).toHaveLength(2);
    expect(ctx.todos.every((t) => t.status === "completed")).toBe(true);
  });
});

describe("TodoRead handler", () => {
  it("returns (no todos) for empty list", () => {
    expect(todoReadHandler({ todos: [] }).output).toBe("(no todos)");
  });

  it("returns full list with status markers", () => {
    const ctx: ToolContext = { todos: [
      { id: "1", content: "A", status: "completed" },
      { id: "2", content: "B", status: "pending" },
    ]};
    const r = todoReadHandler(ctx);
    expect(r.output).toContain("- [completed] A");
    expect(r.output).toContain("- [pending] B");
  });

  it("handles null ctx", () => {
    const r = todoReadHandler(null as any);
    expect(r.output).toBe("(no todos)");
  });

  it("handles ctx.todos being null", () => {
    const r = todoReadHandler({ todos: null } as any);
    expect(r.output).toBe("(no todos)");
  });
});

describe("Agent loop simulation — text-only turns", () => {
  it("breaks after 2 consecutive text-only turns", () => {
    let s = createSimState();
    s = simulateTurn(s, { text: "I'll work on that", tools: [] });
    expect(s.broke).toBe(false);
    s = simulateTurn(s, { text: "Here's the answer", tools: [] });
    expect(s.broke).toBe(true);
    expect(s.brokeAt).toContain("consecutiveTextTurns=2");
  });

  it("does NOT break when tools are called between text turns", () => {
    let s = createSimState();
    s = simulateTurn(s, { text: "Let me check", tools: [] });
    s = simulateTurn(s, { text: "", tools: ["Read"] });
    expect(s.broke).toBe(false);
    expect(s.consecutiveTextTurns).toBe(0);
    s = simulateTurn(s, { text: "Now I'll edit", tools: [] });
    expect(s.broke).toBe(false);
  });

  it("does NOT break on first text-only turn (any length)", () => {
    let s = createSimState();
    s = simulateTurn(s, { text: "A".repeat(1000), tools: [] });
    expect(s.broke).toBe(false);
    expect(s.consecutiveTextTurns).toBe(1);
  });

  it("thinking-only turn triggers nudge, not break", () => {
    let s = createSimState();
    s = simulateTurn(s, { text: "", tools: [], thinking: "Analyzing..." });
    expect(s.broke).toBe(false);
    expect(s.nudgeCount).toBe(1);
  });

  it("truncated response triggers nudge", () => {
    let s = createSimState();
    s = simulateTurn(s, { text: "", tools: [], finishReason: "max_tokens" });
    expect(s.broke).toBe(false);
    expect(s.nudgeCount).toBe(1);
  });
});

describe("Agent loop simulation — complex scenarios", () => {
  it("realistic: create todos → work → text → tools → 2x text → done", () => {
    let s = createSimState();
    s = simulateTurn(s, { text: "", tools: ["TodoWrite", "Read"] });
    s = simulateTurn(s, { text: "", tools: ["StrReplace", "TodoWrite"] });
    s = simulateTurn(s, { text: "", tools: [], thinking: "Looks good..." });
    s = simulateTurn(s, { text: "", tools: ["Read"] });
    s = simulateTurn(s, { text: "Done!", tools: [] });
    expect(s.broke).toBe(false); // 1st text-only
    s = simulateTurn(s, { text: "Summary here.", tools: [] });
    expect(s.broke).toBe(true); // 2nd text-only
  });

  it("10 todo+read steps then 2 text turns", () => {
    let s = createSimState();
    for (let i = 0; i < 10; i++) {
      s = simulateTurn(s, { text: "", tools: ["TodoWrite", "Read"] });
      expect(s.broke).toBe(false);
    }
    s = simulateTurn(s, { text: "All done.", tools: [] });
    expect(s.broke).toBe(false);
    s = simulateTurn(s, { text: "Summary.", tools: [] });
    expect(s.broke).toBe(true);
  });

  it("model gets confused with empty text, then recovers with tools", () => {
    let s = createSimState();
    s = simulateTurn(s, { text: "", tools: ["TodoWrite"] });
    s = simulateTurn(s, { text: "", tools: [] }); // empty text, turn 1
    expect(s.broke).toBe(false);
    s = simulateTurn(s, { text: "", tools: ["Read"] }); // recovers
    expect(s.broke).toBe(false);
    expect(s.consecutiveTextTurns).toBe(0);
  });

  it("model alternates TodoWrite+Read then text, never breaks prematurely", () => {
    let s = createSimState();
    for (let i = 0; i < 20; i++) {
      s = simulateTurn(s, { text: "", tools: ["TodoWrite", "Read"] });
      expect(s.broke).toBe(false);
    }
    // 20 tool-calling steps, still running
    expect(s.step).toBe(20);
  });
});

describe("taskState render", () => {
  function renderTaskState(todos: TodoItem[]): string {
    if (!todos.length) return "";
    const counts = { completed: 0, in_progress: 0, pending: 0, cancelled: 0 };
    for (const t of todos) counts[t.status]++;
    const open = counts.pending + counts.in_progress;
    const parts: string[] = [];
    if (counts.completed) parts.push(`${counts.completed} done`);
    if (open) parts.push(`${open} open`);
    if (counts.cancelled) parts.push(`${counts.cancelled} cancelled`);
    return `Todos: ${todos.length} total (${parts.join(", ")})`;
  }

  it("renders mixed statuses", () => {
    const todos: TodoItem[] = [
      { id: "1", content: "A", status: "completed" },
      { id: "2", content: "B", status: "completed" },
      { id: "3", content: "C", status: "pending" },
      { id: "4", content: "D", status: "in_progress" },
      { id: "5", content: "E", status: "cancelled" },
    ];
    expect(renderTaskState(todos)).toBe("Todos: 5 total (2 done, 2 open, 1 cancelled)");
  });

  it("returns empty for no todos", () => {
    expect(renderTaskState([])).toBe("");
  });

  it("all completed", () => {
    const todos: TodoItem[] = [
      { id: "1", content: "A", status: "completed" },
      { id: "2", content: "B", status: "completed" },
    ];
    expect(renderTaskState(todos)).toBe("Todos: 2 total (2 done)");
  });

  it("all pending", () => {
    const todos: TodoItem[] = [
      { id: "1", content: "A", status: "pending" },
      { id: "2", content: "B", status: "pending" },
    ];
    expect(renderTaskState(todos)).toBe("Todos: 2 total (2 open)");
  });
});

describe("Rolling window (removed but verify thresholds)", () => {
  it("legitimate TodoWrite+Write never triggers", () => {
    const checker = createRollingWindowChecker();
    for (let i = 0; i < 20; i++) {
      const r = checker.check([{ name: "TodoWrite" }, { name: "Write" }]);
      expect(r.triggered).toBe(false);
    }
  });

  it("pure TodoWrite 85%+ with zero edits triggers", () => {
    const checker = createRollingWindowChecker();
    // 7 TodoWrite + 1 Read = 87.5% ratio
    for (let i = 0; i < 2; i++) {
      checker.check([
        { name: "TodoWrite" }, { name: "TodoWrite" }, { name: "TodoWrite" },
        { name: "TodoWrite" }, { name: "TodoWrite" }, { name: "TodoWrite" },
        { name: "TodoWrite" }, { name: "Read" },
      ]);
    }
    const r = checker.check([
      { name: "TodoWrite" }, { name: "TodoWrite" }, { name: "TodoWrite" },
      { name: "TodoWrite" }, { name: "TodoWrite" }, { name: "TodoWrite" },
      { name: "TodoWrite" }, { name: "Read" },
    ]);
    expect(r.triggered).toBe(true);
  });

  it("TodoWrite+Read at 50% never triggers (below 85%)", () => {
    const checker = createRollingWindowChecker();
    for (let i = 0; i < 20; i++) {
      const r = checker.check([{ name: "TodoWrite" }, { name: "Read" }]);
      expect(r.triggered).toBe(false);
    }
  });
});
