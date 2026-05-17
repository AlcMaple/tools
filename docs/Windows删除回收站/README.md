# Recycle —— Windows 强制删除工具

Node.js + PowerShell 的组合脚本，用来**自动化、无视各种占用 / 权限 / AV 干扰**地删除 Windows 上的文件或文件夹。

> 这份 README 同时也是**集成参考文档**——记录了所有踩过的坑和最终的策略选择，未来在项目中复刻这个功能时直接对着看就够了。

---

## TL;DR：两种模式怎么选

| 模式 | 命令 | 行为 | 可靠性 |
|---|---|---|---|
| **回收站模式（默认）** | `node recycle.js <path>` | 尝试整体送回收站，失败时分片送（每个文件、每个空目录单独送） | ⚠️ 看情况，被 AV 卡住时退化成"分片" |
| **永久删除模式** | `node recycle.js --purge <path>` | 直接永久删，绕开回收站 | ✅ **几乎一试就成** |

**对于刚跑过的 Electron 项目、`node_modules`、带 watcher 的目录**：用 `--purge`。
**对于普通临时文件、用户数据**：用默认模式，给用户留个反悔机会。

---

## 关于管理员权限

**默认情况下不需要管理员**。脚本对以下位置普通用户权限就够用：

- 用户目录下（`Downloads`、`Desktop`、`Documents`、`AppData`）
- 自己创建的项目文件夹
- 非系统盘的任意位置（`D:\`、`E:\` 等）

**什么时候需要 `--admin`**：

| 场景 | 是否需要 |
|---|---|
| 删 `C:\Program Files\...` 系统目录 | ✅ 需要 |
| 删 `C:\Windows\...` | ✅ 需要（且很多文件仍删不掉） |
| 文件 owner 不是当前用户（其他用户创建的） | ✅ 需要 |
| 想杀掉其他用户的进程占用 | ✅ 需要 |
| 删自己 Downloads / Desktop 里的东西 | ❌ 不需要 |
| 阶段 2 分片回收 | ❌ 不需要 |

**集成建议**：先不带 `--admin` 跑；如果失败且错误提示"权限拒绝"，再让调用方决定要不要弹 UAC 重试。

---

## 安装

### 1. 文件放对位置

两个文件**必须在同一个目录**：

```
D:\tools\recycle\
  ├─ recycle.js
  └─ recycle-helper.ps1
```

### 2. 确认有 Node.js

```powershell
node -v
```

显示版本号即可。没装去 <https://nodejs.org> 装 LTS。

### 3.（可选）加 PATH

在工具目录里建 `recycle.bat`：

```bat
@echo off
node "%~dp0recycle.js" %*
```

把工具目录加进系统 `Path`（`sysdm.cpl` → 高级 → 环境变量），重开终端后任意目录都能用 `recycle "路径"`。

> ⚠️ 别命名成 `del.bat`，会和系统 `del` 冲突。

---

## CLI 使用

### 基本

```powershell
node recycle.js "D:\path\to\folder"                          # 送回收站
node recycle.js --purge "D:\path\to\folder"                  # 永久删除
node recycle.js --admin "D:\path\to\folder"                  # 提权（弹 UAC，新窗口）
node recycle.js --admin --purge -v "D:\path\to\folder"       # 提权+永久删+详细日志
```

### 选项

| 选项 | 说明 |
|---|---|
| `-v` / `--verbose` | 显示所有内部步骤（哪步失败、杀了哪个进程、重命名到哪、分片进度等） |
| `--admin` / `-a` | 以管理员身份新开窗口运行；UAC 确认后跑，跑完暂停按键关闭，日志会回显到原终端 |
| `--purge` | **永久删除**模式（不送回收站） |

### 一次删多个

```powershell
node recycle.js "D:\a" "D:\b" "C:\c.txt" -v
```

---

## 作为 Node 模块调用（集成场景）

```javascript
const { recycle, EXIT } = require('./recycle');

try {
  const results = recycle('D:/path/to/folder', { purge: false, silent: true });
  // results: [{ status: 'deleted' | 'emptied-and-recycled' | 'already-absent', path }]

  for (const r of results) {
    if (r.status === 'emptied-and-recycled') {
      // 注意：这里要给用户提示！见下方"集成 UI 提示文案"
    }
  }
} catch (e) {
  console.error('删除失败:', e.message);
  // e.errors: [{ target, error, exitCode }]
  // 失败后通常要回退到 --purge 或建议重启
}
```

### 选项一览

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `purge` | boolean | `false` | 永久删除（绕过回收站） |
| `verbose` | boolean | `false` | 控制台打印详细日志 |
| `silent` | boolean | `false` | 屏蔽子进程的 stdout/stderr 输出 |
| `maxRetries` | number | `4` | 每个删除策略内部的重试次数 |

---

## 退出码契约（集成必读）

CLI 退出码 / 调用结果有四种状态，**集成时一定要处理 `4`**：

| 退出码 | `result.status` | 含义 | 用户该看到什么 |
|---|---|---|---|
| `0` | `deleted` | 完整删除成功（整个文件夹原样进回收站 / 永久删除） | "已删除" |
| `1` | — | 失败（抛 Error） | 错误提示，建议回退到 `--purge` 或重启 |
| `2` | — | 参数错误 | 用法提示（一般不会遇到） |
| `4` | `emptied-and-recycled` | **分片回收**：整体送回收站被拦，已按文件 / 子目录逐个送入回收站 | **必须给用户提示**，见下文 |
| —    | `already-absent` | 路径本来就不存在 | 静默成功 |

---

## ⚠️ 重要：阶段 2（分片回收）必须给用户提示

当返回 `exit 4` / `status: 'emptied-and-recycled'` 时，**回收站里的样子和用户预期不一样**——不是一个完整的文件夹，而是一堆散开的文件和子目录条目。集成时必须给用户清晰的提示。

### 推荐提示文案

**事前提示**（删除前，如果你知道目标大概率会触发分片）：

> 删除 "xxx" 时，如果系统拒绝整体送入回收站（常见于刚运行过的项目、被安全软件保护的文件夹），将自动按文件夹内每一项逐个送入回收站。
> - **优点**：所有内容都可恢复（在回收站全选 → 右键还原能重建目录结构）
> - **缺点**：回收站里看到的是散开的条目，不是一个完整文件夹
>
> 如不接受这种方式，可：
> 1. 重启电脑后再删（释放占用后通常能整体回收）
> 2. 使用永久删除功能（不进回收站，直接删除）
> 3. 取消本次删除

**事后提示**（拿到 `exit 4` 之后）：

> ⚠️ "xxx" 因被防护进程阻止整体回收，已按"分片回收"模式将每个文件 / 子目录单独送入回收站。
>
> 内容仍然完整可还原——打开回收站，找到这些条目，全选后右键"还原"即可重建原目录结构。

### UI 决策示意

```
用户点击"删除" → 调用 recycle(path)
  │
  ├─ exit 0 → 显示 "已删除" ✓
  │
  ├─ exit 4 → 显示 "已分片送入回收站" + 详细说明
  │           （可勾选"以后不再提示"，存到用户设置）
  │
  └─ exit 1 (抛错) → 弹对话框：
                    "无法送入回收站。可能原因：
                     - 文件正在被系统或杀毒软件保护
                     - 这种情况下可以："
                    [重启后重试] [永久删除] [取消]
                          │           │
                          │           └─ recycle(path, {purge: true})
                          └─ 提示用户保存工作后手动重启
```

---

## 策略链（实现细节）

### 回收站模式（默认）

```
阶段 1: 整体送回收站（5 秒窗口）
  ├─ 调 IFileOperation（Vista+ 的现代 COM 接口）
  ├─ 失败 → 清属性 + takeown/icacls + 杀已知占用进程
  ├─ 还失败 → 重命名为 _to_delete_xxxxxxxx（脱离原路径，shake off
  │           shell 钩子、索引器、缩略图缓存）
  ├─ 还失败 → 等几百毫秒重试
  └─ 5 秒内整体成功 → exit 0

阶段 2: 分片回收（兜底，几乎必成）
  ├─ 递归枚举整棵树
  ├─ 把所有文件一个一个 IFileOperation 送回收站
  ├─ 按深度倒序（深的先），把空目录一个一个送回收站
  ├─ 最后把根目录送回收站
  └─ 成功 → exit 4
```

**为什么阶段 2 能绕过 AV 拦截**：杀软（典型如 Windows Defender）盯的是"整目录树的重命名 / 移动"（防勒索软件批量加密后转移），不会拦"单个文件送回收站"和"单个空目录送回收站"。分片就是把"整目录移动"拆成 N 个单点操作。

### 永久删除模式（`--purge`）

```
策略链（串行，每个策略内重试 4 次）:
  1. Remove-Item -Recurse -Force
  2. cmd /c rd /s /q     ← 通常这步就成
  3. robocopy /MIR       ← 兜底，处理怪异 ACL / 长路径
```

每次重试前自动：清属性、takeown/icacls、杀占用进程。

### 进程发现（杀掉前先找出谁占用）

1. **Restart Manager**（`rstrtmgr.dll`）—— 资源管理器"文件正在使用中"对话框的底层 API
2. **进程的 .exe 路径在目标内** —— 比如打包后跑起来的 exe
3. **进程加载的 DLL 在目标内**（需要管理员）—— 比如 Electron 加载的本地模块
4. **进程命令行引用了目标路径** —— `node app.js <target>` 这种

**自身保护**：脚本启动时建立自身 PID 链（PID + 父进程链 + 直接子进程），扫到自己一律跳过，避免"自杀"。

---

## 为什么"永久删除"几乎一试就成，"回收站"却经常失败

这是 Windows 一个反直觉的设计：**两者走的不是同一条路径**。

| | 永久删除（`rd /s /q`） | 送回收站（`IFileOperation`） |
|---|---|---|
| 底层 | `DeleteFileW` / `RemoveDirectoryW` | Shell + `MoveFileW`（本质是移动） |
| 看哪个驱动 | NTFS 文件系统驱动 | Shell namespace + NTFS |
| 句柄要求 | 没有阻止"删除"的句柄就行 | 不能有阻止"重命名 / 移动"的句柄 |
| 看大小 | 不看 | 受回收站配额限制 |
| 看保护规则 | 不看 | AV / 防勒索软件特别盯着"整目录移动" |

**关键差异**：很多句柄（Windows Search 索引器、Defender、Electron 的 file watcher）打开时声明了 `FILE_SHARE_DELETE` —— 也就是"删除随便删，我自己会清理监视项，但**不允许重命名**"。这就导致：

- 删单个文件 ✅（NTFS 看到没有阻止删除的句柄）
- 把整个目录移到 `$Recycle.Bin\` ❌（持有方说"不准重命名"）

**重启之所以能进回收站**：重启释放了所有这些 watcher 句柄。

---

## 已知限制（Windows 硬规定，绕不开）

| 限制 | 原因 | 解决办法 |
|---|---|---|
| 网络盘 / FAT32 / exFAT 无法送回收站 | 系统不给这些位置提供回收站 | 用 `--purge` |
| 整体回收被 Defender / 杀软长期阻止 | AV 防勒索软件策略，主动阻止整目录移动 | 工具自动用分片回收（exit 4） |
| 受保护进程杀不掉（MsMpEng / TrustedInstaller） | PPL 受保护进程，管理员都不能杀 | 没办法，工具会跳过它们 |
| 不能静默 UAC 提权 | 微软专门防这个 | 调用方控制 UAC 弹出时机，或应用 manifest 配 `requireAdministrator` |
| 系统保护文件即使 takeown 也删不掉 | WRP（Windows Resource Protection） | 没办法，本来也不该删 |

---

## 集成到项目里的推荐模式

### 模式 A：双策略 + 用户确认（推荐用于普通应用）

```javascript
const { recycle } = require('./recycle');

async function safeDelete(path) {
  try {
    const r = recycle(path, { silent: true });
    if (r[0].status === 'emptied-and-recycled') {
      // 分片成功，提示用户
      ui.notify({
        type: 'warning',
        title: '已分片送入回收站',
        message: `"${path}" 因被安全软件保护无法整体回收，` +
                 `内容已按文件逐个送入回收站。在回收站全选相关项 → 右键还原可重建结构。`,
      });
    } else {
      ui.notify({ type: 'success', message: '已删除' });
    }
    return { ok: true };
  } catch (e) {
    // 回收站完全失败，让用户选下一步
    const choice = await ui.dialog({
      title: '无法送入回收站',
      message: '可能是文件正被安全软件或系统进程保护。',
      buttons: ['重启后重试', '永久删除', '取消'],
    });

    if (choice === '永久删除') {
      const confirm = await ui.confirm(`确定永久删除 "${path}"？此操作不可恢复。`);
      if (confirm) {
        recycle(path, { purge: true, silent: true });
        return { ok: true, permanent: true };
      }
    }
    if (choice === '重启后重试') {
      ui.notify({ message: '请保存工作后重启电脑，然后重新尝试删除。' });
    }
    return { ok: false };
  }
}
```

### 模式 B：项目内"软回收站"（推荐用于专业工具）

如果你的项目本身就是文件管理类的（清理工具、备份工具），**完全自建一个回收目录**：

```javascript
const TRASH = path.join(app.getPath('userData'), 'trash');

function softDelete(target) {
  fs.mkdirSync(TRASH, { recursive: true });
  const stamp = Date.now();
  const trashPath = path.join(TRASH, `${stamp}-${path.basename(target)}`);

  // 单盘内移动是 O(1)，不触发 AV 拦截
  // 因为目的地不在 Downloads/桌面/文档 等受保护路径
  fs.renameSync(target, trashPath);
}

// 配套：后台定时清理过期项
function purgeOldTrash(days = 7) {
  // 遍历 TRASH 删除 mtime > days 的项
  // 这里可以调 recycle(item, { purge: true }) 来强删
}
```

这种方案**完全绕开 Windows 系统回收站的所有限制**，是产品级软件的常见做法。

### 模式 C：直接永久删除（脚本 / 自动化场景）

CI、临时文件清理、缓存管理这类场景，根本不需要回收站这个不可靠的中间层：

```javascript
recycle(path, { purge: true, silent: true });
```

---

## 文件清单

```
recycle/
├─ recycle.js              # Node.js 入口（CLI + 可被 require）
├─ recycle-helper.ps1      # PowerShell 干活脚本
├─ recycle.bat             # （可选）方便加到 PATH 的批处理
└─ README.md               # 这个文件
```

---

## 故障排查

### exit 4 / 回收站里是散件

正常现象。整体回收被 AV 拦了，自动走了分片回收。**内容真的进了回收站**，全选 → 右键还原能重建目录结构（每个文件的"原位置"列还在）。

### "需要管理员权限"

只有目标在系统目录、或文件 owner 不是当前用户时才会出现。加 `--admin`：

```powershell
node recycle.js --admin "路径"
```

普通用户目录（Downloads、Desktop 等）下的文件不需要管理员。

### 阶段 1 反复重试浪费时间

调小 `RecycleTimeoutSec`（默认 5 秒）。可以改 `recycle-helper.ps1` 里 `param` 的默认值，或者从 `recycle.js` 透传。

### 一直 exit 1 怎么办

按顺序试：

1. **重启电脑**（释放所有句柄，再尝试普通删除）—— 90% 情况下能解决
2. **使用 `--purge` 永久删除**（绕开回收站的限制）
3. **关掉杀软实时保护后再试**（最后手段）

如果 `--purge` 也失败，目标可能是：
- 内核驱动锁定（杀软、安全软件）
- TrustedInstaller 保护的系统文件
- 系统正在用的关键 DLL

这些情况只能重启或者关掉相关软件后再删。

---

## 一句话总结

> **`--purge` 是稳定路径，回收站是 best-effort 加分项。** 集成时回收站当主选，**遇到 `exit 4` 一定要提示用户分片情况**，遇到 `exit 1` 给用户三个选项（重启 / 永久删 / 取消），不要让用户对着"回收站删不掉"的错误干瞪眼。