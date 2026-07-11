// Compile-time drift guard between the app's addon API surface and the SDK's
// hand-maintained mirror (sdk/addon-sdk/src/types.ts). Nothing here exists at
// runtime — if this file stops compiling, the addon platform changed and the
// SDK mirror (plus its runtime tables in sdk/addon-sdk/src/permissions.ts)
// must be updated to match.
import type { AddonApi, AddonTaskSpec } from './addons'
import type { AddonHookName, AddonPermission } from './types'
import type {
  AddonHookName as SdkHookName,
  AddonPermission as SdkPermission,
  AddonTaskSpec as SdkTaskSpec,
  HostAddonApi as SdkHostApi,
} from '../../../sdk/addon-sdk/src/types'

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Expect<T extends true> = T

export type _SdkApiInSync = Expect<MutuallyAssignable<AddonApi, SdkHostApi>>
export type _SdkTaskSpecInSync = Expect<MutuallyAssignable<AddonTaskSpec, SdkTaskSpec>>
export type _SdkPermissionsInSync = Expect<MutuallyAssignable<AddonPermission, SdkPermission>>
export type _SdkHooksInSync = Expect<MutuallyAssignable<AddonHookName, SdkHookName>>
