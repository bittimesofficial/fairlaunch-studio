import { defineConfig } from '@playwright/test';
const port = process.env.FAIRLAUNCH_E2E_PORT || '3000';
export default defineConfig({ testDir: './e2e', use: { baseURL: `http://127.0.0.1:${port}`, browserName: 'chromium' }, webServer: { command: `npm run dev -- --port ${port}`, url: `http://127.0.0.1:${port}`, reuseExistingServer: true, timeout: 120000 } });
