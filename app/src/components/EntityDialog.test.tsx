// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EntityDialog } from './EntityDialog'

describe('EntityDialog', () => {
  it('acts as a modal, closes on Escape, and restores prior focus', () => {
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    const onClose = vi.fn()
    const view = render(<EntityDialog onClose={onClose}><input aria-label="Name" /></EntityDialog>)
    const dialog = view.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(view.getByLabelText('Name'))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    view.unmount()
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })
})
