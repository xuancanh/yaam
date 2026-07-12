import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { YaamProvider } from '@yaam/addon-sdk/react'
import { App } from './App'
// This view is fully self-styled (its own tokens + component classes), so it
// deliberately does NOT import @yaam/addon-sdk/ui.css — that would collide.
import './app.css'

async function boot() {
  // `npm run dev` runs the view standalone in a browser — attach the SDK's
  // host stub (mock state, real permission checks). Inside YAAM the view is an
  // iframe and talks to the real host; this branch is erased from prod builds.
  if (import.meta.env.DEV && window.parent === window) {
    const { createHostStub } = await import('@yaam/addon-sdk/testing')
    createHostStub({ granted: ['state:read', 'tasks', 'schedules', 'storage', 'ui', 'http', 'secrets', 'agent'] })
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
