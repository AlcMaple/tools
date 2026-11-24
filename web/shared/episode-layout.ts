export interface SpecialEpisode {
  sort: number | null
  title: string
}

export interface EpisodeLayout {
  main: number
  specials: SpecialEpisode[]
}

export interface EpisodeDetail {
  sort: number | null
  name: string
  nameCn: string
  airdate: string
  duration: string
}

export interface EpisodeDetails {
  main: EpisodeDetail[]
  specials: EpisodeDetail[]
}

// 手帐进度和神回备注一直按连续整数保存；Bangumi 的 SP 却可能从 1 重新编号，甚至有小数话
export function specialAt(layout: EpisodeLayout | undefined, position: number): SpecialEpisode | undefined {
  return layout?.specials[position - layout.main - 1]
}

export function episodeLabel(layout: EpisodeLayout | undefined, position: number): string {
  const special = specialAt(layout, position)
  return special && layout ? `SP ${special.sort ?? position - layout.main}` : `EP ${position}`
}
