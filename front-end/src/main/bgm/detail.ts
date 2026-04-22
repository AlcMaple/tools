import * as https from 'https'
import { getMoegirlSynopsis } from '../moegirl/synopsis'

const BASE_API = 'https://api.bgm.tv/v0'
const HEADERS = {
  'User-Agent': 'tools/1.0 (github.com/user/tools)',
  'Accept': 'application/json',
}

// Staff 职位过滤（从 /persons 端点）
const STAFF_ROLES_FROM_PERSONS = ['导演', '监督', '音乐', '系列构成', '脚本', '人物原案', '总作画监督']
// 从 infobox 直接提取的字段（优先级更高）
const INFOBOX_STAFF_KEYS = ['导演', '监督', '音乐', '系列构成', '人物设定', '原作']

export interface StaffEntry {
  role: string
  name: string
  name_cn: string
}

export interface BgmDetail {
  id: number
  title: string
  title_cn: string
  summary: string
  cover: string
  link: string
  score: number
  rank: number
  votes: number
  date: string
  platform: string
  episodes: number
  tags: string[]
  studio: string
  staff: StaffEntry[]
  infobox: Record<string, string>
}

// ── HTTP helper ────────────────────────────────────────────────────────────────

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: HEADERS }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        res.resume()
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))) }
        catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')) })
  })
}

// ── Parsers ────────────────────────────────────────────────────────────────────
function extractChineseSummary(summary: string): { text: string; hasChinese: boolean } {
  if (!summary) return { text: '', hasChinese: false }
  const splitters = [
    /\[简介原文\]/, /\[簡介原文\]/, /【简介原文】/, /【簡介原文】/,
    /\n简介原文：/, /\n簡介原文：/, /\[introduction\]/i
  ]
  let textToProcess = summary
  for (const splitter of splitters) {
    if (splitter.test(textToProcess)) {
      textToProcess = textToProcess.split(splitter)[0].trim()
      break
    }
  }
  const paragraphs = textToProcess.split(/\r?\n/).map((p) => p.trim()).filter(Boolean)
  const chineseParagraphs = paragraphs.filter((p) => {
    const kanaMatches = p.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || []
    const kanaRatio = kanaMatches.length / p.length
    if (kanaMatches.length > 5 && kanaRatio > 0.1) return false
    return true
  })
  if (chineseParagraphs.length === 0) return { text: summary, hasChinese: false }
  return { text: chineseParagraphs.join('\n'), hasChinese: true }
}

function parseInfobox(infobox: unknown[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const item of infobox) {
    const entry = item as Record<string, unknown>
    const key = String(entry.key ?? '')
    let value = entry.value
    if (Array.isArray(value)) {
      value = value.map((v) => String((v as Record<string, unknown>).v ?? '')).filter(Boolean).join('、')
    }
    result[key] = String(value ?? '').trim()
  }
  return result
}

function pickStaffFromPersons(persons: unknown[]): StaffEntry[] {
  const picked: StaffEntry[] = []
  const seenRoles = new Set<string>()
  for (const p of persons) {
    const person = p as Record<string, unknown>
    const relation = String(person.relation ?? '')
    if (!STAFF_ROLES_FROM_PERSONS.some((role) => relation.includes(role))) continue
    if (seenRoles.has(relation)) continue
    seenRoles.add(relation)
    picked.push({
      role: relation,
      name: String(person.name ?? ''),
      name_cn: String(person.name_cn || person.name || ''),
    })
    if (picked.length >= 6) break
  }
  return picked
}

function pickStaffFromInfobox(infobox: Record<string, string>): StaffEntry[] {
  const result: StaffEntry[] = []
  for (const key of INFOBOX_STAFF_KEYS) {
    const value = (infobox[key] ?? '').trim()
    if (!value) continue
    const first = value.split(/[,，、]/)[0].trim()
    if (first) result.push({ role: key, name: first, name_cn: first })
  }
  return result
}

function mergeStaff(fromInfobox: StaffEntry[], fromPersons: StaffEntry[]): StaffEntry[] {
  const merged = [...fromInfobox]
  const seenRoles = new Set(merged.map((s) => s.role))
  for (const s of fromPersons) {
    if (!Array.from(seenRoles).some((existing) => existing.includes(s.role) || s.role.includes(existing))) {
      merged.push(s)
      seenRoles.add(s.role)
    }
    if (merged.length >= 6) break
  }
  return merged
}

// ── Main ───────────────────────────────────────────────────────────────────────

export async function getBgmDetail(subjectId: number): Promise<BgmDetail> {
  const subject = await fetchJson(`${BASE_API}/subjects/${subjectId}`) as Record<string, unknown>

  const infobox = parseInfobox((subject.infobox as unknown[]) ?? [])
  const rating = (subject.rating as Record<string, unknown>) ?? {}
  const images = (subject.images as Record<string, string>) ?? {}

  const cover = images.large || images.common || images.medium || ''
  const tags = ((subject.tags as { name: string }[]) ?? []).slice(0, 8).map((t) => t.name)

  let studio = infobox['动画制作'] || infobox['制作公司'] || ''
  const airDate = String(subject.date ?? '') || infobox['放送开始'] || ''

  const staffInfobox = pickStaffFromInfobox(infobox)

  let staffPersons: StaffEntry[] = []
  try {
    const persons = await fetchJson(`${BASE_API}/subjects/${subjectId}/persons`) as unknown[]
    if (!studio) {
      for (const p of persons) {
        const person = p as Record<string, unknown>
        if (person.type === 3 && String(person.relation ?? '').includes('动画制作')) {
          studio = String(person.name_cn || person.name || '')
          break
        }
      }
    }
    staffPersons = pickStaffFromPersons(persons)
  } catch { /* persons 失败时仅用 infobox */ }

  const staff = mergeStaff(staffInfobox, staffPersons)

  const rawSummary = String(subject.summary ?? '')
  const bgmSummary = extractChineseSummary(rawSummary)
  let finalSummary = bgmSummary.text
  if (!bgmSummary.hasChinese && rawSummary) {
    const searchTitle = String(subject.name_cn || subject.name || '').trim()
    if (searchTitle) {
      const aliases = (infobox['别名'] ?? '')
        .split(/[、,，]/)
        .map((s) => s.trim())
        .filter(Boolean)
      try {
        const moe = await getMoegirlSynopsis(searchTitle, aliases)
        if (moe) {
          const moeCheck = extractChineseSummary(moe)
          if (moeCheck.hasChinese) finalSummary = moeCheck.text
        }
      } catch { /* moegirl 失败时回退到 BGM 原文 */ }
    }
  }

  return {
    id: Number(subject.id),
    title: String(subject.name ?? ''),
    title_cn: String(subject.name_cn ?? ''),
    summary: finalSummary,
    cover,
    link: `https://bgm.tv/subject/${subjectId}`,
    score: Number(rating.score ?? 0),
    rank: Number(rating.rank ?? 0),
    votes: Number(rating.total ?? 0),
    date: airDate,
    platform: String(subject.platform ?? ''),
    episodes: Number(subject.eps ?? 0),
    tags,
    studio,
    staff,
    infobox,
  }
}
