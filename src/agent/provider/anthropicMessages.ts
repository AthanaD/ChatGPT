import type { WireMessage, WireContentPart } from "../types";

interface AnthropicBlock {
  type: "text" | "tool_use" | "tool_result" | "image";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | AnthropicBlock[];
  source?: { type: "base64"; media_type: string; data: string };
  cache_control?: { type: "ephemeral" };
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}

function systemToBlocks(content: string | WireContentPart[]): AnthropicBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => ({ type: "text", text: p.text, ...(p.cache_control ? { cache_control: p.cache_control } : {}) }));
}

export function toAnthropic(messages: WireMessage[]): { system: AnthropicBlock[]; messages: AnthropicMessage[] } {
  const system: AnthropicBlock[] = [];
  const out: AnthropicMessage[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      system.push(...systemToBlocks(m.content));
    } else if (m.role === "user") {
      if (typeof m.content === "string") {
        out.push({ role: "user", content: m.content });
      } else {
        const blocks: AnthropicBlock[] = [];
        for (const part of m.content) {
          if (part.type === "text") {
            blocks.push({ type: "text", text: part.text, ...(part.cache_control ? { cache_control: part.cache_control } : {}) });
          } else if (part.type === "image_url") {
            const url = part.image_url.url;
            const match = url.match(/^data:([^;]+);base64,(.*)$/);
            if (match) {
              blocks.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } });
            }
          }
        }
        out.push({ role: "user", content: blocks });
      }
    } else if (m.role === "assistant") {
      const blocks: AnthropicBlock[] = [];
      if (m.content) {
        blocks.push({ type: "text", text: m.content });
      }
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          let input: unknown = {};
          try {
            input = JSON.parse(tc.function.arguments || "{}");
          } catch {
            // leave as empty object
          }
          blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
        }
      }
      out.push({ role: "assistant", content: blocks.length ? blocks : "" });
    } else if (m.role === "tool") {
      // tool result -> a user message with a tool_result block; merge consecutive.
      // Array content (text + image) becomes a tool_result with nested blocks.
      let content: string | AnthropicBlock[];
      if (Array.isArray(m.content)) {
        const nested: AnthropicBlock[] = [];
        for (const part of m.content) {
          if (part.type === "text") {
            nested.push({ type: "text", text: part.text });
          } else if (part.type === "image_url") {
            const match = part.image_url.url.match(/^data:([^;]+);base64,(.*)$/);
            if (match) nested.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } });
          }
        }
        content = nested;
      } else {
        content = m.content;
      }
      const block: AnthropicBlock = { type: "tool_result", tool_use_id: m.tool_call_id, content };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  // Anthropic counts breakpoints across the entire serialized request. Keep
  // two early stable boundaries and the two newest boundaries when necessary.
  const marked: AnthropicBlock[] = [];
  const collect = (blocks: AnthropicBlock[]) => {
    for (const block of blocks) {
      if (block.cache_control) marked.push(block);
      if (Array.isArray(block.content)) collect(block.content);
    }
  };
  collect(system);
  for (const message of out) if (Array.isArray(message.content)) collect(message.content);
  for (const block of marked.slice(2, Math.max(2, marked.length - 2))) delete block.cache_control;
  return { system, messages: out };
}

