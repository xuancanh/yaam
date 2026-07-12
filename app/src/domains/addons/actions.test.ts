import { describe, expect, it, vi } from 'vitest'
import { createAddonsActions } from './actions'
import type { AddonsActionsCtx } from './actions'
import type { PackageIoPort } from './ports'
import type { AppState } from '../../core/types'
import type { MutableRefObject } from 'react'

function fakeIo(over: Partial<PackageIoPort> = {}): PackageIoPort {
  return {
    pickFile: vi.fn(async () => null),
    pickFolder: vi.fn(async () => null),
    pickSavePath: vi.fn(async () => null),
    readTextFile: vi.fn(async () => ''),
    writeTextFile: vi.fn(async () => {}),
    httpGetText: vi.fn(async () => ''),
    ...over,
  }
}

function ctx(io: PackageIoPort, over: Partial<AddonsActionsCtx> = {}): AddonsActionsCtx {
  // live dispatch so staging writes addonInstall onto stateRef and a later
  // confirmAddonInstall can read it back
  const stateRef = { current: { addons: [], settings: {}, addonInstall: null } as unknown as AppState } as MutableRefObject<AppState>
  return {
    dispatch: vi.fn((f: (s: AppState) => AppState) => { stateRef.current = f(stateRef.current) }),
    stateRef,
    flash: vi.fn(),
    installPackage: vi.fn(),
    sendAddonChat: vi.fn(),
    makeAddonApi: vi.fn(),
    disposeAddon: vi.fn(),
    io,
    ...over,
  }
}

describe('createAddonsActions install flows', () => {
  it('installAddonFromFile stages a preview, then confirm commits it as a file source', async () => {
    const pkg = '{"name":"x","html":"<b>hi</b>"}'
    const io = fakeIo({ pickFile: vi.fn(async () => '/pkg.yaam.json'), readTextFile: vi.fn(async () => pkg) })
    const c = ctx(io)
    const actions = createAddonsActions(c)
    actions.installAddonFromFile()
    // the picked package is staged for the permission preview — not installed yet
    await vi.waitFor(() => expect(c.stateRef.current.addonInstall).toMatchObject({ json: pkg, source: 'file', name: 'x' }))
    expect(io.readTextFile).toHaveBeenCalledWith('/pkg.yaam.json')
    expect(c.installPackage).not.toHaveBeenCalled()
    // confirming commits it
    actions.confirmAddonInstall()
    expect(c.installPackage).toHaveBeenCalledWith(pkg, 'file')
    expect(c.stateRef.current.addonInstall).toBeNull()
  })

  it('cancelAddonInstall drops the staged install without committing', async () => {
    const pkg = '{"name":"x","html":"<b>hi</b>"}'
    const io = fakeIo({ pickFile: vi.fn(async () => '/pkg.yaam.json'), readTextFile: vi.fn(async () => pkg) })
    const c = ctx(io)
    const actions = createAddonsActions(c)
    actions.installAddonFromFile()
    await vi.waitFor(() => expect(c.stateRef.current.addonInstall).not.toBeNull())
    actions.cancelAddonInstall()
    expect(c.stateRef.current.addonInstall).toBeNull()
    expect(c.installPackage).not.toHaveBeenCalled()
  })

  it('installAddonFromFile is a no-op when the picker is cancelled', async () => {
    const io = fakeIo({ pickFile: vi.fn(async () => null) })
    const c = ctx(io)
    createAddonsActions(c).installAddonFromFile()
    await Promise.resolve()
    expect(io.readTextFile).not.toHaveBeenCalled()
    expect(c.installPackage).not.toHaveBeenCalled()
  })

  it('installAddonFromFile surfaces a read failure as a flash', async () => {
    const io = fakeIo({ pickFile: vi.fn(async () => '/pkg'), readTextFile: vi.fn(async () => { throw new Error('bad file') }) })
    const c = ctx(io)
    createAddonsActions(c).installAddonFromFile()
    await vi.waitFor(() => expect(c.flash).toHaveBeenCalledWith(expect.stringContaining('bad file')))
    expect(c.installPackage).not.toHaveBeenCalled()
  })

  it('confines every folder-package read to the selected directory', async () => {
    const readTextFile = vi.fn(async (path: string) => path.endsWith('addon.yaml')
      ? 'name: scoped\nview: view.html'
      : '<main>safe</main>')
    const io = fakeIo({ pickFolder: vi.fn(async () => '/addons/scoped'), readTextFile })
    const c = ctx(io)

    createAddonsActions(c).installAddonFromFolder()

    await vi.waitFor(() => expect(c.stateRef.current.addonInstall).not.toBeNull())
    expect(c.stateRef.current.addonInstall).toMatchObject({ name: 'scoped', source: 'file' })
    expect(readTextFile).toHaveBeenCalledWith('/addons/scoped/addon.yaml', '/addons/scoped')
    expect(readTextFile).toHaveBeenCalledWith('/addons/scoped/view.html', '/addons/scoped')
  })

  it('installAddonFromUrl fetches http URLs but reads non-http entries as files', async () => {
    const httpIo = fakeIo({ httpGetText: vi.fn(async () => '{"name":"h","html":"<b>h</b>"}') })
    const httpCtx = ctx(httpIo)
    createAddonsActions(httpCtx).installAddonFromUrl('https://x.dev/a.json')
    await vi.waitFor(() => expect(httpIo.httpGetText).toHaveBeenCalledWith('https://x.dev/a.json'))
    await vi.waitFor(() => expect(httpCtx.stateRef.current.addonInstall).toMatchObject({ source: 'url' }))

    const filePkg = '{"name":"f","html":"<b>f</b>"}'
    const fileIo = fakeIo({ readTextFile: vi.fn(async () => filePkg) })
    const c = ctx(fileIo)
    createAddonsActions(c).installAddonFromUrl('/local/a.json')
    await vi.waitFor(() => expect(c.stateRef.current.addonInstall).toMatchObject({ json: filePkg, source: 'file' }))
    expect(fileIo.httpGetText).not.toHaveBeenCalled()
  })

  it('exportAddon writes the package to the chosen path', async () => {
    const io = fakeIo({ pickSavePath: vi.fn(async () => '/out.yaam.json') })
    const c = ctx(io, {
      stateRef: { current: { addons: [{ id: 'ad1', name: 'My Addon' }] } as unknown as AppState } as MutableRefObject<AppState>,
    })
    createAddonsActions(c).exportAddon('ad1')
    await vi.waitFor(() => expect(io.writeTextFile).toHaveBeenCalledWith('/out.yaam.json', expect.any(String)))
    expect(io.pickSavePath).toHaveBeenCalledWith(expect.stringContaining('My-Addon'))
  })
})
