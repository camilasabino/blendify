import { useEffect } from 'react'

export function useUnloadWarning(active: boolean) {
  useEffect(() => {
    if (!active) {
      return
    }
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = true
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [active])
}
