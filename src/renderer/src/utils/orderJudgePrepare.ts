// 材料预处理本体在 web/shared/order-judge-prepare.ts（网页版共用）；桌面版在这里接上本机工具兜底
// （wmv / avi、HEIC、doc / pages）和 pdf.js 的 IPC 版 CMap。

import { reportError } from './reportError'
import { prepareMaterials as prepare, type Prepared } from '../../../../web/shared/order-judge-prepare'

export { extOf, imageTileCount, kindOf, type MaterialKind, type Prepared } from '../../../../web/shared/order-judge-prepare'

export function prepareMaterials(pasted: string, files: File[]): Promise<Prepared> {
  return prepare(pasted, files, {
    convert: (kind, bytes, ext) => window.orderJudgeApi.convert(kind, bytes, ext),
    pdfText: async (file) => (await import('./orderJudgePdf')).pdfText(file),
    onError: reportError,
  })
}
