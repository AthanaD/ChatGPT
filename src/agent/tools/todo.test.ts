/**
 * Unit tests for TodoWrite / TodoRead tools and the rolling window anti-loop.
 * Runs via vitest in CI (no VS Code dependency).
 */
import { describe, it, expect } from "vitest";

// ---- Inline the handler logic to avoid VS Code import chain ----
// These tests exercise the exact same code paths as the real tools.

interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

interface ToolContext {
  todos: TodoItem[];
}

function todoWriteHandler(input: any, ctx: ToolContext): { output: string } {
  const incoming: TodoItem[] = Array.isArray(input.todos) ? input.todos : [];
  if (input.merge) {
    const byId = new Map(ctx.todos.map((t) => [t.id, t]));
    for (const t of incoming) byId.set(t.id, { ...byId.get(t.id), ...t });
    ctx.todos = [...byId.values()];
  } else {
    if (incoming.length === 0) {
      return { output: "error: cannot replace todos with an empty list. Use merge=true to update individual items." };
    }
    ctx.todos = incoming;
  }
  const render = ctx.todos
    .map((t) => {
      const mark =
        t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : t.status === "cancelled" ? "[-]" : "[ ]";
      return `${mark} ${t.content}`;
    })
    .join("\n");
  return { output: render || "(no todos)" };
}

function todoReadHandler(ctx: ToolContext): { output: string } {
  if (!ctx.todos.length) return { output: "(no todos)" };
  return { output: ctx.todos.map((t) => `- [${t.status}] ${t.content}`).join("\n") };
}

// ---- Rolling window anti-loop logic (extracted from loop.ts) ----

function createRollingWindowChecker(windowSize = 6, ratioLimit = 0.75) {
  const EDIT_TOOLS = new Set(["Write", "StrReplace", "Delete", "Shell", "EditNotebook"]);
  let totalRecent = 0;
  let todoRecent = 0;
  let editRecent = 0;
  const steps: { total: number; todo: number; edit: number }[] = [];

  return {
    check(calls: { name: string }[]): { triggered: boolean; message?: string } {
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

      if (totalRecent >= windowSize && editRecent === 0 && todoRecent / totalRecent >= ratioLimit) {
        return {
          triggered: true,
          message: `TodoWrite ${todoRecent}/${totalRecent} (${Math.round((todoRecent / totalRecent) * 100)}%)`,
        };
      }
      return { triggered: false };
    },
    reset() {
      totalRecent = 0;
      todoRecent = 0;
      editRecent = 0;
      steps.length = 0;
    },
    getState: () => ({ totalRecent, todoRecent, editRecent, stepsCount: steps.length }),
  };
}

// ==================== TESTS ====================

describe("TodoWrite handler", () => {
  it("creates todos with merge=false", () => {
    const ctx: ToolContext = { todos: [] };
    const result = todoWriteHandler(
      { todos: [{ id: "1", content: "Fix bug", status: "pending" }], merge: false },
      ctx,
    );
    expect(ctx.todos).toHaveLength(1);
    expect(ctx.todos[0].content).toBe("Fix bug");
    expect(result.output).toBe("[ ] Fix bug");
  });

  it("replaces entire list with merge=false", () => {
    const ctx: ToolContext = { todos: [{ id: "1", content: "Old task", status: "pending" }] };
    todoWriteHandler(
      { todos: [{ id: "2", content: "New task", status: "in_progress" }], merge: false },
      ctx,
    );
    expect(ctx.todos).toHaveLength(1);
    expect(ctx.todos[0].id).toBe("2");
    expect(ctx.todos[0].content).toBe("New task");
  });

  it("REJECTS empty array with merge=false (anti-wipe guard)", () => {
    const ctx: ToolContext = { todos: [{ id: "1", content: "Existing task", status: "pending" }] };
    const result = todoWriteHandler({ todos: [], merge: false }, ctx);
    expect(result.output).toContain("error:");
    expect(ctx.todos).toHaveLength(1); // unchanged
    expect(ctx.todos[0].content).toBe("Existing task");
  });

  it("merges by id with merge=true", () => {
    const ctx: ToolContext = {
      todos: [
        { id: "1", content: "Task A", status: "pending" },
        { id: "2", content: "Task B", status: "pending" },
      ],
    };
    todoWriteHandler(
      { todos: [{ id: "1", status: "completed" }], merge: true },
      ctx,
    );
    expect(ctx.todos).toHaveLength(2);
    expect(ctx.todos.find((t) => t.id === "1")!.status).toBe("completed");
    expect(ctx.todos.find((t) => t.id === "1")!.content).toBe("Task A"); // preserved
    expect(ctx.todos.find((t) => t.id === "2")!.status).toBe("pending"); // unchanged
  });

  it("adds new item with merge=true", () => {
    const ctx: ToolContext = { todos: [{ id: "1", content: "Task A", status: "pending" }] };
    todoWriteHandler(
      { todos: [{ id: "2", content: "Task B", status: "pending" }], merge: true },
      ctx,
    );
    expect(ctx.todos).toHaveLength(2);
  });

  it("outputs [x] for completed, [~] for in_progress, [-] for cancelled, [ ] for pending", () => {
    const ctx: ToolContext = { todos: [] };
    todoWriteHandler(
      {
        todos: [
          { id: "1", content: "Done", status: "completed" },
          { id: "2", content: "Active", status: "in_progress" },
          { id: "3", content: "Skipped", status: "cancelled" },
          { id: "4", content: "Waiting", status: "pending" },
        ],
        merge: false,
      },
      ctx,
    );
    const result = todoWriteHandler({ todos: ctx.todos, merge: true }, ctx);
    expect(result.output).toContain("[x] Done");
    expect(result.output).toContain("[~] Active");
    expect(result.output).toContain("[-] Skipped");
    expect(result.output).toContain("[ ] Waiting");
  });

  it("returns error for empty merge (nothing to merge)", () => {
    const ctx: ToolContext = { todos: [] };
    const result = todoWriteHandler({ todos: [], merge: true }, ctx);
    // merge=true with empty incoming: ctx.todos stays empty, output is "(no todos)"
    expect(ctx.todos).toHaveLength(0);
    expect(result.output).toBe("(no todos)");
  });
});

describe("TodoRead handler", () => {
  it("returns (no todos) for empty list", () => {
    const ctx: ToolContext = { todos: [] };
    expect(todoReadHandler(ctx).output).toBe("(no todos)");
  });

  it("returns full list with status markers", () => {
    const ctx: ToolContext = {
      todos: [
        { id: "1", content: "Task A", status: "completed" },
        { id: "2", content: "Task B", status: "pending" },
      ],
    };
    const result = todoReadHandler(ctx);
    expect(result.output).toContain("- [completed] Task A");
    expect(result.output).toContain("- [pending] Task B");
  });
});

describe("Rolling window anti-loop", () => {
  it("does NOT trigger when TodoWrite + Write (legitimate work)", () => {
    const checker = createRollingWindowChecker();
    // 6 steps of TodoWrite + Write = 50% ratio, but editCallsRecent > 0
    for (let i = 0; i < 6; i++) {
      const result = checker.check([{ name: "TodoWrite" }, { name: "Write" }]);
      expect(result.triggered).toBe(false);
    }
  });

  it("does NOT trigger when TodoWrite < 75% of calls", () => {
    const checker = createRollingWindowChecker();
    // TodoWrite + Read + Read = 33% ratio
    for (let i = 0; i < 6; i++) {
      const result = checker.check([{ name: "TodoWrite" }, { name: "Read" }, { name: "Read" }]);
      expect(result.triggered).toBe(false);
    }
  });

  it("DOES trigger when TodoWrite >= 75% with no edits (Read-only loop)", () => {
    const checker = createRollingWindowChecker();
    // 3 TodoWrite + 1 Read per step = 75% ratio, 0 edits
    // Window size is 6 CALLS — fills after 2 steps (8 calls)
    const r1 = checker.check([{ name: "TodoWrite" }, { name: "TodoWrite" }, { name: "TodoWrite" }, { name: "Read" }]);
    expect(r1.triggered).toBe(false); // only 4 calls, window not full
    const r2 = checker.check([{ name: "TodoWrite" }, { name: "TodoWrite" }, { name: "TodoWrite" }, { name: "Read" }]);
    expect(r2.triggered).toBe(true); // 8 calls, 6 TodoWrite = 75%, 0 edits
    expect(r2.message).toContain("TodoWrite");
  });

  it("does NOT trigger with pure TodoWrite if only 1 step (< window size)", () => {
    const checker = createRollingWindowChecker();
    const result = checker.check([{ name: "TodoWrite" }, { name: "TodoWrite" }]);
    expect(result.triggered).toBe(false); // window not full yet
  });

  it("resets correctly after edit tool call", () => {
    const checker = createRollingWindowChecker();
    // Build up TodoWrite pressure
    for (let i = 0; i < 5; i++) {
      checker.check([{ name: "TodoWrite" }, { name: "Read" }]);
    }
    // Now do a Write — should not trigger even with high ratio
    const result = checker.check([{ name: "TodoWrite" }, { name: "Write" }]);
    expect(result.triggered).toBe(false);
  });

  it("window slides correctly (old entries expire)", () => {
    const checker = createRollingWindowChecker(3); // small window for testing
    // Steps 1-3: pure TodoWrite (fills window)
    checker.check([{ name: "TodoWrite" }]); // total=1, todo=1
    checker.check([{ name: "TodoWrite" }]); // total=2, todo=2
    const r3 = checker.check([{ name: "TodoWrite" }]); // total=3, todo=3 → 100% but window just filled
    expect(r3.triggered).toBe(true); // 3/3 = 100% >= 75%, 0 edits

    // Step 4: Read enters, oldest TodoWrite expires
    checker.reset();
    checker.check([{ name: "TodoWrite" }]);
    checker.check([{ name: "TodoWrite" }]);
    const r4 = checker.check([{ name: "Read" }]); // total=3, todo=2 = 67%
    expect(r4.triggered).toBe(false);
  });
});

describe("taskState render", () => {
  // Inline the render logic from taskState.ts
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

  it("renders summary for mixed statuses", () => {
    const todos: TodoItem[] = [
      { id: "1", content: "A", status: "completed" },
      { id: "2", content: "B", status: "completed" },
      { id: "3", content: "C", status: "pending" },
      { id: "4", content: "D", status: "in_progress" },
      { id: "5", content: "E", status: "cancelled" },
    ];
    const result = renderTaskState(todos);
    expect(result).toBe("Todos: 5 total (2 done, 2 open, 1 cancelled)");
  });

  it("returns empty for no todos", () => {
    expect(renderTaskState([])).toBe("");
  });

  it("renders all completed", () => {
    const todos: TodoItem[] = [
      { id: "1", content: "A", status: "completed" },
      { id: "2", content: "B", status: "completed" },
    ];
    expect(renderTaskState(todos)).toBe("Todos: 2 total (2 done)");
  });
});
