# 自动更新国内加速 - Windows 真机验证指南

> 这份文件是给你切到 Windows 机器之后照着做用的。Mac 上的对话窗口看不到了，所有要做的事都写在这里，做完把结果填回每个步骤下的「📝 结果」框，发回 Mac 端给 Claude 判断下一步。
>
> 配套阶段日志：[docs/ideas/007-自动更新国内加速.md](../ideas/archive/007-自动更新国内加速.md)

## 背景（5 分钟搞清楚）

- **要验证什么**：commit `0a73903` 落地了「国内加速自动更新」方案 —— 用 ghproxy 代理链 + 远程可改 `update-manifest.json` 解决国内无魔法用户连 GitHub feed 死掉的问题。代码已 push 到 `main`，Mac 上 curl 过三条通道都 200，但**国内真机网络才是真考场**。
- **要测两件事**：
  1. **本机 == manifest 版本** → 检查更新应显示「已是最新版本」。这一关过了说明「拉 manifest → 比对版本」整条链路在你这台机器上是通的。
  2. **本机 < manifest 版本** → 检查更新应显示「发现新版本 v0.4.0」并能开始下载。这一关过了说明「拼 ghproxy tag URL → electron-updater 下载」整条链路也通。
- **当前事实**：`package.json` 版本 `0.4.0`，`update-manifest.json` 版本 `0.4.0`，GitHub 上已发布的最新 release 是 **v0.4.0**（不是 draft，是公开 release —— ghproxy 能下到）。
- **网络要求**：**全程不开任何代理 / 不开梯子**。这是「国内无魔法用户」的验证场景，开了代理就白测了。

---

## 前提

环境：**Windows 10/11**，使用 **cmd**（不是 PowerShell —— 本文件命令默认 cmd 语法）。

- [x] 已安装 Node.js（`node -v` 能输出版本）
- [x] 已克隆 `tools` 仓库到 Windows 本地（路径下文用 `<项目根>` 表示）
- [x] 开始前关掉系统/浏览器层面的所有代理、VPN、梯子
- [x] 不要 push 任何代码 —— 测试二会改 `package.json`，**别提交、别推**

```bat
:: 确认 Node、git、curl 都在
node -v
git --version
curl --version
```

📝 结果（贴版本号）：

```
node:
git:
curl:
```

---

## 步骤 0 ｜ 网络基线 curl（最关键，先做这个）

**为什么先做**：app 「无法获取更新信息」可能是三条 manifest 通道全挂，也可能是 app 自身 bug。先用 curl 探一遍通道，**把网络变量和代码变量分开**，避免回头猜。

每条命令的判读规则就写在它后面。**有效响应**应当是 200 + 一段类似 `{"version":"0.4.0","proxies":[...]}` 的 JSON。

```bat
:: 通道 A：ghproxy.net 代理 raw（bootstrap 第一条）
curl -i -L --max-time 15 "https://ghproxy.net/https://raw.githubusercontent.com/AlcMaple/tools/main/update-manifest.json"
```

📝 结果 A（贴前 5 行 header + body 是否包含 `"version":"0.4.0"`）：

```
status:200
body 摘要:
Microsoft Windows [版本 10.0.19045.6466]
(c) Microsoft Corporation。保留所有权利。

C:\Users\Alc29>curl -i -L --max-time 15 "https://ghproxy.net/https://raw.githubusercontent.com/AlcMaple/tools/main/update-manifest.json"
HTTP/1.1 200 OK
Server: nginx
Date: Thu, 28 May 2026 12:23:11 GMT
Content-Type: text/plain; charset=utf-8
Content-Length: 161
Connection: keep-alive
Cache-Control: max-age=300
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox
ETag: "9c9224c3a6a53a9a71da84056103af66373722044791254c0278e3b09341bb6d"
Strict-Transport-Security: max-age=31536000
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-XSS-Protection: 1; mode=block
X-GitHub-Request-Id: C7B2:358F41:195827:2FE7F9:6A1833AC
Via: 1.1 varnish
X-Served-By: cache-lcy-egml8630083-LCY
X-Cache: MISS
X-Cache-Hits: 0
X-Timer: S1779970991.086142,VS0,VE239
Vary: Authorization,Accept-Encoding
Access-Control-Allow-Origin: *
Cross-Origin-Resource-Policy: cross-origin
X-Fastly-Request-ID: a386f5a7461e32acabcb3e21b66fcd865878e2f6
Expires: Thu, 28 May 2026 12:28:11 GMT
Source-Age: 0
Cache-Control: no-cache
Accept-Ranges: bytes

{
  "version": "0.4.0",
  "proxies": [
    "https://ghfast.top/",
    "https://ghproxy.net/",
    "https://gh-proxy.com/",
    "https://github.moeyy.xyz/"
  ]
}

C:\Users\Alc29>
```

```bat
:: 通道 B：ghfast.top 代理 raw（bootstrap 第二条）
curl -i -L --max-time 15 "https://ghfast.top/https://raw.githubusercontent.com/AlcMaple/tools/main/update-manifest.json"
```

📝 结果 B：

```
status:
body 摘要:
C:\Users\Alc29>curl -i -L --max-time 15 "https://ghfast.top/https://raw.githubusercontent.com/AlcMaple/tools/main/update-manifest.json"
HTTP/1.1 200 OK
Server: nginx
Date: Thu, 28 May 2026 12:23:36 GMT
Content-Type: text/plain; charset=utf-8
Content-Length: 161
Connection: keep-alive
Cache-Control: max-age=300
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox
ETag: "9c9224c3a6a53a9a71da84056103af66373722044791254c0278e3b09341bb6d"
Strict-Transport-Security: max-age=31536000
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-XSS-Protection: 1; mode=block
X-GitHub-Request-Id: 799C:354952:99BD60:B2A2BE:6A1833C7
Accept-Ranges: bytes
Via: 1.1 varnish
X-Served-By: cache-bur-kbur8200095-BUR
X-Cache: MISS
X-Cache-Hits: 0
X-Timer: S1779971016.405668,VS0,VE169
Vary: Authorization,Accept-Encoding
Access-Control-Allow-Origin: *
Cross-Origin-Resource-Policy: cross-origin
X-Fastly-Request-ID: 703082445cbe9f2e7e6a542fffc5262450cc4cd1
Expires: Thu, 28 May 2026 12:28:36 GMT
Source-Age: 0
Strict-Transport-Security: max-age=63072000

{
  "version": "0.4.0",
  "proxies": [
    "https://ghfast.top/",
    "https://ghproxy.net/",
    "https://gh-proxy.com/",
    "https://github.moeyy.xyz/"
  ]
}

C:\Users\Alc29>
```

```bat
:: 通道 C：jsdelivr CDN 兜底
curl -i -L --max-time 15 "https://cdn.jsdelivr.net/gh/AlcMaple/tools@main/update-manifest.json"
```

📝 结果 C：

```
status:
body 摘要:

C:\Users\Alc29>curl -i -L --max-time 15 "https://cdn.jsdelivr.net/gh/AlcMaple/tools@main/update-manifest.json"
HTTP/1.1 200 OK
Connection: keep-alive
Content-Length: 161
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: *
Timing-Allow-Origin: *
Cache-Control: public, max-age=604800, s-maxage=43200
Cross-Origin-Resource-Policy: cross-origin
X-Content-Type-Options: nosniff
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
Content-Type: application/json; charset=utf-8
X-JSD-Version: main
X-JSD-Version-Type: branch
ETag: W/"a1-9jwnqWs6zCtCc7dN93oz6JvxnrE"
Accept-Ranges: bytes
Age: 0
Date: Thu, 28 May 2026 12:23:51 GMT
X-Served-By: cache-fra-eddf8230130-FRA, cache-sin-wsat1880084-SIN
X-Cache: MISS, MISS
Vary: Accept-Encoding
alt-svc: h3=":443";ma=86400,h3-29=":443";ma=86400,h3-27=":443";ma=86400

{
  "version": "0.4.0",
  "proxies": [
    "https://ghfast.top/",
    "https://ghproxy.net/",
    "https://gh-proxy.com/",
    "https://github.moeyy.xyz/"
  ]
}

C:\Users\Alc29>
```

```bat
:: 通道 D：直连 GitHub raw（有魔法用户走这条，国内无魔法通常会 timeout 或 connection reset）
curl -i -L --max-time 15 "https://raw.githubusercontent.com/AlcMaple/tools/main/update-manifest.json"
```

📝 结果 D：

```
status:
body 摘要:

C:\Users\Alc29>curl -i -L --max-time 15 "https://raw.githubusercontent.com/AlcMaple/tools/main/update-manifest.json"
HTTP/1.1 200 OK
Connection: keep-alive
Content-Length: 161
Cache-Control: max-age=300
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox
Content-Type: text/plain; charset=utf-8
ETag: "9c9224c3a6a53a9a71da84056103af66373722044791254c0278e3b09341bb6d"
Strict-Transport-Security: max-age=31536000
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-XSS-Protection: 1; mode=block
X-GitHub-Request-Id: E7EC:2B3132:1882AB:2F1A75:6A1833E2
Accept-Ranges: bytes
Date: Thu, 28 May 2026 12:24:03 GMT
Via: 1.1 varnish
X-Served-By: cache-sin-wsat1880030-SIN
X-Cache: MISS
X-Cache-Hits: 0
X-Timer: S1779971043.786807,VS0,VE366
Vary: Authorization,Accept-Encoding
Access-Control-Allow-Origin: *
Cross-Origin-Resource-Policy: cross-origin
X-Fastly-Request-ID: ac10ef0312cea2468983844a78f46f1e17e365d7
Expires: Thu, 28 May 2026 12:29:03 GMT
Source-Age: 0

{
  "version": "0.4.0",
  "proxies": [
    "https://ghfast.top/",
    "https://ghproxy.net/",
    "https://gh-proxy.com/",
    "https://github.moeyy.xyz/"
  ]
}

C:\Users\Alc29>
```

**判读总结**（A/B/C 是「国内加速」要验证的对象，D 只是参考）：

- **A/B/C 至少有一条 200 + 内容正确** → 国内代理链在你这网下可达，**这就是我们想要的结果**，继续后面的测试。app 在 'auto' 模式下会按 1→2→3→4 顺序试，第一个赢的就用，所以哪怕只有一条通也够。
- **A/B/C 全挂** → 国内代理全都连不上，先别测 app，把这四段结果发回，需要换代理域名（远程改 manifest 即生效）。
- **D 通不通跟国内加速验证无关** —— D 是 app 在 'auto' 模式下「代理链全挂时的最后兜底」，也是用户在设置里切到「直连 GitHub」模式时唯一走的路。前提里要求「不开梯子」是为了模拟真实国内用户网络，但 D 在不开梯子时也可能通（运营商抽风、临时白名单都有可能），这不影响 A/B/C 的判断 —— **只要 A/B/C 至少一条通，国内加速的核心路径就算验证到了**。

---

## 测试一 ｜ 同版本，应显示「已是最新」

**目标**：本机版本 `0.4.0` == manifest 版本 `0.4.0`，「检查更新」应明确显示「已是最新版本」。

### 1.1 拉最新代码 + 打包

```bat
cd <项目根>
git pull
git log -1 --oneline
:: 应当能看到 0a73903 或更靠后的 commit；若不是，说明 pull 失败
```

📝 结果：

```
当前 HEAD:
```

```bat
:: 装依赖 + Windows 打包
npm install
npm run build:win
```

打包成功后产物在 `dist\MapleTools_0.4.0_windows_x64.exe`（如果改了 arch 也可能是 `_ia32`）。

📝 结果：

```
- [ ] build:win 成功
- 产物文件名:
- 产物大小:
```

### 1.2 安装并运行

- [ ] 双击 `dist\MapleTools_0.4.0_windows_x64.exe` 装上
- [ ] 启动 MapleTools

> ⚠️ **本机如果已经装过 MapleTools**：先在「设置 → 应用 → MapleTools → 卸载」干掉旧的再装新的，避免版本号串位。

### 1.3 检查更新

- [ ] 设置（齿轮图标） → 关于 → 点「检查更新」按钮
- [ ] 等几秒，观察弹出 / banner 上的文案

**预期文案**：「已是最新版本」或类似措辞。

**可能出现的反例 & 含义**：

| 看到的文案 | 含义 |
|---|---|
| ✅「已是最新版本」 | 测试一通过，进测试二 |
| 「发现新版本 vX.Y.Z」（X.Y.Z != 0.4.0） | 异常 —— 本机 0.4.0 不该比 manifest 0.4.0 小，把版本号截图 |
| 「无法获取更新信息」 | 三通道都没拉到 manifest。结合步骤 0 的 curl 结果定位 |
| 长时间转圈 | 网络层卡死，至少等 30s 再判 |

📝 结果：

```
看到的文案（原样抄）:
本机版本（关于页显示的版本号）:
截图（可选，丢到 dist\screenshots\ 下并写文件名）:
```

---

## 测试二 ｜ 降版本，应显示「发现新版本」并能下载

**目标**：把本机版本临时降到 `0.3.0`，重新打包后运行，「检查更新」应显示「发现新版本 v0.4.0」，并能真去 ghproxy 拉已发布的 v0.4.0 安装包。

### ⚠️ 红线（必读）

1. **绝不 `git commit` / `git push`** 本次的 `package.json` 改动 —— 这只是本地实验，推上去会把线上版本号回退掉。
2. **绝不跑 `npm run sync:manifest`** —— 这会把 `update-manifest.json` 也改成 `0.3.0`，那 GitHub 上和本机就都是 0.3.0 了，永远比不出新版本。
3. 测完务必 `git checkout -- package.json` 把版本号改回 `0.4.0`。

### 2.1 改 package.json 版本

打开 `<项目根>\package.json`，把第 3 行 `"version": "0.4.0"` 改成 `"version": "0.3.0"`，**只改这一处**，保存。

```bat
:: 用 git diff 确认只动了这一行
git diff package.json
```

📝 结果（贴 diff）：

```
```

### 2.2 重新打包

```bat
npm run build:win
```

产物现在应当叫 `dist\MapleTools_0.3.0_windows_x64.exe`。

📝 结果：

```
- [ ] build:win 成功
- 产物文件名:
```

### 2.3 安装并运行

- [ ] 卸载刚才装的 0.4.0（设置 → 应用 → MapleTools → 卸载）
- [ ] 双击 `dist\MapleTools_0.3.0_windows_x64.exe` 装上
- [ ] 启动后先确认「设置 → 关于」里版本号显示 `0.3.0`

📝 结果：

```
关于页版本号:
```

### 2.4 检查更新 —— 看版本

- [ ] 设置 → 关于 → 检查更新

**预期文案**：「发现新版本 v0.4.0」或类似措辞，附带「下载 / 立即更新」按钮。

📝 结果：

```
看到的文案:
有没有"下载"按钮:
```

### 2.5 检查更新 —— 测下载（核心）

> 这一步真的会从 ghproxy 下 ~80MB 左右的安装包，留够时间和流量。

- [ ] 点「下载 / 立即更新」
- [ ] 观察是否出现下载进度条 / 百分比
- [ ] 让它跑完，看是否提示「已下载完成，重启安装」

**判读**：

| 现象 | 含义 |
|---|---|
| ✅ 出现进度条且能跑到 100%，提示重启安装 | 下载链路通，**整套国内加速验证完成** |
| 进度条卡 0% 不动几十秒后报错 | 拼出来的 ghproxy tag URL 这条线挂了，看错误文案 |
| 直接报错"下载失败" | 抄文案 |
| 进度条能动但中途断 | 某个 ghproxy 节点不稳，注意是哪一档进度断的 |

📝 结果：

```
下载是否启动（Y/N）:
最终结果（完成 / 卡住 / 报错）:
错误文案（若有）:
观察到的下载速度（大致）:
```

### 2.6 ⚠️ 不要真的「重启安装」

- 看到「下载完成、重启安装」即可，**先不要点重启**。这台机器装回 `0.3.0` 再被自更新到 `0.4.0` 会让后续测试不好做。
- 直接关 app，**手动卸载 0.3.0**，留着 v0.4.0 安装包以备需要重测。

### 2.7 还原 package.json

```bat
git checkout -- package.json
git diff package.json
:: 应当无输出，表示版本号已经回到 0.4.0
```

📝 结果：

```
- [ ] package.json 已还原
```

---

## 故障排查 ｜ 如果测试一就显示「无法获取更新信息」

按这个顺序定位：

1. **步骤 0 的 curl 结果**：A/B/C 哪几条 200？哪几条挂？挂的话错误是 502 / 403 / timeout / DNS 失败？把完整错误抄回。
2. **app 内日志**：MapleTools 主进程的 console 通常被 electron-updater 写进 log 里。Windows 上路径大概是：

   ```
   %APPDATA%\MapleTools\logs\main.log
   ```

   在文件资源管理器地址栏粘贴 `%APPDATA%\MapleTools\logs\` 回车看看。**最近一次「检查更新」时间附近的日志全段** 抄回来。

   📝 结果（贴最近一次更新检查相关的 log）：

   ```
   ```

3. **当前 main 分支的 manifest 内容**：浏览器打开（如果浏览器能开）：
   - https://ghproxy.net/https://raw.githubusercontent.com/AlcMaple/tools/main/update-manifest.json
   - https://cdn.jsdelivr.net/gh/AlcMaple/tools@main/update-manifest.json

   📝 结果（浏览器能不能打开、内容是否包含 `"version":"0.4.0"`）：

   ```
   ```

---

## 做完汇总

把下面这几项一次性回传 Mac 端：

- [ ] 步骤 0：A/B/C/D 四条 curl 的 status
- [ ] 测试一：app 「检查更新」看到的文案 + 本机版本号
- [ ] 测试二 §2.4：app 看到的「新版本」文案
- [ ] 测试二 §2.5：下载是否启动、是否完成、错误文案（若有）
- [ ] 任何意料外的现象 / 截图 / 日志片段
- [ ] `git status` 确认没有未还原的本地改动（除了这份 md 自己）

```bat
git status
```

📝 最终 status：

```
```
