/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as vscode from "vscode";

/** Cumulative token usage for one model. */
export interface ModelUsage {
	promptTokens: number;
	completionTokens: number;
	requests: number;
	lastUsed: number;
	cachedReadTokens?: number;
	cachedWriteTokens?: number;
	/** Input with reported cache-read details; the remaining input is unknown. */
	cacheReadInputTokens?: number;
	/** Distinguishes a newly reported zero from zeros fabricated by old versions. */
	cacheWriteReported?: boolean;
}

const KEY = "ocursor.usage";
let ctx: vscode.ExtensionContext | undefined;

export function initUsage(context: vscode.ExtensionContext) {
	ctx = context;
}

export function getUsage(): Record<string, ModelUsage> {
	return ctx?.globalState.get<Record<string, ModelUsage>>(KEY) ?? {};
}

export interface UsageMetadata {
	requestId?: string;
	cachedReadTokens?: number;
	cachedWriteTokens?: number;
	cacheReadInputTokens?: number;
}
let writes: Promise<void> = Promise.resolve();
const seenRequests = new Set<string>();

/** Serialize read/update pairs so concurrent chats and children cannot lose usage. */
export function recordUsage(model: string, promptTokens = 0, completionTokens = 0, metadata: UsageMetadata = {}): Promise<void> {
	const update = writes.catch(() => {}).then(async () => {
		if (!ctx || !model) return;
		const all = getUsage();
		const u = all[model] ?? { promptTokens: 0, completionTokens: 0, requests: 0, lastUsed: 0 };
		const requestKey = metadata.requestId ? `${model}/${metadata.requestId}` : undefined;
		const newRequest = !requestKey || !seenRequests.has(requestKey);
		const nonnegative = (n: number | undefined) => Number.isFinite(n) ? Math.max(0, n ?? 0) : 0;
		const addReported = (before: number | undefined, delta: number | undefined) =>
			typeof delta === "number" && Number.isFinite(delta) && delta >= 0 ? (before ?? 0) + delta : before;
		all[model] = {
			promptTokens: u.promptTokens + nonnegative(promptTokens),
			completionTokens: u.completionTokens + nonnegative(completionTokens),
			cachedReadTokens: addReported(u.cachedReadTokens, metadata.cachedReadTokens),
			cachedWriteTokens: addReported(u.cachedWriteTokens, metadata.cachedWriteTokens),
			cacheReadInputTokens: addReported(u.cacheReadInputTokens, metadata.cacheReadInputTokens),
			cacheWriteReported: u.cacheWriteReported || (typeof metadata.cachedWriteTokens === "number" && Number.isFinite(metadata.cachedWriteTokens) && metadata.cachedWriteTokens >= 0) || undefined,
			requests: u.requests + (newRequest ? 1 : 0),
			lastUsed: Date.now(),
		};
		await ctx.globalState.update(KEY, all);
		if (requestKey) {
			seenRequests.add(requestKey);
			if (seenRequests.size > 10000) seenRequests.delete(seenRequests.values().next().value!);
		}
	});
	writes = update;
	return update;
}

export function resetUsage(): Promise<void> {
	const reset = writes.catch(() => {}).then(async () => {
		await ctx?.globalState.update(KEY, undefined);
		seenRequests.clear();
	});
	writes = reset;
	return reset;
}
