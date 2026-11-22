export const GOOD_EPISODE_NOTE_MAX_LENGTH = 60

export interface GoodEpisodeState {
  goodEpisodes: number[]
  goodEpisodeNotes: Record<number, string>
}

export type GoodEpisodeEdit =
  | { kind: 'set-mark'; episode: number; marked: boolean }
  | { kind: 'set-note'; episode: number; text: string }
  | { kind: 'clear' }

export function applyGoodEpisodeEdit(state: GoodEpisodeState, edit: GoodEpisodeEdit): GoodEpisodeState {
  const { goodEpisodes, goodEpisodeNotes } = state
  if (edit.kind === 'clear') {
    return goodEpisodes.length ? { goodEpisodes: [], goodEpisodeNotes: {} } : state
  }

  const { episode } = edit
  const marked = goodEpisodes.includes(episode)
  if (edit.kind === 'set-note') {
    const text = edit.text.trim()
    if (!marked || text === (goodEpisodeNotes[episode] ?? '')) return state
    const notes = { ...goodEpisodeNotes }
    if (text) notes[episode] = text
    else delete notes[episode]
    return { goodEpisodes, goodEpisodeNotes: notes }
  }

  if (marked === edit.marked) return state
  if (edit.marked) {
    return { goodEpisodes: [...goodEpisodes, episode].sort((a, b) => a - b), goodEpisodeNotes }
  }
  const notes = { ...goodEpisodeNotes }
  delete notes[episode]
  return { goodEpisodes: goodEpisodes.filter(n => n !== episode), goodEpisodeNotes: notes }
}
