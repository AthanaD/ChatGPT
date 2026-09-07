import { defineTool } from "./types";

export const readContextTool = defineTool("ReadContext", false, async (input, _signal, _callId, ctx) => {
  if (!ctx?.readContext) return { output: "error: context archive is unavailable" };
  if (typeof input?.id !== "string") return { output: "error: ReadContext requires an archive id" };
  return { output: ctx.readContext(input).replace(/^Error:/, "error:") };
});
