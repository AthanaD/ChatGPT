/**
 * Simulates the agent loop control flow to find exactly where it breaks.
 * Tests the text-only-turn / nudge / break logic in isolation.
 */
import { describe, it, expect } from "vitest";

// ---- Simulated loop state (mirrors loop.ts) ----

interface SimState {
  step: number;
  consecutiveTextTurns: number;
  nudgeCount: number;
  todoNudged: boolean;
  finalText: string;
  broke: boolean;
  brokeAt: string;
}

const CONSECUTIVE_TEXT_LIMIT = 2;
const MAX_NUDGES = 3;

function createSimState(): SimState {
  return {
    step: 0,
    consecutiveTextTurns: 0,
    nudgeCount: 0,
    todoNudged: false,
    finalText: "",
    broke: false,
    brokeAt: "",
  };
}

interface SimTurn {
  text: string;
  tools: string[]; // tool names called
  thinking?: string;
  finishReason?: string;
}

/**
 * Simulates one iteration of the agent loop's text-only-turn handling.
 * Returns the state after processing.
 */
function simulateTurn(state: SimState, turn: SimTurn): SimState {
  state.step++;

  if (turn.tools.length === 0) {
    // --- Text-only turn (matches `if (!calls.length)`) ---
    state.consecutiveTextTurns++;

    // consecutiveTextTurns check
    if (state.consecutiveTextTurns >= CONSECUTIVE_TEXT_LIMIT) {
      state.finalText = turn.text;
      state.broke = true;
      state.brokeAt = `consecutiveTextTurns=${state.consecutiveTextTurns}`;
      return state;
    }

    const canNudge = state.nudgeCount < MAX_NUDGES;

    // Truncated response nudge
    if (canNudge && /length|max_tokens|max_output_tokens/i.test(turn.finishReason || "")) {
      state.nudgeCount++;
      // continue (loop goes to next turn)
      return state;
    }

    // Thinking-only nudge
    if (canNudge && !turn.text.trim() && (turn.thinking || "").trim()) {
      state.nudgeCount++;
      return state;
    }

    // Similarity check (simplified)
    // Empty turn after tool result nudge (simplified — skip)

    // DO NOT break on text length — let consecutiveTextTurns handle exit.
    // Breaking on any text > N chars stops the model mid-task.
  } else {
    // --- Tool call turn ---
    state.consecutiveTextTurns = 0;
  }

  return state;
}

// ==================== TESTS ====================

describe("Agent loop simulation — text-only turns", () => {
  it("breaks after 2 consecutive text-only turns", () => {
    let s = createSimState();
    s = simulateTurn(s, { text: "I'll work on that", tools: [] });
    expect(s.broke).toBe(false);
    expect(s.consecutiveTextTurns).toBe(1);

    s = simulateTurn(s, { text: "Here's the answer", tools: [] });
    expect(s.broke).toBe(true);
    expect(s.brokeAt).toContain("consecutiveTextTurns=2");
  });

  it("does NOT break when tools are called between text turns", () => {
    let s = createSimState();
    s = simulateTurn(s, { text: "Let me check", tools: [] });
    expect(s.broke).toBe(false);

    s = simulateTurn(s, { text: "", tools: ["Read"] }); // tool call resets
    expect(s.broke).toBe(false);
    expect(s.consecutiveTextTurns).toBe(0);

    s = simulateTurn(s, { text: "Now I'll edit", tools: [] });
    expect(s.broke).toBe(false);
    expect(s.consecutiveTextTurns).toBe(1);
  });

  it("does NOT break on meaningful text without tools (consecutiveTextTurns handles it)", () => {
    let s = createSimState();
    s = simulateTurn(s, {
      text: "I've completed all the tasks. Here's a summary of what was done.",
      tools: [],
    });
    expect(s.broke).toBe(false);
    expect(s.consecutiveTextTurns).toBe(1);
  });

  it("does NOT break on short text (<10 chars) without tools", () => {
    let s = createSimState();
    s = simulateTurn(s, { text: "OK", tools: [] });
    expect(s.broke).toBe(false);
    expect(s.consecutiveTextTurns).toBe(1);
  });

  it("does NOT break on empty text without tools", () => {
    let s = createSimState();
    s = simulateTurn(s, { text: "", tools: [] });
    expect(s.broke).toBe(false);
    expect(s.consecutiveTextTurns).toBe(1);
  });

  it("short text on turn 1 + tools on turn 2 = no break", () => {
    let s = createSimState();
    s = simulateTurn(s, { text: "OK", tools: [] });
    expect(s.broke).toBe(false);

    s = simulateTurn(s, { text: "", tools: ["TodoWrite", "Read"] });
    expect(s.broke).toBe(false);
    expect(s.consecutiveTextTurns).toBe(0);
  });

  it("short text on turn 1 + short text on turn 2 = breaks (consecutive limit)", () => {
    let s = createSimState();
    s = simulateTurn(s, { text: "OK", tools: [] });
    expect(s.broke).toBe(false);

    s = simulateTurn(s, { text: "Hmm", tools: [] });
    expect(s.broke).toBe(true);
    expect(s.brokeAt).toContain("consecutiveTextTurns=2");
  });
});

describe("Agent loop simulation — nudge behavior", () => {
  it("thinking-only turn triggers nudge (not break)", () => {
    let s = createSimState();
    s = simulateTurn(s, { text: "", tools: [], thinking: "Let me analyze this..." });
    expect(s.broke).toBe(false);
    expect(s.nudgeCount).toBe(1);
    expect(s.consecutiveTextTurns).toBe(1);
  });

  it("truncated response triggers nudge", () => {
    let s = createSimState();
    s = simulateTurn(s, { text: "", tools: [], finishReason: "max_tokens" });
    expect(s.broke).toBe(false);
    expect(s.nudgeCount).toBe(1);
  });

  it("nudge budget exhausted — no more nudges", () => {
    let s = createSimState();
    s.nudgeCount = MAX_NUDGES;

    s = simulateTurn(s, { text: "", tools: [], finishReason: "max_tokens" });
    expect(s.broke).toBe(false);
    expect(s.nudgeCount).toBe(MAX_NUDGES); // unchanged
  });
});

describe("Agent loop simulation — complex real-world scenarios", () => {
  it("realistic: create todos → work → text → tools → text → done", () => {
    let s = createSimState();

    // Step 1: Create todos + read file
    s = simulateTurn(s, { text: "", tools: ["TodoWrite", "Read"] });
    expect(s.broke).toBe(false);

    // Step 2: Edit file + update todo
    s = simulateTurn(s, { text: "", tools: ["StrReplace", "TodoWrite"] });
    expect(s.broke).toBe(false);

    // Step 3: Thinking only (model reasoning)
    s = simulateTurn(s, { text: "", tools: [], thinking: "The edit looks good..." });
    expect(s.broke).toBe(false);
    expect(s.nudgeCount).toBe(1);

    // Step 4: Model responds with tools
    s = simulateTurn(s, { text: "", tools: ["Read"] });
    expect(s.broke).toBe(false);

    // Step 5: Final answer (first text-only turn after tools)
    s = simulateTurn(s, { text: "Done! I've fixed the bug in all 3 files.", tools: [] });
    expect(s.broke).toBe(false); // consecutiveTextTurns=1, needs 2
    expect(s.consecutiveTextTurns).toBe(1);

    // Step 6: Second text-only turn → breaks
    s = simulateTurn(s, { text: "Let me know if you need anything else.", tools: [] });
    expect(s.broke).toBe(true);
    expect(s.brokeAt).toContain("consecutiveTextTurns=2");
  });

  it("realistic: model gets confused, produces short text, then recovers", () => {
    let s = createSimState();

    s = simulateTurn(s, { text: "", tools: ["TodoWrite", "Read"] });
    s = simulateTurn(s, { text: "OK", tools: [] }); // short text
    expect(s.broke).toBe(false);

    s = simulateTurn(s, { text: "", tools: ["Write"] }); // recovers with tool
    expect(s.broke).toBe(false);
    expect(s.consecutiveTextTurns).toBe(0);

    s = simulateTurn(s, { text: "All done.", tools: [] });
    expect(s.broke).toBe(false); // consecutiveTextTurns=1 after recovery
    expect(s.consecutiveTextTurns).toBe(1);

    // Second text-only turn → breaks
    s = simulateTurn(s, { text: "Here's what I did.", tools: [] });
    expect(s.broke).toBe(true);
    expect(s.brokeAt).toContain("consecutiveTextTurns=2");
  });

  it("realistic: many todo updates interleaved with real work", () => {
    let s = createSimState();

    for (let i = 0; i < 10; i++) {
      s = simulateTurn(s, { text: "", tools: ["TodoWrite", "Read"] });
      expect(s.broke).toBe(false);
    }
    // After 10 tool-calling steps, still running
    expect(s.step).toBe(10);
    expect(s.consecutiveTextTurns).toBe(0);

    // Final answer (first text-only turn)
    s = simulateTurn(s, { text: "Completed all 10 items.", tools: [] });
    expect(s.broke).toBe(false); // consecutiveTextTurns=1

    // Second text-only turn → breaks
    s = simulateTurn(s, { text: "All done.", tools: [] });
    expect(s.broke).toBe(true);
  });

  it("realistic: model keeps producing empty text after tools (BUG SCENARIO)", () => {
    let s = createSimState();

    // Step 1: tools
    s = simulateTurn(s, { text: "", tools: ["TodoWrite", "Read"] });
    expect(s.broke).toBe(false);

    // Step 2: empty text (model confused)
    s = simulateTurn(s, { text: "", tools: [] });
    expect(s.broke).toBe(false); // short text, don't break
    expect(s.consecutiveTextTurns).toBe(1);

    // Step 3: short text (still confused)
    s = simulateTurn(s, { text: "OK", tools: [] });
    expect(s.broke).toBe(true); // consecutiveTextTurns=2 → break
    expect(s.brokeAt).toContain("consecutiveTextTurns=2");
    // Model gets 2 text-only turns. After that, loop exits.
    // This is acceptable — 2 is the limit.
  });
});

describe("Agent loop simulation — edge cases", () => {
  it("empty text counts toward consecutive limit", () => {
    let s = createSimState();
    s = simulateTurn(s, { text: "", tools: [] });
    expect(s.consecutiveTextTurns).toBe(1);
    expect(s.broke).toBe(false);

    s = simulateTurn(s, { text: "", tools: [] });
    expect(s.broke).toBe(true);
  });

  it("10-char text does NOT break (consecutiveTextTurns handles it)", () => {
    let s = createSimState();
    s = simulateTurn(s, { text: "1234567890", tools: [] });
    expect(s.broke).toBe(false);
    expect(s.consecutiveTextTurns).toBe(1);
  });

  it("9-char text does NOT break", () => {
    let s = createSimState();
    s = simulateTurn(s, { text: "123456789", tools: [] });
    expect(s.broke).toBe(false);
  });

  it("100-char text does NOT break on first turn", () => {
    let s = createSimState();
    s = simulateTurn(s, { text: "a".repeat(100), tools: [] });
    expect(s.broke).toBe(false);
    expect(s.consecutiveTextTurns).toBe(1);

    // Second turn: breaks
    s = simulateTurn(s, { text: "b".repeat(100), tools: [] });
    expect(s.broke).toBe(true);
    expect(s.brokeAt).toContain("consecutiveTextTurns=2");
  });
});
