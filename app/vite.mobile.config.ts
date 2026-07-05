// Second build target: the phone companion app. Reuses components from src/
// (Markdown, types) but ships as ONE self-contained HTML file that the Rust
// remote server embeds via include_str! — no static hosting, no CDN, works
// behind Cloudflare Tunnel / Tailscale because everything is inlined and all
// API calls are relative.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: 'dist-mobile',
    rollupOptions: { input: 'mobile.html' },
    chunkSizeWarningLimit: 2000,
  },
})
