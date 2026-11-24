export interface SpecialEpisode {
  sort: number | null
  title: string
}

export interface EpisodeLayout {
  main: number
  specials: SpecialEpisode[]
}

// 手帐进度和神回备注一直按连续整数保存；Bangumi 的 SP 却可能从 1 重新编号，甚至有小数话
export function specialAt(layout: EpisodeLayout | undefined, position: number): SpecialEpisode | undefined {
  return layout?.specials[position - layout.main - 1]
}

export function episodeLabel(layout: EpisodeLayout | undefined, position: number): string {
  const special = specialAt(layout, position)
  return special && layout ? `SP ${special.sort ?? position - layout.main}` : `EP ${position}`
}

export function episodeBreakdown(layout: EpisodeLayout): string {
  const sp = layout.specials.length === 1 ? episodeLabel(layout, layout.main + 1) : `${layout.specials.length} 集 SP`
  return layout.main ? `正篇 ${layout.main} 集 · ${sp}` : sp
}
