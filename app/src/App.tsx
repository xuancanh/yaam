import { lazy, Suspense } from 'react'
import { ConductorProvider, useConductorSelector } from './store'
import { TitleBar } from './domains/shell/TitleBar'
import { IconRail } from './domains/shell/IconRail'
import { Sidebar } from './domains/master/Sidebar'
import { Workspace } from './domains/session/Workspace'
import { SlideOver } from './domains/shell/SlideOver'
import { Drawer } from './domains/shell/Drawer'
import { CommandPalette } from './domains/shell/CommandPalette'
import { Toast } from './domains/shell/Toast'
import { RemoteCompanion } from './domains/remote/RemoteCompanion'

// Keep the terminal workspace responsive at startup. Secondary product areas
// are substantial and mutually exclusive, so fetch their UI only on first use.
const ControlCenter = lazy(() => import('./domains/shell/ControlCenter').then(m => ({ default: m.ControlCenter })))
const Board = lazy(() => import('./domains/board/Board').then(m => ({ default: m.Board })))
const Timeline = lazy(() => import('./domains/shell/Timeline').then(m => ({ default: m.Timeline })))
const Schedules = lazy(() => import('./domains/schedules/Schedules').then(m => ({ default: m.Schedules })))
const TemplatesView = lazy(() => import('./domains/schedules/TemplatesView').then(m => ({ default: m.TemplatesView })))
const ToolsView = lazy(() => import('./domains/settings/ToolsView').then(m => ({ default: m.ToolsView })))
const AddonsView = lazy(() => import('./domains/addons/AddonsView').then(m => ({ default: m.AddonsView })))
const ChatView = lazy(() => import('./domains/chat/ChatView').then(m => ({ default: m.ChatView })))
const SettingsView = lazy(() => import('./domains/settings/SettingsView').then(m => ({ default: m.SettingsView })))
const AddonView = lazy(() => import('./domains/addons/AddonView').then(m => ({ default: m.AddonView })))

function ViewFallback() {
  return <div style={{ padding: 24, color: 'var(--dim)', fontSize: 13 }}>Loading view…</div>
}

/** Select the active top-level view from the centralized navigation state. */
function MainArea() {
  const view = useConductorSelector(x => x.view)
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {view === 'workspace' && <Workspace />}
      {view !== 'workspace' && (
        <Suspense fallback={<ViewFallback />}>
          {view === 'overview' && <ControlCenter />}
          {view === 'board' && <Board />}
          {view === 'timeline' && <Timeline />}
          {view === 'crons' && <Schedules />}
          {view === 'templates' && <TemplatesView />}
          {view === 'tools' && <ToolsView />}
          {view === 'addons' && <AddonsView />}
          {view === 'chat' && <ChatView />}
          {view === 'settings' && <SettingsView />}
          {view === 'addon' && <AddonView />}
        </Suspense>
      )}
    </div>
  )
}

/** Compose the persistent title bar, navigation, Master sidebar, and active view. */
function Shell() {
  return (
    <div style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <TitleBar />
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <IconRail />
        <Sidebar />
        <MainArea />
      </div>
      <SlideOver />
      <Drawer />
      <CommandPalette />
      <Toast />
      <RemoteCompanion />
    </div>
  )
}

/** Install the state provider around the complete desktop application shell. */
export default function App() {
  return (
    <ConductorProvider>
      <Shell />
    </ConductorProvider>
  )
}
