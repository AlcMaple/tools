// 当前公告的内容与版本。改文案但不想重新打扰已静音用户时保留 id；需要重新展示一条新公告时再改 id。
export const CURRENT_ANNOUNCEMENT = {
  id: 'site-updates-20261007-v1',
  eyebrow: '纱雾的小便签',
  title: '小站又更新了几处',
  lead: '追番页和周历多了新玩法，加番和播放也更稳了，来看看吧',
  sections: [
    {
      title: '追番页可以按年份和季度排列',
      body: '想翻翻哪一年、哪一季追过什么，现在一眼就能找到',
    },
    {
      title: '番剧周历能看往期了',
      body: '翻回之前的周，看看那阵子都在播什么',
    },
    {
      title: '一次加多部番更稳了',
      body: '之前批量添加时封面会整批加载失败，现在已经修好',
    },
    {
      title: '播放更流畅',
      body: '修复了 PC 网页起播后反复卡顿，以及手机上站内播放稀饭动漫不起播的问题',
    },
    {
      title: '手机上更顺手',
      body: '输入框不再聚焦时跳动或自动放大，加番页也适配了不同屏幕',
    },
  ],
} as const

export const CURRENT_ANNOUNCEMENT_ID = CURRENT_ANNOUNCEMENT.id
