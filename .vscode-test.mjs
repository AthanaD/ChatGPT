import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  version: '1.96.0',
  ...(process.env.OPENCURSOR_TEST_EXTENSION_PATH ? { extensionDevelopmentPath: process.env.OPENCURSOR_TEST_EXTENSION_PATH } : {}),
  launchArgs: ['--disable-gpu', '--disable-workspace-trust', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])],
  mocha: { timeout: 20000 },
});
