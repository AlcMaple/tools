import { useEffect } from 'react'
import type { WatchMode } from '../api'
import { auth } from '../auth'

declare global {
  interface Window {
    __mapleReturnToTracks?: (player: Window, ownerId: number) => boolean
  }
}

export function allowsTracksPlayerOpener(url: string, mode: WatchMode, enabled: boolean): boolean {
  if (!enabled || mode !== 'online') return false
  try {
    const target = new URL(url, window.location.href)
    return target.origin === window.location.origin && target.pathname === '/api/player/page'
      && !target.username && !target.password
  } catch {
    return false
  }
}

export function tracksPlayerLinkRel(url: string, mode: WatchMode, enabled: boolean): string {
  return allowsTracksPlayerOpener(url, mode, enabled) ? 'opener' : 'noreferrer'
}

export function useTracksPlayerReturn(enabled: boolean, ownerId: number | null): void {
  useEffect(() => {
    if (!enabled || ownerId === null) return
    let mounted = true
    const returnToTracks = (player: Window, returningOwnerId: number): boolean => {
      if (!mounted || ownerId !== returningOwnerId || auth.user?.id !== ownerId
        || window.location.hash !== '#/tracks') return false
      try {
        if (player.closed || player.opener !== window || player.location.origin !== window.location.origin
          || player.location.pathname !== '/api/player/page') return false
        window.focus()
        return true
      } catch {
        return false
      }
    }
    window.__mapleReturnToTracks = returnToTracks
    return () => {
      mounted = false
      if (window.__mapleReturnToTracks === returnToTracks) delete window.__mapleReturnToTracks
    }
  }, [enabled, ownerId])
}
