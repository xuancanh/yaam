import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { YaamProvider } from '@yaam/addon-sdk/react'
import { App } from './App'
import '@yaam/addon-sdk/ui.css'
import './app.css'

async function boot() {
  // `npm run dev` runs the view standalone in a browser — attach the SDK's
  // host stub (mock state, real permission checks). Inside YAAM the view is
  // an iframe (parent !== window) and talks to the real host; the stub and
  // this branch are erased from production builds entirely.
  if (import.meta.env.DEV && window.parent === window) {
    const { createHostStub } = await import('@yaam/addon-sdk/testing')
    createHostStub()
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <YaamProvider>
        <App />
      </YaamProvider>
    </StrictMode>,
  )
}

void boot()
