import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'

const STORAGE_KEY = 'blendify.scrollPositions'
const MAX_STORED_POSITIONS = 50
const MAX_RESTORE_FRAMES = 30

function isPositionEntry(entry: unknown): entry is [string, number] {
  return (
    Array.isArray(entry) &&
    typeof entry[0] === 'string' &&
    typeof entry[1] === 'number'
  )
}

function readStoredPositions(): Map<string, number> {
  try {
    const entries: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]')
    return new Map(Array.isArray(entries) ? entries.filter(isPositionEntry) : [])
  } catch {
    return new Map()
  }
}

function writeStoredPositions(positions: Map<string, number>): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...positions]))
  } catch {
    return
  }
}

function rememberPosition(positions: Map<string, number>, key: string, top: number) {
  positions.delete(key)
  positions.set(key, top)
  if (positions.size > MAX_STORED_POSITIONS) {
    const oldest = positions.keys().next().value
    if (oldest !== undefined) {
      positions.delete(oldest)
    }
  }
}

function restorePosition(top: number): () => void {
  let frame = 0
  let attempts = 0
  const attempt = () => {
    window.scrollTo(0, top)
    attempts += 1
    if (Math.abs(window.scrollY - top) > 1 && attempts < MAX_RESTORE_FRAMES) {
      frame = window.requestAnimationFrame(attempt)
    }
  }
  attempt()
  return () => window.cancelAnimationFrame(frame)
}

function currentHref(): string {
  const { pathname, search, hash } = window.location
  return pathname + search + hash
}

function focusMainContent() {
  const main = document.querySelector<HTMLElement>('main')
  if (!main || main.contains(document.activeElement)) {
    return
  }
  main.focus({ preventScroll: true })
}

export function useRouteScrollRestoration() {
  const location = useLocation()
  const navigationType = useNavigationType()
  const [positions] = useState(readStoredPositions)
  const currentKey = useRef(location.key)
  const committedHref = useRef(currentHref())
  const previousPathname = useRef<string | null>(null)

  useEffect(() => {
    const { history } = window
    const previousMode = history.scrollRestoration
    history.scrollRestoration = 'manual'
    let frame = 0
    const save = () => {
      frame = 0
      // The URL changes before React commits the next page; scrolls in that gap
      // (such as a Suspense fallback shrinking the page) belong to no entry.
      if (currentHref() !== committedHref.current) {
        return
      }
      rememberPosition(positions, currentKey.current, window.scrollY)
    }
    const onScroll = () => {
      if (frame === 0) {
        frame = window.requestAnimationFrame(save)
      }
    }
    const persist = () => writeStoredPositions(positions)

    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('pagehide', persist)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('pagehide', persist)
      history.scrollRestoration = previousMode
    }
  }, [positions])

  useLayoutEffect(() => {
    const pathnameChanged =
      previousPathname.current !== null &&
      previousPathname.current !== location.pathname
    currentKey.current = location.key
    committedHref.current = currentHref()
    previousPathname.current = location.pathname

    if (location.hash) {
      return
    }
    if (navigationType === 'POP') {
      const saved = positions.get(location.key)
      return saved === undefined ? undefined : restorePosition(saved)
    }
    if (!pathnameChanged) {
      return
    }
    window.scrollTo(0, 0)
    focusMainContent()
  }, [location.key, location.pathname, location.hash, navigationType, positions])
}
