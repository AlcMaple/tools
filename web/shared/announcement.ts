// 当前公告的内容与版本。改文案但不想重新打扰已静音用户时保留 id；需要重新展示一条新公告时再改 id。
export const CURRENT_ANNOUNCEMENT = {
  id: 'site-position-playback-v1',
  eyebrow: '纱雾的小便签',
  title: '关于这个小站，先说几句…',
  lead: '嗯…这张便签只想在开场后递给你一次',
  sections: [
    {
      title: '它想帮什么忙？',
      body: 'MapleTools 想把找番和观看的路稍微铺平一点：加速找动漫，也让观看体验顺一点',
    },
    {
      title: '网页版和应用版',
      body: '这里主要是介绍与轻量体验入口；如果会长期在电脑上使用，更建议下载应用版。手机目前只支持网页版',
    },
    {
      title: '平常怎么看？',
      body: '日常还是更推荐在 B 站观看；遇到审核较严或打码较重的内容，也可以在这里看看有没有更合适的观看入口',
    },
    {
      title: '关于服务器',
      body: '服务器真的不算厉害…快源观看一般不受影响；慢源可能要排队，稍等一会儿就好',
    },
  ],
} as const

export const CURRENT_ANNOUNCEMENT_ID = CURRENT_ANNOUNCEMENT.id
