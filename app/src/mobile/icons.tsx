// One stroke-icon set for the companion (24px grid, 1.8 stroke, round caps),
// replacing mixed Unicode glyphs whose weight and size varied by font.
import type { ReactNode } from 'react'

function Svg({ size = 22, children, fill }: { size?: number; children: ReactNode; fill?: boolean }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'}
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

type P = { size?: number }

/** terminal window: sessions */
export const IconAgents = ({ size }: P) => (
  <Svg size={size}><rect x="3" y="4.5" width="18" height="15" rx="3" /><path d="M7.5 10l2.5 2-2.5 2M12.5 14.5h4" /></Svg>
)
/** tray: things waiting on you */
export const IconInbox = ({ size }: P) => (
  <Svg size={size}><path d="M4 13.5l2.2-7.1A2 2 0 0 1 8.1 5h7.8a2 2 0 0 1 1.9 1.4L20 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z" /><path d="M4 13.5h4.5l1 2h5l1-2H20" /></Svg>
)
/** board columns: tasks */
export const IconTasks = ({ size }: P) => (
  <Svg size={size}><rect x="3.5" y="4.5" width="5" height="15" rx="1.6" /><rect x="10" y="4.5" width="5" height="10" rx="1.6" /><rect x="16.5" y="4.5" width="4" height="6.5" rx="1.6" /></Svg>
)
/** speech bubble: chat */
export const IconChat = ({ size }: P) => (
  <Svg size={size}><path d="M5 18.5V7a2.5 2.5 0 0 1 2.5-2.5h9A2.5 2.5 0 0 1 19 7v6.5a2.5 2.5 0 0 1-2.5 2.5H8.5z" /><path d="M8.5 9.5h7M8.5 12.5h4.5" /></Svg>
)
/** four-point spark: Master */
export const IconMaster = ({ size }: P) => (
  <Svg size={size}><path d="M12 3.5c.6 4.4 2.6 6.4 7 7-4.4.6-6.4 2.6-7 7-.6-4.4-2.6-6.4-7-7 4.4-.6 6.4-2.6 7-7z" /><path d="M18.5 3.5v3M17 5h3" /></Svg>
)
export const IconBack = ({ size = 22 }: P) => (
  <Svg size={size}><path d="M14.5 5.5L8 12l6.5 6.5" /></Svg>
)
export const IconSend = ({ size = 18 }: P) => (
  <Svg size={size}><path d="M12 19V5.5M6 11.5l6-6 6 6" /></Svg>
)
export const IconPlus = ({ size = 20 }: P) => (
  <Svg size={size}><path d="M12 5v14M5 12h14" /></Svg>
)
export const IconPhoto = ({ size = 20 }: P) => (
  <Svg size={size}><rect x="3.5" y="5" width="17" height="14" rx="3" /><circle cx="9" cy="10" r="1.6" /><path d="M20.5 15.5l-4.5-4.5-8 8" /></Svg>
)
export const IconMic = ({ size = 20 }: P) => (
  <Svg size={size}><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" /></Svg>
)
export const IconKeys = ({ size = 20 }: P) => (
  <Svg size={size}><rect x="2.5" y="6" width="19" height="12" rx="2.5" /><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h1.5M7 14h10" /></Svg>
)
export const IconStop = ({ size = 13 }: P) => (
  <Svg size={size} fill><rect x="5.5" y="5.5" width="13" height="13" rx="2.5" /></Svg>
)
export const IconSearch = ({ size = 17 }: P) => (
  <Svg size={size}><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></Svg>
)
export const IconDownload = ({ size = 18 }: P) => (
  <Svg size={size}><path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14" /></Svg>
)
export const IconShare = ({ size = 16 }: P) => (
  <Svg size={size}><path d="M12 3.5v11M8 7.5l4-4 4 4" /><path d="M7 11H6a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 18 11h-1" /></Svg>
)
export const IconClose = ({ size = 16 }: P) => (
  <Svg size={size}><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" /></Svg>
)
