import { AGENT_IMAGE_LIMITS } from '../../shared/agent-history'

export interface AgentAttachment { key: string; state: 'busy' | 'ready' | 'bad'; url: string; blob: Blob | null; imageId: string | null }

export const agentImageUrl = (sessionId: string, imageId: string) => `/api/agent/sessions/${encodeURIComponent(sessionId)}/images/${imageId}`

// 与接单评估同一口径：长边缩到 1280、白底转 JPEG，原图不出本机。解不开的格式（HEIC 等）直接报错，由调用方标成读不了。
export async function shrinkImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, AGENT_IMAGE_LIMITS.edge / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 不可用')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    if (!blob) throw new Error('JPEG 编码失败')
    if (blob.size > AGENT_IMAGE_LIMITS.bytes) throw new Error('压缩后仍超过上限')
    return blob
  } finally { bitmap.close() }
}

export function imageFiles(list: DataTransferItemList | FileList | null | undefined): File[] {
  if (!list) return []
  const files = 'length' in list && list instanceof FileList ? Array.from(list) : Array.from(list as DataTransferItemList).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((f): f is File => f !== null)
  return files.filter(file => file.type.startsWith('image/'))
}
