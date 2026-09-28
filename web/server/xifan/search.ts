import { nextXifan } from './next'

export const XIFAN_SEARCH_MAX_LENGTH = 100
export interface XifanSearchHit {
  xifanId: number
  xifanName: string
  cover: string
  episode: string
  year: string
  area: string
}
export type XifanSearchResponse = { needsCaptcha: true } | { needsCaptcha: false; data: XifanSearchHit[] }
export interface XifanCaptcha { imageB64: string; mime: string }

export async function getXifanCaptcha(_uid: number): Promise<XifanCaptcha> {
  throw new Error('稀饭新版搜索和邮箱登录不再使用图片验证码，请刷新页面')
}
export async function verifyXifanCaptcha(_uid: number, _code: string): Promise<{ success: boolean }> {
  throw new Error('稀饭新版搜索不再使用图片验证码，请刷新页面')
}
export async function searchXifan(uid: number, keyword: string): Promise<XifanSearchResponse> {
  const hits = await nextXifan(uid).search(keyword)
  return { needsCaptcha: false, data: hits.map(h => ({ xifanId: h.id, xifanName: h.title, cover: h.cover, episode: h.episode, year: h.year, area: h.area })) }
}
