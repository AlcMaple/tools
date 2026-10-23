import { searchAll } from './api'
import type { GirigiriSearchHit } from './api'
export type { GirigiriSearchHit } from './api'

export const GIRIGIRI_SEARCH_MAX_LENGTH = 100
export type GirigiriSearchResponse = { needsCaptcha: true } | { needsCaptcha: false; data: GirigiriSearchHit[] }
export interface GirigiriCaptcha { imageB64: string; mime: string }

// 保留旧客户端的接口形状；新版公开搜索不再申请或校验旧站验证码。
export async function getGirigiriCaptcha(_uid: number): Promise<GirigiriCaptcha> {
  throw new Error('Girigiri 新版搜索无需验证码，请重新搜索')
}

export async function verifyGirigiriCaptcha(_uid: number, _code: string): Promise<{ success: boolean }> {
  throw new Error('Girigiri 新版搜索无需验证码，请重新搜索')
}

export async function searchGirigiri(_uid: number, keyword: string): Promise<GirigiriSearchResponse> {
  const clean = keyword.trim()
  if (!clean || clean.length > GIRIGIRI_SEARCH_MAX_LENGTH) throw new Error(`搜索词长度需为 1–${GIRIGIRI_SEARCH_MAX_LENGTH} 个字符`)
  return { needsCaptcha: false, data: await searchAll(clean) }
}
