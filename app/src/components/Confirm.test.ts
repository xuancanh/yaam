// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { confirmAction } from './Confirm'

const overlay = () => document.body.lastElementChild as HTMLElement | null
const buttons = () => [...document.querySelectorAll('button')] as HTMLButtonElement[]
const byLabel = (label: string) => buttons().find(b => b.textContent === label)!

afterEach(() => {
  document.body.innerHTML = ''
})

describe('confirmAction', () => {
  it('renders title/detail and resolves true on the confirm button', async () => {
    const p = confirmAction({ title: 'Delete session “X”?', detail: 'This cannot be undone.' })
    expect(document.body.textContent).toContain('Delete session “X”?')
    expect(document.body.textContent).toContain('This cannot be undone.')
    byLabel('Delete').click()
    await expect(p).resolves.toBe(true)
    expect(overlay()).toBeNull() // dialog removed
  })

  it('resolves false on Cancel', async () => {
    const p = confirmAction({ title: 'Delete?' })
    byLabel('Cancel').click()
    await expect(p).resolves.toBe(false)
  })

  it('resolves false on backdrop click and on Escape', async () => {
    const p1 = confirmAction({ title: 'Backdrop?' })
    overlay()!.click()
    await expect(p1).resolves.toBe(false)

    const p2 = confirmAction({ title: 'Escape?' })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await expect(p2).resolves.toBe(false)
    expect(document.body.querySelectorAll('div').length).toBe(0)
  })

  it('uses a custom confirm label and non-danger styling for reversible actions', async () => {
    const p = confirmAction({ title: 'Archive task?', confirmLabel: 'Archive', danger: false })
    const btn = byLabel('Archive')
    expect(btn.style.background).not.toContain('var(--red)')
    btn.click()
    await expect(p).resolves.toBe(true)
  })

  it('a second request replaces the first (never stacks dialogs)', async () => {
    const first = confirmAction({ title: 'First?' })
    const second = confirmAction({ title: 'Second?' })
    expect(document.body.textContent).not.toContain('First?')
    expect(document.body.textContent).toContain('Second?')
    // the replaced dialog must not leave its caller hanging: it resolves false
    await expect(first).resolves.toBe(false)
    byLabel('Delete').click()
    await expect(second).resolves.toBe(true)
  })
})
