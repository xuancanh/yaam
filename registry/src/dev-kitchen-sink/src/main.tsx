import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { YaamProvider } from '@yaam/addon-sdk/react'
import { App } from './App'
// This view carries its own copy of the host UI kit (its <style> is the toolkit
// ui.css), so it deliberately does NOT import @yaam/addon-sdk/ui.css.
import './app.css'

async function boot() {
  if (import.meta.env.DEV && window.parent === window) {
    const { createHostStub } = await import('@yaam/addon-sdk/testing')
    createHostStub({ granted: ['state:read', 'sessions:send', 'sessions:launch', 'tasks', 'schedules', 'agent', 'master:prompt', 'ui', 'storage', 'http', 'secrets'] })
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
