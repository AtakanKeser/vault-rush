import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement>
const base = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

export const IconLogo = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="7.5" />
    <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
  </svg>
)
export const IconOverview = (p: P) => (
  <svg {...base} {...p}>
    <rect x="3" y="3" width="8" height="8" rx="2" />
    <rect x="13" y="3" width="8" height="5" rx="2" />
    <rect x="13" y="10" width="8" height="11" rx="2" />
    <rect x="3" y="13" width="8" height="8" rx="2" />
  </svg>
)
export const IconEvents = (p: P) => (
  <svg {...base} {...p}>
    <rect x="3" y="5" width="18" height="16" rx="2.5" />
    <path d="M3 10h18M8 3v4M16 3v4" />
    <path d="M8 15l2 2 4-4" />
  </svg>
)
export const IconPlayers = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
  </svg>
)
export const IconSystem = (p: P) => (
  <svg {...base} {...p}>
    <rect x="3" y="4" width="18" height="6" rx="2" />
    <rect x="3" y="14" width="18" height="6" rx="2" />
    <path d="M7 7h.01M7 17h.01" strokeWidth="2.6" />
  </svg>
)
export const IconExperiments = (p: P) => (
  <svg {...base} {...p}>
    <path d="M9 3h6M10 3v6.5L4.5 19a1.5 1.5 0 0 0 1.3 2.2h12.4a1.5 1.5 0 0 0 1.3-2.2L14 9.5V3" />
    <path d="M7.5 15h9" />
  </svg>
)
export const IconDice = (p: P) => (
  <svg {...base} {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
    <circle cx="8.5" cy="8.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="8.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="8.5" cy="15.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="15.5" r="1.1" fill="currentColor" stroke="none" />
  </svg>
)
export const IconCheck = (p: P) => (
  <svg {...base} {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
)
export const IconCheckCircle = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 12.5l2.5 2.5 4.5-5" />
  </svg>
)
export const IconX = (p: P) => (
  <svg {...base} {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
)
export const IconAlert = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 3.5l9.5 16.5H2.5L12 3.5z" />
    <path d="M12 10v4.5M12 17.5h.01" strokeWidth="2.4" />
  </svg>
)
export const IconInfo = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" strokeWidth="2.4" />
  </svg>
)
export const IconRefresh = (p: P) => (
  <svg {...base} {...p}>
    <path d="M20 12a8 8 0 1 1-2.35-5.65" />
    <path d="M20 4v5h-5" />
  </svg>
)
export const IconSearch = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </svg>
)
export const IconArrowLeft = (p: P) => (
  <svg {...base} {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </svg>
)
export const IconArrowRight = (p: P) => (
  <svg {...base} {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
)
export const IconChevronRight = (p: P) => (
  <svg {...base} {...p}>
    <path d="M9 6l6 6-6 6" />
  </svg>
)
export const IconEye = (p: P) => (
  <svg {...base} {...p}>
    <path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </svg>
)
export const IconRestore = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 12a8 8 0 1 0 2.35-5.65" />
    <path d="M4 4v5h5" />
    <path d="M12 8v4.5l3 1.8" />
  </svg>
)
export const IconLogout = (p: P) => (
  <svg {...base} {...p}>
    <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" />
    <path d="M15 8l5 4-5 4M20 12H9" />
  </svg>
)
export const IconKey = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="8" cy="14" r="4.5" />
    <path d="M11.5 10.5L20 2M16 6l3 3M14 8l2 2" />
  </svg>
)
export const IconGift = (p: P) => (
  <svg {...base} {...p}>
    <rect x="3" y="9" width="18" height="12" rx="2" />
    <path d="M3 13h18M12 9v12" />
    <path d="M12 9c-2.5 0-4.5-1.3-4.5-3S9 3 10 3c1.6 0 2 2.5 2 6zM12 9c2.5 0 4.5-1.3 4.5-3S15 3 14 3c-1.6 0-2 2.5-2 6z" />
  </svg>
)
export const IconClock = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.5 2" />
  </svg>
)
export const IconPulse = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />
  </svg>
)
export const IconLock = (p: P) => (
  <svg {...base} {...p}>
    <rect x="4.5" y="10" width="15" height="11" rx="2.5" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </svg>
)
export const IconSpinner = (p: P) => (
  <svg {...base} {...p} className={`spin ${p.className ?? ''}`}>
    <path d="M12 3a9 9 0 1 0 9 9" />
  </svg>
)
