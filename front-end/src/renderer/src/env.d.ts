import type { BgmSearchResult, BgmDetail } from './types/bgm'

declare global {
  interface Window {
    versions: {
      node: () => string
      chrome: () => string
      electron: () => string
    }
    bgmApi: {
      search: (keyword: string) => Promise<BgmSearchResult[]>
      detail: (subjectId: number) => Promise<BgmDetail>
    }
  }
}
