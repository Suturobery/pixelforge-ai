// PixelForge AI — SSR-safe media hook: true when the viewport is phone-sized
// (below Tailwind's md breakpoint). Drives the mobile overlay layout (dock
// becomes a drawer, panels default-collapsed).

'use client'

import { useEffect, useState } from 'react'

const QUERY = '(max-width: 767px)'

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia(QUERY)
    const update = () => setMobile(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return mobile
}
