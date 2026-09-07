import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const scanner = fileURLToPath(new URL("./check-secrets.mjs", import.meta.url));
function scan(files) {
  const cwd = mkdtempSync(join(tmpdir(), "ocursor-security-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd });
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, name)), { recursive: true });
      writeFileSync(join(cwd, name), content);
    }
    execFileSync("git", ["add", "."], { cwd });
    return spawnSync(process.execPath, [scanner], { cwd, encoding: "utf8" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("accepts key-prefix assertions, ordinary task names, and an env example", () => {
  const result = scan({
    "src/example.test.ts": 'const pattern = /^(sk-|tp-|vbk_)/; const name = "task-state"; key.startsWith("vbk_");',
    ".env.example": "API_KEY=your-key-here\n",
  });
  assert.equal(result.status, 0, result.stderr);
});

for (const prefix of ["sk-", "tp-", "vbk_", "Bearer "]) {
  test(`rejects a ${prefix.trim()} credential without logging it`, () => {
    const token = prefix + "aB3dE5fG7hI9jK1lM3nO5pQ7";
    const result = scan({ "webview-ui/example.tsx": `const key = "${token}";` });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /example\.tsx:1: potential credential/);
    assert.ok(!result.stderr.includes(token));
  });
}

for (const filename of [".env", ".env.local", "nested/service.env", "nested/.env.production"]) {
  test(`rejects tracked ${filename}`, () => {
    const result = scan({ [filename]: "API_KEY=placeholder" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /committed environment file/);
  });
}
