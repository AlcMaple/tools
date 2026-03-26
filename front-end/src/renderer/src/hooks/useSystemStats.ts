import { useState, useEffect } from 'react'
import { downloadStore } from '../stores/downloadStore'

function formatFree(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB FREE`
  if (bytes >= 1e9) return `${Math.round(bytes / 1e9)} GB FREE`
  return `${Math.round(bytes / 1e6)} MB FREE`
}

function formatSpeed(bps: number): string {
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} MB/s`
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} KB/s`
  return '0 KB/s'
}

export function useSystemStats(): {
  diskFreeLabel: string
  diskFreeRaw: number | null
  diskTotal: number | null
  activeTasks: number
  networkOnline: boolean
  speedLabel: string
} {
  const [diskFree, setDiskFree] = useState<number | null>(null)
  const [diskTotal, setDiskTotal] = useState<number | null>(null)
  const [activeTasks, setActiveTasks] = useState(0)
  const [networkOnline, setNetworkOnline] = useState(navigator.onLine)
  const [speedBps, setSpeedBps] = useState(0)

  // Active task count
  useEffect(() => {
    const update = (): void => setActiveTasks(downloadStore.getActiveTasks().length)
    update()
    return downloadStore.subscribe(update)
  }, [])

  // Disk free space — fetch once then every 30s
  useEffect(() => {
    const fetchDisk = async (): Promise<void> => {
      try {
        const { free, total } = await window.systemApi.getDiskFree()
        setDiskFree(free)
        setDiskTotal(total)
      } catch { /* ignore */ }
    }
    fetchDisk()
    const id = setInterval(fetchDisk, 30_000)
    return () => clearInterval(id)
  }, [])

  // Real connectivity check via main process (every 10s)
  useEffect(() => {
    const check = async (): Promise<void> => {
      try {
        const ok = await window.systemApi.checkConnectivity()
        setNetworkOnline(ok)
      } catch { /* ignore */ }
    }
    check()
    const id = setInterval(check, 10_000)
    return () => clearInterval(id)
  }, [])

  // navigator.onLine events as immediate fallback
  useEffect(() => {
    const onOnline = (): void => setNetworkOnline(true)
    const onOffline = (): void => setNetworkOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  // Download speed
  useEffect(() => {
    return window.systemApi.onSpeedUpdate(setSpeedBps)
  }, [])

  return {
    diskFreeLabel: diskFree === null ? '— FREE' : formatFree(diskFree),
    diskFreeRaw: diskFree,
    diskTotal,
    activeTasks,
    networkOnline,
    speedLabel: formatSpeed(speedBps),
  }
}
