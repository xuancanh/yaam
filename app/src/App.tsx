import { ConductorProvider, useConductor } from './store'
import { TitleBar } from './components/TitleBar'
import { IconRail } from './components/IconRail'
import { Sidebar } from './components/Sidebar'
import { Workspace } from './components/Workspace'
import { Overview } from './components/Overview'
import { Board } from './components/Board'
import { Timeline } from './components/Timeline'
import { Schedules } from './components/Schedules'
import { TemplatesView } from './components/TemplatesView'
import { ToolsView } from './components/ToolsView'
import { SettingsView } from './components/SettingsView'
import { AddonView } from './components/AddonView'
import { SlideOver } from './components/SlideOver'
import { Drawer } from './components/Drawer'
import { CommandPalette } from './components/CommandPalette'
import { Toast } from './components/Toast'

/** Select the active top-level view from the centralized navigation state. */
function MainArea() {
  const s = useConductor()
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {s.view === 'workspace' && <Workspace />}
      {s.view === 'overview' && <Overview />}
      {s.view === 'board' && <Board />}
      {s.view === 'timeline' && <Timeline />}
      {s.view === 'crons' && <Schedules />}
      {s.view === 'templates' && <TemplatesView />}
      {s.view === 'tools' && <ToolsView />}
      {s.view === 'settings' && <SettingsView />}
      {s.view === 'addon' && <AddonView />}
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
