// Runtime drift guard: the SDK's permission tables must equal the host's.
// (The type-level guard lives in app/src/core/addon-sdk-compat.ts, inside the
// app's tsc gate.)
import { describe, expect, it } from 'vitest'
import {
  ADDON_RPC_METHODS as APP_RPC,
  ALL_PERMISSIONS as APP_ALL,
  DANGEROUS_PERMISSIONS as APP_DANGEROUS,
  METHOD_PERMISSION as APP_METHODS,
} from '../../../app/src/core/addons'
import { ADDON_RPC_METHODS, ALL_PERMISSIONS, DANGEROUS_PERMISSIONS, METHOD_PERMISSION } from '../src/permissions'

describe('host ↔ sdk permission tables', () => {
  it('METHOD_PERMISSION matches the host exactly', () => {
    expect(METHOD_PERMISSION).toEqual(APP_METHODS)
  })

  it('ADDON_RPC_METHODS matches the host whitelist exactly', () => {
    expect([...ADDON_RPC_METHODS].sort()).toEqual([...APP_RPC].sort())
  })

  it('ALL_PERMISSIONS ids and labels match the host', () => {
    expect(ALL_PERMISSIONS).toEqual(APP_ALL)
  })

  it('DANGEROUS_PERMISSIONS matches the host', () => {
    expect([...DANGEROUS_PERMISSIONS].sort()).toEqual([...APP_DANGEROUS].sort())
  })
})
