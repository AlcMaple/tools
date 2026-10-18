// 当前公告的内容与版本。改文案但不想重新打扰已静音用户时保留 id；需要重新展示一条新公告时再改 id。
export const CURRENT_ANNOUNCEMENT = {
  id: 'site-updates-20261018-v1',
  eyebrow: '纱雾的小便签',
  title: '小站又更新了几处',
  lead: '纱雾能看图了，周历能直接开看，还多了接单评估',
  sections: [
    {
      title: '纱雾能看图了',
      body: '截图粘贴、拖进对话框或点「图片」，和问题一起发给纱雾，一次最多 4 张',
    },
    {
      title: '番剧周历能直接开看',
      body: '海报下面多了「继续看 / 试看」，追过的番接着上次的集数播；还可以只看自己追的番',
    },
    {
      title: '新增接单评估',
      body: '把派单的文字、截图、视频或文档放进来，对照你的能力档案看看这一单能不能接',
    },
    {
      title: '追番页换了新样子',
      body: '卡片和时间线重新画过了；更喜欢原来的全身立绘，可以在设置的「外观」里切回旧版',
    },
    {
      title: '播放更稳',
      body: 'Girigiri 拖进度不再报错，高码率片段也不容易卡；iPhone 跳进度后能正常起播，手机连家里宽带不再一直缓冲',
    },
    {
      title: '还有一些小改进',
      body: '可以设置密保问题找回密码；Windows 上卡片不再发糊；平板和手机点右上角头像就能找到反馈与建议、退出登录',
    },
  ],
} as const

export const CURRENT_ANNOUNCEMENT_ID = CURRENT_ANNOUNCEMENT.id
