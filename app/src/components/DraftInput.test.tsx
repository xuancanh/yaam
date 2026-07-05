// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { render, act, cleanup, fireEvent } from '@testing-library/react'
import { DraftInput } from './DraftInput'

afterEach(cleanup)

function setup(value = 'start', onCommit = vi.fn()) {
  const utils = render(createElement(DraftInput, { value, onCommit, 'aria-label': 'field' }))
  const input = utils.getByLabelText('field') as HTMLInputElement
  return { input, onCommit, ...utils }
}

describe('DraftInput', () => {
  it('edits locally without committing on each keystroke', () => {
    const { input, onCommit } = setup()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'hello' } })
    expect(input.value).toBe('hello')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('commits the draft on blur', () => {
    const { input, onCommit } = setup()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'us-west-2' } })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('us-west-2')
  })

  it('commits on Enter', () => {
    const { input, onCommit } = setup()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('x')
  })

  it('does not commit when the value is unchanged', () => {
    const { input, onCommit } = setup('same')
    fireEvent.focus(input)
    fireEvent.blur(input)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('reverts to the committed value on Escape', () => {
    const { input, onCommit } = setup('keep')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'discard' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('keep')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('syncs from an external value change when not being edited', () => {
    const onCommit = vi.fn()
    const { input, rerender } = setup('one', onCommit)
    act(() => { rerender(createElement(DraftInput, { value: 'two', onCommit, 'aria-label': 'field' })) })
    expect(input.value).toBe('two')
  })
})
