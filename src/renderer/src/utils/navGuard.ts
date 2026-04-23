/**
 * Module-level navigation guard for HashRouter environments.
 * Settings registers a listener when dirty; Sidebar calls requestNavigation
 * before proceeding so Settings can show its unsaved-changes dialog.
 */
type Listener = (to: string) => void

let _listener: Listener | null = null

export const navGuard = {
  setListener: (fn: Listener | null): void => {
    _listener = fn
  },
  isActive: (): boolean => _listener !== null,
  /** Returns true if navigation should proceed, false if blocked. */
  requestNavigation: (to: string): boolean => {
    if (_listener) {
      _listener(to)
      return false
    }
    return true
  },
}
