import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json' with { type: 'json' }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // single source of truth for the running app version — used for the title-bar
  // badge and the addon minAppVersion compatibility check.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'safari15',
  },
})
