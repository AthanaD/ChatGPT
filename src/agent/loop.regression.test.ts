/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamChatOpts } from "./provider";
import type { RunAgentOptions } from "./loopTypes";
import type { AgentEvent, ProviderEvent, Step, ToolCall, WireMessage } from "./types";
import type { Tool } from "./tools/types";

// Keep the production loop, mode registry, todo handlers, ledger, message builder,
// and budget fitting. Replace only the provider and tools with external effects.
const fixture = vi.hoisted(() => {
	const executions: { name: string; input: unknown }[] = [];
	const tool = (name: string, mutating = false): Tool => ({
		mutating,
		schema: { type: "function", function: { name, description: name, parameters: { type: "object" } } },
		execute: async (input) => {
			executions.push({ name, input });
			return { output: name === "Read" ? "file contents" : "ok" };
		},
	});
	return {
		tool,
		executions,
		requests: [] as StreamChatOpts[],
		turns: [] as ProviderEvent[][],
		approve: vi.fn(async (_name: string, _input: unknown, _callId?: string) => true),
		callMcp: vi.fn(async () => "MCP completed"),
	};
});

vi.mock("./provider", () => ({
	streamChat: async function* (options: StreamChatOpts) {
		const turn = fixture.turns[fixture.requests.length];
		fixture.requests.push(options);
		if (!turn) throw new Error("Unexpected model continuation after the scripted final answer");
		for (const event of turn) yield event;
	},
}));
vi.mock("./tools/files", () => ({
	readFileTool: fixture.tool("Read"), listDirTool: fixture.tool("ListDir"),
	globTool: fixture.tool("Glob"), fileSearchTool: fixture.tool("FileSearch"),
	readLintsTool: fixture.tool("ReadLints"), strReplaceTool: fixture.tool("StrReplace", true),
	writeTool: fixture.tool("Write", true), deleteFileTool: fixture.tool("Delete", true),
	editNotebookTool: fixture.tool("EditNotebook", true),
}));
vi.mock("./tools/search", () => ({
	grepTool: fixture.tool("Grep"), semanticSearchTool: fixture.tool("SemanticSearch"),
	searchDocsTool: fixture.tool("SearchDocs"),
}));
vi.mock("./tools/shell", () => ({ runTerminalTool: fixture.tool("Shell", true), awaitShellTool: fixture.tool("AwaitShell") }));
vi.mock("./tools/web", () => ({ webSearchTool: fixture.tool("WebSearch"), webFetchTool: fixture.tool("WebFetch") }));
vi.mock("./tools/mcp", () => ({
	callMcpToolTool: fixture.tool("CallMcpTool", true), fetchMcpResourceTool: fixture.tool("FetchMcpResource", true),
	listMcpResourcesTool: fixture.tool("ListMcpResources"),
}));
vi.mock("./tools/shared", () => ({
	disposeShellSession: vi.fn(), toolTimeoutMs: () => 0,
	withToolTimeout: <T>(promise: Promise<T>) => promise,
	setSubagentRunner: vi.fn(), setQuestionAsker: vi.fn(), setToolTimeoutOverrides: vi.fn(),
	DEFAULT_TOOL_TIMEOUTS_SEC: {}, getSubagentRunner: vi.fn(), getQuestionAsker: vi.fn(),
	slugify: vi.fn(), makeDiff: vi.fn(), firstDiffLine: vi.fn(),
}));
vi.mock("../stores/pendingChanges", () => ({ pendingChanges: {} }));
vi.mock("../context/workspaceUtils", () => ({
	getWorkspaceRoot: () => "/workspace",
	normalizeToolPaths: (_name: string, input: unknown) => input,
}));
vi.mock("../context/cursorContext", () => ({
	buildUserInfoBlock: async () => "", buildOpenFilesBlock: async () => "",
}));
vi.mock("./approvalPolicy", () => ({
	actionTypeForCall: (name: string) => ["Write", "Shell", "WritePlan"].includes(name) ? "edits" : undefined,
}));
vi.mock("./prompt", () => ({ systemPrompt: () => "You are a coding assistant." }));
vi.mock("../integrations/mcpClient", () => ({
	mcpManager: {
		listTools: () => [{ qualifiedName: "mcp__test__write", server: "test", tool: { name: "write", inputSchema: {} } }],
		callTool: fixture.callMcp,
	},
}));
vi.mock("../logging", () => ({ logError: vi.fn() }));

import { runAgent } from "./loop";
import { writePlanTool } from "./tools/agent";

function call(name: string, input: unknown, id: string): ToolCall {
	return { name, arguments: JSON.stringify(input), id };
}

function toolTurn(...calls: ToolCall[]): ProviderEvent[] {
	return [...calls.map((call): ProviderEvent => ({ type: "tool-call", call })), { type: "done", finishReason: "tool_calls" }];
}

function answer(text: string, finishReason = "stop"): ProviderEvent[] {
	return [{ type: "text-delta", text }, { type: "done", finishReason }];
}

async function run(turns: ProviderEvent[][], options: Partial<RunAgentOptions> = {}) {
	fixture.turns.push(...turns);
	const history: Step[] = [];
	const events: AgentEvent[] = [];
	await runAgent({
		apiBaseUrl: "https://provider.invalid", apiKey: "", model: "test-model",
		mode: "agent", prompt: "Complete the requested task", history,
		maxSteps: 12, enableFileReading: true, enableTerminalSuggestions: true,
		enableWorkspaceContext: false, approve: fixture.approve,
		signal: new AbortController().signal, emit: (event) => events.push(event),
		...options,
	});
	return { history, events };
}

function expectFinished(events: AgentEvent[], text: string, requests: number) {
	expect(events.filter((event) => event.type === "error")).toEqual([]);
	expect(events).toContainEqual({ type: "run-status", status: "finished" });
	expect(events).toContainEqual(expect.objectContaining({ type: "run-result", text }));
	expect(fixture.requests).toHaveLength(requests);
}

function expectCompleteToolGroups(messages: WireMessage[]) {
	const pending = new Set<string>();
	for (const message of messages) {
		if (message.role === "tool") {
			expect(pending.has(message.tool_call_id), "tool result has a matching call").toBe(true);
			pending.delete(message.tool_call_id);
		} else {
			expect([...pending], "all tool results precede the next non-tool message").toEqual([]);
			if (message.role === "assistant") {
				for (const toolCall of message.tool_calls ?? []) pending.add(toolCall.id);
			}
		}
	}
	expect([...pending], "every tool call is answered").toEqual([]);
}

beforeEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	fixture.requests.length = 0;
	fixture.turns.length = 0;
	fixture.executions.length = 0;
	vi.spyOn(writePlanTool, "execute").mockImplementation(async (input) => {
		fixture.executions.push({ name: "WritePlan", input });
		return { output: "Plan saved to .plans/test.md" };
	});
});

describe("runAgent PR 170 regressions", () => {
	it("allows reading a file again after editing it", async () => {
		const { history, events } = await run([
			toolTurn(call("Read", { path: "a.ts" }, "read-before")),
			toolTurn(call("Write", { path: "a.ts", contents: "fixed" }, "write")),
			toolTurn(call("Read", { path: "a.ts" }, "read-after")),
			answer("Fixed and verified."),
		]);
		expect(fixture.executions.map((item) => item.name)).toEqual(["Read", "Write", "Read"]);
		expect(history.filter((step) => step.kind === "tool-result").map((step) => step.callId)).toEqual(["read-before", "write", "read-after"]);
		expectFinished(events, "Fixed and verified.", 4);
	});

	it("executes todo updates whose serialized arguments differ after character 200", async () => {
		const first = { id: "first", content: "A completed task with a detailed description. ".repeat(8), status: "completed" };
		const pending = call("TodoWrite", { todos: [first, { id: "second", content: "Remaining work", status: "pending" }] }, "pending");
		const completed = call("TodoWrite", { todos: [first, { id: "second", content: "Remaining work", status: "completed" }] }, "completed");
		expect(pending.arguments.slice(0, 200)).toBe(completed.arguments.slice(0, 200));
		const { history, events } = await run([toolTurn(pending), toolTurn(completed), answer("Both tasks completed.")]);
		expect(history).toContainEqual(expect.objectContaining({ kind: "tool-result", callId: "completed", output: expect.stringContaining("[x] Remaining work") }));
		expectFinished(events, "Both tasks completed.", 3);
	});

	it.each([undefined, 100_000])("keeps empty TodoRead reminders after every batch result (contextTokens=%s)", async (contextTokens) => {
		const { history, events } = await run([
			toolTurn(call("Read", { path: "a.ts" }, "read"), call("TodoRead", {}, "todos"), call("Grep", { pattern: "name" }, "grep")),
			answer("No tasks have been recorded."),
		], { contextTokens });
		const batchIndex = history.findIndex((step) => step.kind === "assistant" && step.calls.length === 3);
		expect(history.slice(batchIndex + 1, batchIndex + 4).map((step) => step.kind === "tool-result" ? step.callId : step.kind)).toEqual(["read", "todos", "grep"]);
		expect(history[batchIndex + 4]).toMatchObject({ kind: "user", synthetic: true, text: expect.stringContaining("TodoRead") });
		const nextMessages = fixture.requests[1].messages;
		expect(nextMessages.filter((message) => message.role === "tool").map((message) => message.tool_call_id)).toEqual(["read", "todos", "grep"]);
		expectCompleteToolGroups(nextMessages);
		expectFinished(events, "No tasks have been recorded.", 2);
	});

	it.each(["Write", "Shell", "mcp__test__write"])("rejects %s in Plan even when approval would permit it", async (name) => {
		const { history, events } = await run([
			toolTurn(call(name, { path: "a.ts", contents: "unplanned", command: "touch a.ts" }, "forbidden")),
			toolTurn(call("WritePlan", { title: "Plan", plan: "Inspect the implementation." }, "plan")),
			answer("The plan is saved."),
		], { mode: "plan" });
		expect(history).toContainEqual(expect.objectContaining({ kind: "tool-result", callId: "forbidden", status: "error", output: expect.stringContaining("not allowed in plan mode") }));
		expect(fixture.executions.some((item) => item.name === name)).toBe(false);
		expect(fixture.callMcp).not.toHaveBeenCalled();
		expect(fixture.approve.mock.calls.every(([toolName]) => toolName !== name)).toBe(true);
		expect(fixture.requests[0].tools?.map((tool) => tool.function.name)).not.toContain(name);
		expectFinished(events, "The plan is saved.", 3);
	});

	it("finishes an ordinary Ask response in one request", async () => {
		const { events } = await run([answer("The answer is forty two.")], { mode: "ask" });
		expectFinished(events, "The answer is forty two.", 1);
	});

	it("finishes an agent response once its todo list is complete", async () => {
		const { events } = await run([
			toolTurn(call("TodoWrite", { todos: [{ id: "done", content: "Implement the change", status: "completed" }] }, "complete")),
			answer("Implemented the requested change."),
		]);
		expectFinished(events, "Implemented the requested change.", 2);
	});

	it("finishes a small completed task without requiring a todo list", async () => {
		const { events } = await run([toolTurn(call("Write", { path: "a.ts", contents: "fixed" }, "write")), answer("The fix is applied.")]);
		expectFinished(events, "The fix is applied.", 2);
	});

	it("continues unfinished todos and then accepts the completed answer", async () => {
		const { events } = await run([
			toolTurn(call("TodoWrite", { todos: [{ id: "work", content: "Implement the change", status: "pending" }] }, "pending")),
			answer("I still have implementation work left."),
			toolTurn(call("TodoWrite", { merge: true, todos: [{ id: "work", status: "completed" }] }, "completed")),
			answer("The task is complete."),
		]);
		expect(JSON.stringify(fixture.requests[2].messages)).toContain("incomplete todo");
		expectFinished(events, "The task is complete.", 4);
	});

	it.each(["length", "max_tokens", "max_output_tokens"])("continues a response truncated with %s", async (finishReason) => {
		const { events } = await run([answer("The explanation begins", finishReason), answer("and is now complete.")]);
		expect(JSON.stringify(fixture.requests[1].messages)).toContain("output-token limit");
		expectFinished(events, "and is now complete.", 2);
	});

	it("recovers a thinking-only turn", async () => {
		const { events } = await run([
			[{ type: "thinking-delta", text: "I need to finish the response." }, { type: "done", finishReason: "stop" }],
			answer("Here is the completed answer."),
		]);
		expect(JSON.stringify(fixture.requests[1].messages)).toContain("only internal reasoning");
		expectFinished(events, "Here is the completed answer.", 2);
	});

	it("recovers an empty response after a tool result", async () => {
		const { events } = await run([toolTurn(call("Read", { path: "a.ts" }, "read")), answer(""), answer("The file looks correct.")]);
		expect(JSON.stringify(fixture.requests[2].messages)).toContain("If you need to make more tool calls");
		expectFinished(events, "The file looks correct.", 3);
	});

	it("asks Plan to save its plan and accepts the final answer after WritePlan", async () => {
		const { events } = await run([
			answer("First inspect the code, then implement the change."),
			toolTurn(call("WritePlan", { title: "Implementation", plan: "Inspect, implement, verify." }, "plan")),
			answer("The implementation plan is saved."),
		], { mode: "plan" });
		expect(JSON.stringify(fixture.requests[1].messages)).toContain("Call the WritePlan tool now");
		expect(fixture.executions.map((item) => item.name)).toEqual(["WritePlan"]);
		expectFinished(events, "The implementation plan is saved.", 3);
	});

	it("still pauses a repeated tool loop at the configured step limit", async () => {
		const { history, events } = await run(
			Array.from({ length: 4 }, (_, i) => toolTurn(call("Read", { path: "a.ts" }, `read-${i}`))),
			{ maxSteps: 4 },
		);
		expect(fixture.executions).toHaveLength(4);
		expect(fixture.requests).toHaveLength(4);
		expect(events).toContainEqual({ type: "max-steps", steps: 4 });
		expect(history.filter((step) => step.kind === "tool-result")).toHaveLength(4);
	});
});
