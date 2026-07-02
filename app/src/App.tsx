import { ConductorProvider, useConductor } from './store'
import { TitleBar } from './components/TitleBar'
import { IconRail } from './components/IconRail'
import { Sidebar } from './components/Sidebar'
import { Workspace } from './components/Workspace'
import { Overview } from './components/Overview'
import { Board } from './components/Board'
import { Timeline } from './components/Timeline'
import { UsageView } from './components/UsageView'
import { Schedules } from './components/Schedules'
import { ToolsView } from './components/ToolsView'
import { SettingsView } from './components/SettingsView'
import { SlideOver } from './components/SlideOver'
import { Drawer } from './components/Drawer'
import { CommandPalette } from './components/CommandPalette'
import { Toast } from './components/Toast'

function MainArea() {
  const s = useConductor()
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {s.view === 'workspace' && <Workspace />}
      {s.view === 'overview' && <Overview />}
      {s.view === 'board' && <Board />}
      {s.view === 'timeline' && <Timeline />}
      {s.view === 'usage' && <UsageView />}
      {s.view === 'crons' && <Schedules />}
      {s.view === 'tools' && <ToolsView />}
      {s.view === 'settings' && <SettingsView />}
    </div>
  )
}

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

export default function App() {
  return (
    <ConductorProvider>
      <Shell />
    </ConductorProvider>
  )
}
