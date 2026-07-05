import { ConductorProvider, useConductor } from './store'
import { TitleBar } from './domains/shell/TitleBar'
import { IconRail } from './domains/shell/IconRail'
import { Sidebar } from './domains/master/Sidebar'
import { Workspace } from './domains/session/Workspace'
import { Overview } from './domains/shell/Overview'
import { Board } from './domains/board/Board'
import { Timeline } from './domains/shell/Timeline'
import { Schedules } from './domains/schedules/Schedules'
import { TemplatesView } from './domains/schedules/TemplatesView'
import { ToolsView } from './domains/settings/ToolsView'
import { AddonsView } from './domains/addons/AddonsView'
import { ChatView } from './domains/chat/ChatView'
import { SettingsView } from './domains/settings/SettingsView'
import { AddonView } from './domains/addons/AddonView'
import { SlideOver } from './domains/shell/SlideOver'
import { Drawer } from './domains/shell/Drawer'
import { CommandPalette } from './domains/shell/CommandPalette'
import { Toast } from './domains/shell/Toast'

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
      {s.view === 'addons' && <AddonsView />}
      {s.view === 'chat' && <ChatView />}
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
