---
name: UI Integration Design
description: 在现有页面设计基础上添加新功能时，如何让新元素自然融入而不是强行插入按钮或入口。
---

# UI Integration Design

在现有 UI 上增加功能时，不能孤立地想"在哪里放一个按钮"，而要问"这个信息/操作，原本应该属于哪里"。

## 核心原则

### 1. 找到功能的"自然宿主"

新功能一定依附于某个已有的上下文——找到它，把功能嵌进去，而不是浮在外面。

**判断方法**：功能操作的对象是什么？那个对象的展示区域就是宿主。

> **案例**：本地库"查看文件夹路径"功能，操作对象是文件列表，宿主就是文件列表的头部区域。把路径栏嵌在列表顶部，而不是在页面某个角落单独放一个按钮。

### 2. 信息优先，操作次之

先把信息展示出来，操作隐藏在 hover 里。用户第一眼看到的是"这里有信息"，想操作时才发现可以点击。这比"这里有一个按钮"更自然。

**实现方式**：
- 主体内容正常显示（路径文字、状态文字）
- 操作图标用 `opacity-0 group-hover:opacity-100` 或 `text-primary/0 group-hover:text-primary/60` 在 hover 时淡入
- 整个区域可点击（`<button>` 包裹整行），而不是只有图标可点

```tsx
<button className="group flex items-center gap-3 ... hover:bg-surface-container-high transition-colors"
  onClick={...}>
  <span className="...text-on-surface-variant/50">{path}</span>
  <span className="material-symbols-outlined text-primary/0 group-hover:text-primary/60 transition-colors">
    open_in_new
  </span>
</button>
```

### 3. 复用，不叠加

新功能加进来后，检查原来是否有重复承担相同职责的元素，有就删掉。不能既加新的又留旧的。

> **案例**：路径栏加进文件列表头部后，状态栏里原有的 "Open Folder" 按钮就是重复的，直接删掉。

### 4. 用现有视觉语言

新元素的字体、颜色 token、圆角、间距，全部跟周围的元素保持一致，不引入新的视觉变量。

- 字体：`font-label text-[10px] uppercase tracking-widest` / `font-label text-[10px] tracking-wide`
- 颜色：`text-on-surface-variant/50`（低调）、`text-primary`（强调）
- 背景：与宿主区域同色系，hover 升一档（如 `bg-surface-container` → `hover:bg-surface-container-high`）
- 边框：`border-b border-white/5`（跟列表分隔线一致）

### 5. 不为功能创造新的视觉层级

如果加一个功能需要你新建一个卡片、一个 section、一个浮层，先停下来重新想。大多数功能都能找到现有的层级来寄生，不需要新建容器。

### 6. 下拉菜单宽度跟随触发元素

**默认规则**：下拉菜单的宽度 = 触发它的按钮（或 split button 整体）的宽度。不要拍脑袋写 `min-w-[180px]` / `min-w-[200px]` 这类"够大就行"的固定值——多半会超出触发元素，悬空伸到旁边按钮上方，视觉上像漏了一截。

**实现方式**：触发器外层 `relative`，下拉用 `absolute top-full ... w-full`，宽度自然继承父级。

```tsx
<div className="relative inline-flex" ref={menuRef}>
  <button>主操作</button>
  <button onClick={toggle}>▾</button>

  {open && (
    <div className="absolute top-full right-0 mt-1.5 w-full ...">
      {/* w-full ⇒ 菜单宽度 = 触发器整体宽度 */}
      <button className="w-full ...">选项 A</button>
      <button className="w-full ...">选项 B</button>
    </div>
  )}
</div>
```

**菜单项装不下时**：压缩**菜单项**，不要扩**容器**。手段：
- 字号降一档（`text-sm` → `text-xs font-label`，与项目其他下拉对齐）
- 图标缩 1px（16 → 15）
- gap 收紧（`gap-2` → `gap-1.5`）
- 必要时加 `whitespace-nowrap`、`shrink-0` 防换行/挤压

只有当**所有压缩都做完仍然装不下**，才去扩触发按钮本身的宽度（保持触发按钮 = 菜单宽度的同构关系），而不是给菜单写一个孤立的 `min-w`。

> **案例**：FileExplorer 的 DELETE split button 第一版用 `min-w-[180px]` 让菜单往左悬空越界到 OPEN 按钮上方。改成 `w-full` 后菜单严格贴着 split button 的右下角，"两个选项"和"一个按钮"在视觉上是一个垂直延展的整体。

---

## 工作流程

1. **明确操作对象**：这个功能操作/展示的是什么数据？
2. **找到宿主**：这个数据当前在页面的哪个区域展示？
3. **确定嵌入点**：宿主区域的头部/尾部/内部的哪个位置最自然？
4. **写 hover 交互**：信息可见，操作在 hover 时出现
5. **清理重复元素**：删掉原来重复承担相同职责的入口
6. **视觉对齐**：字体、颜色、间距跟周围一致，不引入新 token
7. **下拉宽度对齐**：若设计含下拉菜单，确认菜单宽度跟随触发器（默认 `w-full`），别用孤立的 `min-w`

---

## 反模式（避免）

- ❌ "在右上角加一个按钮" — 孤立的按钮，没有上下文
- ❌ 新功能 + 旧功能同时保留 — 叠加而不是替换
- ❌ 为一个功能新建一个 section / 卡片容器 — 视觉层级膨胀
- ❌ 操作图标常驻显示 — 视觉噪声，应该在 hover 时才出现
- ❌ 下拉菜单写 `min-w-[180px]` / `w-[200px]` 等固定值 — 容易超出触发器宽度悬空越界
