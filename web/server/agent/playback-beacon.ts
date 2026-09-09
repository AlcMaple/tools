// 阶段 8：播放页回报给 Agent 权威回执的那一小段内联脚本，稀饭 / Girigiri 两张播放页共用一份。
//
// 播放页是服务端返回的裸 HTML，不在 SPA bundle 里（见 src/player-monitoring.ts 的说明），
// 所以这段只能以源码字符串的形式拼进模板，不能 import。写法保持 ES5 + 无可选链，
// 与两张播放页里其余脚本一致。
//
// 它只做一件事：把「刚刚发生了什么」告诉服务端。状态机、证据来源和是否算成功全在
// server/agent/playback-store.ts 里判定 —— 页面不能自称播完了，跨域套娃 iframe 只能到 unknown。
export const PLAYBACK_BEACON = `
  // Agent 播放回执：actionId 由「确认打开」那一下的服务端 302 带过来；没有它就整段静默。
  var agentAction = (new URLSearchParams(location.search)).get('agentAction') || ''
  var agentSent = {}, agentChain = Promise.resolve(), agentWatched = 0, agentLastTime = 0
  function agentReport(event, detail){
    if (!agentAction || agentSent[event]) return
    agentSent[event] = 1
    // 串成一条链依次发：服务端状态机只接受严格顺序的下一步，并发发送会被网络乱序打乱，
    // 乱序的那条会被当作「不适用的事件」丢掉，回执就永远停在半路。
    agentChain = agentChain.then(function(){
      return fetch('/api/agent/actions/' + encodeURIComponent(agentAction) + '/playback-event', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', keepalive: true,
        body: JSON.stringify({ actionId: agentAction, event: event, detail: String(detail || '').slice(0, 200) })
      })
    }).catch(function(){})
  }
  // 「真的看起来了」的判据是累计前进 15 秒，不是收到过一次 playing ——
  // 起播就暂停、或点开发现是错的那一集，都不该记成看完了这次打开。
  function agentWatch(media){
    if (!agentAction) return
    media.addEventListener('timeupdate', function(){
      var now = media.currentTime
      var delta = now - agentLastTime
      agentLastTime = now
      if (delta > 0 && delta < 2) agentWatched += delta
      if (agentWatched >= 15) agentReport('watched', 'played ' + Math.round(agentWatched) + 's')
    })
    media.addEventListener('seeking', function(){ agentLastTime = media.currentTime })
  }
`
