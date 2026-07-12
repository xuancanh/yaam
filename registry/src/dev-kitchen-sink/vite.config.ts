import { defineConfig } from 'vite'

export default defineConfig({
  // keep a single React instance even when @yaam/addon-sdk is file:-linked
  resolve: { dedupe: ['react', 'react-dom'] },
})
