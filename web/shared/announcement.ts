// 当前公告的内容与版本。改文案但不想重新打扰已静音用户时保留 id；需要重新展示一条新公告时再改 id。
export const CURRENT_ANNOUNCEMENT = {
  id: 'site-position-playback-v2',
  eyebrow: '纱雾的小便签',
  title: '关于这个小站，先说几句…',
  lead: '嗯…这张便签我只在你刚进来的时候递给你一次，记住就好……',
  sections: [
    {
      title: '这个小站想帮什么？',
      body: '这里主要用来记住看过的番、快速找到集数和观看入口……才不是要替代专门的播放平台，只是帮你少翻几次',
    },
    {
      title: '平常先去哪里看？',
      body: '默认推荐从 B 站或源站跳转开始：喜欢弹幕就去 B 站，想安静看就用源站。按自己的习惯选，不用勉强',
    },
    {
      title: '遇到删减或不想看弹幕？',
      body: 'B 站这一集有删减，就回到源站继续看；如果本来就不喜欢弹幕，也可以直接选择源站，清静一点更舒服',
    },
    {
      title: '源站卡顿了怎么办？',
      body: '源站加载不顺时，可以回来本站试试。这里有加速功能，不过服务器容量有限，人太多时可能会变慢……不要一口气全挤进来啦',
    },
  ],
} as const

export const CURRENT_ANNOUNCEMENT_ID = CURRENT_ANNOUNCEMENT.id
