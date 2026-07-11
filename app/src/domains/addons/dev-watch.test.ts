import { describe, expect, it } from 'vitest'
import { createDevAddonWatcher, loadDevFolder } from './dev-watch'
import type { Addon, AppState } from '../../core/types'

const MANIFEST = (version: string) => `manifest: 3
name: Dev Thing
version: ${version}
icon: 🧪
permissions:
  - ui
view: view.html
`

function fakeFs(files: Record<string, string>) {
  return {
    files,
    readTextFile: async (path: string) => {
      const rel = path.replace(/^\/dev\/thing\//, '')
      if (rel in files) return files[rel]
      throw new Error(`no such file: ${path}`)
    },
  }
}

function watcherWith(files: Record<string, string>, addons: Partial<Addon>[]) {
  const fs = fakeFs(files)
  const installs: string[] = []
  const flashes: string[] = []
  const stateRef = {
    current: {
      addons: addons.map(a => ({
        id: 'a1', name: 'Dev Thing', enabled: true, devPath: '/dev/thing', source: 'file', ...a,
      })),
    } as AppState,
  }
  const w = createDevAddonWatcher({
    stateRef,
    readTextFile: fs.readTextFile,
    installPackage: json => installs.push(json),
    flash: t => flashes.push(t),
    logEvent: () => {},
  })
  return { w, fs, installs, flashes, stateRef }
}

describe('loadDevFolder', () => {
  it('loads via any manifest name and resolves view refs', async () => {
    const fs = fakeFs({ 'addon.yaml': MANIFEST('1.0.0'), 'view.html': '<html>hi</html>' })
    const json = JSON.parse(await loadDevFolder(fs.readTextFile, '/dev/thing'))
    expect(json.name).toBe('Dev Thing')
    expect(json.html).toBe('<html>hi</html>')
  })

  it('throws a readable error without a manifest', async () => {
    const fs = fakeFs({})
    await expect(loadDevFolder(fs.readTextFile, '/dev/thing')).rejects.toThrow('no addon.yaml')
  })
})

describe('createDevAddonWatcher', () => {
  it('seeds a baseline on the first tick, reinstalls on change only', async () => {
    const { w, fs, installs, flashes } = watcherWith(
      { 'addon.yaml': MANIFEST('1.0.0'), 'view.html': '<html>v1</html>' }, [{}])
    await w.tick()
    expect(installs).toEqual([]) // baseline, no reload
    await w.tick()
    expect(installs).toEqual([]) // unchanged
    fs.files['view.html'] = '<html>v2</html>'
    await w.tick()
    expect(installs.length).toBe(1)
    expect(installs[0]).toContain('v2')
    expect(flashes.some(f => f.includes('reloaded'))).toBe(true)
    await w.tick()
    expect(installs.length).toBe(1) // stable after reload
  })

  it('ignores disabled and non-dev addons', async () => {
    const { w, installs } = watcherWith(
      { 'addon.yaml': MANIFEST('1.0.0'), 'view.html': 'x' },
      [{ enabled: false }],
    )
    await w.tick()
    await w.tick()
    expect(installs).toEqual([])
  })

  it('flashes a load error once, not every tick', async () => {
    const { w, fs, flashes } = watcherWith({ 'addon.yaml': MANIFEST('1.0.0'), 'view.html': 'x' }, [{}])
    await w.tick()
    delete fs.files['view.html']
    await w.tick()
    await w.tick()
    expect(flashes.filter(f => f.startsWith('dev reload failed')).length).toBe(1)
    // recovery clears the error memory and reloads on the changed content
    fs.files['view.html'] = 'y'
    await w.tick()
    expect(flashes.filter(f => f.includes('reloaded')).length).toBe(1)
  })

  it('start/dispose drive tick on the injected clock', () => {
    const fs = fakeFs({})
    let intervalFn: (() => void) | null = null
    let cleared = false
    const w = createDevAddonWatcher({
      stateRef: { current: { addons: [] } as unknown as AppState },
      readTextFile: fs.readTextFile,
      installPackage: () => {},
      flash: () => {},
      logEvent: () => {},
      clock: {
        setInterval: ((fn: () => void) => { intervalFn = fn; return 1 }) as typeof globalThis.setInterval,
        clearInterval: (() => { cleared = true }) as typeof globalThis.clearInterval,
      },
    })
    w.start()
    expect(intervalFn).not.toBeNull()
    w.dispose()
    expect(cleared).toBe(true)
  })
})
