## 一、搜索结果页——动漫卡片结构

### 整体层级
```
body.theme2
  └── div.box-width
        └── div.row.mask2
              └── div.vod-detail.style-detail.cor4.search-list   ← 每张卡片
```

### 每张卡片内部结构

```html
<div class="vod-detail style-detail cor4 search-list">
  <div class="flex rel overflow">

    <!-- 左侧：封面图 -->
    <div class="fadeInLeft">
      <div class="detail-pic">
        <img class="lazy lazy1 gen-movie-img mask- entered loaded"
             alt="葬送的芙莉蓮 第二季"
             data-src="/upload/vod/{date}/{hash}.webp"   ← ⚠️ 懒加载，用 data-src 不是 src
             referrerpolicy="no-referrer">
      </div>
    </div>

    <!-- 右侧：信息区 -->
    <div class="detail-info rel flex-auto lightSpeedIn">

      <!-- 标题 -->
      <a href="/GV{id}/">
        <h3 class="slide-info-title hide">葬送的芙莉蓮 第二季</h3>
      </a>

      <!-- 状态 + 年份 + 月份 -->
      <div class="slide-info hide this-wap">
        <span class="slide-info-remarks cor5">更新至09集 / 23點0分</span>
        <span class="slide-info-remarks"><a>2026</a></span>
        <span class="slide-info-remarks"><a>一月</a></span>
      </div>

      <!-- 导演 -->
      <div class="slide-info hide partition">
        <strong class="cor6 r6">導演 :</strong>
        <a>北川朋哉</a>
      </div>

      <!-- 演员 -->
      <div class="slide-info hide this-wap partition">
        <strong class="cor6 r6">演員 :</strong>
        <span>種崎敦美, 市之瀬加那 ...</span>
      </div>

      <!-- 类型 -->
      <div class="slide-info hide this-wap partition">
        <strong class="cor6 r6">類型 :</strong>
        <a>冒險</a>, <a>劇情</a> ...
      </div>

      <!-- 按钮 -->
      <a class="button" href="/playGV{id}-1-1/">播放</a>
      <div class="detail-get-box collection button bj3">收藏</div>

    </div>
  </div>
</div>
```

**两季的差异**：`slide-info-remarks.cor5` 的文字不同——第二季是"更新至09集"，第一季是"已完結"。

---

## 二、播放页——资源列表与集数结构

### 整体层级
```
div.player-anthology
  ├── div.anthology-header.top20          ← "資源列表" 标题 + 排序/单列/下集按钮
  └── div.anthology.wow.fadeInUp
        ├── div.anthology-tab.nav-swiper.b-b.swiper-*   ← 繁中/简中 切换 Tab
        ├── div.flex.line-switch.wrap                   ← 布局切换（空）
        └── div.anthology-list.top20.select-a           ← 集数列表总容器
              ├── div.anthology-list-box.none.dx         ← 繁中列表
              └── div.anthology-list-box.none            ← 简中列表
```

### Tab 切换标签（繁中/简中）

```html
<div class="anthology-tab nav-swiper b-b swiper-initialized ...">
  <div class="swiper-wrapper">
    <!-- 繁中（激活状态有 on + swiper-slide-active） -->
    <a class="vod-playerUrl swiper-slide on nav-dt swiper-slide-active"
       data-form="cht">
      <i class="fa"></i>           ← 图标（CSS 字体渲染"繁中"文字）
      <span class="badge">9</span> ← 集数角标
    </a>

    <!-- 简中（未激活） -->
    <a class="vod-playerUrl swiper-slide swiper-slide-next"
       data-form="chs">
      <i class="fa"></i>
      <span class="badge">8</span>
    </a>
  </div>
</div>
```

### 集数列表（li 条目）

```html
<!-- 繁中列表：class 有 dx 标记为当前激活源 -->
<div class="anthology-list-box none dx">
  <ul class="anthology-list-play size">

    <!-- 当前播放集：li 有 on + ecnav-dt，a 内多一个 em.play-on 动画 -->
    <li class="bj3 border on ecnav-dt">
      <a class="hide cor4" href="/playGV26879-1-1/">
        <span>01</span>
        <em class="play-on">   ← 正在播放动画（4个空 i）
          <i></i><i></i><i></i><i></i>
        </em>
      </a>
    </li>

    <!-- 其他集：普通 li，无 on/ecnav-dt，无 em.play-on -->
    <li class="bj3 border">
      <a class="hide cor4" href="/playGV26879-1-2/">
        <span>02</span>
      </a>
    </li>
    ...
  </ul>
</div>

<!-- 简中列表：无 dx，同样有 none（隐藏） -->
<div class="anthology-list-box none">
  <ul class="anthology-list-play size">
    <li class="bj3 border">
      <a class="hide cor4" href="/playGV26879-2-1/">  ← 注意第二段是 -2-
        <span>01</span>
      </a>
    </li>
    ...
  </ul>
</div>
```

---

## 三、你复制元素获取不到的原因

**核心问题有三个：**

**① 图片用懒加载 `data-src` 而非 `src`**
图片元素 `src` 属性是空的或占位符，真实地址在 `data-src`，直接取 `src` 拿不到图。

**② 两个集数列表都有 `none` class（即 `display:none`）**
`anthology-list-box` 永远带着 `none`，靠 `dx` class 区分"当前 Tab"，但 JS 会在切 Tab 时动态显示对应 box。如果你用 `querySelector` 只选可见元素，或者 Playwright/Puppeteer 里用 `isVisible()` 判断，都会漏掉它们。要直接用 class 选择器 `.anthology-list-box` 全量抓，再根据有无 `dx` 判断是哪个源。

**③ `anthology-tab` 里的"繁中/简中"文字是 CSS 字体图标渲染的，不是 innerText**
`<i class="fa">` 的内容是空的，文字是通过 CSS `::before` 伪元素 + 字体文件渲染出来的，所以用 `textContent` 或 `innerText` 取不到"繁中"，只能靠 `data-form="cht"` / `data-form="chs"` 属性来区分。