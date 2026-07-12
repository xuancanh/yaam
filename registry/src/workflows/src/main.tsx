import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { YaamProvider } from '@yaam/addon-sdk/react'
import { App } from './App'
// This view is fully self-styled, so it deliberately does NOT import
// @yaam/addon-sdk/ui.css — that would collide with its own classes.
import './app.css'

async function boot() {
  if (import.meta.env.DEV && window.parent === window) {
    const { createHostStub } = await import('@yaam/addon-sdk/testing')
    createHostStub({ granted: ['state:read', 'tasks', 'schedules', 'storage', 'ui'] })
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
