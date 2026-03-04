#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const env = {
  ...process.env,
  FFUI_E2E_LIVE: '1',
};

const buildResult = spawnSync('pnpm', ['run', 'build'], {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});

if (buildResult.status !== 0) {
  process.exit(buildResult.status ?? 1);
}

const testResult = spawnSync('pnpm', ['exec', 'playwright', 'test', '-c', 'playwright.electron.config.ts'], {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});

process.exit(testResult.status ?? 1);
