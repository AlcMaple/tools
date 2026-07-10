// B 站在线播放的数据形状 —— 与 main/bili/api.ts 的导出一一对应。

/** 稿件的一个分 P。合集里 page 就是链接上的 &p=N。 */
export interface BiliPage {
  page: number
  cid: number
  part: string
  duration: number
}

export interface BiliVideoInfo {
  bvid: string
  aid: number
  title: string
  pages: BiliPage[]
}

/** DASH 里一路音轨或视轨:单文件 fMP4 + SegmentBase 字节范围。 */
export interface BiliTrack {
  /** 视轨里是 qn(80=1080P…),音轨里是音质 id。 */
  id: number
  /** 主进程已包成 mtmedia:// 代理 URL(带防盗链 Referer),直接喂给播放器。 */
  baseUrl: string
  bandwidth: number
  codecs: string
  mimeType: string
  initRange: string
  indexRange: string
  /** 音轨为 0。 */
  width: number
  height: number
}

export interface BiliDash {
  duration: number
  video: BiliTrack[]
  audio: BiliTrack[]
  /** 该账号在这个稿件上**真正拿得到**的画质档(已与 dash.video 求交)。 */
  qualities: { qn: number; label: string }[]
}
