/** Deterministic repository outcome checks: real execution, scripted model decisions. */
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderEvent, AgentEvent, Step, ToolCall } from "./types";
import type { StreamChatOpts } from "./provider";
import type { RunAgentOptions } from "./loopTypes";

type Turn = ProviderEvent[] | ((request: StreamChatOpts) => ProviderEvent[] | Promise<ProviderEvent[]>);
const fixture = vi.hoisted(() => ({ root: "", turns: [] as Turn[], requests: [] as StreamChatOpts[], estimates: [] as { input: number; output: number }[] }));
vi.mock("./provider", () => ({ streamChat: async function* (request: StreamChatOpts) {
  fixture.requests.push(request);
  const scripted = fixture.turns.shift();
  if (!scripted) throw new Error("Evaluation exhausted scripted model decisions: unexpected continuation");
  const events = typeof scripted === "function" ? await scripted(request) : scripted;
  const input = Math.ceil(JSON.stringify({ messages: request.messages, tools: request.tools }).length / 4);
  const output = Math.ceil(JSON.stringify(events).length / 4);
  fixture.estimates.push({ input, output });
  for (const event of events) yield event;
  yield { type: "usage", promptTokens: input, completionTokens: output, cachedReadTokens: 0, cachedWriteTokens: 0, model: request.model };
} }));
vi.mock("vscode", () => ({ workspace: {
  get workspaceFolders() { return [{ uri: { fsPath: fixture.root } }]; }, textDocuments: [],
}, window: { tabGroups: { all: [] } }, languages: { getDiagnostics: () => [] }, DiagnosticSeverity: { Warning: 1, Error: 0 } }));
vi.mock("../context/cursorContext", () => ({ buildUserInfoBlock: async () => "", buildOpenFilesBlock: async () => "" }));
vi.mock("../logging", () => ({ logError: vi.fn(), logInfo: vi.fn() }));

import { runAgent } from "./loop";
import { DEFAULT_APPROVAL, evaluateApproval, type ApprovalPolicy } from "./approvalPolicy";
import { pendingChanges } from "../stores/pendingChanges";
import { mcpManager } from "../integrations/mcpClient";

let root: string;
const metrics: Record<string, unknown>[] = [];
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ocursor-eval-")); fixture.root = root;
  fixture.turns = []; fixture.requests = []; fixture.estimates = [];
  await fs.writeFile(path.join(root, "protected.txt"), "must remain unchanged\n");
});
afterEach(async () => { vi.restoreAllMocks(); pendingChanges.acceptAll(); await fs.rm(root, { recursive: true, force: true }); });
afterAll(async () => {
  if (process.env.OPENCURSOR_EVAL_REPORT) await fs.writeFile(process.env.OPENCURSOR_EVAL_REPORT, JSON.stringify({
    measurement: "Deterministic execution fixtures, not a live-model benchmark. Token counts are character estimates; cache and billed cost are unmeasured.", cases: metrics,
  }, null, 2));
});
function call(name: string, input: unknown, id = `${name}-${Math.random()}`): ToolCall { return { name, arguments: JSON.stringify(input), id }; }
function tools(...calls: ToolCall[]): ProviderEvent[] { return [...calls.map((call): ProviderEvent => ({ type: "tool-call", call })), { type: "done", finishReason: "tool_calls" }]; }
function answer(text = "Completed and verified."): ProviderEvent[] { return [{ type: "text-delta", text }, { type: "done", finishReason: "stop" }]; }
function testShell(file = "verify.cjs") { return tools(call("Shell", { command: `node ${file}`, description: "Verify repository task outcome", block_until_ms: 2000 })); }
function policy(): ApprovalPolicy {
  const result = structuredClone(DEFAULT_APPROVAL);
  for (const rule of Object.values(result)) rule.mode = "allow";
  result.edits.denylist = ["protected.txt"]; result.delete.mode = "deny"; result.outside.mode = "deny";
  return result;
}
async function evaluate(name: string, turns: Turn[], options: Partial<RunAgentOptions> = {}) {
  fixture.turns = turns;
  const events: AgentEvent[] = [], decisions: { name: string; allowed: boolean }[] = [];
  const started = performance.now();
  const history: Step[] = options.history ?? [];
  await runAgent({ apiBaseUrl: "https://fixture.invalid", apiKey: "", model: "fixture-model", mode: "agent",
    prompt: name, history, maxTokens: 1024, maxSteps: 16, enableFileReading: true, enableTerminalSuggestions: true,
    enableWorkspaceContext: false, signal: new AbortController().signal,
    approve: async (name, input) => { const allowed = evaluateApproval(policy(), name, input, root) === "allow"; decisions.push({ name, allowed }); return allowed; },
    changeOwner: { conversationId: name, turnIndex: 0 }, emit: (event) => events.push(event), ...options,
  });
  const unauthorizedChanges = (await fs.readFile(path.join(root, "protected.txt"), "utf8")) === "must remain unchanged\n" ? 0 : 1;
  const terminal = events.filter((e) => e.type === "run-status").at(-1);
  const shellResults = events.filter((e) => e.type === "tool-call-completed" && e.name === "Shell");
  const fileState: Record<string, { bytes: number; sha256: string }> = {};
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const data = await fs.readFile(path.join(root, entry.name));
    fileState[entry.name] = { bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
  }
  metrics.push({ name, outcome: terminal?.type === "run-status" ? terminal.status : "missing", turns: fixture.requests.length,
    toolCalls: events.filter((e) => e.type === "tool-call-completed").length, elapsedMs: Math.round(performance.now() - started),
    estimatedInputTokens: fixture.estimates.reduce((n, v) => n + v.input, 0), estimatedOutputTokens: fixture.estimates.reduce((n, v) => n + v.output, 0),
    cachedReadTokens: null, cachedWriteTokens: null, billedUsd: null, unauthorizedChanges, fileState,
    verificationCommands: shellResults.map((e) => e.type === "tool-call-completed" ? e.result : ""),
  });
  expect(unauthorizedChanges).toBe(0);
  expect(events.filter((e) => e.type === "error")).toEqual([]);
  return { events, history, decisions, requests: [...fixture.requests] };
}
function shellSucceeded(events: AgentEvent[]) {
  expect(events.some((e) => e.type === "tool-call-completed" && e.name === "Shell" && /exit_code=0/.test(e.result))).toBe(true);
}

describe("repository outcomes through the production agent", () => {
  it("fixes a defect across two files and passes the repository verification", async () => {
    await fs.writeFile(path.join(root, "math.cjs"), "exports.add = (a,b) => a-b;\n");
    await fs.writeFile(path.join(root, "consumer.cjs"), "exports.result = require('./math.cjs').add(2,3) + 1;\n");
    await fs.writeFile(path.join(root, "verify.cjs"), "const assert=require('node:assert/strict');assert.equal(require('./math.cjs').add(2,3),5);assert.equal(require('./consumer.cjs').result,5);\n");
    const result = await evaluate("multi-file bug fix", [
      tools(call("Read", { path: "math.cjs" }), call("Read", { path: "consumer.cjs" })),
      tools(call("StrReplace", { path: "math.cjs", old_string: "a-b", new_string: "a+b" }), call("StrReplace", { path: "consumer.cjs", old_string: ") + 1", new_string: ")" })),
      testShell(), answer(),
    ]);
    shellSucceeded(result.events); expect(result.requests).toHaveLength(4);
    expect(await fs.readFile(path.join(root, "math.cjs"), "utf8")).toContain("a+b");
  });
  it("refactors implementation and caller while preserving behavior", async () => {
    await fs.writeFile(path.join(root, "greet.cjs"), "exports.greet = name => 'Hello '+name;\n");
    await fs.writeFile(path.join(root, "app.cjs"), "exports.message = require('./greet.cjs').greet('Ada');\n");
    await fs.writeFile(path.join(root, "verify.cjs"), "require('node:assert/strict').equal(require('./app.cjs').message,'Hello Ada');\n");
    const result = await evaluate("refactor with caller update", [
      tools(call("Read", { path: "greet.cjs" }), call("Read", { path: "app.cjs" })),
      tools(call("StrReplace", { path: "greet.cjs", old_string: "exports.greet", new_string: "exports.greeting" }), call("StrReplace", { path: "app.cjs", old_string: ".greet('Ada')", new_string: ".greeting('Ada')" })),
      testShell(), answer(),
    ]);
    shellSucceeded(result.events); expect(await fs.readFile(path.join(root, "app.cjs"), "utf8")).toContain(".greeting(");
  });
  it("receives the failing test evidence, fixes it, and reruns successfully", async () => {
    await fs.writeFile(path.join(root, "value.cjs"), "exports.value=41;\n");
    await fs.writeFile(path.join(root, "verify.cjs"), "require('node:assert/strict').equal(require('./value.cjs').value,42);\n");
    const result = await evaluate("test failure diagnosis", [testShell(), (request) => {
      expect(JSON.stringify(request.messages)).toContain("exit_code=1");
      return tools(call("Read", { path: "value.cjs" }));
    }, tools(call("StrReplace", { path: "value.cjs", old_string: "41", new_string: "42" })), testShell(), answer()]);
    shellSucceeded(result.events);
    expect(result.events.filter((e) => e.type === "tool-call-completed" && e.name === "Shell")).toHaveLength(2);
  });
  it("delivers a real image-read result to the next provider request", async () => {
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1sAAAAASUVORK5CYII=", "base64");
    await fs.writeFile(path.join(root, "pixel.png"), image);
    const result = await evaluate("image inspection context", [tools(call("Read", { path: "pixel.png" })), (request) => {
      expect(JSON.stringify(request.messages)).toContain(image.toString("base64")); return answer("The image was supplied for inspection.");
    }], { mode: "ask" });
    expect(result.history.some((s) => s.kind === "tool-result" && s.image?.base64 === image.toString("base64"))).toBe(true);
  });
  it("respects a blocked edit and ends with a blocker instead of unauthorized work", async () => {
    const result = await evaluate("blocked task", [tools(call("Write", { path: "protected.txt", contents: "unauthorized" })), answer("The policy blocks this edit; the file was preserved.")]);
    expect(result.decisions).toEqual([{ name: "Write", allowed: false }]);
    expect(result.requests).toHaveLength(2); expect(pendingChanges.count()).toBe(0);
  });
  it("recovers an archived fact after a long-context handoff", async () => {
    const text = "historical detail\n".repeat(8000) + "CRITICAL_DECISION: use port 49152\n" + "later detail\n".repeat(8000);
    const history: Step[] = [{ kind: "user", text: "Remember the confirmed port." }, { kind: "assistant", text: "", calls: [call("Read", { path: "decision.txt" }, "old-read")] },
      { kind: "tool-result", callId: "old-read", name: "Read", output: text, status: "completed" }];
    const result = await evaluate("long context recovery", [(request) => {
      const serialized = JSON.stringify(request.messages);
      expect(serialized.length).toBeLessThan(text.length / 3);
      const id = serialized.match(/ctx_[a-f0-9]{64}/)?.[0]; expect(id).toBeTruthy();
      return tools(call("ReadContext", { id, pattern: "CRITICAL_DECISION" }));
    }, (request) => { expect(JSON.stringify(request.messages)).toContain("CRITICAL_DECISION: use port 49152"); return answer("Use port 49152."); }], { history, contextTokens: 32000 });
    expect(result.history.some((s) => s.kind === "tool-result" && s.output === text)).toBe(true);
  });
  it("serializes concurrent child edits so both verified changes survive", async () => {
    await fs.writeFile(path.join(root, "shared.txt"), "alpha\nbeta\n");
    await fs.writeFile(path.join(root, "verify.cjs"), "require('node:assert/strict').equal(require('fs').readFileSync('shared.txt','utf8'),'ALPHA\\nBETA\\n');\n");
    // Foreground Task calls run concurrently. Each child receives one scripted
    // edit; decisions are independent and the real shared file lock is exercised.
    const result = await evaluate("conflicting child edits", [
      tools(call("Task", { prompt: "Change alpha to ALPHA", description: "Edit first line" }), call("Task", { prompt: "Change beta to BETA", description: "Edit second line" })),
      tools(call("StrReplace", { path: "shared.txt", old_string: "alpha", new_string: "ALPHA" })),
      tools(call("StrReplace", { path: "shared.txt", old_string: "beta", new_string: "BETA" })), answer("Child finished."), answer("Child finished."), testShell(), answer(),
    ]);
    shellSucceeded(result.events); expect(await fs.readFile(path.join(root, "shared.txt"), "utf8")).toBe("ALPHA\nBETA\n");
  });
  it("cancels an approval-time interruption without executing the queued write", async () => {
    const controller = new AbortController();
    const result = await evaluate("interrupted run", [tools(call("Write", { path: "interrupted.txt", contents: "must not appear" }))], {
      signal: controller.signal, approve: async () => { controller.abort(); return true; },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(fs.stat(path.join(root, "interrupted.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.events).toContainEqual({ type: "run-status", status: "cancelled" }); expect(pendingChanges.count()).toBe(0);
  });
  it("guards MCP resource downloads with every applicable policy and the hook before writing", async () => {
    const read = vi.spyOn(mcpManager, "readResource").mockResolvedValue("resource content\n");
    const original = Buffer.from([0, 255, 128, 72]);
    const file = path.join(root, "download.bin"); await fs.writeFile(file, original);
    for (const type of ["mcp", "edits", "outside"] as const) {
      const configured = policy(); configured[type].mode = "deny";
      const destination = type === "outside" ? path.join(root, "..", `${path.basename(root)}-outside.bin`) : file;
      const result = await evaluate(`MCP download denied by ${type}`, [tools(call("FetchMcpResource", { server: "fixture", uri: "fixture://document", downloadPath: destination })), answer("Download is blocked.")], {
        approve: async (name, input) => evaluateApproval(configured, name, input, root) === "allow",
      });
      expect(result.events.some((e) => e.type === "tool-call-completed" && e.status === "error")).toBe(true);
      expect(read).not.toHaveBeenCalled(); expect(await fs.readFile(file)).toEqual(original);
      if (type === "outside") await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const hook = vi.fn(async () => "resource is blocked by the hook");
    await evaluate("MCP download hook veto", [tools(call("FetchMcpResource", { server: "fixture", uri: "fixture://document", downloadPath: file })), answer("Hook blocked the download.")], { onHook: hook });
    expect(hook).toHaveBeenCalledWith("beforeMcp", expect.objectContaining({ server: "fixture" }), "FetchMcpResource", expect.any(AbortSignal));
    expect(read).not.toHaveBeenCalled();
    const editVeto = vi.fn(async (event: string, context: Record<string, string>) => {
      if (event !== "beforeEdit") return undefined;
      expect(JSON.parse(context.tool_input)).toEqual({ file_path: "download.bin", content: "resource content\n" });
      return "content was rejected";
    });
    await evaluate("MCP content edit hook veto", [tools(call("FetchMcpResource", { server: "fixture", uri: "fixture://document", downloadPath: file })), answer("Hook preserved the file.")], { onHook: editVeto });
    expect(read).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(file)).toEqual(original);
    read.mockClear();
    const afterEdit = vi.fn();
    const allowed = await evaluate("MCP download with undo", [tools(call("FetchMcpResource", { server: "fixture", uri: "fixture://document", downloadPath: file })), answer()], { onAfterEdit: afterEdit });
    expect(read).toHaveBeenCalledTimes(1); expect(afterEdit).toHaveBeenCalledWith("download.bin");
    expect(allowed.events.some((e) => e.type === "tool-call-completed" && !!e.diff)).toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe("resource content\n");
    await pendingChanges.reject(file); expect(await fs.readFile(file)).toEqual(original);
  });
});
