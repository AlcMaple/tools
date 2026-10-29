// 浏览器读不到文件的真实路径，只能拿到文件名；这里用 File System Access API 记住用户选过的每个本机文件句柄（存 IndexedDB，
// 按「资料类型 + 文件名」一条，和设置里的网页路径一一对应），之后打开页面时逐个重读，本地改过就覆盖上传。
// 句柄权限被浏览器收回时，借用户页面上的第一次点击 / 按键重新申请。
import type { DocKind } from '../../shared/order-judge-api'

interface Handle {
  name: string
  getFile(): Promise<File>
  queryPermission(o: { mode: 'read' }): Promise<PermissionState>
  requestPermission(o: { mode: 'read' }): Promise<PermissionState>
}

type Picker = (o: { types: { accept: Record<string, string[]> }[]; multiple: false; startIn?: Handle }) => Promise<Handle[]>

const picker = (): Picker | null => (window as unknown as { showOpenFilePicker?: Picker }).showOpenFilePicker ?? null

export const canLink = (): boolean => picker() !== null

// 服务端网页路径就是文件名，句柄按同样的键存
const key = (kind: DocKind, name: string): string => `${kind}\n${name}`

const open = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const req = indexedDB.open('order-judge-linked', 1)
  req.onupgradeneeded = () => req.result.createObjectStore('handles')
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
})

async function store<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction('handles', mode).objectStore('handles'))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally { db.close() }
}

const load = (kind: DocKind, name: string): Promise<Handle | undefined> => store('readonly', s => s.get(key(kind, name)) as IDBRequest<Handle | undefined>)

export async function linkedNames(kind: DocKind): Promise<string[]> {
  try {
    const keys = await store('readonly', s => s.getAllKeys())
    return keys.filter((k): k is string => typeof k === 'string' && k.startsWith(`${kind}\n`)).map(k => k.slice(kind.length + 1))
  } catch { return [] }
}

export const forgetLinked = async (kind: DocKind, name: string): Promise<void> => {
  try { await store('readwrite', s => s.delete(key(kind, name))) } catch { /* 句柄库不可用时没有可清的东西 */ }
}

// from：从设置里某一条打开时，系统选择窗口直接停在那个文件所在的文件夹，路径由系统窗口自己显示
export async function pickLinked(kind: DocKind, from?: string): Promise<File | null> {
  const show = picker()
  if (!show) return null
  let start: Handle | undefined
  if (from) { try { start = await load(kind, from) } catch { start = undefined } }
  let handle: Handle
  try {
    [handle] = await show({ types: [{ accept: { 'text/markdown': ['.md', '.markdown'], 'text/plain': ['.txt'] } }], multiple: false, ...(start ? { startIn: start } : {}) })
  } catch (e) {
    if ((e as Error).name === 'AbortError') return null
    throw e
  }
  await store('readwrite', s => s.put(handle, key(kind, handle.name)))
  return handle.getFile()
}

// 'ask'：浏览器要求用户手势才能再读，调用方在下一次手势里带 ask=true 重来
export async function readLinked(kind: DocKind, name: string, ask = false): Promise<{ file: File } | 'none' | 'ask' | 'gone'> {
  let handle: Handle | undefined
  try { handle = await load(kind, name) } catch { return 'none' }
  if (!handle) return 'none'
  try {
    let perm = await handle.queryPermission({ mode: 'read' })
    if (perm !== 'granted' && ask) perm = await handle.requestPermission({ mode: 'read' })
    if (perm !== 'granted') return 'ask'
    return { file: await handle.getFile() }
  } catch {
    return 'gone'
  }
}
