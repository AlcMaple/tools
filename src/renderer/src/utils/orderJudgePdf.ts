// 只在放进 PDF 时才动态加载（pdf.js 体积大）。
// worker 直接挂在主线程跑：打包后页面走 file://，Worker 从 file:// 起不来，主线程版本两种环境都能用。
import * as pdfjs from 'pdfjs-dist'
import * as pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs'
import { MAX_DOC_CHARS } from '../../../../web/shared/order-judge'

;(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfWorker

const BINARY = 1 // pdf.js 的 CMapCompressionType.BINARY

class IpcCMapReaderFactory {
  async fetch({ name }: { name: string }): Promise<{ cMapData: Uint8Array; compressionType: number }> {
    const data = await window.orderJudgeApi.cmap(name)
    if (!data) throw new Error(`缺少 CMap ${name}`)
    return { cMapData: data, compressionType: BINARY }
  }
}

export async function pdfPageCount(file: File): Promise<number> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise
  const n = doc.numPages
  void doc.destroy()
  return n
}

export async function pdfText(file: File): Promise<{ text: string; pages: number }> {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    CMapReaderFactory: IpcCMapReaderFactory,
    cMapPacked: true,
    isEvalSupported: false,
  }).promise
  try {
    let out = ''
    for (let i = 1; i <= doc.numPages && out.length < MAX_DOC_CHARS; i++) {
      const content = await (await doc.getPage(i)).getTextContent()
      for (const it of content.items) {
        if ('str' in it) out += it.str + (it.hasEOL ? '\n' : '')
      }
      out += '\n'
    }
    // 部分 PDF 的「一」「小」是康熙部首字形，NFKC 归一成常用字
    return { text: out.normalize('NFKC').trim(), pages: doc.numPages }
  } finally {
    void doc.destroy()
  }
}
