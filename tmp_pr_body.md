## Summary

This PR adds new AI providers, resolves critical performance bottlenecks, hardens security against credential leaks, fixes agent loop infinite resume behavior, and introduces unit testing with GitHub Actions CI.

## Changes

### New Providers
- **Xiaomi MIMO** (mimo-v2.5-pro, mimo-v2.5) - OpenAI-compatible endpoint at token-plan-sgp.xiaomimimo.com/v1
- **Verboo AI** - OpenAI-compatible endpoint at code.verboo.ai/router/v1
- **Atlas Cloud** - Preset with live model discovery (api.atlascloud.ai/v1)
- **Astraflow (UCloud)** - Global and China endpoints for 200+ models

### Performance (P0 fixes)
- **structuredClone removal** - Eliminated redundant deep-cloning of history on every agent loop iteration and in fitStepsToBudget. History is now shallow-cloned; stripThinking creates new objects via spread without mutating originals.
- **Provider fetch timeouts** - Added 8s per-provider timeout in modelRegistry.doFetch() so a slow/unresponsive provider no longer blocks startup for all providers.

### Security
- **Hardcoded credential removal** - Moved Google OAuth clientSecret from oauth.ts to process.env.ANTIGRAVITY_CLIENT_SECRET. Git history was cleaned with filter-branch to remove all traces.
- **.gitignore hardened** - Added .env and .env.* patterns; .env.example added with safe placeholders.
- **Pre-commit hook** - Detects and blocks commits containing API keys, tokens, passwords, or .env files.
- **CI security scan** - GitHub Actions workflow includes a secret-leak check step.

### Agent Loop Anti-Loop
- **Consecutive text-only turn counter** - Breaks the loop after 3 consecutive text-only responses (no tool calls), preventing the resume echo chamber.
- **Nudge budget** - Maximum 5 system reminder injections per run to prevent infinite re-nudge cycles.
- **Hard cap for autoContinue** - Even with auto-continue enabled, the loop enforces 2x MAX_STEPS as an absolute maximum.

### Testing and CI
- **Vitest unit tests** - 12 tests covering normalizeBaseUrl, kindMatches, PROVIDER_PRESETS integrity, URL validation, and security assertions.
- **GitHub Actions CI** - Matrix build on Node 20/22: check-types, lint, vitest, esbuild, package. Separate security-scan job.

### UI
- **Thinking block spacing** - Reduced thinking-card thinking-body padding for tighter rendering.

### Bug Fixes
- **normalizeBaseUrl** applied to all 7 fetch() calls in provider.ts to prevent double-slash URLs.
- **MIMO model fallback** - listModels() now falls back to hardcoded catalog for xiaomimimo.com endpoints.
- **MIMO chat error messages** - 404 errors now include an actionable hint about verifying Base URL and API Key.

## Validation

- pnpm run check-types passes (TypeScript strict)
- pnpm run lint - 0 errors
- pnpm run test:unit - 12/12 tests pass
- node esbuild.js --production builds cleanly
- npx @vscode/vsce package --no-dependencies produces ocursor-0.1.4.vsix (1.01 MB)
- Security scan: no API keys, tokens, or credentials found in source or git history
