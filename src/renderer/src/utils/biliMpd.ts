// B 站 DASH JSON → DASH MPD(XML)。
//
// B 站的 playurl 只给一份 JSON,不给 MPD;而 shaka-player 要的是 MPD。好在 B 站的每
// 一路轨都是「单文件 fMP4 + SegmentBase 字节范围」,正好对应 DASH 的 on-demand profile
// (isoff-on-demand):一个 <BaseURL> + 一个 <SegmentBase indexRange> 就完整描述了它,
// shaka 靠 indexRange 取 sidx 索引后自己发 Range 拉分片。
//
// 只收 **avc1** 视轨(见 pickVideoTracks):B 站同一档画质会同时给 avc1 / hev1 / av01
// 三种编码,三者编码不同不能塞进同一个 AdaptationSet;而 hev1(HEVC)与 av01(AV1)在
// 各平台的 Electron 里解码支持参差,avc1 是唯一到处都能硬解的那个。
import type { BiliDash, BiliTrack } from '../types/bili'

/** URL 里的 & ? 等在 XML 文本节点里必须转义,否则 MPD 解析直接失败。 */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 该稿件里能用的视轨:只留 avc1,按画质从高到低。 */
export function pickVideoTracks(dash: BiliDash): BiliTrack[] {
  const avc = dash.video.filter((v) => v.codecs.startsWith('avc1'))
  // 理论上不会空(B 站每档都给 avc1);真空了就别把画质列表也弄没,原样用。
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
 * 合成一份自包含的 MPD。视轨含全部 avc1 档(切画质靠 shaka 的 selectVariantTrack,
 * 不用重新 load),音轨含 B 站给的全部 mp4a 档。
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
