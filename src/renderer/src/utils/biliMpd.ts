// B 站的 DASH JSON → DASH MPD(XML)。
//
// playurl 只给一份 JSON,而 shaka-player 要的是 MPD。好在每一路轨都是「单文件 fMP4 +
// 字节范围索引」,正好对应 DASH 的 on-demand profile:一个 <BaseURL> + 一个
// <SegmentBase indexRange> 就完整描述了它,shaka 取到索引后自己发 Range 拉分片。
//
// **只收 avc1 视轨**:同一档画质会同时给 avc1 / hev1 / av01 三种编码,编码不同不能塞进同一个
// AdaptationSet;而 HEVC 与 AV1 在各平台 Electron 里的解码支持参差,avc1 是唯一到处都能硬解的。
import type { BiliDash, BiliTrack } from '../types/bili'

/** URL 里的 & ? 等在 XML 文本节点里必须转义,否则 MPD 解析直接失败。 */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 这个稿件里能用的视轨:只留 avc1,按画质从高到低。 */
export function pickVideoTracks(dash: BiliDash): BiliTrack[] {
  const avc = dash.video.filter((v) => v.codecs.startsWith('avc1'))
  // 理论上不会空;真空了也别把画质列表一起弄没,原样用。
  const list = avc.length > 0 ? avc : dash.video
  return [...list].sort((a, b) => b.id - a.id)
}

function representation(t: BiliTrack, id: string, extra: string): string {
  return [
    `<Representation id="${id}" codecs="${t.codecs}" bandwidth="${t.bandwidth}"${extra}>`,
    `<BaseURL>${xmlEscape(t.baseUrl)}</BaseURL>`,
    `<SegmentBase indexRange="${t.indexRange}"><Initialization range="${t.initRange}"/></SegmentBase>`,
    '</Representation>',
  ].join('')
}

/**
 * 合成一份自包含的 MPD。视轨含全部 avc1 档(切画质靠 shaka 换 variant,不用重新 load)
 * 音轨含站点给的全部档。
 */
export function buildBiliMpd(dash: BiliDash): string {
  const dur = `PT${dash.duration}S`
  const videos = pickVideoTracks(dash)
    .map((t, i) => representation(t, `v${t.id}-${i}`, ` width="${t.width}" height="${t.height}"`))
    .join('')
  const audios = dash.audio
    .map((t) => representation(t, `a${t.id}`, ''))
    .join('')

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"',
    ` type="static" mediaPresentationDuration="${dur}" minBufferTime="PT1.5S">`,
    `<Period duration="${dur}">`,
    '<AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true" startWithSAP="1"',
    ' subsegmentAlignment="true" subsegmentStartsWithSAP="1">',
    videos,
    '</AdaptationSet>',
    '<AdaptationSet contentType="audio" mimeType="audio/mp4" segmentAlignment="true" startWithSAP="1"',
    ' subsegmentAlignment="true" subsegmentStartsWithSAP="1">',
    audios,
    '</AdaptationSet>',
    '</Period></MPD>',
  ].join('')
}

/**
 * MPD 本身没有可取的 http 地址(它是我们凭空拼的),包成 data: URI 交给 shaka ——
 * shaka 内置 DataUriPlugin 认这个 scheme。用 URI 编码而不是 base64,免得处理 UTF-8。
 */
export function biliMpdUri(dash: BiliDash): string {
  return `data:application/dash+xml,${encodeURIComponent(buildBiliMpd(dash))}`
}
