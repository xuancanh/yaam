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
  return {
    dispatch: vi.fn(),
    stateRef: { current: { addons: [], settings: {} } as unknown as AppState } as MutableRefObject<AppState>,
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
  it('installAddonFromFile reads the picked file and installs it as a file source', async () => {
    const io = fakeIo({ pickFile: vi.fn(async () => '/pkg.yaam.json'), readTextFile: vi.fn(async () => '{"name":"x"}') })
    const c = ctx(io)
    createAddonsActions(c).installAddonFromFile()
    await vi.waitFor(() => expect(c.installPackage).toHaveBeenCalledWith('{"name":"x"}', 'file'))
    expect(io.readTextFile).toHaveBeenCalledWith('/pkg.yaam.json')
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

    await vi.waitFor(() => expect(c.installPackage).toHaveBeenCalled())
    expect(readTextFile).toHaveBeenCalledWith('/addons/scoped/addon.yaml', '/addons/scoped')
    expect(readTextFile).toHaveBeenCalledWith('/addons/scoped/view.html', '/addons/scoped')
  })

  it('installAddonFromUrl fetches http URLs but reads non-http entries as files', async () => {
    const httpIo = fakeIo({ httpGetText: vi.fn(async () => '{"http":1}') })
    createAddonsActions(ctx(httpIo, { installPackage: vi.fn() })).installAddonFromUrl('https://x.dev/a.json')
    await vi.waitFor(() => expect(httpIo.httpGetText).toHaveBeenCalledWith('https://x.dev/a.json'))

    const fileIo = fakeIo({ readTextFile: vi.fn(async () => '{"file":1}') })
    const c = ctx(fileIo)
    createAddonsActions(c).installAddonFromUrl('/local/a.json')
    await vi.waitFor(() => expect(c.installPackage).toHaveBeenCalledWith('{"file":1}', 'file'))
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
