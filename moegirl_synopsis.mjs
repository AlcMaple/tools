#!/usr/bin/env node
/**
 * moegirl_synopsis.js
 * -------------------
 * 从萌娘百科（https://mzh.moegirl.org.cn）抓取动漫条目的剧情简介，
 * 支持可选地先从 bgm.tv 拿到「中文名 + 别名」作为候选标题。
 *
 * 关键点（踩坑记录）：
 * 1. 萌娘百科 "Moe Skin" 会把真正的 wiki 内容放在
 *        <template id="MOE_SKIN_TEMPLATE_BODYCONTENT">...</template>
 *    里，由客户端 Vue 渲染。直接从原始 HTML 解析正文时要先把这个
 *    template 的 innerHTML 取出来，再当作一份新的 HTML 文档解析。
 * 2. /api.php 默认会回 "Unauthorized API call"，所以直接抓页面 HTML。
 * 3. 小节标题结构（现代 MediaWiki）：
 *        <div class="mw-heading mw-heading3">
 *            <h3 id="剧情简介"><span id="..."></span>剧情简介</h3>
 *        </div>
 *    - id 在 h3 本身，不是 .mw-headline span
 *    - 外面套了一层 div.mw-heading，在"走兄弟节点找下一 heading"时要
 *      把这层 wrapper 也算进去
 * 4. 很多条目的中文名 / 别名和萌娘百科的页面名对不上，比如
 *    bgm 的《光之美少女》(subject 4243)，别名第一个是「两个人是光之美少女」，
 *    但萌娘百科里真正的那个页面叫《光之美少女(无印)》，
 *    直接搜"光之美少女"会落在「光之美少女系列」这个系列介绍页。
 *    本脚本的处理方式：
 *      a. 用 displayTitle 尾缀 `系列` / 页面内 `#系列介绍`/`#系列作品` /
 *         只有 `第X代` 分节而没有「简介」分节 这几条信号识别系列页；
 *      b. 在系列页里扫 <a title="..."> 的 title 属性 + 文字，
 *         只要文字命中 bgm 的任一别名，就把 title 当作真正的页面名
 *         再跳一次。
 *
 * 依赖：
 *     Node.js >= 18（用内置 fetch）
 *     cheerio（npm i cheerio）
 *
 * 用法：
 *     node moegirl_synopsis.js                 # 跑内置测试集
 *     node moegirl_synopsis.js 杀手青春        # 直接用萌娘百科标题
 *     node moegirl_synopsis.js 581284          # 纯数字当作 bgm subject id
 *     node moegirl_synopsis.js https://bgm.tv/subject/4243
 */

import * as cheerio from 'cheerio';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const MOEGIRL_BASE = 'https://mzh.moegirl.org.cn/';
const BGM_BASE = 'https://bgm.tv/';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// 按优先级排序的简介类标题
const SYNOPSIS_KEYWORDS = [
  '剧情简介',
  '故事简介',
  '剧情概要',
  '故事概要',
  '故事梗概',
  '内容简介',
  '作品简介',
  '剧情介绍',
  '简介',
];

const TEMPLATE_ID = 'MOE_SKIN_TEMPLATE_BODYCONTENT';
const PAGE_DATA_ID = 'MOE_SKIN_PAGE_DATA';

// ---------------------------------------------------------------------------
// 网络
// ---------------------------------------------------------------------------
async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    redirect: 'follow',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

// ---------------------------------------------------------------------------
// 萌娘百科页面解析
// ---------------------------------------------------------------------------
/**
 * 把页面 HTML 拆成：真正渲染用的正文根 (.mw-parser-output) + displayTitle。
 */
function loadMoegirlPage(html) {
  const $full = cheerio.load(html);

  // displayTitle：优先取 MOE_SKIN_PAGE_DATA 里的 JSON
  let displayTitle = null;
  const pageDataEl = $full(`#${PAGE_DATA_ID}`);
  if (pageDataEl.length) {
    try {
      const raw = pageDataEl.text() || pageDataEl.html() || '{}';
      const data = JSON.parse(raw);
      displayTitle =
        data.displaytitle || data.wgPageName || data.wgTitle || data.title || null;
    } catch {
      /* 忽略 */
    }
  }
  if (!displayTitle) {
    const t = $full('title').text();
    if (t) displayTitle = t.replace(/\s*-\s*萌娘百科.*$/, '').trim() || null;
  }
  if (displayTitle) {
    displayTitle = displayTitle.replace(/<[^>]+>/g, '').trim();
  }

  // 真正的正文在 <template> 里
  const tplEl = $full(`#${TEMPLATE_ID}`);
  let $body;
  if (tplEl.length) {
    const inner = tplEl.html() || '';
    $body = cheerio.load(inner);
  } else {
    // 老版皮肤 / 其他站：直接回退到整页
    $body = $full;
  }

  let root = $body('.mw-parser-output').first();
  if (!root.length) root = $body.root();

  return { $: $body, root, displayTitle };
}

// ---------------------------------------------------------------------------
// 标题 / 系列页识别
// ---------------------------------------------------------------------------
function findSynopsisHeading($, root) {
  const headings = root.find('h1,h2,h3,h4,h5,h6').toArray();
  // 1) 精确匹配候选关键词（按优先级）
  for (const kw of SYNOPSIS_KEYWORDS) {
    for (const h of headings) {
      const $h = $(h);
      if ($h.attr('id') === kw || $h.text().trim() === kw) return $h;
    }
  }
  // 2) 模糊匹配
  for (const h of headings) {
    const text = $(h).text().trim();
    if (/(简介|概要|梗概)/.test(text)) return $(h);
  }
  return null;
}

function isSeriesPage($, root, displayTitle) {
  if (displayTitle && /系列\s*$/.test(displayTitle)) return true;
  if (root.find('#系列介绍, #系列作品').length) return true;

  const headings = root.find('h2,h3').toArray();
  const hasEra = headings.some((h) => {
    const $h = $(h);
    const id = $h.attr('id') || $h.text().trim();
    return /^第[一二三四五六七八九十百千]+代$/.test(id);
  });
  if (hasEra && !findSynopsisHeading($, root)) return true;

  return false;
}

/**
 * 走 heading 之后的兄弟节点，收集到下一个同级或更高级标题之前的段落文本。
 */
function extractSynopsis($, heading) {
  const $wrapper = heading.closest('div.mw-heading');
  const startNode = $wrapper.length ? $wrapper : heading;
  const startLevel = parseInt(heading.prop('tagName').substring(1), 10);

  const parts = [];
  let sib = startNode.next();

  while (sib.length) {
    const tag = (sib.prop('tagName') || '').toUpperCase();

    // 下一个同级或更高级 heading -> 停止
    if (tag === 'DIV' && sib.hasClass('mw-heading')) {
      const inner = sib.find('h1,h2,h3,h4,h5,h6').first();
      if (inner.length) {
        const lvl = parseInt(inner.prop('tagName').substring(1), 10);
        if (lvl <= startLevel) break;
      }
    } else if (/^H[1-6]$/.test(tag)) {
      const lvl = parseInt(tag.substring(1), 10);
      if (lvl <= startLevel) break;
    }

    if (['P', 'UL', 'OL', 'BLOCKQUOTE'].includes(tag)) {
      const t = sib.text().trim();
      if (t) parts.push(t);
    } else if (tag === 'DIV') {
      const cls = sib.attr('class') || '';
      if (/\b(poem|quote|mw-collapsible)\b/.test(cls)) {
        const t = sib.text().trim();
        if (t) parts.push(t);
      }
    }

    sib = sib.next();
  }

  return tidy(parts.join('\n\n'));
}

function tidy(text) {
  return text
    .replace(/\[\s*\d+\s*\]/g, '')
    .replace(/\[\s*编辑\s*\]/g, '')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 系列页 -> 在页面里找 <a title="..."> 的文字命中别名的链接，
 * 把 title 属性当作真正的条目名返回。
 */
function findLinkByAlias($, root, aliases) {
  const anchors = root.find('a[title]').toArray();
  for (const alias of aliases) {
    if (!alias) continue;
    for (const a of anchors) {
      const $a = $(a);
      if ($a.text().trim() === alias) {
        const title = $a.attr('title');
        if (title) return title;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// bgm.tv 解析
// ---------------------------------------------------------------------------
async function fetchBgmInfo(subjectId) {
  const url = `${BGM_BASE}subject/${subjectId}`;
  const html = await fetchHtml(url);
  if (!html) return null;

  const $ = cheerio.load(html);
  const out = { cn: null, original: null, aliases: [] };

  const h1 = $('h1.nameSingle');
  if (h1.length) {
    const a = h1.find('a').first();
    if (a.length) out.original = a.text().trim();
  }

  const seen = new Set();
  $('#infobox li').each((_, li) => {
    const $li = $(li);
    const tip = $li.children('.tip').first();
    if (!tip.length) return;
    const key = tip.text().trim();

    // 从 .tip 之后开始取文本，遇到 ul/ol/br 就停（避免把嵌套的别名列表吞掉）
    let value = '';
    let n = tip[0].next;
    while (n) {
      if (n.type === 'tag' && ['ul', 'ol', 'br'].includes(n.name)) break;
      if (n.type === 'text') value += n.data;
      else if (n.type === 'tag') value += $(n).text();
      n = n.next;
    }
    value = value.trim();
    if (!value) return;

    if (key.startsWith('中文名')) {
      if (!out.cn) out.cn = value;
    } else if (key.startsWith('别名')) {
      if (!seen.has(value)) {
        seen.add(value);
        out.aliases.push(value);
      }
    }
  });

  return out;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function tryPage(title) {
  const html = await fetchHtml(MOEGIRL_BASE + encodeURIComponent(title));
  if (!html) return { ok: false, reason: '404' };
  const page = loadMoegirlPage(html);
  return { ok: true, ...page };
}

async function resolveSynopsis(bgmInfo) {
  // 候选标题：中文名 > 每个别名
  const candidates = [];
  const push = (s) => {
    if (s && !candidates.includes(s)) candidates.push(s);
  };
  push(bgmInfo.cn);
  for (const a of bgmInfo.aliases) push(a);

  const allNames = candidates.slice(); // 用于系列页 link 匹配

  for (const candidate of candidates) {
    const page = await tryPage(candidate);
    if (!page.ok) continue;

    const { $, root, displayTitle } = page;
    if (!root || root.length === 0) continue;

    if (isSeriesPage($, root, displayTitle)) {
      const resolved = findLinkByAlias($, root, allNames);
      if (!resolved) continue;

      const deeper = await tryPage(resolved);
      if (!deeper.ok) continue;
      if (!deeper.root || deeper.root.length === 0) continue;
      if (isSeriesPage(deeper.$, deeper.root, deeper.displayTitle)) continue;

      const h = findSynopsisHeading(deeper.$, deeper.root);
      if (!h) continue;
      const syn = extractSynopsis(deeper.$, h);
      if (syn) {
        return {
          matchedTitle: resolved,
          via: `series(${candidate})->resolve`,
          synopsis: syn,
        };
      }
      continue;
    }

    const heading = findSynopsisHeading($, root);
    if (heading) {
      const syn = extractSynopsis($, heading);
      if (syn) {
        return {
          matchedTitle: displayTitle || candidate,
          via: 'direct',
          synopsis: syn,
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const TEST_CASES = [
  { title: '杀手青春', bgmId: '581284' },
  { title: '冰之城墙' },
  { title: '亚托莉' },
  { title: '光之美少女', bgmId: '4243' }, // 系列页 + 别名解析的典型例子
];

function parseArg(arg) {
  const m = arg.match(/\/subject\/(\d+)/);
  if (m) return { bgmId: m[1] };
  if (/^\d+$/.test(arg)) return { bgmId: arg };
  return { title: arg };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runOne(target) {
  const label = target.title || target.bgmId || '?';
  console.log('='.repeat(72));
  console.log(`《${label}》${target.bgmId ? ` (bgm ${target.bgmId})` : ''}`);
  console.log('='.repeat(72));

  let bgmInfo = { cn: null, original: null, aliases: [] };
  if (target.bgmId) {
    try {
      bgmInfo = (await fetchBgmInfo(target.bgmId)) || bgmInfo;
      console.log(
        `[bgm] 中文名=${bgmInfo.cn ?? '(空)'}  原名=${bgmInfo.original ?? '(空)'}  别名=${JSON.stringify(bgmInfo.aliases)}`,
      );
    } catch (e) {
      console.log(`[bgm] 抓取失败: ${e.message}`);
    }
  }
  if (!bgmInfo.cn && target.title) bgmInfo.cn = target.title;

  let result = null;
  try {
    result = await resolveSynopsis(bgmInfo);
  } catch (e) {
    console.log(`[错误] ${e.message}`);
  }

  if (result) {
    console.log(`[匹配] ${result.matchedTitle}  (via ${result.via})`);
    console.log(`[字数] ${result.synopsis.length}`);
    console.log();
    console.log(result.synopsis);
  } else {
    console.log('[未找到简介]');
  }
  console.log();
}

async function main() {
  const args = process.argv.slice(2);
  const targets = args.length ? args.map(parseArg) : TEST_CASES;

  let hit = 0;
  for (const t of targets) {
    try {
      await runOne(t);
      hit += 1;
    } catch (e) {
      console.error(e);
    }
    await sleep(400); // 温和限速
  }
  console.log(`共 ${targets.length} 个，跑完 ${hit} 个。`);
}

// ESM entrypoint detect
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1] || '');

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export {
  fetchBgmInfo,
  fetchHtml,
  loadMoegirlPage,
  findSynopsisHeading,
  isSeriesPage,
  extractSynopsis,
  findLinkByAlias,
  resolveSynopsis,
};