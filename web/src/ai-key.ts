const storageKey = (uid: number): string => `mt.byok.key.${uid}`
export const keyEndpoint = (endpoint: string): string => endpoint.trim().replace(/\/+$/, '')

export function readByokKey(uid: number, endpoint: string, storage?: Pick<Storage, 'getItem'>): string {
  if (!endpoint) return ''
  try {
    const text = (storage ?? localStorage).getItem(storageKey(uid))
    if (!text) return ''
    const saved: unknown = JSON.parse(text)
    return saved && typeof saved === 'object' && 'endpoint' in saved && saved.endpoint === keyEndpoint(endpoint)
      && 'key' in saved && typeof saved.key === 'string' ? saved.key : ''
  } catch {
    return ''
  }
}

export function writeByokKey(uid: number, endpoint: string, key: string, storage?: Pick<Storage, 'setItem' | 'removeItem'>): boolean {
  try {
    const target = storage ?? localStorage
    if (key) target.setItem(storageKey(uid), JSON.stringify({ endpoint: keyEndpoint(endpoint), key }))
    else target.removeItem(storageKey(uid))
    return true
  } catch {
    return false
  }
}
