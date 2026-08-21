/**
 * INTEGRATION TESTS — simulates the COMPLETE flow from model input to UI render.
 * Tests what deepseek-v4-flash ACTUALLY sends, not what we expect.
 */
import { describe, it, expect } from "vitest";

// ---- Types ----
interface TodoItem { id: string; content: string; status: "pending" | "in_progress" | "completed" | "cancelled"; }
interface ToolContext { todos: TodoItem[]; }

// ---- Handler (exact copy from agent.ts) ----
function todoWriteHandler(input: any, ctx: ToolContext): { output: string } {
  try {
    if (!ctx) return { output: "error: todo context unavailable" };
    if (!Array.isArray(ctx.todos)) ctx.todos = [];

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
    }).filter(Boolean) as TodoItem[];

    if (incoming.length === 0 && ctx.todos.length === 0) {
      return {
        output: "ERROR: You called TodoWrite with an empty list.",
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
        const mark = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : t.status === "cancelled" ? "[-]" : "[ ]";
        return `${mark} ${t.content || "unnamed"}`;
      })
      .join("\n");
    return { output: render || "(no todos)" };
  } catch (e) {
    return { output: `(todos: ${ctx?.todos?.length || 0} items)` };
  }
}

// ---- UI parser (exact copy from Tool.tsx) ----
function parseTodos(output: string): { status: string; content: string }[] {
  const items: { status: string; content: string }[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    let m = line.match(/^\[(x| |~|-)\]\s+(.*)$/);
    if (m) {
      const map: Record<string, string> = { x: "completed", " ": "pending", "~": "in_progress", "-": "cancelled" };
      items.push({ status: map[m[1]] || "pending", content: m[2] });
      continue;
    }
    m = line.match(/^-\s*\[(\w+)\]\s+(.*)$/);
    if (m) {
      items.push({ status: m[1], content: m[2] });
    }
  }
  return items;
}

// ---- Full integration: handler → parseTodos → UI ----
function simulateFullFlow(input: any): { handlerOutput: string; uiItems: { status: string; content: string }[]; ctx: ToolContext } {
  const ctx: ToolContext = { todos: [] };
  const result = todoWriteHandler(input, ctx);
  const uiItems = parseTodos(result.output);
  return { handlerOutput: result.output, uiItems, ctx };
}

// ==================== TESTS ====================

describe("INTEGRATION: deepseek-v4-flash actual inputs", () => {
  it("deepseek sends todos: [] (empty array) → error, not (no todos)", () => {
    const { handlerOutput, uiItems } = simulateFullFlow({ todos: [], merge: false });
    expect(handlerOutput).toContain("ERROR");
    expect(uiItems.length).toBe(0);
  });

  it("deepseek sends todos: ['task1', 'task2'] (strings) → renders correctly", () => {
    const { handlerOutput, uiItems, ctx } = simulateFullFlow({ todos: ["Explore codebase", "Analyze issues", "Write proposal"], merge: false });
    expect(ctx.todos.length).toBe(3);
    expect(handlerOutput).toContain("[ ] Explore codebase");
    expect(handlerOutput).toContain("[ ] Analyze issues");
    expect(handlerOutput).toContain("[ ] Write proposal");
    expect(uiItems.length).toBe(3);
    expect(uiItems[0].content).toBe("Explore codebase");
  });

  it("deepseek sends tasks: ['a', 'b'] (wrong field name) → works", () => {
    const { handlerOutput, ctx } = simulateFullFlow({ tasks: ["Task A", "Task B"], merge: false });
    expect(ctx.todos.length).toBe(2);
    expect(handlerOutput).toContain("[ ] Task A");
  });

  it("deepseek sends items: ['x'] (wrong field name) → works", () => {
    const { ctx } = simulateFullFlow({ items: ["Item X"], merge: false });
    expect(ctx.todos.length).toBe(1);
  });

  it("deepseek sends bare array (no field name) → works", () => {
    const { ctx } = simulateFullFlow(["Task A", "Task B"]);
    expect(ctx.todos.length).toBe(2);
  });

  it("deepseek sends merge: 'true' (string instead of boolean) → merge mode", () => {
    const ctx: ToolContext = { todos: [{ id: "1", content: "Existing", status: "pending" }] };
    const r = todoWriteHandler({ todos: [{ content: "New task", status: "in_progress" }], merge: "true" }, ctx);
    expect(ctx.todos.length).toBe(2);
  });

  it("deepseek sends merge: 1 (number) → merge mode", () => {
    const ctx: ToolContext = { todos: [{ id: "1", content: "Existing", status: "pending" }] };
    const r = todoWriteHandler({ todos: [{ content: "New task", status: "pending" }], merge: 1 }, ctx);
    expect(ctx.todos.length).toBe(2);
  });
});

describe("INTEGRATION: malformed inputs that cause (no todos)", () => {
  it("input is null → error", () => {
    const { handlerOutput } = simulateFullFlow(null);
    expect(handlerOutput).toContain("ERROR");
  });

  it("input is undefined → error", () => {
    const { handlerOutput } = simulateFullFlow(undefined);
    expect(handlerOutput).toContain("ERROR");
  });

  it("input is empty object → error", () => {
    const { handlerOutput } = simulateFullFlow({});
    expect(handlerOutput).toContain("ERROR");
  });

  it("input.todos is null → error", () => {
    const { handlerOutput } = simulateFullFlow({ todos: null, merge: false });
    expect(handlerOutput).toContain("ERROR");
  });

  it("input.todos is string → error (not array)", () => {
    const { handlerOutput } = simulateFullFlow({ todos: "not an array", merge: false });
    expect(handlerOutput).toContain("ERROR");
  });

  it("input.todos is number → error (not array)", () => {
    const { handlerOutput } = simulateFullFlow({ todos: 42, merge: false });
    expect(handlerOutput).toContain("ERROR");
  });

  it("input.todos is boolean → error (not array)", () => {
    const { handlerOutput } = simulateFullFlow({ todos: true, merge: false });
    expect(handlerOutput).toContain("ERROR");
  });

  it("input.todos is object (not array) → error", () => {
    const { handlerOutput } = simulateFullFlow({ todos: { task: "A" }, merge: false });
    expect(handlerOutput).toContain("ERROR");
  });

  it("input has no todos/tasks/items fields → error", () => {
    const { handlerOutput } = simulateFullFlow({ merge: false, other: "data" });
    expect(handlerOutput).toContain("ERROR");
  });
});

describe("INTEGRATION: mixed valid/invalid items", () => {
  it("array with null + strings → strings survive, nulls filtered", () => {
    const { ctx } = simulateFullFlow({ todos: [null, "Task A", undefined, "Task B"], merge: false });
    expect(ctx.todos.length).toBe(2);
    expect(ctx.todos[0].content).toBe("Task A");
  });

  it("array with objects missing content → fills 'unnamed'", () => {
    const { ctx } = simulateFullFlow({ todos: [{ id: "1", status: "pending" }], merge: false });
    expect(ctx.todos.length).toBe(1);
    expect(ctx.todos[0].content).toBe("unnamed");
  });

  it("array with objects missing status → defaults to 'pending'", () => {
    const { ctx } = simulateFullFlow({ todos: [{ id: "1", content: "Task" }], merge: false });
    expect(ctx.todos[0].status).toBe("pending");
  });

  it("array with objects missing id → auto-generates id", () => {
    const { ctx } = simulateFullFlow({ todos: [{ content: "Task", status: "pending" }], merge: false });
    expect(ctx.todos[0].id).toMatch(/^auto_/);
  });

  it("array with invalid status → defaults to 'pending'", () => {
    const { ctx } = simulateFullFlow({ todos: [{ content: "Task", status: "invalid" }], merge: false });
    expect(ctx.todos[0].status).toBe("pending");
  });

  it("array with all nulls → error (nothing survives filter)", () => {
    const { handlerOutput } = simulateFullFlow({ todos: [null, null, null], merge: false });
    expect(handlerOutput).toContain("ERROR");
  });
});

describe("INTEGRATION: parseTodos matches handler output", () => {
  it("handler output '[ ] Task' → parseTodos returns 1 item", () => {
    const { handlerOutput, uiItems } = simulateFullFlow({ todos: ["Task"], merge: false });
    expect(uiItems.length).toBe(1);
    expect(uiItems[0].status).toBe("pending");
    expect(uiItems[0].content).toBe("Task");
  });

  it("handler output '[x] Done' → parseTodos returns completed", () => {
    const { handlerOutput, uiItems } = simulateFullFlow({ todos: [{ content: "Done", status: "completed" }], merge: false });
    expect(uiItems.length).toBe(1);
    expect(uiItems[0].status).toBe("completed");
  });

  it("handler output '[~] Active' → parseTodos returns in_progress", () => {
    const { handlerOutput, uiItems } = simulateFullFlow({ todos: [{ content: "Active", status: "in_progress" }], merge: false });
    expect(uiItems.length).toBe(1);
    expect(uiItems[0].status).toBe("in_progress");
  });

  it("handler output '[-] Skip' → parseTodos returns cancelled", () => {
    const { handlerOutput, uiItems } = simulateFullFlow({ todos: [{ content: "Skip", status: "cancelled" }], merge: false });
    expect(uiItems.length).toBe(1);
    expect(uiItems[0].status).toBe("cancelled");
  });

  it("handler output '(no todos)' → parseTodos returns empty (shows fallback)", () => {
    const uiItems = parseTodos("(no todos)");
    expect(uiItems.length).toBe(0);
  });

  it("handler output 'ERROR: ...' → parseTodos returns empty (shows fallback)", () => {
    const uiItems = parseTodos("ERROR: You called TodoWrite with an empty list.");
    expect(uiItems.length).toBe(0);
  });
});

describe("INTEGRATION: realistic deepseek multi-step flow", () => {
  it("create → mark progress → complete → final", () => {
    const ctx: ToolContext = { todos: [] };

    // Step 1: Create 3 todos (deepseek style — strings)
    const r1 = todoWriteHandler({ todos: ["Explore codebase", "Analyze issues", "Write proposal"], merge: false }, ctx);
    expect(ctx.todos.length).toBe(3);
    expect(parseTodos(r1.output).length).toBe(3);

    // Step 2: Mark first as in_progress (merge)
    const r2 = todoWriteHandler({ todos: [{ content: "Explore codebase", status: "in_progress" }], merge: true }, ctx);
    expect(ctx.todos.length).toBe(3);
    const items2 = parseTodos(r2.output);
    expect(items2.find((i) => i.content === "Explore codebase")?.status).toBe("in_progress");

    // Step 3: Mark first as completed (merge)
    const r3 = todoWriteHandler({ todos: [{ content: "Explore codebase", status: "completed" }], merge: true }, ctx);
    expect(ctx.todos.length).toBe(3);
    const items3 = parseTodos(r3.output);
    expect(items3.find((i) => i.content === "Explore codebase")?.status).toBe("completed");
    expect(items3.filter((i) => i.status === "pending").length).toBe(2);

    // Step 4: All done
    const r4 = todoWriteHandler({ todos: [
      { content: "Explore codebase", status: "completed" },
      { content: "Analyze issues", status: "completed" },
      { content: "Write proposal", status: "completed" },
    ], merge: true }, ctx);
    expect(ctx.todos.every((t) => t.status === "completed")).toBe(true);
  });
});
