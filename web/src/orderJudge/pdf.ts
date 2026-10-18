// 只在放进 PDF 时才动态加载（pdf.js 体积大）。CMap 由 vite.config.ts 的插件出在 /pdfjs/cmaps/。
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { MAX_DOC_CHARS } from '../../shared/order-judge'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const open = async (file: File) => pdfjs.getDocument({
  data: new Uint8Array(await file.arrayBuffer()),
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  isEvalSupported: false,
}).promise

export async function pdfPageCount(file: File): Promise<number> {
  const doc = await open(file)
  const n = doc.numPages
  void doc.destroy()
  return n
}

export async function pdfText(file: File): Promise<{ text: string; pages: number }> {
  const doc = await open(file)
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
