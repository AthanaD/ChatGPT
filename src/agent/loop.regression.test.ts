/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamChatOpts } from "./provider";
import type { RunAgentOptions } from "./loopTypes";
import type { AgentEvent, ProviderEvent, ResponsesReasoning, Step, ToolCall, WireMessage } from "./types";
import type { Tool } from "./tools/types";
import type { ToolSpec } from "./tools/schemas";

type ScriptedTurn = ProviderEvent[] | ((request: StreamChatOpts) => ProviderEvent[]);

// Keep the production loop, mode registry, todo handlers, ledger, message builder,
// and budget fitting. Replace only the provider and tools with external effects.
const fixture = vi.hoisted(() => {
	const executions: { name: string; input: unknown }[] = [];
	const tool = (spec: ToolSpec, mutating = false): Tool => ({
		mutating,
		schema: { type: "function", function: spec },
		execute: async (input) => {
			executions.push({ name: spec.name, input });
			return { output: spec.name === "Read" ? "file contents" : "ok" };
		},
	});
	return {
		tool,
		executions,
		requests: [] as StreamChatOpts[],
		turns: [] as ScriptedTurn[],
		approve: vi.fn(async (_name: string, _input: unknown, _callId?: string) => true),
		callMcp: vi.fn(async () => "MCP completed"),
	};
});

vi.mock("./provider", () => ({
	streamChat: async function* (options: StreamChatOpts) {
		const turn = fixture.turns[fixture.requests.length];
		fixture.requests.push(options);
		if (!turn) throw new Error("Unexpected model continuation after the scripted final answer");
		for (const event of typeof turn === "function" ? turn(options) : turn) yield event;
	},
}));
vi.mock("./tools/files", async () => {
	const { TOOL_SPECS: s } = await vi.importActual<typeof import("./tools/schemas")>("./tools/schemas");
	return {
		readFileTool: fixture.tool(s.Read), listDirTool: fixture.tool(s.ListDir),
		globTool: fixture.tool(s.Glob), fileSearchTool: fixture.tool(s.FileSearch),
		readLintsTool: fixture.tool(s.ReadLints), strReplaceTool: fixture.tool(s.StrReplace, true),
		writeTool: fixture.tool(s.Write, true), deleteFileTool: fixture.tool(s.Delete, true),
		editNotebookTool: fixture.tool(s.EditNotebook, true),
	};
});
vi.mock("./tools/search", async () => {
	const { TOOL_SPECS: s } = await vi.importActual<typeof import("./tools/schemas")>("./tools/schemas");
	return { grepTool: fixture.tool(s.Grep), semanticSearchTool: fixture.tool(s.SemanticSearch), searchDocsTool: fixture.tool(s.SearchDocs) };
});
vi.mock("./tools/shell", async () => {
	const { TOOL_SPECS: s } = await vi.importActual<typeof import("./tools/schemas")>("./tools/schemas");
	return { runTerminalTool: fixture.tool(s.Shell, true), awaitShellTool: fixture.tool(s.AwaitShell) };
});
vi.mock("./tools/web", async () => {
	const { TOOL_SPECS: s } = await vi.importActual<typeof import("./tools/schemas")>("./tools/schemas");
	return { webSearchTool: fixture.tool(s.WebSearch), webFetchTool: fixture.tool(s.WebFetch) };
});
vi.mock("./tools/mcp", async () => {
	const { TOOL_SPECS: s } = await vi.importActual<typeof import("./tools/schemas")>("./tools/schemas");
	return { callMcpToolTool: fixture.tool(s.CallMcpTool, true), fetchMcpResourceTool: fixture.tool(s.FetchMcpResource, true), listMcpResourcesTool: fixture.tool(s.ListMcpResources) };
});
vi.mock("./tools/shared", () => ({
	disposeShellSession: vi.fn(), toolTimeoutMs: () => 0,
	withToolTimeout: <T>(promise: Promise<T>) => promise,
	setSubagentRunner: vi.fn(), setQuestionAsker: vi.fn(), setToolTimeoutOverrides: vi.fn(),
	DEFAULT_TOOL_TIMEOUTS_SEC: {}, getSubagentRunner: vi.fn(), getQuestionAsker: vi.fn(),
	slugify: vi.fn(), makeDiff: vi.fn(), firstDiffLine: vi.fn(),
}));
vi.mock("../stores/fileMutations", () => ({ mutateFile: vi.fn() }));
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
import { TOOLS } from "./tools";
import * as cursorContext from "../context/cursorContext";
import { mcpManager } from "../integrations/mcpClient";

function call(name: string, input: unknown, id: string): ToolCall {
	return { name, arguments: JSON.stringify(input), id };
}

function toolTurn(...calls: ToolCall[]): ProviderEvent[] {
	return [...calls.map((call): ProviderEvent => ({ type: "tool-call", call })), { type: "done", finishReason: "tool_calls" }];
}

function answer(text: string, finishReason = "stop"): ProviderEvent[] {
	return [{ type: "text-delta", text }, { type: "done", finishReason }];
}

function olderReadHistory(request: string, marker: string): Step[] {
	const history: Step[] = [{ kind: "user", text: request }];
	for (let i = 0; i < 18; i++) {
		const toolCall = call("Read", { path: `history-${i}.ts` }, `history-${i}`);
		history.push(
			{ kind: "assistant", text: "", calls: [toolCall] },
			{ kind: "tool-result", callId: toolCall.id, name: "Read", status: "completed", output: `${"Prior source detail\n".repeat(150)}${i === 0 ? marker : "ordinary observation"}\n${"More source detail\n".repeat(150)}` },
		);
	}
	return history;
}

async function run(turns: ScriptedTurn[], options: Partial<RunAgentOptions> = {}) {
	fixture.turns.push(...turns);
	const history: Step[] = options.history ?? [];
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

describe("Responses reasoning continuations", () => {
	const reasoning: ResponsesReasoning = {
		model: "gpt-5.4", provider: "openai",
		items: [
			{ type: "reasoning", id: "rs_first", summary: [], encrypted_content: "opaque-first-response" },
			{ type: "reasoning", id: "rs_second", summary: [{ type: "summary_text", text: "Inspecting files" }], encrypted_content: "opaque-second-item" },
		],
	};

	it.each([false, true])("replays complete state through tool results with display thinking=%s", async (displayThinking) => {
		const firstTurn: ProviderEvent[] = [
			...(displayThinking ? [{ type: "thinking-delta" as const, text: "Visible reasoning summary" }] : []),
			{ type: "responses-reasoning", reasoning },
			...toolTurn(call("Read", { path: "first.ts" }, "first"), call("Read", { path: "second.ts" }, "second")),
		];
		const { history, events } = await run([
			firstTurn,
			toolTurn(call("Read", { path: "third.ts" }, "third")),
			answer("All three files inspected."),
		], { model: reasoning.model });
		const assistants = history.filter((step) => step.kind === "assistant");
		expect(assistants[0].responsesReasoning).toEqual(reasoning);
		expect(assistants[1].responsesReasoning).toBeUndefined();
		expect(assistants[2].responsesReasoning).toBeUndefined();
		const replay = fixture.requests[1].messages.find((message) => message.role === "assistant");
		expect(replay).toMatchObject({ role: "assistant", content: null, responsesReasoning: reasoning });
		expect(replay).not.toHaveProperty("thinking");
		for (const request of fixture.requests) expectCompleteToolGroups(request.messages);
		expect(JSON.stringify(events)).not.toContain("opaque-first-response");
		expect(JSON.stringify(events)).not.toContain("responses-reasoning");
		expectFinished(events, "All three files inspected.", 3);
	});

	it("restores a completed response's reasoning from serialized history on the next user run", async () => {
		const first = await run([
			[{ type: "responses-reasoning", reasoning }, ...answer("The initial answer.")],
		], { model: reasoning.model });
		const savedHistory: Step[] = JSON.parse(JSON.stringify(first.history));
		await run([answer("The follow-up answer.")], { model: reasoning.model, history: savedHistory, prompt: "Explain the answer" });
		expect(fixture.requests[1].messages).toContainEqual(expect.objectContaining({
			role: "assistant", content: "The initial answer.", responsesReasoning: reasoning,
		}));
		expect(savedHistory.filter((step) => step.kind === "assistant").at(-1)?.responsesReasoning).toBeUndefined();
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

	it.each([undefined, 100_000])("keeps empty TodoRead results adjacent without forcing a todo list (contextTokens=%s)", async (contextTokens) => {
		const { history, events } = await run([
			toolTurn(call("Read", { path: "a.ts" }, "read"), call("TodoRead", {}, "todos"), call("Grep", { pattern: "name" }, "grep")),
			answer("No tasks have been recorded."),
		], { contextTokens });
		const batchIndex = history.findIndex((step) => step.kind === "assistant" && step.calls.length === 3);
		expect(history.slice(batchIndex + 1, batchIndex + 4).map((step) => step.kind === "tool-result" ? step.callId : step.kind)).toEqual(["read", "todos", "grep"]);
		expect(history[batchIndex + 4]).toMatchObject({ kind: "assistant", text: "No tasks have been recorded." });
		expect(history.filter((step) => step.kind === "user" && step.synthetic)).toEqual([]);
		const nextMessages = fixture.requests[1].messages;
		expect(nextMessages.filter((message) => message.role === "tool").map((message) => message.tool_call_id)).toEqual(["read", "todos", "grep"]);
		expect(JSON.stringify(nextMessages)).not.toContain("MUST call TodoWrite");
		expect(nextMessages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "todos", content: "(no todos)" }));
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

	it("finishes three useful reads without inserting todo-creation reminders", async () => {
		const { history, events } = await run([
			toolTurn(call("Read", { path: "a.ts" }, "read-a")),
			toolTurn(call("Read", { path: "b.ts" }, "read-b")),
			toolTurn(call("Read", { path: "c.ts" }, "read-c")),
			answer("The three files use the same interface."),
		]);
		expect(history.filter((step) => step.kind === "user" && step.synthetic)).toEqual([]);
		expectFinished(events, "The three files use the same interface.", 4);
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

	it("nudges an incomplete todo only once before accepting a blocked final answer", async () => {
		const blocked = "The dependency service is unavailable. Restore it before I can finish.";
		const { history, events } = await run([
			toolTurn(call("TodoWrite", { todos: [{ id: "work", content: "Fetch required dependency", status: "pending" }] }, "pending")),
			answer("I could not fetch the dependency."),
			answer(blocked),
		]);
		const reminders = history.filter((step) => step.kind === "user" && step.synthetic && step.text.includes("incomplete todo"));
		expect(reminders).toHaveLength(1);
		expectFinished(events, blocked, 3);
	});

	it.each([undefined, 1024, 8192])("respects the configured Plan output limit (%s) on every request", async (maxTokens) => {
		const { events } = await run([
			toolTurn(call("WritePlan", { title: "Implementation", plan: "Inspect, implement, verify." }, "plan")),
			answer("The implementation plan is saved."),
		], { mode: "plan", maxTokens });
		expect(fixture.requests.map((request) => request.maxTokens)).toEqual([maxTokens, maxTokens]);
		expectFinished(events, "The implementation plan is saved.", 2);
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

describe("runAgent context consumption", () => {
	it.each([true, false])("loads only a discovered MCP schema and preserves approval (approved=%s)", async (approved) => {
		const connected = Array.from({ length: 12 }, (_, i) => ({
			qualifiedName: `mcp__records__operation_${i}`,
			server: "records",
			tool: {
				name: `operation_${i}`,
				description: `Record operation ${i}. ${"Field validation instructions. ".repeat(20)}`,
				inputSchema: { type: "object", properties: Object.fromEntries(Array.from({ length: 8 }, (_, field) => [`field_${field}`, { type: "string", description: "A field value with validation requirements. ".repeat(5) }])) },
			},
		}));
		vi.spyOn(mcpManager, "listTools").mockReturnValue(connected);
		fixture.approve.mockResolvedValueOnce(approved);
		const selected = connected[5];
		const input = { field_0: "record-42" };
		const activeMcpNames = (request: StreamChatOpts) => request.tools?.map((tool) => tool.function.name).filter((name) => name.startsWith("mcp__"));
		const final = approved ? "The record operation completed." : "The requested operation was denied.";
		const { events } = await run([
			(request) => {
				expect(activeMcpNames(request)).toEqual([]);
				expect(JSON.stringify(request.messages)).toContain("Connected MCP tool schemas are available on demand");
				return toolTurn(call("ReadContext", { id: "mcp", pattern: selected.qualifiedName }, "find-mcp"));
			},
			(request) => {
				expect(activeMcpNames(request)).toEqual([]);
				const result = request.messages.find((message) => message.role === "tool" && message.tool_call_id === "find-mcp");
				const catalog = result?.role === "tool" && typeof result.content === "string" ? result.content : "";
				const line = catalog.split("\n").find((entry) => entry.includes(selected.qualifiedName));
				const reference = line?.match(/ReadContext \{"id":"([^"]+)"\}/);
				expect(reference).toBeDefined();
				return toolTurn(call("ReadContext", { id: reference![1] }, "load-mcp-schema"));
			},
			(request) => {
				expect(activeMcpNames(request)).toEqual([selected.qualifiedName]);
				expect(request.tools?.find((tool) => tool.function.name === selected.qualifiedName)?.function.parameters).toEqual(selected.tool.inputSchema);
				return toolTurn(call(selected.qualifiedName, input, "selected-mcp"));
			},
			answer(final),
		]);
		expect(fixture.approve).toHaveBeenCalledWith(selected.qualifiedName, input, "selected-mcp");
		if (approved) expect(fixture.callMcp).toHaveBeenCalledWith(selected.qualifiedName, input, expect.any(AbortSignal));
		else expect(fixture.callMcp).not.toHaveBeenCalled();
		expect(fixture.requests[0].tools).toEqual(fixture.requests[1].tools);
		expect(fixture.requests[2].tools).toEqual(fixture.requests[3].tools);
		for (const request of fixture.requests) expectCompleteToolGroups(request.messages);
		expectFinished(events, final, 4);
	});

	it.each(["buildUserInfoBlock", "buildOpenFilesBlock"] as const)("counts %s before making an oversized provider request", async (source) => {
		vi.spyOn(cursorContext, source).mockResolvedValue("Workspace instructions and selected file context. ".repeat(3000));
		const { events } = await run([], { enableWorkspaceContext: true, contextTokens: 20_000, maxTokens: 1024 });
		expect(fixture.requests).toEqual([]);
		expect(events).toContainEqual({ type: "run-status", status: "error" });
		expect(events).toContainEqual({ type: "error", message: expect.stringContaining("context window is too small") });
	});

	it("rejects a response reservation that leaves no room for a request", async () => {
		const { events } = await run([], { contextTokens: 4096, maxTokens: 4096 });
		expect(fixture.requests).toEqual([]);
		expect(events).toContainEqual({ type: "run-status", status: "error" });
		expect(events).toContainEqual({ type: "error", message: expect.stringContaining("context window is too small") });
	});

	it("executes large edits verbatim and sends retrievable abbreviated arguments on later turns", async () => {
		const marker = "ORIGINAL_MIDDLE_OF_WRITTEN_FILE";
		const input = { path: "generated.ts", contents: `${"export const example = 1;\n".repeat(1000)}${marker}\n${"// generated content\n".repeat(1000)}` };
		const writeCall = call("Write", input, "large-write");
		const { history, events } = await run([
			toolTurn(writeCall),
			(request) => {
				const sentCall = request.messages.flatMap((message) => message.role === "assistant" ? message.tool_calls ?? [] : [])
					.find((toolCall) => toolCall.id === "large-write");
				expect(sentCall).toBeDefined();
				expect(sentCall!.function.arguments.length).toBeLessThan(writeCall.arguments.length / 4);
				const historical = JSON.parse(sentCall!.function.arguments);
				expect(historical.path).toBe(input.path);
				expect(historical.contents).not.toContain(marker);
				return toolTurn(call("ReadContext", { id: historical._context_archive.id, pattern: marker }, "recover-write"));
			},
			(request) => {
				const result = request.messages.find((message) => message.role === "tool" && message.tool_call_id === "recover-write");
				expect(result?.role === "tool" ? result.content : "").toContain(marker);
				return answer("The generated file is written.");
			},
		]);
		expect(fixture.executions).toContainEqual({ name: "Write", input });
		expect(history).toContainEqual(expect.objectContaining({ kind: "assistant", calls: [writeCall] }));
		for (const request of fixture.requests) expectCompleteToolGroups(request.messages);
		expectFinished(events, "The generated file is written.", 3);
	});

	it("reduces repeated large-output payloads while keeping full results and retrieving omitted details", async () => {
		const marker = "ARCHIVE_ONLY_DEPENDENCY_MISMATCH_42";
		const outputs = ["alpha", "beta", "gamma"].map((name) => Array.from({ length: 3000 }, (_, i) =>
			i === 1500 ? `${name}: ${marker}` : `${name}:${i + 1} export const setting_${i} = \"a realistic source value with implementation details\";`,
		).join("\n"));
		const outputByCall = new Map(outputs.map((output, i) => [`read-${i}`, output]));
		const read = vi.spyOn(TOOLS.Read, "execute");
		for (const output of outputs) read.mockResolvedValueOnce({ output });
		const { history, events } = await run([
			...outputs.map((_, i) => toolTurn(call("Read", { path: `file-${i}.ts` }, `read-${i}`))),
			(request) => {
				const result = request.messages.find((message) => message.role === "tool" && message.tool_call_id === "read-0");
				expect(result?.role).toBe("tool");
				const preview = result?.role === "tool" && typeof result.content === "string" ? result.content : "";
				expect(preview).not.toContain(marker);
				const reference = preview.match(/ReadContext \{"id":"([^"]+)"\}/);
				expect(reference, "large results advertise a retrievable context reference").not.toBeNull();
				return toolTurn(call("ReadContext", { id: reference![1], pattern: marker }, "recover-middle"));
			},
			(request) => {
				const result = request.messages.find((message) => message.role === "tool" && message.tool_call_id === "recover-middle");
				expect(result?.role === "tool" ? result.content : "").toContain(`alpha: ${marker}`);
				return answer("The archived source identifies the dependency mismatch.");
			},
		], { contextTokens: 1_000_000 });

		const measuredRequests = fixture.requests.slice(0, 4);
		const sentCharacters = measuredRequests.reduce((sum, request) => sum + JSON.stringify({ messages: request.messages, tools: request.tools }).length, 0);
		const fullOutputCharacters = measuredRequests.reduce((sum, request) => {
			const messages = request.messages.map((message) => message.role === "tool" && outputByCall.has(message.tool_call_id)
				? { ...message, content: outputByCall.get(message.tool_call_id) }
				: message);
			return sum + JSON.stringify({ messages, tools: request.tools }).length;
		}, 0);
		expect(sentCharacters).toBeLessThan(fullOutputCharacters * 0.35);
		for (const [callId, output] of outputByCall) {
			expect(history).toContainEqual(expect.objectContaining({ kind: "tool-result", callId, output }));
			expect(events).toContainEqual(expect.objectContaining({ type: "tool-call-completed", callId, result: output }));
		}
		for (const request of fixture.requests) expectCompleteToolGroups(request.messages);
		expectFinished(events, "The archived source identifies the dependency mismatch.", 5);
	});

	it("restores archived output references from saved chat history in a subsequent Ask run", async () => {
		const marker = "DETAIL_NEEDED_ON_FOLLOWUP";
		const output = `${"Earlier source lines\n".repeat(1000)}${marker}\n${"Later source lines\n".repeat(1000)}`;
		vi.spyOn(TOOLS.Read, "execute").mockResolvedValueOnce({ output });
		const first = await run([
			toolTurn(call("Read", { path: "source.ts" }, "saved-read")),
			answer("I have inspected the source."),
		]);
		const preview = fixture.requests[1].messages.find((message) => message.role === "tool" && message.tool_call_id === "saved-read");
		const reference = (preview?.role === "tool" && typeof preview.content === "string" ? preview.content : "").match(/ReadContext \{"id":"([^"]+)"\}/);
		expect(reference).not.toBeNull();
		expectFinished(first.events, "I have inspected the source.", 2);

		fixture.requests.length = 0;
		fixture.turns.length = 0;
		const second = await run([
			toolTurn(call("ReadContext", { id: reference![1], pattern: marker }, "followup-detail")),
			(request) => {
				const result = request.messages.find((message) => message.role === "tool" && message.tool_call_id === "followup-detail");
				expect(result?.role === "tool" ? result.content : "").toContain(marker);
				return answer("The earlier output includes the requested detail.");
			},
		], { mode: "ask", prompt: "What was the omitted detail?", history: first.history });
		expect(second.history).toContainEqual(expect.objectContaining({ kind: "tool-result", callId: "saved-read", output }));
		for (const request of fixture.requests) expectCompleteToolGroups(request.messages);
		expectFinished(second.events, "The earlier output includes the requested detail.", 2);
	});

	it.each([false, true])("retains the current request and archived history after compaction (summary failure=%s)", async (summaryFails) => {
		const marker = "OLD_FINDING_RETRIEVED_AFTER_COMPACTION";
		const originalRequest = "Inspect the dependency initialization.";
		const followup = "Recover the earlier finding and explain it.";
		const history = olderReadHistory(originalRequest, marker);
		const originalHistory = [...history];
		const summary = "Earlier files were inspected. The user now needs an earlier finding explained.";
		const { events } = await run([
			(request) => {
				expect(request.tools).toBeUndefined();
				expect(request.maxTokens).toBe(1536);
				expect(JSON.stringify(request.messages).length).toBeLessThan(100_000);
				if (summaryFails) throw new Error("Summary provider temporarily unavailable");
				return [...answer(summary), { type: "usage", promptTokens: 750, completionTokens: 60 }];
			},
			(request) => {
				const text = JSON.stringify(request.messages);
				expect(text).toContain(`<user_query>\\n${followup}\\n</user_query>`);
				expect(text).toContain(originalRequest);
				expect(text).not.toContain(marker);
				if (!summaryFails) expect(text.split(summary)).toHaveLength(2);
				return toolTurn(call("ReadContext", { id: "history", pattern: marker }, "recover-history"));
			},
			(request) => {
				const result = request.messages.find((message) => message.role === "tool" && message.tool_call_id === "recover-history");
				expect(result?.role === "tool" ? result.content : "").toContain(marker);
				return toolTurn(call("Read", { path: "verify.ts" }, "verify"));
			},
			toolTurn(call("Read", { path: "verify-other.ts" }, "verify-other")),
			answer("The earlier finding has been recovered and explained."),
		], { prompt: followup, history, contextTokens: 16_000, maxTokens: 1024 });
		expect(history.slice(0, originalHistory.length)).toEqual(originalHistory);
		expect(events.filter((event) => event.type === "compaction")).toEqual([
			{ type: "compaction", status: "running" },
			summaryFails ? { type: "compaction", status: "failed" } : { type: "compaction", status: "done", summary },
		]);
		if (!summaryFails) expect(events).toContainEqual(expect.objectContaining({ type: "usage", promptTokens: 750, completionTokens: 60 }));
		expect(fixture.requests.filter((request) => request.tools === undefined)).toHaveLength(1);
		for (const request of fixture.requests.slice(1)) expectCompleteToolGroups(request.messages);
		expectFinished(events, "The earlier finding has been recovered and explained.", 5);
	});

	it("reuses a serialized summary and todo state on the next run without another paid summary", async () => {
		const history = olderReadHistory("Inspect dependency initialization.", "DETAIL_PRESERVED_IN_SAVED_TRANSCRIPT");
		const contextState: NonNullable<RunAgentOptions["contextState"]> = {};
		const summary = "Dependency initialization was inspected; verification remains blocked by service access.";
		const pending = { id: "verify", content: "Verify the dependency path", status: "pending" };
		const first = await run([
			(request) => {
				expect(request.tools).toBeUndefined();
				return answer(summary);
			},
			toolTurn(call("TodoWrite", { todos: [pending] }, "pending-verification")),
			answer("The dependency service is unavailable."),
			answer("I need access to the service before verification can continue."),
		], { prompt: "Verify the dependency path.", history, contextState, contextTokens: 16_000, maxTokens: 1024 });
		expectFinished(first.events, "I need access to the service before verification can continue.", 4);
		expect(contextState.checkpoint).toBeDefined();
		expect(contextState.todos).toEqual([pending]);

		// Simulate saving/reloading the conversation, rather than sharing object identity.
		const restored = JSON.parse(JSON.stringify({ history, contextState })) as { history: Step[]; contextState: NonNullable<RunAgentOptions["contextState"]> };
		fixture.requests.length = 0;
		fixture.turns.length = 0;
		const second = await run([
			(request) => {
				expect(request.tools).toBeDefined();
				expect(JSON.stringify(request.messages)).toContain(summary);
				return toolTurn(call("TodoRead", {}, "restored-todos"));
			},
			(request) => {
				const todos = request.messages.find((message) => message.role === "tool" && message.tool_call_id === "restored-todos");
				expect(todos?.role === "tool" ? todos.content : "").toContain("[pending] Verify the dependency path");
				return toolTurn(call("TodoWrite", { merge: true, todos: [{ id: "verify", status: "completed" }] }, "finished-verification"));
			},
			answer("Verification is complete."),
		], { prompt: "The service is available. Continue verification.", ...restored, contextTokens: 16_000, maxTokens: 1024 });
		expectFinished(second.events, "Verification is complete.", 3);
		expect(second.events.filter((event) => event.type === "compaction")).toEqual([]);
		expect(fixture.requests.every((request) => request.tools !== undefined)).toBe(true);
		expect(restored.contextState.todos).toEqual([{ ...pending, status: "completed" }]);
		expect(second.history).toContainEqual(expect.objectContaining({ kind: "tool-result", output: expect.stringContaining("DETAIL_PRESERVED_IN_SAVED_TRANSCRIPT") }));
		for (const request of fixture.requests) expectCompleteToolGroups(request.messages);
	});
});

describe("immutable run permissions", () => {
  it("refuses Ask mode escalation before a subsequent write", async () => {
    const { history } = await run([
      toolTurn(call("SwitchMode", { target_mode_id: "agent" }, "switch")),
      toolTurn(call("Write", { path: "a", contents: "bad" }, "write")), answer("Cannot edit in Ask mode."),
    ], { mode: "ask" });
    expect(fixture.executions).toEqual([]);
    expect(history.filter(s => s.kind === "tool-result")).toEqual(expect.arrayContaining([
      expect.objectContaining({ callId: "switch", status: "error", output: expect.stringContaining("permissions") }),
      expect.objectContaining({ callId: "write", status: "error" }),
    ]));
  });
  it("keeps custom children read-only and inherits disabled web tools", async () => {
    await run([
      toolTurn(call("Task", { prompt: "edit", readonly: true, subagent_type: "custom" }, "task")),
      toolTurn(call("Write", { path: "a", contents: "bad" }, "child-write"), call("WebFetch", { url: "https://example.com" }, "child-web")),
      answer("Child done"), answer("Done"),
    ], { mode: "ask", enableWebFetch: false, customSubagents: [{ name: "custom", readonly: false, prompt: "Edit", description: "edit", id: "custom" }] });
    expect(fixture.executions).toEqual([]);
    expect(fixture.requests[1].tools?.some(t => ["Write", "WebFetch"].includes(t.function.name))).toBe(false);
  });
  it("runs generic MCP calls through approval and beforeMcp hooks", async () => {
    const hook = vi.fn(async () => "blocked fixture");
    await run([toolTurn(call("CallMcpTool", { server: "test", toolName: "write", arguments: { value: 1 } }, "mcp")), answer("Blocked")], { onHook: hook });
    expect(fixture.approve).toHaveBeenCalledWith("mcp__test__write", { value: 1 }, "mcp");
    expect(hook).toHaveBeenCalledWith('beforeMcp', { tool: "mcp__test__write", tool_input: '{"value":1}' }, "mcp__test__write", expect.any(AbortSignal));
    expect(fixture.callMcp).not.toHaveBeenCalled();
  });
  it("does not dispatch a tool if Stop arrives while approval resolves", async () => {
    const abort = new AbortController();
    const { events } = await run([toolTurn(call("Write", { path: "a", contents: "bad" }, "write"))], {
      signal: abort.signal, approve: async () => { abort.abort(); return true; },
    });
    expect(fixture.executions).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool-call-completed", status: "error", result: expect.stringContaining("cancelled") }));
  });
});

describe("native file-edit hooks", () => {
  it("vetoes a permitted Write before mutation with native input", async () => {
    const hook = vi.fn(async (event: string) => event === "beforeEdit" ? "protected by hook" : undefined);
    const { history } = await run([toolTurn(call("Write", { path: "a.ts", contents: "new" }, "edit")), answer("Hook blocked the edit")], { onHook: hook });
    expect(hook).toHaveBeenCalledWith("beforeEdit", { path: "a.ts", tool_input: JSON.stringify({ path: "a.ts", contents: "new", file_path: "a.ts", content: "new" }) }, "Write", expect.any(AbortSignal));
    expect(fixture.executions).toEqual([]);
    expect(history).toContainEqual(expect.objectContaining({ kind: "tool-result", status: "error", output: "blocked by hook: protected by hook" }));
  });
});


it("passes the child cancellation signal into its blocking hook", async () => {
  const parent = new AbortController();
  const aborts = new Map<string, () => void>();
  let childSignal: AbortSignal | undefined;
  await run([
    toolTurn(call("Task", { prompt: "Run a check", description: "Check" }, "child")),
    toolTurn(call("Shell", { command: "echo check" }, "shell")), answer("Child stopped."),
  ], {
    signal: parent.signal, registerSubagentAbort: (id, abort) => { aborts.set(id, abort); },
    onBeforeShell: async (_command, signal) => { childSignal = signal; aborts.get("child")!(); return "cancelled"; },
  });
  expect(childSignal).not.toBe(parent.signal);
  expect(childSignal?.aborted).toBe(true);
  expect(parent.signal.aborted).toBe(false);
  expect(fixture.executions).toEqual([]);
});
