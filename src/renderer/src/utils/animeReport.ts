// MyAnime 极简报告 —— 生成 QQ 邮箱用的 HTML 邮件正文，仿原 PDF 视觉：
// 米白底 + 黑色正文 + 红色编号 + 大号黑色 section 标题 + 红色加粗 section 分隔。
//
// 所有样式都内联（style="..."）—— QQ 邮箱 / 主流手机邮件 app 会激进剥离
// <style> 块和外部样式表，inline style 是唯一稳定的样式通道。
//
// 字体：用 `-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`
// 系统栈，让 iOS / macOS / Windows / Android 各看各的本地字体，PDF 的"中文宋体
// 偏正经"那种风格保留下来（PingFang/微软雅黑而不是 Arial）。
//
// 宽度：max-width 600px 居中。手机邮件 app 会按视口宽度自动适配（< 600 时
// 容器自适应填满），桌面上保持 PDF 那种"窄页面、易读行长"的感觉。

import type { AnimeTrack } from '../stores/animeTrackStore'
import { compressGoodEpisodes } from '../stores/animeTrackStore'
import type { Recommendation } from '../stores/recommendationStore'

// ── HTML 转义 ────────────────────────────────────────────────────────────────

const ESC_MAP: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}
function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ESC_MAP[c]!)
}

// ── 显示标题 ────────────────────────────────────────────────────────────────

function displayTitle(t: { title: string; titleCn?: string }): string {
  return t.titleCn || t.title
}

// ── 集数文本 ────────────────────────────────────────────────────────────────
//
// 极简报告只关心"看到第几集"，不显示总集数 —— 总集数信息冗余（在追番列表
// 里的番都没看完，看到几就是几），手机扫读时去掉 "/12" 这种尾巴行更短更清爽。

function episodeText(episode: number): string {
  return `${episode}`
}

// ── 排序 ────────────────────────────────────────────────────────────────────
//
// 用户要求"统一按添加日期"——新加的在最上面（倒序）。
// tracks 用 startedAt，recs 用 createdAt，都是 ISO，字符串比较即可（ISO 字符串
// 的字典序跟时间序一致）。

function sortByAddedDesc<T extends { startedAt?: string; createdAt?: string }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => {
    const da = a.startedAt ?? a.createdAt ?? ''
    const db = b.startedAt ?? b.createdAt ?? ''
    return db.localeCompare(da)
  })
}

// ── Section 渲染 ────────────────────────────────────────────────────────────
//
// 每个 section 都是「红色装饰条 + 黑色标题 + 计数徽章 + 内容」的三段式,
// 跟原 PDF 的"加粗黑色 section header"对齐。
// 空数据时显示一行米色"（本期无新增）"提示，不删 section —— 保持邮件结构稳定,
// 让用户每次都看到一致的"这三块都在"心智地图。

function sectionHeader(label: string, count: number): string {
  return `
    <div style="margin:32px 0 14px;border-bottom:2px solid #c91432;padding-bottom:8px;">
      <span style="display:inline-block;width:4px;height:18px;background:#c91432;margin-right:10px;vertical-align:-3px;"></span>
      <span style="font-size:18px;font-weight:900;letter-spacing:1px;color:#1a1a1a;">${esc(label)}</span>
      <span style="font-size:12px;font-weight:600;color:#c91432;margin-left:10px;letter-spacing:0.5px;">${count} 部</span>
    </div>
  `
}

function emptyLine(): string {
  return `
    <p style="margin:6px 0;font-size:13px;color:#9a948a;font-style:italic;">（本期无新增）</p>
  `
}

// ── 追番列表 ────────────────────────────────────────────────────────────────
//
// 仿 PDF "1、动漫名：集数" 格式。number 用红色加粗，名字黑色，集数低饱和灰。

function renderWatchingList(tracks: AnimeTrack[]): string {
  if (tracks.length === 0) return emptyLine()
  return tracks.map((t, i) => `
    <p style="margin:5px 0;font-size:14px;line-height:1.65;color:#1a1a1a;">
      <span style="color:#c91432;font-weight:700;margin-right:4px;">${i + 1}、</span>
      <span style="font-weight:500;">${esc(displayTitle(t))}</span>
      <span style="color:#6a655d;">：${esc(episodeText(t.episode))}</span>
    </p>
  `).join('')
}

// ── 推荐列表 ────────────────────────────────────────────────────────────────
//
// 推荐只要"看一眼名字"，所以更紧凑：编号 + 名字，省去状态 / 推荐对象等冗余。

function renderRecommendList(recs: Recommendation[]): string {
  if (recs.length === 0) return emptyLine()
  return recs.map((r, i) => `
    <p style="margin:5px 0;font-size:14px;line-height:1.65;color:#1a1a1a;">
      <span style="color:#c91432;font-weight:700;margin-right:4px;">${i + 1}、</span>
      <span style="font-weight:500;">${esc(displayTitle(r))}</span>
    </p>
  `).join('')
}

// ── 好看集 ──────────────────────────────────────────────────────────────────
//
// 跟 PDF 一致：动漫名 + 紧凑集号字符串（"1、4-5、16-19"）。
// 集号用 compressGoodEpisodes 折叠 —— 跟应用里 ✨ chip 的展示口径一致。

function renderGoodEpisodes(tracks: AnimeTrack[]): string {
  if (tracks.length === 0) return emptyLine()
  return tracks.map(t => `
    <p style="margin:5px 0;font-size:14px;line-height:1.65;color:#1a1a1a;">
      <span style="font-weight:500;">${esc(displayTitle(t))}</span>
      <span style="color:#6a655d;">：${esc(compressGoodEpisodes(t.goodEpisodes))}</span>
    </p>
  `).join('')
}

// ── 顶层 builder ───────────────────────────────────────────────────────────

interface ReportInput {
  tracks: AnimeTrack[]
  recommendations: Recommendation[]
}

/**
 * 拼好的 HTML 邮件正文（不含 main 进程追加的发件落款）。
 *
 * 内部过滤规则：
 *   - 追番列表：排除 status === 'completed'（看完了不用再追）
 *   - 推荐：排除 status === 'rejected'（已经拒了不用看）
 *   - 好看集：所有有标记的 track（不论状态），完结番的好看集仍然值得回味
 *
 * 三段都空时返回带"本期无更新"提示的极简版，让"空发也发"路径有意义。
 */
export function buildAnimeReportHtml({ tracks, recommendations }: ReportInput): string {
  const watching = sortByAddedDesc(tracks.filter(t => t.status !== 'completed'))
  const recs = sortByAddedDesc(recommendations.filter(r => r.status !== 'rejected'))
  const goodEps = sortByAddedDesc(tracks.filter(t => t.goodEpisodes.length > 0))
  const allEmpty = watching.length === 0 && recs.length === 0 && goodEps.length === 0

  const dateLabel = (() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })()

  // PDF 风格容器：米白底 + 居中 + 阴影一点点。手机视口 < 600 时浏览器会
  // 自动让 max-width 兜住实际宽度，不会横向滚动。
  const containerStyle = [
    'max-width:600px',
    'margin:0 auto',
    'padding:32px 36px 28px',
    'background:#fdfcf8',
    'border:1px solid #e8e0d6',
    'border-radius:12px',
    'font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
    'color:#1a1a1a',
  ].join(';')

  const headerBlock = `
    <div style="text-align:center;margin-bottom:24px;padding-bottom:20px;border-bottom:1px solid #e8e0d6;">
      <div style="font-size:11px;letter-spacing:3px;color:#c91432;font-weight:700;text-transform:uppercase;margin-bottom:6px;">
        My Anime Report
      </div>
      <h1 style="margin:0;font-size:26px;font-weight:900;letter-spacing:1px;color:#1a1a1a;">
        我的追番
      </h1>
      <div style="margin-top:8px;font-size:12px;color:#9a948a;letter-spacing:1px;">
        ${esc(dateLabel)}
      </div>
    </div>
  `

  // 三段全空：跳过 section header，给一个温柔的"本期无更新"占位整页。
  if (allEmpty) {
    return `
      <div style="background:#f3efe7;padding:24px 12px;">
        <div style="${containerStyle}">
          ${headerBlock}
          <div style="text-align:center;padding:40px 0 20px;color:#9a948a;">
            <div style="font-size:48px;line-height:1;margin-bottom:12px;">✦</div>
            <p style="margin:0;font-size:14px;letter-spacing:1px;">本期无更新</p>
            <p style="margin:8px 0 0;font-size:11px;color:#bdb6a8;">追番、推荐、好看集都是空的</p>
          </div>
        </div>
      </div>
    `
  }

  return `
    <div style="background:#f3efe7;padding:24px 12px;">
      <div style="${containerStyle}">
        ${headerBlock}

        ${sectionHeader('追番列表', watching.length)}
        ${renderWatchingList(watching)}

        ${sectionHeader('推荐', recs.length)}
        ${renderRecommendList(recs)}

        ${sectionHeader('好看集', goodEps.length)}
        ${renderGoodEpisodes(goodEps)}
      </div>
    </div>
  `
}
