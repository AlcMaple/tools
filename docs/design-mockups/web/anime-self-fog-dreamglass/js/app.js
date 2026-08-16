/* ============================================================
   「雾境梦璃」设计稿 · 共享交互脚本
   主题切换 / 背景粒子 / 点击星屑 / 对话盒 Toast /
   自绘下拉 / 模态框 / 倒计时 —— 各页面共用
   ============================================================ */
'use strict';

/* ---------- 图标 sprite：统一内联 SVG，一次注入全页可用 ---------- */
const MIST_ICONS = {
  star: '<path d="M12 1.8l2.35 7.85L22.2 12l-7.85 2.35L12 22.2l-2.35-7.85L1.8 12l7.85-2.35z"/>',
  calendar: '<path d="M20 4h-3V2h-2v2H9V2H7v2H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H4V9h16zm0-13H4V6h16z"/>',
  play: '<path d="M8 5v14l11-7z"/>',
  plus: '<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z"/>',
  search: '<path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/>',
  tune: '<path d="M3 17v2h6v-2zM3 5v2h10V5zm10 16v-2h8v-2h-8v-2h-2v6zM7 9v2H3v2h4v2h2V9zm14 4v-2H11v2zm-6-4h2V7h4V5h-4V3h-2z"/>',
  mail: '<path d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 4-8 5-8-5V6l8 5 8-5z"/>',
  eye: '<path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zm0 12a4.5 4.5 0 1 1 4.5-4.5 4.5 4.5 0 0 1-4.5 4.5zm0-7a2.5 2.5 0 1 0 2.5 2.5 2.5 2.5 0 0 0-2.5-2.5z"/>',
  'eye-off': '<path d="M2.1 3.51 3.51 2.1l18.39 18.39-1.41 1.41-3.28-3.28A10.2 10.2 0 0 1 12 19.5c-5 0-9.27-3.11-11-7.5a11.7 11.7 0 0 1 5.15-5.24zM12 8.5a3.5 3.5 0 0 1 3.5 3.5l-1.32 1.32a2.4 2.4 0 0 0-3.16-3.16L9.7 8.84A3.5 3.5 0 0 1 12 8.5zm-7.4-.61A11.6 11.6 0 0 0 1 12c1.73 4.39 6 7.5 11 7.5 1.39 0 2.72-.25 3.96-.7L13.5 15.3A4.5 4.5 0 0 1 8.7 10.5zM6.22 5.97l1.55 1.55A10 10 0 0 1 12 6.5c5 0 9.27 3.11 11 7.5a12 12 0 0 1-2.28 3.35l1.46 1.46A11.9 11.9 0 0 0 24 12c-1.73-4.39-6-7.5-11-7.5a10.7 10.7 0 0 0-3.1.46z" opacity=".9"/>',
  chev: '<path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/>',
  close: '<path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>',
  check: '<path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>',
  moon: '<path d="M12.3 4.9c.4-.2.6-.7.5-1.1s-.6-.8-1-.8C6.8 3.1 3 7.1 3 12c0 5 4 9 9 9 4.9 0 8.9-3.8 9-8.8 0-.4-.3-.9-.8-1s-.9.1-1.1.5c-.9 1.5-2.5 2.3-4.2 2.3-2.7 0-4.9-2.2-4.9-4.9 0-1.7.9-3.3 2.3-4.2z"/>',
  sun: '<path d="M20 8.69V4h-4.69L12 .69 8.69 4H4v4.69L.69 12 4 15.31V20h4.69L12 23.31 15.31 20H20v-4.69L23.31 12 20 8.69zM12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6zm0-10c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4z"/>',
  logout: '<path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8v-2H4z"/>',
  user: '<path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm0 2c-3.31 0-8 1.79-8 4v2h16v-2c0-2.21-4.69-4-8-4z"/>',
  shield: '<path d="M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5z"/>',
  refresh: '<path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z"/>',
  edit: '<path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z"/>',
  heart: '<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54z"/>',
  tv: '<path d="M21 3H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5v2h8v-2h5a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 14H3V5h18z"/>',
  send: '<path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"/>',
  trash: '<path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/>',
  alert: '<path d="M1 21h22L12 2zm12-3h-2v-2h2zm0-4h-2v-4h2z"/>',
  key: '<path d="M12.65 10C11.83 7.67 9.61 6 7 6a6 6 0 1 0 0 12c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h2v-4zM7 14a2 2 0 1 1 2-2 2 2 0 0 1-2 2z"/>',
  login: '<path d="M11 7 9.6 8.4 12.2 11H2v2h10.2l-2.6 2.6L11 17l5-5zM20 19h-8v2h8a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-8v2h8z"/>',
};

document.head.insertAdjacentHTML(
  'beforeend',
  `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">${Object.entries(MIST_ICONS)
    .map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24">${v}</symbol>`)
    .join('')}</svg>`
);

/* Google 四色 G（品牌资源，多色 path） */
const GOOGLE_MARK = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
<path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.57 5.57 0 0 1-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"/>
<path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A12 12 0 0 0 12 24z"/>
<path fill="#FBBC05" d="M5.27 14.29A7.2 7.2 0 0 1 4.89 12c0-.8.14-1.57.38-2.29V6.62H1.29A12 12 0 0 0 0 12c0 1.94.47 3.76 1.29 5.38z"/>
<path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42A11.97 11.97 0 0 0 12 0 12 12 0 0 0 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"/>
</svg>`;

/* ---------- 主题：夜雾（默认）/ 晨雾 ---------- */
const Mist = {
  get theme() { return document.documentElement.dataset.mist || 'night'; },
  set(theme) {
    if (theme === this.theme) return;
    const root = document.documentElement;
    root.classList.add('mist-transition');
    root.dataset.mist = theme;
    try { localStorage.setItem('mist-theme', theme); } catch (e) { /* 隐私模式 */ }
    clearTimeout(this._t);
    this._t = setTimeout(() => root.classList.remove('mist-transition'), 500);
    document.dispatchEvent(new CustomEvent('mist:theme', { detail: { theme } }));
  },
  toggle() { this.set(this.theme === 'night' ? 'day' : 'night'); },
};

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-mist-toggle]');
  if (btn) {
    Mist.toggle();
    const isNight = Mist.theme === 'night';
    btn.innerHTML = isNight
      ? '<svg class="ic"><use href="#i-moon"/></svg>'
      : '<svg class="ic"><use href="#i-sun"/></svg>';
    btn.title = isNight ? '切换到晨雾' : '切换到夜雾';
  }
});

/* ---------- 背景粒子：夜雾=星屑闪烁 / 晨雾=樱花花瓣 ---------- */
(() => {
  const cv = document.getElementById('mist-particles');
  if (!cv || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ctx = cv.getContext('2d');
  let W, H, parts = [], raf;

  const rand = (a, b) => a + Math.random() * (b - a);

  function resize() {
    W = cv.width = innerWidth * devicePixelRatio;
    H = cv.height = innerHeight * devicePixelRatio;
    cv.style.width = innerWidth + 'px';
    cv.style.height = innerHeight + 'px';
    const n = Math.round(Math.min(64, (innerWidth * innerHeight) / 26000));
    parts = Array.from({ length: n }, () => spawn(true));
  }

  function spawn(anyY) {
    const night = Mist.theme === 'night';
    return night
      ? {
          x: rand(0, W), y: anyY ? rand(0, H) : -20,
          r: rand(0.8, 2.2) * devicePixelRatio,
          vy: rand(0.05, 0.22), vx: rand(-0.05, 0.05),
          tw: rand(0.5, 1.6), ph: rand(0, Math.PI * 2),
        }
      : {
          x: rand(0, W), y: anyY ? rand(0, H) : -20,
          r: rand(2, 4) * devicePixelRatio,
          vy: rand(0.35, 0.9), vx: rand(-0.4, 0.4),
          rot: rand(0, Math.PI * 2), vr: rand(-0.02, 0.02),
          hue: Math.random() < 0.7 ? '244,168,196' : '186,152,235',
          sw: rand(0.008, 0.02), ph: rand(0, Math.PI * 2),
        };
  }

  function drawStar(p, alpha) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.ph);
    ctx.fillStyle = `rgba(246,222,150,${alpha})`;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      ctx.rotate(Math.PI / 2);
      ctx.moveTo(0, 0);
      ctx.lineTo(p.r * 2.6, p.r * 0.55);
      ctx.lineTo(p.r * 2.6, -p.r * 0.55);
    }
    ctx.fill();
    ctx.restore();
  }

  function tick(t) {
    ctx.clearRect(0, 0, W, H);
    const night = Mist.theme === 'night';
    for (const p of parts) {
      p.x += p.vx + Math.sin(t * 0.0004 + p.ph) * 0.08;
      p.y += p.vy;
      if (p.y > H + 30 || p.x < -30 || p.x > W + 30) Object.assign(p, spawn(false));
      if (night) {
        const a = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(t * 0.001 * p.tw + p.ph));
        drawStar(p, a);
      } else {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        p.rot += p.vr;
        ctx.fillStyle = `rgba(${p.hue},.55)`;
        ctx.beginPath();
        ctx.ellipse(0, 0, p.r, p.r * 0.55, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
    raf = requestAnimationFrame(tick);
  }

  addEventListener('resize', resize);
  resize();
  raf = requestAnimationFrame(tick);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else raf = requestAnimationFrame(tick);
  });
})();

/* ---------- 点击星屑反馈 ---------- */
document.addEventListener('pointerdown', (e) => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (e.target.closest('input, textarea, .dd-menu')) return;
  for (let i = 0; i < 6; i++) {
    const s = document.createElement('span');
    s.className = 'spark';
    s.textContent = '✦';
    const ang = Math.random() * Math.PI * 2;
    const dist = 22 + Math.random() * 30;
    s.style.cssText = `left:${e.clientX}px;top:${e.clientY}px;--dx:${Math.cos(ang) * dist}px;--dy:${Math.sin(ang) * dist}px;font-size:${10 + Math.random() * 8}px`;
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 600);
  }
});

/* ---------- 对话盒 Toast（名牌 + 打字机） ---------- */
const Say = (() => {
  let box, txtEl, timer, typeTimer, hideTimer, queue = [], busy = false;

  function ensure() {
    if (box) return;
    box = document.createElement('div');
    box.className = 'toast-vn';
    box.innerHTML = `<span class="plate">纱雾</span><p class="txt"></p>
      <button class="btn-ico close-x" title="关闭"><svg class="ic sm"><use href="#i-close"/></svg></button>`;
    document.body.appendChild(box);
    txtEl = box.querySelector('.txt');
    box.querySelector('.close-x').addEventListener('click', finish);
  }

  function play({ text, error }) {
    ensure();
    box.classList.toggle('t-error', !!error);
    box.querySelector('.plate').textContent = '纱雾';
    box.classList.add('show');
    let i = 0;
    clearInterval(typeTimer);
    txtEl.innerHTML = '<span class="caret"></span>';
    typeTimer = setInterval(() => {
      i++;
      txtEl.innerHTML = text.slice(0, i).replace(/</g, '&lt;') + '<span class="caret"></span>';
      if (i >= text.length) {
        clearInterval(typeTimer);
        clearTimeout(hideTimer);
        hideTimer = setTimeout(finish, 3600);
      }
    }, 26);
  }

  function finish() {
    ensure();
    clearTimeout(hideTimer);
    clearInterval(typeTimer);
    box.classList.remove('show');
    busy = false;
    clearTimeout(timer);
    timer = setTimeout(next, 320);
  }

  function next() {
    if (busy || !queue.length) return;
    busy = true;
    play(queue.shift());
  }

  return {
    say(text, opts = {}) {
      queue.push({ text, error: opts.error });
      next();
    },
  };
})();

/* ---------- 倒计时按钮（发送验证码等） ---------- */
function countdown(btn, sec = 60) {
  let left = sec;
  const origin = btn.dataset.originText || btn.textContent;
  btn.dataset.originText = origin;
  btn.disabled = true;
  btn.textContent = `${left}s 后重发`;
  const t = setInterval(() => {
    left--;
    if (left <= 0) {
      clearInterval(t);
      btn.disabled = false;
      btn.textContent = origin;
    } else btn.textContent = `${left}s 后重发`;
  }, 1000);
}

/* ---------- 自绘下拉 ---------- */
document.addEventListener('click', (e) => {
  const dd = e.target.closest('.dd');
  document.querySelectorAll('.dd.open').forEach((d) => { if (d !== dd) d.classList.remove('open'); });
  if (!dd) return;
  if (e.target.closest('.dd-btn')) dd.classList.toggle('open');
  const item = e.target.closest('.dd-item');
  if (item) {
    dd.querySelectorAll('.dd-item.on').forEach((i) => i.classList.remove('on'));
    item.classList.add('on');
    const val = dd.querySelector('.dd-val');
    if (val) val.textContent = item.dataset.val || item.textContent.trim();
    dd.classList.remove('open');
    dd.dispatchEvent(new CustomEvent('dd:select', { detail: { value: item.dataset.val || item.textContent.trim() } }));
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.dd.open').forEach((d) => d.classList.remove('open'));
});

/* ---------- 模态框 ---------- */
document.addEventListener('click', (e) => {
  const open = e.target.closest('[data-dialog-open]');
  if (open) {
    const d = document.getElementById(open.dataset.dialogOpen);
    if (d) { d.classList.add('show'); const f = d.querySelector('input'); if (f) setTimeout(() => f.focus(), 120); }
  }
  if (e.target.closest('[data-dialog-close]') || e.target.classList.contains('dim')) {
    e.target.closest('.dim')?.classList.remove('show');
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.dim.show').forEach((d) => d.classList.remove('show'));
});

/* ---------- Tabs ---------- */
document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (!tab) return;
  const wrap = tab.closest('[data-tabs]');
  wrap.querySelectorAll('[data-tab]').forEach((t) => t.classList.toggle('on', t === tab));
  wrap.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('show', p.dataset.panel === tab.dataset.tab));
});

/* ---------- 顶栏当前页高亮 ---------- */
document.querySelectorAll('.nav-link[href]').forEach((a) => {
  if (a.getAttribute('href') === location.pathname.split('/').pop()) a.classList.add('on');
});
