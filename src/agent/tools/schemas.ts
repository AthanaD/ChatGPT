/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

// Shared tool contracts with concise model-facing descriptions.
// Every Tool schema is derived from here (see defineTool in types.ts).
// Handlers live in the sibling files and reference these specs by name.

export interface ToolSpec {
  name: string;
  description: string;
  parameters: object;
}

export const TOOL_SPECS: Record<string, ToolSpec> = {};

function def(spec: ToolSpec) {
  TOOL_SPECS[spec.name] = spec;
}

def({
  name: "ReadContext",
  description: "Read or search archived context by id, or use id history for the full conversation. Returns a bounded excerpt; use next_line/next_column to continue. Load only the details needed for the current task.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Archive id from a previous result, or history for the full conversation transcript" },
      start_line: { type: "integer", minimum: 1, description: "First line, 1-based" },
      end_line: { type: "integer", minimum: 1, description: "Last line, inclusive" },
      start_column: { type: "integer", minimum: 1, description: "Resume a long line from next_column" },
      pattern: { type: "string", description: "Literal text to find in the archived content" },
    },
    required: ["id"],
  },
});

def({
  name: "Shell",
  description: "Execute terminal operations such as git, package managers and Docker in a stateful shell. The shell starts at the workspace root; cwd and environment persist. Use working_directory to select a directory and quote paths containing spaces. Supply a concise 5–10 word description.\n\nBefore starting a server or other process that should not be duplicated, inspect existing terminals and their output files. Before creating files/directories through a command, verify the parent exists and is the intended location with ls.\n\nUse specialized tools for file operations: Read for reading, Grep/Glob for searching, StrReplace for editing, and Write for creating files. Avoid cat/head/tail, find/grep, and sed/awk edits; if a shell search is unavoidable, try rg before grep. Do not pipe output through head, tail or sed merely to shorten it: large output is retained in a terminal file for retrieval.\n\nBatch independent commands as parallel Shell calls. Chain dependent commands with &&; use ; only when earlier failures should not stop later commands. Do not separate commands with newlines except inside quoted strings. Add dependencies with the package manager using current versions; do not invent versions.\n\nLong-running commands:\n- block_until_ms defaults to 30000 and includes startup time. Exceeding it backgrounds the command rather than failing; 0 backgrounds immediately. No trailing & is needed. For foreground work allow more than its expected runtime and adjust the buffer using elapsed_ms.\n- Completion notifications arrive after your turn, independently of output-match notifications. Work on independent tasks meanwhile; use AwaitShell when blocked on a result or when close monitoring is needed.\n- notify_on_output is only for explicitly requested monitoring. Use stable sentinel output and selective anchored regexes, with a reason of at most five words. Noisy output can be filtered with scripts. Notifications arrive after your turn; debounce_ms has a 5000ms minimum, and an excessively noisy watcher is terminated with a notice.\n- You can schedule a reminder with a background command that sleeps then echoes a message; choose the delay based on expected task duration.\n\nGit safety and commits:\n- Commit or push only when requested; ask if unclear. Never change git config. Destructive operations, skipping hooks/signing and force pushes require explicit user instruction; warn before a requested force push to main/master. Avoid interactive -i commands.\n- Before a requested commit, run git status, git diff and git log in parallel. Review staged/unstaged changes and untracked files, follow repository commit style, and restrict this investigation to git commands. Do not commit likely secrets; warn if requested. Do not create an empty commit.\n- Stage relevant files, commit with a concise 1–2 sentence message explaining why the change is needed, then run git status to verify success. Pass multiline commit messages via a quoted HEREDOC.\n- Avoid amend. It requires an explicit request or a successful commit whose hook modified files to include; verify HEAD was created by you in this conversation (git log -1 --format='%an %ae') and is unpushed (git status says ahead). If a commit failed or a hook rejected it, fix the issue and create a new commit. Never amend an already pushed commit without explicit instruction.\n\nPull requests and GitHub:\n- Use gh for GitHub URLs, issues, PRs, checks and releases; PR review comments are available through gh api repos/OWNER/REPO/pulls/NUMBER/comments.\n- For a requested PR, inspect git status, git diff, remote tracking/up-to-date status, git log and git diff BASE...HEAD in parallel. Review every included commit, then prepare a title and summary of the complete change plus a test plan.\n- Create a branch if needed, push with -u if needed, and create the PR with gh pr create. Supply the body through a quoted HEREDOC with Summary and Test plan sections. Do not change git config or use TodoWrite/Task during this PR workflow. Return the PR URL.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to execute" },
      working_directory: { type: "string", description: "The absolute path to the working directory to execute the command in (defaults to current directory)" },
      block_until_ms: { type: "number", description: "How long to block and wait for the command to complete before moving it to background (in milliseconds). Defaults to 30000ms (30 seconds). Set to 0 to immediately run the command in the background. The timer includes the shell startup time." },
      description: { type: "string", description: "Clear, concise description of what this command does in 5-10 words" },
      notify_on_output: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern matched against stdout/stderr output. Do not match all outputs." },
          reason: { type: "string", description: "5 or less words describing why you are watching for this output. The UI (only visible to user) will prefix it as 'Monitored `reason`'." },
          debounce_ms: { type: "number", description: "Milliseconds that must elapse between notifications. The harness enforces a minimum of 5000ms." },
        },
        required: ["pattern", "reason"],
        description: "Optional output notification config. Each terminal output which matches the pattern will notify you. ONLY set this when the user explicitly requests monitoring.",
      },
      request_smart_mode_approval: { type: "boolean", description: "Set to true when immediately retrying the exact same command after Auto-review blocks it and you decide the user should approve it through the native approval card." },
      smart_mode_block_reason: { type: "string", description: "Provide the exact block reason returned by Auto-review in the prior rejection. Required when request_smart_mode_approval is true so the approval card shows the original classifier reason without re-running the classifier." },
    },
    required: ["command"],
  },
});

def({
  name: "Glob",
  description: "\nTool to search for files matching a glob pattern\n\n- Works fast with codebases of any size\n- Returns matching file paths sorted by modification time\n- Use this tool when you need to find files by name patterns\n- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches that are potentially useful as a batch.\n",
  parameters: {
    type: "object",
    properties: {
      target_directory: { type: "string", description: "Absolute path to directory to search for files in. If not provided, defaults to Cursor workspace root." },
      glob_pattern: { type: "string", description: "The glob pattern to match files against.\nPatterns not starting with \"**/\" are automatically prepended with \"**/\" to enable recursive searching.\n\nExamples:\n\t- \"*.js\" (becomes \"**/*.js\") - find all .js files\n\t- \"**/node_modules/**\" - find all node_modules directories\n\t- \"**/test/**/test_*.ts\" - find all test_*.ts files in any test directory" },
    },
    required: ["glob_pattern"],
  },
});

def({
  name: "Grep",
  description: "A powerful search tool built on ripgrep\nUsage:\n- Prefer using Grep for search tasks when you know the exact symbols or strings to search for. Whenever possible, use this tool instead of invoking grep or rg as a terminal command. The Grep tool has been optimized for speed and file restrictions inside Cursor.\n- Supports full regex syntax (e.g., \"log.*Error\", \"function\\s+\\w+\")\n- Filter files with glob parameter (e.g., \".js\", \"**/.tsx\") or type parameter (e.g., \"js\", \"py\", \"rust\")\n- Output modes: \"content\" shows matching lines (default), \"files_with_matches\" shows only file paths, \"count\" shows match counts\n- Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use interface\\{\\} to find interface{} in Go code)\n- Multiline matching: By default patterns match within single lines only. For cross-line patterns like struct \\{[\\s\\S]*?field, use multiline: true\n- Results are capped to several thousand output lines for responsiveness; when truncation occurs, the results report \"at least\" counts, but are otherwise accurate.\n- Content output formatting closely follows ripgrep output format: '-' for context lines, ':' for match lines, and all context/match lines below each file group.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The regular expression pattern to search for in file contents" },
      path: { type: "string", description: "File or directory to search in (rg pattern -- PATH). Defaults to Cursor workspace root." },
      glob: { type: "string", description: "Glob pattern to filter files (e.g. \"*.js\", \"*.{ts,tsx}\") - maps to rg --glob" },
      output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "Output mode: \"content\" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), \"files_with_matches\" shows file paths (supports head_limit), \"count\" shows match counts (supports head_limit). Defaults to \"content\"." },
      "-B": { type: "number", description: "Number of lines to show before each match (rg -B). Requires output_mode: \"content\", ignored otherwise." },
      "-A": { type: "number", description: "Number of lines to show after each match (rg -A). Requires output_mode: \"content\", ignored otherwise." },
      "-C": { type: "number", description: "Number of lines to show before and after each match (rg -C). Requires output_mode: \"content\", ignored otherwise." },
      "-i": { type: "boolean", description: "Case insensitive search (rg -i) Defaults to false" },
      type: { type: "string", description: "File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types." },
      head_limit: { type: "number", minimum: 0, description: "Limit output size. For \"content\" mode: limits total matches shown. For \"files_with_matches\" and \"count\" modes: limits number of files." },
      offset: { type: "number", minimum: 0, description: "Skip first N entries. For \"content\" mode: skips first N matches. For \"files_with_matches\" and \"count\" modes: skips first N files. Use with head_limit for pagination." },
      multiline: { type: "boolean", description: "Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false." },
    },
    required: ["pattern"],
  },
});

def({
  name: "AwaitShell",
  description: "Observe or wait for a background shell job. Omit shell_id to sleep for block_until_ms without a shell command. Completed unawaited jobs notify you after your turn; observe a job you believe has ended (including one you killed) to consume a stale notification.\n\nWork on independent tasks instead of polling. Await only when your next step needs this result and no other productive work remains, or close monitoring is required. Never poll a job described as \"manually backgrounded by the user\". Tests, installs, watchers and short scripts normally need only completion notifications. Training/evaluation runs, deployments, long builds, data pipelines, migrations and transfers may need monitoring for hangs or corrective action.\n\nAfter immediately backgrounding a command (block_until_ms: 0), read its output file once to confirm startup; this is a smoke check, not a polling loop.\n\nWhen actively monitoring:\n- Continue until termination, a healthy steady state for a nonterminating process, or a diagnosed hang. If hung, use the output header's pid to stop it when safe, fix the cause if possible and proceed.\n- Regex waits can detect known startup/status/error lines. Regexes match the output body, excluding headers and footers.\n- Match waits to expected runtime. For further waits use 60–270s slices or 1200s+ instead of round five-minute waits to reduce prompt-cache misses.\n- Output headers include pid and running_for_ms, refreshed every 5000ms; completion adds exit_code and elapsed_ms.",
  parameters: {
    type: "object",
    properties: {
      shell_id: { type: "string", description: "Optional shell id to poll. If omitted, this tool sleeps for the full block_until_ms duration and then returns. Required when block_until_ms is 0." },
      block_until_ms: { type: "number", description: "Max sleep time to block before returning (in milliseconds). Defaults to 30000ms. Set to 0 for non-blocking status check." },
      pattern: { type: "string", description: "Block until the regex matches stdout/stderr stream (or task completes). Matches anywhere in the shell output, not just new output. Will not match terminal file headers or footers, e.g. exit_code. Accepts JavaScript regex patterns (compiled with the multiline `m` flag)." },
    },
  },
});

def({
  name: "Read",
  description: "Reads a file from the local filesystem. You can access any file directly by using this tool.\nIf the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.\n\nUsage:\n- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters\n- Lines in the output are numbered starting at 1, using following format: LINE_NUMBER|LINE_CONTENT\n- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful.\n- If you read a file that exists but has empty contents you will receive 'File is empty.'\n\nImage Support:\n- This tool can also read image files when called with the appropriate path.\n- Supported image formats: jpeg/jpg, png, gif, webp.\n\nPDF Support:\n- PDF files are converted into text content automatically (subject to the same character limits as other files).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "The absolute path of the file to read." },
      offset: { type: "integer", description: "The line number to start reading from. Positive values are 1-indexed from the start of the file. Negative values count backwards from the end (e.g. -1 is the last line). Only provide if the file is too large to read at once." },
      limit: { type: "integer", description: "The number of lines to read. Only provide if the file is too large to read at once." },
    },
    required: ["path"],
  },
});

def({
  name: "Delete",
  description: "Deletes a file at the specified path. The operation will fail gracefully if:\n    - The file doesn't exist\n    - The operation is rejected for security reasons\n    - The file cannot be deleted",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "The absolute path of the file to delete" },
    },
    required: ["path"],
  },
});

def({
  name: "StrReplace",
  description: "Performs exact string replacements in files.\n\nUsage:\n- When editing text, ensure you preserve the exact indentation (tabs/spaces) as it appears before.\n- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string.\n- Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.\n- Optional parameter: replace_all (boolean, default false) — if true, replaces all occurrences of old_string in the file.\n\nIf you want to create a new file, use the Write tool instead.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "The absolute path to the file to modify" },
      old_string: { type: "string", description: "The text to replace" },
      new_string: { type: "string", description: "The text to replace it with (must be different from old_string)" },
      replace_all: { type: "boolean", description: "Replace all occurrences of old_string (default false)" },
    },
    required: ["path", "old_string", "new_string"],
  },
});

def({
  name: "Write",
  description: "Writes a file to the local filesystem.\n\nUsage:\n- This tool will overwrite the existing file if there is one at the provided path.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "The absolute path to the file to modify" },
      contents: { type: "string", description: "The contents to write to the file" },
    },
    required: ["path", "contents"],
  },
});

def({
  name: "EditNotebook",
  description: "Use this tool to edit a jupyter notebook cell. Use ONLY this tool to edit notebooks.\n\nThis tool supports editing existing cells and creating new cells:\n\t- If you need to edit an existing cell, set 'is_new_cell' to false and provide the 'old_string' and 'new_string'.\n\t\t-- The tool will replace ONE occurrence of 'old_string' with 'new_string' in the specified cell.\n\t- If you need to create a new cell, set 'is_new_cell' to true and provide the 'new_string' (and keep 'old_string' empty).\n\t- It's critical that you set the 'is_new_cell' flag correctly!\n\t- This tool does NOT support cell deletion, but you can delete the content of a cell by passing an empty string as the 'new_string'.\n\nOther requirements:\n\t- Cell indices are 0-based.\n\t- 'old_string' and 'new_string' should be a valid cell content, i.e. WITHOUT any JSON syntax that notebook files use under the hood.\n\t- The old_string MUST uniquely identify the specific instance you want to change. This means:\n\t\t-- Include AT LEAST 3-5 lines of context BEFORE the change point\n\t\t-- Include AT LEAST 3-5 lines of context AFTER the change point\n\t- This tool can only change ONE instance at a time. If you need to change multiple instances:\n\t\t-- Make separate calls to this tool for each instance\n\t\t-- Each call must uniquely identify its specific instance using extensive context\n\t- This tool might save markdown cells as \"raw\" cells. Don't try to change it, it's fine. We need it to properly display the diff.\n\t- If you need to create a new notebook, just set 'is_new_cell' to true and cell_idx to 0.\n\t- ALWAYS generate arguments in the following order: target_notebook, cell_idx, is_new_cell, cell_language, old_string, new_string.\n\t- Prefer editing existing cells over creating new ones!\n\t- ALWAYS provide ALL required arguments (including BOTH old_string and new_string). NEVER call this tool without providing 'new_string'.",
  parameters: {
    type: "object",
    properties: {
      target_notebook: { type: "string", description: "The path to the notebook file you want to edit. You can use either a relative path in the workspace or an absolute path. If an absolute path is provided, it will be preserved as is." },
      cell_idx: { type: "number", description: "The index of the cell to edit (0-based)" },
      is_new_cell: { type: "boolean", description: "If true, a new cell will be created at the specified cell index. If false, the cell at the specified cell index will be edited." },
      cell_language: { type: "string", description: "The language of the cell to edit. Should be STRICTLY one of these: 'python', 'markdown', 'javascript', 'typescript', 'r', 'sql', 'shell', 'raw' or 'other'." },
      old_string: { type: "string", description: "The text to replace (must be unique within the cell, and must match the cell contents exactly, including all whitespace and indentation)." },
      new_string: { type: "string", description: "The edited text to replace the old_string or the content for the new cell." },
    },
    required: ["target_notebook", "cell_idx", "is_new_cell", "cell_language", "old_string", "new_string"],
  },
});

def({
  name: "TodoWrite",
  description: "Manage a structured task list for complex work (three or more distinct steps), nontrivial planning, multiple user requests, or an explicitly requested todo list. Skip trivial single tasks and informational conversation. Do not add a separate testing task unless requested.\n\nUse specific, actionable items and capture new requirements as they arrive. merge=false replaces the entire list; merge=true merges by id, preserving omitted fields. Mark the first current task in_progress, keep only one in_progress at a time, and complete it before starting another. States: pending (not started), in_progress (working), completed (finished successfully), cancelled (no longer needed). Mark completion immediately and add follow-ups when needed.\n\nBatch updates with related tool calls and start the actual work in the same batch as the initial list. Apart from initially creating the list, update silently without announcing todo maintenance.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique identifier for the TODO item" },
            content: { type: "string", description: "The description/content of the todo item" },
            status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"], description: "The current status of the TODO item" },
          },
          required: ["id", "content", "status"],
        },
        description: "Array of TODO items to update or create. Can be a single item.",
      },
      merge: { type: "boolean", description: "Whether to merge the todos with the existing todos. If true, the todos will be merged into the existing todos based on the id field. You can leave unchanged properties undefined. If false, the new todos will replace the existing todos." },
    },
    required: ["todos", "merge"],
  },
});

def({
  name: "ReadLints",
  description: "Read and display linter errors from the current workspace. You can provide paths to specific files or directories, or omit the argument to get diagnostics for all files.\n\n- If a file path is provided, returns diagnostics for that file only\n- If a directory path is provided, returns diagnostics for all files within that directory\n- If no path is provided, returns diagnostics for all files in the workspace\n- This tool can return linter errors that were already present before your edits, so avoid calling it with a very wide scope of files\n- NEVER call this tool on a file unless you've edited it or are about to edit it",
  parameters: {
    type: "object",
    properties: {
      paths: { type: "array", items: { type: "string" }, description: "Optional. An array of paths to files or directories to read linter errors for. You can use either relative paths in the workspace or absolute paths. If provided, returns diagnostics for the specified files/directories only. If not provided, returns diagnostics for all files in the workspace." },
    },
  },
});

def({
  name: "SemanticSearch",
  description: "`SemanticSearch`: semantic search that finds code by meaning, not exact text\n\n### When to Use This Tool\n\nUse `SemanticSearch` when you need to:\n- Explore unfamiliar codebases\n- Ask \"how / where / what\" questions to understand behavior\n- Find code by meaning rather than exact text\n\n### When NOT to Use\n\nSkip `SemanticSearch` for:\n1. Exact text matches (use `Grep`)\n2. Reading known files (use `Read`)\n3. Simple symbol lookups (use `Grep`)\n4. Find file by name (use `Glob`)\n\n### Examples\n\n<example>\n  Query: \"Where is interface MyInterface implemented in the frontend?\"\n<reasoning>\n  Good: Complete question asking about implementation location with specific context (frontend).\n</reasoning>\n</example>\n\n<example>\n  Query: \"Where do we encrypt user passwords before saving?\"\n<reasoning>\n  Good: Clear question about a specific process with context about when it happens.\n</reasoning>\n</example>\n\n<example>\n  Query: \"MyInterface frontend\"\n<reasoning>\n  BAD: Too vague; use a specific question instead. This would be better as \"Where is MyInterface used in the frontend?\"\n</reasoning>\n</example>\n\n<example>\n  Query: \"AuthService\"\n<reasoning>\n  BAD: Single word searches should use `Grep` for exact text matching instead.\n</reasoning>\n</example>\n\n<example>\n  Query: \"What is AuthService? How does AuthService work?\"\n<reasoning>\n  BAD: Combines two separate queries. A single semantic search is not good at looking for multiple things in parallel. Split into separate parallel searches: like \"What is AuthService?\" and \"How does AuthService work?\"\n</reasoning>\n</example>\n\n### Target Directories\n\n- Provide ONE directory or file path; [] searches the whole repo. No globs or wildcards.\n  Good:\n  - [\"backend/api/\"]   - focus directory\n  - [\"src/components/Button.tsx\"] - single file\n  - [] - search everywhere when unsure\n  BAD:\n  - [\"frontend/\", \"backend/\"] - multiple paths\n  - [\"src/**/utils/**\"] - globs\n  - [\"*.ts\"] or [\"**/*\"] - wildcard paths\n\n### Search Strategy\n\n1. Start with exploratory queries - semantic search is powerful and often finds relevant context in one go. Begin broad with [] if you're not sure where relevant code is.\n2. Review results; if a directory or file stands out, rerun with that as the target.\n3. Break large questions into smaller ones (e.g. auth roles vs session storage).\n4. For big files (>1K lines) run `SemanticSearch`, or `Grep` if you know the exact symbols you're looking for, scoped to that file instead of reading the entire file.\n\n<example>\n  Step 1: { \"query\": \"How does user authentication work?\", \"target_directories\": [], \"explanation\": \"Find auth flow\" }\n  Step 2: Suppose results point to backend/auth/ → rerun:\n          { \"query\": \"Where are user roles checked?\", \"target_directories\": [\"backend/auth/\"], \"explanation\": \"Find role logic\" }\n<reasoning>\n  Good strategy: Start broad to understand overall system, then narrow down to specific areas based on initial results.\n</reasoning>\n</example>\n\n<example>\n  Query: \"How are websocket connections handled?\"\n  Target: [\"backend/services/realtime.ts\"]\n<reasoning>\n  Good: We know the answer is in this specific file, but the file is too large to read entirely, so we use semantic search to find the relevant parts.\n</reasoning>\n</example>\n\n### Usage\n- When full chunk contents are provided, avoid re-reading the exact same chunk contents using the Read tool.\n- Sometimes, just the chunk signatures and not the full chunks will be shown. Chunk signatures are usually Class or Function signatures that chunks are contained in. Use the Read or Grep tools to explore these chunks or files if you think they might be relevant.\n- When reading chunks that weren't provided as full chunks (e.g. only as line ranges or signatures), you'll sometimes want to expand the chunk ranges to include the start of the file to see imports, expand the range to include lines from the signature, or expand the range to read multiple chunks from a file at once.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "A complete question about what you want to understand. Ask as if talking to a colleague: 'How does X work?', 'What happens when Y?', 'Where is Z handled?'" },
      target_directories: { type: "array", items: { type: "string" }, description: "Prefix directory paths to limit search scope (single directory only, no glob patterns)" },
      num_results: { type: "integer", minimum: 1, maximum: 15, description: "The number of results to return. Defaults to 15. Do not specify a value larger than 15." },
    },
    required: ["query", "target_directories"],
  },
});

def({
  name: "SearchDocs",
  description: "Semantic search over user-indexed external documentation sources (added in Settings > Indexing & Docs).\n\nUse this tool when the user mentions an indexed doc (e.g. an <attached type=\"doc\" /> tag in their message) or asks about a library/service whose docs are indexed. Prefer this over WebSearch/WebFetch for indexed sources — it is faster and returns only relevant excerpts.\n\n- `doc` is the doc source name or id (from the mention tag's title/content, or omit to search all indexed docs).\n- Returns the top matching excerpts with their page URLs; call again with a refined query for more.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "A complete question or topic to search for in the documentation." },
      doc: { type: "string", description: "Doc source name or id to search. Omit to search all indexed docs." },
      num_results: { type: "integer", minimum: 1, maximum: 12, description: "Max excerpts to return (default 6)." },
    },
    required: ["query"],
  },
});

def({
  name: "WebSearch",
  description: "Search the web for real-time information about any topic. Returns summarized information from search results and relevant URLs.\n\nUse this tool when you need up-to-date information that might not be available or correct in your training data, or when you need to verify current facts.\nThis includes queries about:\n- Libraries, frameworks, and tools whose APIs, best practices, or usage instructions are frequently updated. (\"How do I run Postgres in a container?\")\n- Current events or technology news. (\"Which AI model is best for coding?\")\n- Informational queries similar to what you might Google (\"kubernetes operator for mysql\")\n\nIMPORTANT - Use the correct year in search queries:\n- Today's date is 2026-06-27. You MUST use this year when searching for recent information, documentation, or current events.\n- Example: If today is 2026-06-27 and the user asks for \"latest React docs\", search for \"React documentation 2026\", NOT \"React documentation 2025\"",
  parameters: {
    type: "object",
    properties: {
      search_term: { type: "string", description: "The search term to look up on the web. Be specific and include relevant keywords for better results. For technical queries, include version numbers or dates if relevant." },
      explanation: { type: "string", description: "One sentence explanation as to why this tool is being used, and how it contributes to the goal." },
    },
    required: ["search_term"],
  },
});

def({
  name: "WebFetch",
  description: "Fetch content from a specified URL and return its contents in a readable markdown format. Use this tool when you need to retrieve and analyze webpage content.\n\n- The URL must be a fully-formed, valid URL.\n- This tool is read-only and will not work for requests intended to have side effects.\n- This fetch tries to return live results but may return previously cached content.\n- Authentication is not supported, and an error will be returned if the URL requires authentication.\n- If the URL is returning a non-200 status code, e.g. 404, the tool will not return the content and will instead return an error message.\n- This fetch runs from an isolated server. Hosts like localhost or private IPs will not work.\n- This tool does not support fetching binary content, e.g. media or PDFs.\n- For static assets and non-webpage URLs, use the `Shell` tool instead.\n",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch. The content will be converted to a readable markdown format." },
      requestSmartModeApproval: { type: "boolean", description: "Set to true when immediately retrying the exact same fetch after Auto-review blocks it and you decide the user should approve it through the native approval card." },
      smartModeBlockReason: { type: "string", description: "Provide the exact block reason returned by Auto-review in the prior rejection. Required when requestSmartModeApproval is true so the approval card shows the original classifier reason without re-running the classifier." },
    },
    required: ["url"],
  },
});

def({
  name: "AskQuestion",
  description: "Collect answers from the user through the chat UI. Use this tool only when you are blocked on a decision that is genuinely the user's to make: one you cannot resolve from the request, the code, or sensible defaults.\n\nEach question can ask for a choice (multiple-choice options, with an optional free-text \"Other\") or for structured input (text, textArea, number, date).\n\nUsage notes:\n- For choice questions define at least 2 options; the user can always type \"Other\".\n- Use allow_multiple: true to allow multiple answers to be selected for a question\n- Use type: \"text\" / \"textArea\" / \"number\" / \"date\" (without options) when you need typed input, and set required: true when an answer is mandatory\n- If you recommend a specific option, make that the first option in the list and add \"(Recommended)\" at the end of the label\n- Prefer this tool over listing options in your final response text (as letters, numbers, bullet points, etc)",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Optional title for the questions form" },
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique identifier for this question" },
            prompt: { type: "string", description: "The question text to display to the user, without the options." },
            type: {
              type: "string",
              enum: ["choices", "text", "textArea", "number", "date"],
              description: "Input kind for this question. \"choices\" (default) renders the listed options; the others render a plain input field. Required questions can be marked with required: true.",
            },
            required: { type: "boolean", description: "If true, the user must answer before submitting (default false)." },
            placeholder: { type: "string", description: "Placeholder text for text/textArea/number/date questions." },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "Unique identifier for this option" },
                  label: { type: "string", description: "Display text for this option" },
                },
                required: ["id", "label"],
              },
              minItems: 2,
              description: "Answer options for a \"choices\" question (minimum 2 required)",
            },
            allow_multiple: { type: "boolean", description: "If true, user can select multiple options. Defaults to false." },
          },
          required: ["id", "prompt"],
        },
        minItems: 1,
        description: "Array of questions to present to the user (minimum 1 required)",
      },
    },
    required: ["questions"],
  },
});

def({
  name: "Task",
  description: "Delegate a concrete, complex task to a subagent. Specify subagent_type, a 3–5 word description, all necessary context and exactly what its final report should contain. A fresh agent cannot see the user's message or prior assistant steps. Avoid handing off the entire user request and merely returning the result.\n\nUse explore for broad codebase discovery; answer narrow questions, known-file reads, exact symbol searches and direct MCP requests with the relevant tools. Launch independent subtasks concurrently in one message with multiple Task calls; this is required when the user requests parallel agents. Use proactively when the selected agent description calls for it.\n\nA completed agent returns one report; its output is generally trustworthy. Background completion is notified after you end your turn: continue other work or finish, without polling or AwaitShell. Its report already contains a user-visible summary; do not repeat a single background report unless asked, synthesizing multiple reports, or handling a blocker requiring parent action. Link agents as [label](agent-id), without separately printing raw IDs.\n\nResume a completed agent using its ID to preserve context. Resuming a running agent fails unless interrupt is true; interrupt only at the user's explicit request. resume=\"self\" forks the parent into a new child. Otherwise each invocation starts fresh.\n\nBuilt-in subagent_types:\n- generalPurpose: complex research, uncertain searches and multi-step execution.\n- explore: fast, read-only codebase exploration; cannot modify files. Specify thoroughness as quick, medium or very thorough.\n- shell: command execution, git and terminal tasks.\n- cursor-guide: Cursor Desktop, IDE, CLI, Cloud Agents, Bugbot and other product documentation.\n- ci-investigator: investigate one failing PR check and report its root cause when requested.\n- bugbot: Bugbot-like local code review only when explicitly requested.\n- security-review: local security review only when explicitly requested.\n- best-of-n-runner: isolated experiments or competing attempts, each in its own git worktree and branch.\n- docs-researcher: fetch library documentation without filling the parent context.\n- code-reviewer: review a completed major project step against its plan and coding standards.",
  parameters: {
    type: "object",
    properties: {
      description: { type: "string", description: "A short, user-friendly title for the subagent. This appears in the UI as the subagent's name. Make it concrete and distinct, consider recent titles to avoid reuse. For resumed subagents which you are prompting to work on a separate task, give an updated description based on the latest work the subagent is performing. (Do not rename if the subagent is continuing work on the same high-level task.)" },
      prompt: { type: "string", description: "The task for the agent to perform" },
      model: { type: "string", description: "Optional model slug for this agent. Omit it unless the user explicitly named a model — by default the subagent inherits the parent agent's model. Never guess or invent a slug: an unknown slug is ignored and the parent model is used instead. Do not pass if resume field is set (prior model will be used)." },
      resume: { type: "string", description: "Optional agent ID to resume from. If provided, sends a follow-up message to the agent after it has completed. Requests to a currently running asynchronous agent fail unless `interrupt` is true; set `interrupt` to true only when you intend to interrupt the running agent. Use \"self\" to start a new agent with your own entire conversation history as a starting point (aka 'self-fork')." },
      readonly: { type: "boolean", description: "If true, the subagent will run in readonly mode (\"Ask mode\") with restricted write operations and no MCP or internet access." },
      subagent_type: {
        type: "string",
        description: "Subagent type to use for this task. Either one of the built-in types (generalPurpose, explore, shell, cursor-guide, ci-investigator, bugbot, security-review, best-of-n-runner, docs-researcher, code-reviewer) or the name of a configured subagent — including a member of an assigned team listed in <assigned_teams> or <subagents>.",
      },
      file_attachments: { type: "array", items: { type: "string" }, description: "Optional array of file paths to images or videos to pass to video-review subagents. Files are read and attached to the subagent's context. Use to forward relevant media (e.g. images sent by user) to subagents." },
      interrupt: { type: "boolean", description: "If true and `resume` targets a running async agent, interrupt the current run and send this prompt immediately. Only use when the user explicitly asks to interrupt or change what the running agent is doing." },
      run_in_background: { type: "boolean", description: "Run the agent in the background (returns output_file path to check later). If this is false, you will be blocked until the agent completes. If the user is currently in Multitask Mode, always set this parameter to True. When true, the background subagent will send a notification when it completes." },
    },
    required: ["description", "prompt"],
  },
});

def({
  name: "FetchMcpResource",
  description: "Reads a specific resource from an MCP server, identified by server name and resource URI. Optionally, set downloadPath (relative to the workspace) to save the resource to disk; when set, the resource will be downloaded and not returned to the model.",
  parameters: {
    type: "object",
    properties: {
      server: { type: "string", description: "The MCP server identifier" },
      uri: { type: "string", description: "The resource URI to read" },
      downloadPath: { type: "string", description: "Optional relative path in the workspace to save the resource to. When set, the resource is written to disk and is not returned to the model." },
      requestSmartModeApproval: { type: "boolean", description: "Set to true when immediately retrying the exact same resource fetch after Auto-review blocks it and you decide the user should approve it through the native approval card." },
      smartModeBlockReason: { type: "string", description: "Provide the exact block reason returned by Auto-review in the prior rejection. Required when requestSmartModeApproval is true so the approval card shows the original classifier reason without re-running the classifier." },
    },
    required: ["server", "uri"],
  },
});

def({
  name: "SwitchMode",
  description: "Switch the interaction mode to better match the current task. Each mode is optimized for a specific type of work.\n\n## When to Switch Modes\n\nSwitch modes proactively when:\n1. **Task type changes** - User shifts from asking questions to requesting implementation, or vice versa\n2. **Complexity emerges** - What seemed simple reveals architectural decisions or multiple approaches\n3. **Debugging needed** - An error, bug, or unexpected behavior requires investigation\n4. **Planning needed** - The task is large, ambiguous, or has significant trade-offs to discuss\n5. **You're stuck** - Multiple attempts without progress suggest a different approach is needed\n\n## When NOT to Switch\n\nDo NOT switch modes for:\n- Simple, clear tasks that can be completed quickly in current mode\n- Mid-implementation when you're making good progress\n- Minor clarifying questions (just ask them)\n- Tasks where the current mode is working well\n\n## Available Modes\n\n### Agent Mode [switchable]\nDefault implementation mode with full access to all tools for making changes.\n\n### Plan Mode [switchable]\nRead-only collaborative mode for designing implementation approaches before coding.\n\n### Debug Mode (cannot switch to this mode)\nSystematic troubleshooting mode for investigating bugs, failures, and unexpected behavior with runtime evidence.\n\n### Ask Mode (cannot switch to this mode)\nRead-only mode for exploring code and answering questions without making changes.\n\n## Important Notes\n\n- **Be proactive**: Don't wait for the user to ask you to switch modes\n- **Explain briefly**: When switching, briefly explain why in your `explanation` parameter\n- **Don't over-switch**: If the current mode is working, stay in it\n- **User approval required**: Mode switches require user consent",
  parameters: {
    type: "object",
    properties: {
      target_mode_id: { type: "string", description: "The mode to switch to. Allowed values: 'plan', 'agent'." },
      explanation: { type: "string", description: "Optional explanation for why the mode switch is requested. This helps the user understand why you're switching modes." },
    },
    required: ["target_mode_id"],
  },
});

def({
  name: "ListMcpResources",
  description: "Lists the resources exposed by connected MCP servers. Resources are addressable pieces of context (files, database rows, API responses, etc.) that a server makes available, identified by a server name and a resource URI. Use this to discover what is available before reading a specific resource with FetchMcpResource.\n\nUsage:\n- Returns one entry per resource: the owning server, the resource URI, an optional human-readable name, and the MIME type when provided.\n- Pass `server` to limit the listing to a single MCP server; omit it to list resources across every connected server.\n- If no servers are connected or none expose resources, the result will say so.\n- Pair with FetchMcpResource: list to discover URIs, then fetch the specific URI you need.",
  parameters: {
    type: "object",
    properties: {
      server: { type: "string", description: "Optional MCP server identifier to filter the listing to a single server. Omit to list resources from all connected servers." },
    },
  },
});

def({
  name: "CallMcpTool",
  description: "Call an MCP tool by server identifier and tool name with arbitrary JSON arguments. IMPORTANT: Always read the tool's schema/descriptor BEFORE calling to ensure correct parameters.\n\nExample:\n{\n  \"server\": \"my-mcp-server\",\n  \"toolName\": \"search\",\n  \"arguments\": { \"query\": \"example\", \"limit\": 10 },\n  \"description\": \"Search the docs for the example API\"\n}",
  parameters: {
    type: "object",
    properties: {
      server: { type: "string", description: "Identifier of the MCP server hosting the tool." },
      toolName: { type: "string", description: "Name of the MCP tool to invoke." },
      arguments: { type: "object", description: "Arguments to pass to the MCP tool, as described in the tool descriptor." },
      description: { type: "string", description: "Clear, concise description of what this call does in 5-10 words" },
      requestSmartModeApproval: { type: "boolean", description: "Set to true when immediately retrying the exact same MCP call after Auto-review blocks it and you decide the user should approve it through the native approval card." },
      smartModeBlockReason: { type: "string", description: "Provide the exact block reason returned by Auto-review in the prior rejection. Required when requestSmartModeApproval is true so the approval card shows the original classifier reason without re-running the classifier." },
    },
    required: ["server", "toolName"],
  },
});

// ---------------------------------------------------------------------------
// OpenCursor-specific tools (not part of Cursor's request). Same description
// style and level of detail as the tools above.
// ---------------------------------------------------------------------------

def({
  name: "ListDir",
  description: "Lists the files and subdirectories contained directly within a single directory. The fastest way to understand the shape of an unfamiliar part of the codebase before diving in.\n\nUsage:\n- Returns one entry per line; directories are suffixed with a trailing slash (e.g. `src/`) and files are not. Never pass a slash-suffixed entry to Read — list or glob it instead.\n- Lists only the immediate children of the given directory; it is NOT recursive. Use Glob for recursive name matching or Grep to search file contents.\n- Common noise directories (`.git`, `node_modules`, `dist`, `out`) are omitted from the listing.\n- Prefer this over a `Shell` `ls` call: it is faster and respects the workspace's ignore rules.\n- You have the capability to call multiple tools in a single response. Batch independent listings together.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path of the directory to list. Defaults to the workspace root when omitted." },
    },
  },
});

def({
  name: "FileSearch",
  description: "Fuzzy search for files by name when you know part of a filename but not its exact path. Matches a query fragment against every file path in the workspace using a subsequence/substring fuzzy score and returns the best matches, most relevant first.\n\nUsage:\n- Use this when you remember roughly what a file is called (e.g. `sidebar`, `authmiddleware`) but not where it lives.\n- For exact directory/name patterns prefer Glob; for searching file CONTENTS prefer Grep or SemanticSearch.\n- Returns up to 30 matching workspace-relative paths. If you get too many results, provide a longer, more specific fragment.\n- The query is matched case-insensitively against the full relative path, so you can include directory hints (e.g. `agent/tools`).",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Filename fragment to match against file paths (case-insensitive). May include path separators to narrow results (e.g. \"agent/loop\")." },
    },
    required: ["query"],
  },
});

def({
  name: "TodoRead",
  description: "Read the current structured task list for this session exactly as it was last written with TodoWrite.\n\nUsage:\n- Use to re-orient yourself on a long task: it returns every todo with its current status (pending, in_progress, completed, cancelled).\n- This is a read-only companion to TodoWrite; it never modifies the list.\n- Returns `(no todos)` when no task list has been created yet.\n- You normally do NOT need to call this right after TodoWrite, since you already know the list you just wrote.",
  parameters: {
    type: "object",
    properties: {},
  },
});

def({
  name: "WritePlan",
  description: "Write the implementation plan for the current task to a Markdown file under `.plans/`. This is the deliverable of PLAN MODE and the ONLY file you are allowed to create while in plan mode.\n\nUsage:\n- Call this exactly once, after you have finished investigating the codebase, with the complete plan as Markdown.\n- The plan should contain: a one-line goal, then an ordered list of steps where each step names the file(s) to touch and the precise change to make, plus any risks or verification steps.\n- The file is named from a slugified version of `title` (e.g. \"Add auth\" -> `.plans/add-auth.md`). Writing the same title again overwrites the previous plan.\n- After it succeeds, give the user a brief summary and tell them to switch to agent mode to execute the plan.\n- Never reply with the plan as plain text instead of calling this tool, and never end a plan-mode turn without having called it.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short plan title, used to generate the filename under `.plans/`." },
      content: { type: "string", description: "The full implementation plan as Markdown." },
    },
    required: ["title", "content"],
  },
});
