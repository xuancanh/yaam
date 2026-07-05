import { describe, expect, it } from 'vitest'
import { expectArray, expectObject, expectObjectArray } from './validate'

describe('IPC response validators', () => {
  it('expectArray passes arrays and rejects non-arrays with an attributed error', () => {
    expect(expectArray([1, 2], 'listDir')).toEqual([1, 2])
    expect(() => expectArray({}, 'listDir')).toThrow(/listDir: expected an array.*object/)
    expect(() => expectArray(null, 'listDir')).toThrow(/got null/)
  })

  it('expectObject requires the given keys', () => {
    expect(expectObject({ a: 1, b: 2 }, ['a'], 'x')).toEqual({ a: 1, b: 2 })
    expect(() => expectObject({ a: 1 }, ['a', 'b'], 'gitStatus')).toThrow(/missing "b"/)
    expect(() => expectObject([], ['a'], 'gitStatus')).toThrow(/expected an object.*array/)
    expect(() => expectObject(null, ['a'], 'gitStatus')).toThrow(/got null/)
  })

  it('expectObjectArray validates every element and attributes the index', () => {
    expect(expectObjectArray([{ id: 1 }], ['id'], 'chatSearch')).toEqual([{ id: 1 }])
    expect(() => expectObjectArray([{ id: 1 }, { nope: 2 }], ['id'], 'chatSearch')).toThrow(/chatSearch\[1\]: .*missing "id"/)
    expect(() => expectObjectArray('nope', ['id'], 'chatSearch')).toThrow(/chatSearch: expected an array/)
  })
})
