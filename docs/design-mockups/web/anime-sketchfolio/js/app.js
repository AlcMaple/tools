/* ============================================================
   「纱雾画稿 Sagiri Sketchfolio」共享交互层
   全静态：无任何网络请求；mock 数据写死，任何时间打开都完整。
   触摸优先：功能不依赖 hover；触控目标 ≥40px；
   临时提示绝对定位不挤布局；下拉与触发器同宽；通知走便签 Toast。
   ============================================================ */
(function () {
  'use strict';

  /* ---------- 图标 sprite（手绘感线性图标） ---------- */
  const SPRITE = `
<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">
  <symbol id="i-pencil" viewBox="0 0 24 24"><path d="M4 20l1.2-4.2L15.6 5.4a2.1 2.1 0 0 1 3 3L8.2 18.8 4 20z"/><path d="M13.6 7.4l3 3"/></symbol>
  <symbol id="i-calendar" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/></symbol>
  <symbol id="i-tracks" viewBox="0 0 24 24"><rect x="6" y="8.5" width="14" height="11.5" rx="2"/><path d="M4 15.5V6a2 2 0 0 1 2-2h9.5"/></symbol>
  <symbol id="i-settings" viewBox="0 0 24 24"><path d="M4 6.5h8M17.5 6.5H20M4 12h3M12.5 12H20M4 17.5h10M19 17.5h1"/><circle cx="14.5" cy="6.5" r="2.2"/><circle cx="9.5" cy="12" r="2.2"/><circle cx="16.5" cy="17.5" r="2.2"/></symbol>
  <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M15.5 15.5L20.5 20.5"/></symbol>
  <symbol id="i-user" viewBox="0 0 24 24"><circle cx="12" cy="8.2" r="3.6"/><path d="M5 20c1.2-3.6 4-5.3 7-5.3s5.8 1.7 7 5.3"/></symbol>
  <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5.5v13M5.5 12h13"/></symbol>
  <symbol id="i-minus" viewBox="0 0 24 24"><path d="M5.5 12h13"/></symbol>
  <symbol id="i-play" viewBox="0 0 24 24"><path fill="currentColor" stroke="none" d="M8.5 5.8v12.4l10-6.2z"/></symbol>
  <symbol id="i-star" viewBox="0 0 24 24"><path d="M12 3.8l2.5 5.1 5.6.8-4 3.9 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4-3.9 5.6-.8z"/></symbol>
  <symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></symbol>
  <symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></symbol>
  <symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 4.5L21 19.5H3z"/><path d="M12 10.2v3.6M12 16.4v.2"/></symbol>
  <symbol id="i-chev" viewBox="0 0 24 24"><path d="M6 9.5l6 6 6-6"/></symbol>
  <symbol id="i-eye" viewBox="0 0 24 24"><path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.7"/></symbol>
  <symbol id="i-eye-off" viewBox="0 0 24 24"><path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.7"/><path d="M4.5 4.5l15 15"/></symbol>
  <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 3.5v4.3h-4.3"/></symbol>
  <symbol id="i-external" viewBox="0 0 24 24"><path d="M14 4.5h5.5V10M19.5 4.5l-8.5 8.5"/><path d="M18.5 13.5V19a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H11"/></symbol>
  <symbol id="i-dots" viewBox="0 0 24 24"><circle fill="currentColor" stroke="none" cx="12" cy="5.5" r="1.6"/><circle fill="currentColor" stroke="none" cx="12" cy="12" r="1.6"/><circle fill="currentColor" stroke="none" cx="12" cy="18.5" r="1.6"/></symbol>
  <symbol id="i-logout" viewBox="0 0 24 24"><path d="M9.5 8l-4 4 4 4M5 12h9.5"/><path d="M13 4.5h5.5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H13"/></symbol>
  <symbol id="i-clip" viewBox="0 0 24 24"><path d="M16.5 11.5l-6.9 6.9a3.4 3.4 0 0 1-4.8-4.8l8.2-8.2a2.3 2.3 0 0 1 3.2 3.2l-8.2 8.2a1.1 1.1 0 0 1-1.6-1.6l7.2-7.2"/></symbol>
  <symbol id="i-tag" viewBox="0 0 24 24"><path d="M4 4.5h7l9 9-7 7-9-9z"/><circle cx="8.5" cy="8.5" r="1.6"/></symbol>
  <symbol id="i-edit" viewBox="0 0 24 24"><path d="M12 20.5h8.5"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7.2 18.8 3 20l1.2-4.2z"/></symbol>
  <symbol id="i-mail" viewBox="0 0 24 24"><rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3.5 7.5l8.5 6 8.5-6"/></symbol>
  <symbol id="i-google" viewBox="0 0 24 24"><path fill="#4285F4" stroke="none" d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.46a5.53 5.53 0 0 1-2.4 3.63v3h3.87c2.27-2.09 3.57-5.17 3.57-8.82z"/><path fill="#34A853" stroke="none" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.87-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.72-4.96H1.28v3.1A12 12 0 0 0 12 24z"/><path fill="#FBBC05" stroke="none" d="M5.28 14.28A7.2 7.2 0 0 1 4.9 12c0-.79.14-1.56.38-2.28v-3.1H1.28a12 12 0 0 0 0 10.76l4-3.1z"/><path fill="#EA4335" stroke="none" d="M12 4.77c1.76 0 3.35.61 4.6 1.8l3.43-3.43C17.95 1.19 15.23 0 12 0A12 12 0 0 0 1.28 6.62l4 3.1c.94-2.85 3.59-4.95 6.72-4.95z"/></symbol>
  <symbol id="i-pause" viewBox="0 0 24 24"><path d="M9 5.5v13M15 5.5v13"/></symbol>
  <symbol id="i-back" viewBox="0 0 24 24"><path d="M14.5 5.5L8 12l6.5 6.5"/></symbol>
</svg>`;
  document.body.insertAdjacentHTML('afterbegin', SPRITE);

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const ic = (name, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------- 封面：随原型保存的本地缩略图，不在浏览器运行时请求图床 ---------- */
  const LOCAL_COVERS = Object.freeze({
    frieren2: 'assets/covers/frieren.jpg',
    rezero4: 'assets/covers/rezero.jpg',
    bocchi2: 'assets/covers/bocchi.png',
    kusuriya2: 'assets/covers/kusuriya.jpg',
    dandadan2: 'assets/covers/dandadan.jpg',
    dandadan3: 'assets/covers/dandadan.jpg',
    spyfamily3: 'assets/covers/spy-family.jpg',
    mushoku3: 'assets/covers/mushoku.jpg',
    aohanako2: 'assets/covers/blue-box.jpg',
    onepiece: 'assets/covers/one-piece.jpg',
    sakamoto2: 'assets/covers/sakamoto.png',
    haruhi: 'assets/covers/haruhi.png'
  });
  function coverMarkup(show) {
    const src = LOCAL_COVERS[show.id];
    if (src) {
      return `<img class="cover-img" src="${src}" alt="${esc(show.t)} 封面" loading="lazy" decoding="async">`;
    }
    const initial = esc((show.t.replace(/[！!？?＿—－・\s]/g, ' ').trim()[0]) || '☆');
    return `<div class="cover-ph" style="background:linear-gradient(160deg,hsl(${show.hue},45%,72%),hsl(${(show.hue + 40) % 360},40%,52%))">${initial}</div>`;
  }

  /* ---------- 自绘下拉 ---------- */
  function bindDD(host) {
    const trig = $('.dd-trigger', host) || $('button', host);
    if (!trig) return;
    trig.addEventListener('click', (e) => {
      e.stopPropagation();
      $$('.dd-host.open').forEach((h) => { if (h !== host) h.classList.remove('open'); });
      host.classList.toggle('open');
    });
    $$('.dd-item', host).forEach((it) => it.addEventListener('click', () => {
      $$('.dd-item.on', host).forEach((x) => x.classList.remove('on'));
      it.classList.add('on');
      const val = $('.dd-val', trig);
      if (val && it.dataset.val) val.textContent = it.dataset.val;
      host.classList.remove('open');
      host.dispatchEvent(new CustomEvent('dd-select', { detail: Object.assign({}, it.dataset) }));
    }));
  }
  document.addEventListener('click', () => $$('.dd-host.open').forEach((h) => h.classList.remove('open')));

  /* ---------- 弹窗 ---------- */
  function openDialog(id) {
    const w = document.getElementById(id);
    if (!w) return;
    w.classList.add('open');
    const f = $('input,button', $('.dlg', w));
    if (f) f.focus();
  }
  function closeDialog(el) { el.closest('.dlg-backdrop').classList.remove('open'); }
  function bindDialogs() {
    $$('[data-dialog-open]').forEach((b) => b.addEventListener('click', (e) => {
      e.preventDefault();
      openDialog(b.dataset.dialogOpen);
    }));
    $$('[data-dialog-close]').forEach((b) => b.addEventListener('click', () => closeDialog(b)));
    $$('.dlg-backdrop').forEach((w) => w.addEventListener('click', (e) => { if (e.target === w) w.classList.remove('open'); }));
  }

  /* ---------- 便签 Toast（单例：右下角始终一张，后来的直接顶掉先来的） ---------- */
  let toastRoot = null;
  let toastCur = null;
  let toastTimer = 0;
  function toast(text, opt) {
    opt = opt || {};
    if (!toastRoot) { toastRoot = document.createElement('div'); toastRoot.id = 'toast-root'; document.body.appendChild(toastRoot); }
    if (toastCur) { clearTimeout(toastTimer); toastCur.remove(); }
    const el = document.createElement('div');
    el.className = 'toast-note' + (opt.err ? ' err' : '');
    el.innerHTML = `
      <img class="avatar" src="assets/sagiri-face.png" alt="">
      <div class="toast-body">
        <div class="toast-name">纱雾${opt.err ? ' · 小声' : ''}</div>
        <div class="toast-text"></div>
      </div>
      <span class="stamp small ${opt.err ? 'st-sakura' : 'st-teal'} toast-stamp">${opt.err ? '!' : '✓'}</span>`;
    $('.toast-text', el).textContent = text;
    toastRoot.appendChild(el);
    const st = $('.toast-stamp', el);
    st.classList.remove('pop'); void st.offsetWidth; st.classList.add('pop');
    toastCur = el;
    toastTimer = setTimeout(() => {
      el.classList.add('out');
      // 动画可能被 prefers-reduced-motion 关掉（animationend 不来），兜一个定时移除
      const drop = () => { el.remove(); if (toastCur === el) toastCur = null; };
      el.addEventListener('animationend', drop, { once: true });
      setTimeout(drop, 400);
    }, opt.err ? 3600 : 2700);
  }

  /* ---------- 验证码倒计时 ---------- */
  function bindCountdown(btn) {
    if (btn.disabled) return;
    let t = 60;
    btn.disabled = true;
    btn.classList.add('counting');
    const tick = () => {
      btn.textContent = t + 's 后重发';
      if (t-- > 0) { setTimeout(tick, 1000); }
      else { btn.disabled = false; btn.classList.remove('counting'); btn.textContent = '重新发送'; }
    };
    tick();
    toast('验证码已发送（演示数据，不真的发邮件）');
  }

  /* ---------- 密码明暗切换 ---------- */
  function bindEyes() {
    $$('.eye').forEach((btn) => btn.addEventListener('click', () => {
      const input = $('input', btn.closest('.field-row'));
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
      $('use', btn).setAttribute('href', show ? '#i-eye-off' : '#i-eye');
    }));
  }

  /* ---------- 稀饭验证码（点图换一张） ---------- */
  const CAPTCHA_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  function randCh() { return CAPTCHA_CHARS[Math.floor(Math.random() * CAPTCHA_CHARS.length)]; }
  function bindCaptchas() {
    $$('.captcha').forEach((c) => {
      if (!c.children.length) c.innerHTML = '<span></span>'.repeat(4);
      const render = () => $$('span', c).forEach((sp) => { sp.textContent = randCh(); });
      render();
      c.title = '看不清？点一下换一张';
      c.addEventListener('click', render);
    });
  }

  /* ---------- 表单演示（错误抖动 + 行内提示） ---------- */
  function bindFormDemo(form, onOk) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      let bad = null;
      $$('input[required]', form).forEach((inp) => {
        const field = inp.closest('.field');
        if (!inp.value.trim()) {
          if (field) field.classList.add('err');
          const msg = field && $('.field-msg', field);
          if (msg) msg.classList.add('show');
          if (!bad) bad = inp;
        } else if (field) {
          field.classList.remove('err');
          const msg = $('.field-msg', field);
          if (msg) msg.classList.remove('show');
        }
      });
      if (bad) { bad.focus(); return; }
      (onOk || (() => {}))();
    });
  }
  $$('input').forEach((inp) => inp.addEventListener('input', () => {
    const field = inp.closest('.field');
    if (field) field.classList.remove('err');
    const msg = field && $('.field-msg', field);
    if (msg) msg.classList.remove('show');
  }));

  /* ============================================================
     页面控制器
     ============================================================ */
  const page = document.body.dataset.page;

  /* ---------- 周历：日期章 + 单日胶片 + 立绘气泡 ---------- */
  if (page === 'calendar') {
    const WEEK = [
      { d: '周一', date: 10, shows: [
        { id: 'bocchi2', t: 'ぼっち・ざ・ろっく！第２期', ep: 8, hue: 268, tracked: true },
        { id: 'yurucamp4', t: 'ゆるキャン△ SEASON４', ep: 7, hue: 95 },
        { id: 'hikikomari', t: 'ひきこまりの吸血姫は眠りたい', ep: 7, hue: 335 },
        { id: 'classroom3', t: 'ようこそ実力至上主義の教室へ 第３期', ep: 7, hue: 210 },
        { id: 'onimai3', t: 'お兄ちゃんはおしまい！第３期', ep: 7, hue: 320 } ] },
      { d: '周二', date: 11, shows: [
        { id: 'kusuriya2', t: '薬屋のひとりごと 第２期', ep: 31, hue: 165 },
        { id: 'dandadan3', t: 'ダンダダン 第３期', ep: 2, hue: 30 },
        { id: 'gachiakuta2', t: 'ガチアクタ 第２期', ep: 8, hue: 15 },
        { id: 'kitakore2', t: 'その着せ替え人形は恋をする 第２期', ep: 7, hue: 340 },
        { id: 'natsume8', t: '夏目友人帳 第８期', ep: 6, hue: 130 } ] },
      { d: '周三', date: 12, shows: [
        { id: 'spyfamily3', t: 'SPY×FAMILY 第３期', ep: 8, hue: 350, tracked: true },
        { id: 'shikanoko', t: 'しかのこのこのここしたんたん', ep: 8, hue: 45 },
        { id: 'apothecary0', t: '棺の公会アポセカリー', ep: 6, hue: 220 },
        { id: 'inaka3', t: '虚構推理 第３期', ep: 7, hue: 250 },
        { id: 'arknights2', t: 'アークナイツ 第２期', ep: 5, hue: 200 } ] },
      { d: '周四', date: 13, shows: [
        { id: 'kaiju8_2', t: '怪獣８号 第２期', ep: 9, hue: 260 },
        { id: 'windb', t: 'ウィンドブレイカー 第３期', ep: 7, hue: 190 },
        { id: 'mushoku3', t: '無職転生 ～異世界行ったら本気だす～ 第Ⅲ期', ep: 3, hue: 155, tracked: true },
        { id: 'gbc2', t: 'ガールズバンドクライ 第２期', ep: 4, hue: 285 },
        { id: 'soraow', t: 'ソラオの世界', ep: 6, hue: 100 } ] },
      { d: '周五', date: 14, shows: [
        { id: 'sousou', t: '葬送のフリーレン 外伝', ep: 4, hue: 180 },
        { id: 'nelke', t: '鬼滅の刃 夜行孤鬼の章', ep: 5, hue: 280 },
        { id: 'aohanako2', t: 'アオのハコ 第２期', ep: 6, hue: 205, tracked: true },
        { id: 'lls4', t: 'ラブライブ！スーパースター!! 第４期', ep: 6, hue: 355 },
        { id: 'tsukimichi3', t: '月が導く異世界道中 第３期', ep: 5, hue: 240 } ] },
      { d: '周六', date: 15, shows: [
        { id: 'onepiece', t: 'ONE PIECE', ep: 1129, hue: 25, tracked: true },
        { id: 'sakamoto2', t: 'SAKAMOTO DAYS 第２期', ep: 8, hue: 60 },
        { id: 'bluebox2', t: 'アオのハコ 続編特別編', ep: 2, hue: 205 },
        { id: 'tenpuran4', t: '転スラじお 第４期', ep: 7, hue: 175 },
        { id: 'maougakuin3', t: '魔王学院の不適合者 Ⅲ', ep: 5, hue: 300 } ] },
      { d: '周日', date: 16, today: true, shows: [
        { id: 'frieren2', t: '葬送のフリーレン 第２期', ep: 8, hue: 200, tracked: true },
        { id: 'rezero4', t: 'Re:ゼロから始める異世界生活 第４期', ep: 8, hue: 230, tracked: true },
        { id: 'grandpa', t: 'じいさんばあさん 若返る', ep: 7, hue: 120 },
        { id: 'kaguya_m', t: 'かぐや様は告らせたい ～ファイナル～', ep: 4, hue: 55 },
        { id: 'bocchiday', t: 'ぼっち・ざ・ろっく！ 再放送', ep: 3, hue: 268 } ] }
    ];
    const tracked = new Set(WEEK.flatMap((d) => d.shows.filter((s) => s.tracked).map((s) => s.id)));
    const calBody = $('#calBody');
    // 桌面（≥961px）= 整周纵览：七天「章头 + 胶片」竖排，一季番剧一屏纵览；
    // 手机 = 日期章选天 + 单日胶片（横滑）。与真实代码 CalendarPage 同一双形态。
    const mqWide = window.matchMedia('(min-width: 961px)');
    let selDay = WEEK.findIndex((d) => d.today);
    if (selDay < 0) selDay = 0;

    const RIG_LINES = {
      onTrack: ['哦哦，这部我也在追！', '贴上了贴上了～', '这周就等它了！', '眼光不错嘛。'],
      onUntrack: ['欸？不追了吗……', '撕掉了哦。', '好吧……'],
      idle: ['唔……在看什么呢？', '今天也想画点什么。', '别、别一直盯着我看啦。', '翻面也要优雅地翻。']
    };
    const rigBubbles = $$('.rig-bubble span');
    let lineIdx = 0;
    function setRigLine(kind) {
      const pool = RIG_LINES[kind];
      const text = pool[lineIdx++ % pool.length];
      rigBubbles.forEach((b) => {
        b.style.opacity = '0';
        setTimeout(() => { b.textContent = text; b.style.opacity = '1'; }, 180);
      });
    }

    function posterHTML(s) {
      const on = tracked.has(s.id);
      return `
      <article class="poster${on ? ' tracked' : ''}" data-id="${s.id}">
        <div class="cover">
          ${coverMarkup(s)}
          <button class="track-btn${on ? ' on' : ''}" type="button" aria-label="${on ? '取消追番' : '追番'}">${on ? ic('check', 'ic') : ic('plus', 'ic')}</button>
          <a class="bgm-link" href="#" data-t="${esc(s.t)}">${ic('external', 'ic ic-sm')}详情</a>
        </div>
        <div class="poster-title">${esc(s.t)}</div>
        <div class="poster-ep">EP ${s.ep}</div>
      </article>`;
    }
    function dayHeadHTML(d) {
      return `
        <div class="day-head">
          <span class="ribbon${d.today ? ' sakura' : ''}">${d.today ? ic('star', 'ic ic-sm') + '今天' : d.d}</span>
          <span class="font-hand muted">8/${d.date} · ${d.shows.length} 部在播</span>
          <hr class="hr-dash">
          <span class="sparkle">✦</span>
        </div>`;
    }
    function filmHTML(d) {
      return d.shows.length ? d.shows.map(posterHTML).join('') : '<div class="film-empty faint">这一天没有排片</div>';
    }
    function renderCal() {
      if (mqWide.matches) {
        calBody.innerHTML = WEEK.map((d) => `
          <section class="day-sec" id="day-sec-${d.date}">
            ${dayHeadHTML(d)}
            <div class="film" aria-label="${d.d}在播番剧">${filmHTML(d)}</div>
          </section>`).join('');
      } else {
        calBody.innerHTML = `
          <div class="date-strip" role="tablist" aria-label="选择日期">${WEEK.map((d, i) => `
            <button class="dstamp${i === selDay ? ' on' : ''}${d.today ? ' today' : ''}" type="button" data-i="${i}" title="${d.d} · ${d.shows.length} 部">
              <span class="dw">${d.d}</span>
              <span class="dnum">${d.date}</span>
              <span class="dc">${d.shows.length} 部</span>
              ${d.today ? '<svg class="clip-today" aria-hidden="true"><use href="#i-clip"></use></svg>' : ''}
            </button>`).join('')}
          </div>
          ${dayHeadHTML(WEEK[selDay])}
          <div class="film" aria-label="当日在播番剧">${filmHTML(WEEK[selDay])}</div>`;
      }
    }
    mqWide.addEventListener('change', renderCal);
    renderCal();

    calBody.addEventListener('click', (e) => {
      const stamp = e.target.closest('.dstamp');
      if (stamp) {
        selDay = +stamp.dataset.i;
        renderCal();
        return;
      }
      const bgm = e.target.closest('.bgm-link');
      if (bgm) {
        e.preventDefault();
        toast(`打开『${bgm.dataset.t}』的 Bangumi 详情（原型示意）`);
        return;
      }
      const btn = e.target.closest('.track-btn');
      if (!btn) return;
      const card = btn.closest('.poster');
      const id = card.dataset.id;
      const nowOn = !tracked.has(id);
      if (nowOn) tracked.add(id); else tracked.delete(id);
      card.classList.toggle('tracked', nowOn);
      btn.classList.toggle('on', nowOn);
      btn.innerHTML = nowOn ? ic('check', 'ic') : ic('plus', 'ic');
      btn.setAttribute('aria-label', nowOn ? '取消追番' : '追番');
      const st = document.createElement('span');
      st.className = 'stamp small st-teal pop';
      st.style.cssText = 'position:absolute;top:58px;right:8px;pointer-events:none;color:var(--teal)';
      st.textContent = nowOn ? '追' : '…';
      $('.cover', card).appendChild(st);
      setTimeout(() => st.remove(), 900);
      toast(nowOn ? `已把『${$('.poster-title', card).textContent}』加入追番` : '已取消追番');
      setRigLine(nowOn ? 'onTrack' : 'onUntrack');
    });

    $('#backToday').addEventListener('click', () => {
      const idx = WEEK.findIndex((d) => d.today);
      if (mqWide.matches) {
        const sec = document.getElementById('day-sec-' + WEEK[idx].date);
        if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        selDay = idx;
        renderCal();
        const t = $$('.dstamp', calBody)[selDay];
        if (t) t.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }
      toast('已回到今天 · 8/16 周日');
    });
    $('#refreshCal').addEventListener('click', function () {
      const svg = $('svg', this);
      svg.style.transition = 'transform .6s ease';
      svg.style.transform = 'rotate(360deg)';
      setTimeout(() => { svg.style.transition = 'none'; svg.style.transform = 'rotate(0)'; }, 620);
      toast('周历已刷新');
    });
  }

  /* ---------- 追番：等宽卡片网格的手帐内页 ---------- */
  if (page === 'tracks') {
    const TODAY = '周日'; // 与周历一致：今天 = 8/16 周日（静态演示）
    const TRACKS = [
      { id: 'frieren2', t: '葬送のフリーレン 第２期', status: 'doing', ep: 7, total: null, weekday: '周日', hue: 200,
        tags: [{ v: '奇幻', mine: false }, { v: '旅途', mine: false }, { v: '每周必看', mine: true }] },
      { id: 'rezero4', t: 'Re:ゼロから始める異世界生活 第４期', status: 'doing', ep: 8, total: null, weekday: '周日', hue: 230,
        tags: [{ v: '异世界', mine: false }, { v: '轮回', mine: false }] },
      { id: 'bocchi2', t: 'ぼっち・ざ・ろっく！第２期', status: 'doing', ep: 8, total: null, weekday: '周一', hue: 268,
        tags: [{ v: '乐队', mine: false }, { v: '社恐共鸣', mine: true }] },
      { id: 'kusuriya2', t: '薬屋のひとりごと 第２期', status: 'wish', ep: 0, total: null, weekday: '周二', hue: 165,
        tags: [{ v: '宫斗', mine: false }, { v: '推理', mine: false }] },
      { id: 'dandadan2', t: 'ダンダダン 第２期', status: 'done', ep: 12, total: 12, weekday: null, hue: 30,
        tags: [{ v: '超自然', mine: false }, { v: '作画爆炸', mine: true }] },
      { id: 'spyfamily3', t: 'SPY×FAMILY 第３期', status: 'doing', ep: 7, total: 25, weekday: '周三', hue: 350,
        tags: [{ v: '家庭喜剧', mine: false }] },
      { id: 'mushoku3', t: '無職転生 ～異世界行ったら本気だす～ 第Ⅲ期', status: 'doing', ep: 3, total: null, weekday: '周四', hue: 155,
        tags: [{ v: '异世界', mine: false }, { v: '慢热神作', mine: true }] },
      { id: 'aohanako2', t: 'アオのハコ 第２期', status: 'doing', ep: 6, total: null, weekday: '周五', hue: 205,
        tags: [{ v: '青春', mine: false }] },
      { id: 'onepiece', t: 'ONE PIECE', status: 'doing', ep: 1127, total: null, weekday: '周六', hue: 25,
        tags: [{ v: '航海', mine: false }, { v: '十年老坑', mine: true }] },
      { id: 'sakamoto2', t: 'SAKAMOTO DAYS 第２期', status: 'wish', ep: 0, total: null, weekday: '周六', hue: 60,
        tags: [{ v: '杀手', mine: false }] },
      { id: 'haruhi', t: '涼宮ハルヒの憂鬱', status: 'doing', ep: 5, total: 24, weekday: null, hue: 45,
        tags: [{ v: '重温', mine: true }, { v: '经典', mine: false }] }
    ];
    const POOL = [
      { id: 'kaiju8_2', t: '怪獣８号 第２期', meta: 'TV · 连载中', hue: 260, weekday: '周四' },
      { id: 'windb3', t: 'ウィンドブレイカー 第３期', meta: 'TV · 连载中', hue: 190, weekday: '周四' },
      { id: 'yurucamp4', t: 'ゆるキャン△ SEASON４', meta: 'TV · 连载中', hue: 95, weekday: '周一' },
      { id: 'natsume8', t: '夏目友人帳 第８期', meta: 'TV · 连载中', hue: 130, weekday: '周二' },
      { id: 'rurudra', t: 'ルリドラゴン', meta: 'TV · 已完结', hue: 120, weekday: null },
      { id: 'shikanoko', t: 'しかのこのこのここしたんたん', meta: 'TV · 连载中', hue: 45, weekday: '周三' },
      { id: 'tsukimichi3', t: '月が導く異世界道中 第３期', meta: 'TV · 连载中', hue: 240, weekday: '周五' },
      { id: 'lls4', t: 'ラブライブ！スーパースター!! 第４期', meta: 'TV · 连载中', hue: 355, weekday: '周五' }
    ];
    const STATUS = { doing: '在看', wish: '想看', done: '看完' };
    let curTab = 'all';
    let query = '';

    function stampOf(t) {
      const cls = t.status === 'doing' ? 'st-teal' : t.status === 'done' ? 'st-gold' : 'st-silver';
      return `<span class="stamp small ${cls}" title="${STATUS[t.status]}">${STATUS[t.status]}</span>`;
    }
    function cardHTML(t) {
      const pct = t.total ? Math.min(100, Math.round((t.ep / t.total) * 100)) : (t.ep > 0 ? Math.min(100, 8 + t.ep * 6) : 0);
      const isToday = t.weekday === TODAY;
      return `
      <article class="trk-row" data-id="${t.id}">
        <span class="tape tr ${isToday ? 'sakura' : 'teal'}"></span>
        <div class="trk-cover">
          ${coverMarkup(t)}
        </div>
        <div class="trk-body">
          <div class="trk-head">
            <div class="trk-marks">${stampOf(t)}${isToday ? '<span class="chip-today">今天更新</span>' : ''}</div>
            <div class="trk-title">${esc(t.t)}</div>
            <span class="trk-ep">${t.total ? t.ep + ' / ' + t.total : t.ep + ' 集'}</span>
          </div>
          <div class="ep-ctrl">
            <div class="stepper">
              <button class="ep-minus" type="button" aria-label="减一集">${ic('minus', 'ic ic-sm')}</button>
              <span class="ep-num">EP ${t.ep}</span>
              <button class="ep-plus" type="button" aria-label="加一集">${ic('plus', 'ic ic-sm')}</button>
            </div>
            <div class="prog${t.status === 'done' ? ' done' : ''}"><i style="width:${pct}%"></i></div>
          </div>
          <div class="tagx-row">
            ${t.tags.map((g) => `<span class="tagx${g.mine ? ' mine' : ''}" data-tag="${esc(g.v)}">${esc(g.v)}${g.mine ? `<button aria-label="删除标签">${ic('x', 'ic ic-sm')}</button>` : ''}</span>`).join('')}
            <button class="tagx tagx-add" type="button" data-act="tagadd">＋ 标签</button>
          </div>
          <div class="trk-actions">
            <a class="btn btn-sm btn-primary" href="player.html">${ic('play', 'ic ic-sm')}继续看</a>
            <button class="btn btn-sm btn-ghost" type="button">${ic('external', 'ic ic-sm')}BGM</button>
            <div class="status-seg" role="group" aria-label="追番状态">
              <button class="seg-btn${t.status === 'wish' ? ' on' : ''}" type="button" data-status="wish" aria-pressed="${t.status === 'wish'}">想看</button>
              <button class="seg-btn${t.status === 'doing' ? ' on' : ''}" type="button" data-status="doing" aria-pressed="${t.status === 'doing'}">在看</button>
              <button class="seg-btn${t.status === 'done' ? ' on' : ''}" type="button" data-status="done" aria-pressed="${t.status === 'done'}">看完</button>
            </div>
            <button class="btn btn-sm btn-danger trk-rm" type="button" data-menu="remove">${ic('x', 'ic ic-sm')}移出</button>
          </div>
        </div>
        <div class="tagpop"></div>
      </article>`;
    }
    function renderCounts() {
      $$('.tabf').forEach((b) => {
        const k = b.dataset.tab;
        $('.badge-num', b).textContent = k === 'all' ? TRACKS.length : TRACKS.filter((t) => t.status === k).length;
      });
    }
    function render() {
      const qs = query.trim().toLowerCase();
      const match = (t) => (curTab === 'all' || t.status === curTab) && (!qs || t.t.toLowerCase().includes(qs));
      const visible = TRACKS.filter(match);
      const grid = $('#trkGrid');
      const todayN = TRACKS.filter((t) => t.weekday === TODAY).length;
      $('#todayCnt').textContent = todayN;
      $$('.rig-bubble span').forEach((b) => {
        b.textContent = todayN ? `今天有 ${todayN} 部更新，快去看快去看！` : '今天没有更新，慢慢补番也好～';
      });
      if (!visible.length) {
        grid.style.display = 'none';
        $('#trkEmpty').style.display = '';
        renderCounts();
        return;
      }
      grid.style.display = '';
      $('#trkEmpty').style.display = 'none';
      grid.innerHTML = visible.map(cardHTML).join('');
      renderCounts();
    }
    function findTrack(card) { return TRACKS.find((t) => t.id === card.closest('[data-id]').dataset.id); }
    function rerenderCard(t) {
      $$(`[data-id="${t.id}"]`).forEach((c) => {
        const tmp = document.createElement('div');
        tmp.innerHTML = cardHTML(t);
        c.replaceWith(tmp.firstElementChild);
      });
    }

    $$('.tabf').forEach((b) => b.addEventListener('click', () => {
      $$('.tabf').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      curTab = b.dataset.tab;
      render();
    }));
    const searchInput = $('#trkSearch');
    searchInput.addEventListener('input', () => {
      query = searchInput.value;
      render();
    });

    // 加番弹窗：显式入口，搜索 + 全量候选
    const addList = $('#addList');
    function renderPool() {
      const q = ($('#addSearch').value.trim() || '').toLowerCase();
      const hits = POOL.filter((p) => !q || p.t.toLowerCase().includes(q));
      addList.innerHTML = hits.length ? hits.map((p) => {
        const initial = esc((p.t.replace(/[！!？?＿—－・\s]/g, ' ').trim()[0]) || '☆');
        const added = TRACKS.some((t) => t.id === p.id);
        return `
        <div class="sugg-item">
          <span class="mini-cover" style="background:linear-gradient(160deg,hsl(${p.hue},45%,68%),hsl(${(p.hue + 40) % 360},40%,50%))">${initial}</span>
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.t)}</span>
          <span class="sugg-meta">${esc(p.meta)}${p.weekday ? ' · ' + p.weekday + '更新' : ''}</span>
          ${added
            ? '<span class="tagx mine" style="margin-left:auto">已经在手帐里啦</span>'
            : `<button class="btn btn-sm btn-primary" type="button" data-add="${p.id}" style="margin-left:auto;flex:none">${ic('plus', 'ic ic-sm')}贴进手帐</button>`}
        </div>`;
      }).join('') : '<div class="sugg-note">没有找到匹配的番剧……换个名字再试试？</div>';
    }
    $$('[data-dialog-open="addDlg"]').forEach((b) => b.addEventListener('click', () => {
      $('#addSearch').value = '';
      renderPool();
    }));
    $('#addSearch').addEventListener('input', renderPool);
    addList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-add]');
      if (!btn) return;
      const p = POOL.find((x) => x.id === btn.dataset.add);
      TRACKS.unshift({ id: p.id, t: p.t, status: 'wish', ep: 0, total: null, weekday: p.weekday, hue: p.hue, tags: [] });
      render(); renderPool();
      toast(`哼，『${p.t}』已经贴进手帐啦，先放在「想看」里。`);
    });

    $('#trkGrid').addEventListener('click', listActions);
    function listActions(e) {
      const card = e.target.closest('[data-id]');
      if (!card) return;
      const t = findTrack(card);
      if (e.target.closest('.ep-plus')) {
        t.ep += 1;
        if (t.status === 'wish') { t.status = 'doing'; toast(`『${t.t}』开始追啦`); }
        rerenderCard(t); renderCounts();
      } else if (e.target.closest('.ep-minus')) {
        if (t.ep > 0) t.ep -= 1;
        rerenderCard(t); renderCounts();
      } else if (e.target.closest('[data-status]')) {
        const next = e.target.closest('[data-status]').dataset.status;
        if (next !== t.status) {
          t.status = next;
          if (next === 'done' && t.total === null) t.total = t.ep;
          rerenderCard(t); renderCounts();
          toast(`『${t.t}』已标为「${STATUS[next]}」`);
        }
      } else if (e.target.closest('[data-menu="remove"]')) {
        openDialog('rmDlg');
        $('#rmName').textContent = t.t;
        $('#rmYes').onclick = () => {
          const i = TRACKS.indexOf(t);
          if (i > -1) TRACKS.splice(i, 1);
          closeDialog($('#rmYes'));
          render(); toast(`已移出『${t.t}』`);
        };
      } else if (e.target.closest('[data-act="tagadd"]')) {
        const pop = $('.tagpop', card);
        pop.classList.toggle('open');
        if (pop.classList.contains('open')) {
          pop.innerHTML = `<input maxlength="6" placeholder="回车添加，≤6 字"><button class="btn btn-sm" type="button">贴上</button>`;
          const inp = $('input', pop);
          inp.focus();
          const add = () => {
            const v = inp.value.trim();
            if (v && !t.tags.some((g) => g.v === v)) { t.tags.push({ v, mine: true }); rerenderCard(t); toast(`贴上了『${v}』标签`); }
            else if (v) toast('已经有这个标签了', { err: true });
          };
          inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); add(); } });
          $('button', pop).addEventListener('click', add);
        }
      } else if (e.target.closest('.tagx > button')) {
        const v = e.target.closest('.tagx').dataset.tag;
        t.tags = t.tags.filter((g) => g.v !== v);
        rerenderCard(t); toast(`撕掉了『${v}』标签`);
      }
    }
    $('#syncBtn').addEventListener('click', () => toast('追番已与服务器同步'));
    render();
  }

  /* ---------- 播放器 ---------- */
  if (page === 'player') {
    const LINES = {
      xifan: [
        { n: '稀饭 · 线路一', m: 'mp4 直连 · 高清' },
        { n: '稀饭 · 线路二', m: 'm3u8 · 高清' },
        { n: '稀饭 · 线路三', m: 'iframe 兜底' }
      ],
      girigiri: [
        { n: 'Girigiri · 繁中', m: 'm3u8 · 高清' },
        { n: 'Girigiri · 简中', m: 'm3u8 · 标准' }
      ]
    };
    let curSrc = 'xifan';
    let curEp = 8;
    const linesEl = $('#lineList');
    function renderLines() {
      linesEl.innerHTML = LINES[curSrc].map((l, i) => `
        <button class="line-card${i === 0 ? ' on' : ''}" type="button">
          <span class="lc-dot"></span>
          <span class="lc-name">${l.n}</span>
          <span class="lc-meta">${l.m}</span>
        </button>`).join('');
    }
    renderLines();
    linesEl.addEventListener('click', (e) => {
      const card = e.target.closest('.line-card');
      if (!card) return;
      $$('.line-card', linesEl).forEach((c) => c.classList.remove('on'));
      card.classList.add('on');
      toast(`已切换到「${$('.lc-name', card).textContent}」`);
    });
    $$('.src-seg > button').forEach((b) => b.addEventListener('click', () => {
      $$('.src-seg > button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      curSrc = b.dataset.src;
      renderLines();
      toast(curSrc === 'xifan' ? '已切到稀饭源（保持第 ' + curEp + ' 集）' : '已切到 Girigiri 源（保持第 ' + curEp + ' 集）');
    }));
    const pv = $('#pvBox');
    $('#playBtn').addEventListener('click', () => {
      const playing = pv.classList.toggle('playing');
      $('#playUse').setAttribute('href', playing ? '#i-pause' : '#i-play');
      toast(playing ? '开始播放（原型演示，没有真实视频流）' : '已暂停');
    });
    const grid = $('#epGrid');
    grid.addEventListener('click', (e) => {
      const cell = e.target.closest('.ep-cell');
      if (!cell) return;
      $$('.ep-cell', grid).forEach((c) => c.classList.remove('on'));
      cell.classList.add('on');
      curEp = parseInt(cell.textContent.replace(/\D/g, ''), 10);
      $('#epBadge').textContent = 'EP ' + curEp;
      pv.classList.remove('playing');
      $('#playUse').setAttribute('href', '#i-play');
      toast(`切到第 ${curEp} 集`);
    });
  }

  /* ---------- 设置：纸口袋手风琴 ---------- */
  if (page === 'settings') {
    const MODULES = ['profile', 'security', 'xifan', 'pref', 'sync'];
    function applyHash() {
      const h = (location.hash || '#profile').slice(1);
      const mod = MODULES.includes(h) ? h : 'profile';
      $$('.pocket').forEach((p) => p.classList.toggle('open', p.dataset.mod === mod));
      const el = $(`.pocket[data-mod="${mod}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    window.addEventListener('hashchange', applyHash);
    $$('.pocket-tab').forEach((b) => b.addEventListener('click', () => {
      const pocket = b.closest('.pocket');
      const willOpen = !pocket.classList.contains('open');
      $$('.pocket.open').forEach((p) => p.classList.remove('open'));
      if (willOpen) {
        pocket.classList.add('open');
        history.replaceState(null, '', '#' + pocket.dataset.mod);
      } else {
        history.replaceState(null, '', '#' + pocket.dataset.mod);
      }
    }));
    applyHash();

    $$('.save-btn').forEach((b) => b.addEventListener('click', function () {
      this.disabled = true;
      const note = $('.save-note', this.parentElement);
      if (note) { note.classList.add('show'); setTimeout(() => note.classList.remove('show'), 1800); }
      toast('已保存');
      setTimeout(() => { this.disabled = false; }, 800);
    }));
    $('#rbNext') && $('#rbNext').addEventListener('click', function () {
      if ($('#rbStep1').style.display !== 'none') {
        const mail = $('#rbMail');
        if (!mail.value.trim()) { mail.closest('.field').classList.add('err'); return; }
        $('#rbStep1').style.display = 'none';
        $('#rbStep2').style.display = 'flex';
        this.textContent = '完成换绑';
        toast('验证码已发到新邮箱（演示）');
      } else {
        const code = $('#rbStep2 input');
        if (!code.value.trim()) { code.closest('.field').classList.add('err'); return; }
        closeDialog(this);
        setTimeout(() => toast('邮箱换绑完成'), 200);
        $('#rbStep1').style.display = '';
        $('#rbStep2').style.display = 'none';
        this.textContent = '下一步';
      }
    });
    $('#rbBack') && $('#rbBack').addEventListener('click', () => {
      $('#rbStep1').style.display = '';
      $('#rbStep2').style.display = 'none';
      $('#rbNext').textContent = '下一步';
    });
    $('#ubDone') && $('#ubDone').addEventListener('click', function () {
      const code = $('#unbindDlg input');
      if (!code.value.trim()) { code.closest('.field').classList.add('err'); return; }
      closeDialog(this);
      setTimeout(() => toast('邮箱已解绑'), 200);
    });
    $$('form').forEach((f) => f.addEventListener('submit', (e) => e.preventDefault()));
    $('#xfLoginBtn') && $('#xfLoginBtn').addEventListener('click', function () {
      const user = $('#xfUser');
      if (!user.value.trim()) { user.closest('.field').classList.add('err'); return; }
      $('#xfForm').style.display = 'none';
      $('#xfOk').style.display = '';
      toast('稀饭账号已登录');
    });
    $('#xfLogout') && $('#xfLogout').addEventListener('click', () => {
      $('#xfForm').style.display = '';
      $('#xfOk').style.display = 'none';
      toast('已退出稀饭账号');
    });
  }

  /* ---------- 全页通用绑定 ---------- */
  $$('.dd-host').forEach(bindDD);
  bindDialogs();
  bindEyes();
  bindCaptchas();
  $$('.tail-btn.send').forEach((b) => b.addEventListener('click', () => bindCountdown(b)));
  // 立绘点击：弹一下（台词由各页自己接）
  $$('.rig-click').forEach((img) => img.addEventListener('click', () => {
    img.classList.remove('bounce'); void img.offsetWidth; img.classList.add('bounce');
  }));

  /* ---------- 登录态（原型内持久，跨页一致） ---------- */
  function setAuth(state) {
    document.body.dataset.auth = state;
    try { localStorage.setItem('sketch-auth', state); } catch (e) { /* file:// 隐私模式可忽略 */ }
  }
  if (localStorage.getItem('sketch-auth') === 'out') document.body.dataset.auth = 'out';
  $$('[data-logout]').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();
    setAuth('out');
    toast('已退出登录，回来记得找我');
    const href = b.getAttribute('href');
    if (href && href !== '#' && href !== 'index.html') location.href = href;
  }));

  const authDlg = $('#authDlg');
  if (authDlg) {
    const showPane = (name) => {
      $$('.auth-pane', authDlg).forEach((p) => p.classList.toggle('show', p.dataset.pane === name));
      $$('.auth-tab', authDlg).forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
    };
    $$('.auth-tab', authDlg).forEach((b) => b.addEventListener('click', () => showPane(b.dataset.tab)));
    $$('[data-pane-link]', authDlg).forEach((l) => l.addEventListener('click', () => showPane(l.dataset.paneLink)));
    const okByForm = {
      loginForm: () => { setAuth('in'); closeDialog($('#loginForm')); toast('登录成功！欢迎回来～'); },
      codeForm: () => { setAuth('in'); closeDialog($('#codeForm')); toast('登录成功！欢迎回来～'); },
      regForm: () => { setAuth('in'); closeDialog($('#regForm')); toast('注册成功，已自动登录'); },
      forgotForm: () => { toast('新密码已生效，用新密码登录吧'); showPane('pwd'); }
    };
    $$('form.auth-pane', authDlg).forEach((f) => bindFormDemo(f, okByForm[f.id]));
    $('.btn-google', authDlg).addEventListener('click', () => toast('跳转 Google 授权页（原型内不真跳）'));
  }
})();
