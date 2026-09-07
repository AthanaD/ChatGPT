import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
// Match a credential body, not a bare prefix in documentation or a regex.
const credential = /\b(?:sk-|tp-|vbk_)[A-Za-z0-9_-]{20,}|\bBearer\s+[A-Za-z0-9._~+/-]{20,}/;
let failed = false;
for (const file of files) {
  if (/(?:^|\/)[^/]*\.env(?:\.[^/]+)?$/.test(file) && !file.endsWith(".env.example")) {
    console.error(`${file}: committed environment file`);
    failed = true;
  }
  if (!/^(?:src|webview-ui)\/.*\.tsx?$/.test(file)) continue;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!credential.test(lines[i])) continue;
    // Never print the matching value into CI logs.
    console.error(`${file}:${i + 1}: potential credential`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log("Security scan passed.");
