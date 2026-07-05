import { defineConfig } from 'vitest/config'

// Unit tests run in Node against the pure logic modules. Modules that reach the
// Tauri bridge (`./native`) are mocked per-test; nothing here touches a real PTY.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
