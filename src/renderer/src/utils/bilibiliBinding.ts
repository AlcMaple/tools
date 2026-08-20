/**
 * B 站源重构(source:'Bilibili')前,手动加链接只能走通用「+ 添加链接」,存成
 * source:'Custom' + bilibili.com 的 URL。这个判断让新逻辑照样认得那些老数据,
 * 不然它们会被当成"未绑定 B 站",UI 上误判成还没搜、播放器默认选中空的 B 站位。
 */
export function isBilibiliUrl(url: string): boolean {
  return /bilibili\.com/i.test(url)
}

export function isLegacyBilibiliBinding(b: { source: string; sourceUrl?: string; sourceKey: string }): boolean {
  return b.source === 'Custom' && isBilibiliUrl(b.sourceUrl || b.sourceKey)
}
