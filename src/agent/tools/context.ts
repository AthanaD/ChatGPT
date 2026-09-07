/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { defineTool } from "./types";

export const readContextTool = defineTool("ReadContext", false, async (input, _signal, _callId, ctx) => {
  if (!ctx?.readContext) return { output: "error: context archive is unavailable" };
  if (typeof input?.id !== "string") return { output: "error: ReadContext requires an archive id" };
  return { output: ctx.readContext(input).replace(/^Error:/, "error:") };
});
