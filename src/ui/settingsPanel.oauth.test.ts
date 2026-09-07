/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthStatus } from "../agent/oauth/types";

const fixture = vi.hoisted(() => ({
  status: { accounts: [], errors: {}, balanceStrategy: "first" } as OAuthStatus,
  receive: undefined as ((message: Record<string, unknown>) => Promise<void>) | undefined,
  onStatus: undefined as ((status: OAuthStatus) => void) | undefined,
  postMessage: vi.fn(),
  writeText: vi.fn(async (_text: string) => {}),
  login: vi.fn(async (_kind: string) => {}),
  reopen: vi.fn(async (_kind: string) => {}),
  manual: vi.fn(async (_kind: string, _url: string) => {}),
  cancel: vi.fn(),
}));

vi.mock("vscode", () => ({
  ViewColumn: { One: 1 },
  Uri: { joinPath: () => "icon" },
  env: { clipboard: { writeText: fixture.writeText } },
  window: { createWebviewPanel: () => ({
    webview: { html: "", postMessage: fixture.postMessage, onDidReceiveMessage: (callback: typeof fixture.receive) => { fixture.receive = callback; return { dispose() {} }; } },
    onDidDispose: () => ({ dispose() {} }), dispose() {}, reveal() {},
  }) },
}));
vi.mock("../agent/oauth", () => ({
  login: fixture.login, openLoginInBrowser: fixture.reopen, completeManual: fixture.manual, cancelLogin: fixture.cancel,
  getStatus: () => fixture.status,
  onOAuthStatus: (callback: typeof fixture.onStatus) => { fixture.onStatus = callback; return { dispose() {} }; },
}));
vi.mock("../stores/settingsManager", () => ({ DEFAULT_SETTINGS: {} }));
vi.mock("../agent/provider", () => ({ listModels: vi.fn() }));
vi.mock("./webviewHtml", () => ({ renderWebviewHtml: () => "<html></html>" }));
vi.mock("../stores/featureStore", () => ({ MODEL_CATALOG: [] }));
vi.mock("../context/workspaceContext", () => ({ listRules: vi.fn(), listSkills: vi.fn() }));
vi.mock("../integrations/mcpClient", () => ({ mcpManager: {} }));
vi.mock("../agent/personas", () => ({ BUILTIN_PERSONAS: [] }));
vi.mock("../agent/semanticIndex", () => ({ onIndexStatus: () => () => {} }));
vi.mock("../agent/docsIndex", () => ({ onDocsStatus: () => () => {} }));
vi.mock("../context/workspaceUtils", () => ({ getWorkspaceRoot: vi.fn() }));
vi.mock("../agent/llamacpp", () => ({ onLlamacppStatus: () => ({ dispose() {} }) }));
vi.mock("../agent/ollama", () => ({ onOllamaStatus: () => ({ dispose() {} }) }));
vi.mock("../stores/usageStore", () => ({ getUsage: vi.fn(), resetUsage: vi.fn() }));
vi.mock("../integrations/externalHooks", () => ({}));
vi.mock("../stores/modelRegistry", () => ({ onAllModels: () => () => {} }));

import { SettingsPanel } from "./settingsPanel";

const authorizationUrl = "https://auth.openai.com/oauth/authorize?state=fixture&code_challenge=public-challenge";
beforeEach(() => {
  vi.clearAllMocks();
  fixture.status = { accounts: [], errors: {}, balanceStrategy: "first", pending: "codex", authorizationUrl };
  SettingsPanel.createOrShow({ extensionUri: "extension" } as any, {} as any, {} as any);
});
afterEach(() => { SettingsPanel.currentPanel?.dispose(); });

describe("settings host OAuth message handling", () => {
  it("dispatches Codex Add Account, browser retry, and cancellation through the real webview listener", async () => {
    await fixture.receive!({ type: "oauthLogin", kind: "codex" });
    await fixture.receive!({ type: "oauthOpenLogin", kind: "codex" });
    await fixture.receive!({ type: "oauthCancel", kind: "codex" });
    expect(fixture.login).toHaveBeenCalledWith("codex");
    expect(fixture.reopen).toHaveBeenCalledWith("codex");
    expect(fixture.cancel).toHaveBeenCalledWith("codex");
  });

  it("forwards the current authorization URL when status is requested or pushed", async () => {
    await fixture.receive!({ type: "oauthGet" });
    fixture.onStatus!(fixture.status);
    expect(fixture.postMessage.mock.calls).toEqual([
      [{ type: "oauthStatus", status: fixture.status }],
      [{ type: "oauthStatus", status: fixture.status }],
    ]);
  });

  it("copies only the active host URL and acknowledges its identity", async () => {
    await fixture.receive!({ type: "oauthCopyLogin", kind: "codex", url: "https://untrusted.invalid" });
    expect(fixture.writeText).toHaveBeenCalledWith(authorizationUrl);
    expect(fixture.postMessage).toHaveBeenCalledWith({ type: "oauthLinkCopied", kind: "codex", authorizationUrl });
    await fixture.receive!({ type: "oauthCopyLogin", kind: "claude-code" });
    expect(fixture.writeText).toHaveBeenCalledTimes(1);
    fixture.status = { accounts: [], errors: {}, balanceStrategy: "first" };
    await fixture.receive!({ type: "oauthCopyLogin", kind: "codex" });
    expect(fixture.writeText).toHaveBeenCalledTimes(1);
  });

  it.each(["oauthLogin", "oauthOpenLogin", "oauthManualCallback", "oauthCopyLogin"])("surfaces %s failures while retaining the current manual-login fallback", async (type) => {
    const failure = new Error("Fixture operation failed");
    if (type === "oauthLogin") fixture.login.mockRejectedValueOnce(failure);
    if (type === "oauthOpenLogin") fixture.reopen.mockRejectedValueOnce(failure);
    if (type === "oauthManualCallback") fixture.manual.mockRejectedValueOnce(failure);
    if (type === "oauthCopyLogin") fixture.writeText.mockRejectedValueOnce(failure);
    await fixture.receive!({ type, kind: "codex", url: "http://localhost:1455/auth/callback?code=fixture" });
    await Promise.resolve();
    expect(fixture.postMessage).toHaveBeenCalledWith({ type: "oauthStatus", status: {
      ...fixture.status, errors: { codex: "Fixture operation failed" },
    } });
  });

  it.each([false, true])("ignores a cancelled manual exchange's late error after restart=%s", async (restart) => {
    let rejectExchange!: (error: Error) => void;
    fixture.manual.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectExchange = reject; }));
    const exchange = fixture.receive!({ type: "oauthManualCallback", kind: "codex", url: "http://localhost:1455/auth/callback?code=old" });
    await fixture.receive!({ type: "oauthCancel", kind: "codex" });
    fixture.status = { accounts: [], errors: {}, balanceStrategy: "first" };
    if (restart) {
      await fixture.receive!({ type: "oauthLogin", kind: "codex" });
      fixture.status = { ...fixture.status, pending: "codex", authorizationUrl: `${authorizationUrl}&attempt=new` };
    }
    fixture.onStatus!(fixture.status);
    fixture.postMessage.mockClear();
    rejectExchange(new Error("Old exchange was cancelled"));
    await exchange;
    expect(fixture.postMessage).not.toHaveBeenCalled();
    expect(fixture.status.errors).toEqual({});
  });

  it("surfaces a backend-recorded manual error after the failed attempt has cleared its URL", async () => {
    fixture.manual.mockImplementationOnce(async () => {
      fixture.status = { accounts: [], errors: { codex: "Token exchange failed" }, balanceStrategy: "first" };
      throw new Error("Token exchange failed");
    });
    await fixture.receive!({ type: "oauthManualCallback", kind: "codex", url: "code" });
    expect(fixture.postMessage).toHaveBeenCalledWith({ type: "oauthStatus", status: fixture.status });
  });

  it("still surfaces manual submission when no login was active", async () => {
    fixture.status = { accounts: [], errors: {}, balanceStrategy: "first" };
    fixture.manual.mockRejectedValueOnce(new Error("No login in progress"));
    await fixture.receive!({ type: "oauthManualCallback", kind: "codex", url: "code" });
    expect(fixture.postMessage).toHaveBeenCalledWith({ type: "oauthStatus", status: {
      ...fixture.status, errors: { codex: "No login in progress" },
    } });
  });
});
