// 当前公告的内容与版本。改文案但不想重新打扰已静音用户时保留 id；需要重新展示一条新公告时再改 id。
export const CURRENT_ANNOUNCEMENT = {
  id: 'site-updates-20260928-v1',
  eyebrow: '纱雾的小便签',
  title: '小站最近更新了这些',
  lead: '找番、记进度、接着看……这次都整理了一下，来看看吧',
  sections: [
    {
      title: '纱雾可以帮你找番了',
      body: '可以聊番、找观看入口，也能帮你整理追番进度和标签；修改前会先让你确认',
    },
    {
      title: '追番和分享更顺手',
      body: '支持手动添加番剧、按标签筛选和直接输入进度；追番大厅里也能看看大家的点评，找找下一部想看的番',
    },
    {
      title: '播放体验更新',
      body: '换上了新播放器，自动优选线路，并提前准备下一集；稀饭官网地址也已更新为 next.xifanacg.com',
    },
    {
      title: '登录多了一个选择',
      body: '新增 GitHub 快捷注册与登录',
    },
    {
      title: '追番记录可以备份了',
      body: '在设置里的「备份与恢复」导出记录和封面，需要时再导入，也可以导出 Markdown 留着翻看',
    },
    {
      title: '手机上也更好用了',
      body: '调整了窄屏集数和弹窗布局',
    },
  ],
} as const

export const CURRENT_ANNOUNCEMENT_ID = CURRENT_ANNOUNCEMENT.id
