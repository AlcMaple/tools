# Oracle Cloud 永久免费 ARM 服务器 —— 从 0 到 1 保姆教程

> 配套 [012-网页版.md](../ideas/012-网页版.md)。目标：白嫖一台永久免费的 ARM 云主机当网页版后端。
> ⚠️ **前提**：Oracle 注册**必须绑卡**（VISA/MC，有时银联可过），**不收支付宝 / 微信**。
> 没卡就走这条路之前先看 012「服务器选型」里的免费 serverless 替代方案。
> ⚠️ 本教程按 2026 年初的 Oracle 控制台写，Oracle 偶尔改按钮文案 / 菜单位置，
> 对不上时按同名功能找一下即可，主流程多年没变。

## 开始前准备

- **邮箱**：建议 Gmail / Outlook，别用国内邮箱（易收不到验证信）。
- **手机号**：接短信验证码。
- **一张 VISA / Mastercard 信用卡**：只做身份验证，Always Free **不扣费**，但可能有
  ~$1 临时预授权、几天后自动退回。⚠️ **最大注册坑**：部分国内储蓄卡 / 虚拟卡验证失败，
  优先用**双币信用卡**。
- **时间**：约 30–60 分钟（抢 ARM 容量可能要多试几次）。

## 第 0 步：先记住 4 件事（省得后面踩坑）

1. **"永久免费"不是那 300 刀试用**：注册送的 Always Free 里，ARM（Ampere A1）最高
   **4 核 + 24GB 内存**、200GB 块存储、**每月 10TB 出口流量**，永久免费。那 300 刀 /
   30 天试用是另一回事，别混。
2. **Home Region 选了永久不能改**：注册时选的主区域定终身。选离国内近、延迟低的 ——
   **日本东京 (Japan East / Tokyo)** 或 **韩国首尔 (South Korea Central / Seoul)** 一般
   对国内最好，新加坡次之。**选之前想清楚。**
3. **ARM 抢不到是最大痛点**：热门区的免费 Ampere A1 经常 "Out of capacity"，要换可用域
   (AD) / 错峰 / 多试。别慌，有耐心。
4. **闲置会被回收**：Oracle 会回收"纯免费账号"里长期闲置的 ARM。最稳的防回收 =
   开完机后**升级成 Pay As You Go（按量付费）**：免费额度照样免费、不扣钱，只是脱离
   "纯免费"被回收的名单（见第 6 步）。

## 第 1 步：注册账号

1. 浏览器打开 **oracle.com/cloud/free** → **Start for free**。
2. 选国家 / 地区、填邮箱 → 收验证邮件、点链接。
3. 设密码，填 Account Name（租户名，起个英文，如 `alcmaple`）。
4. **选 Home Region** —— ⚠️ 永久不可改，选 **Japan East (Tokyo)** 或 **South Korea
   Central (Seoul)**。
5. 手机短信验证。
6. **绑卡验证身份**（不扣费）。失败就换一张 VISA / MC 信用卡。
7. 同意协议 → 完成，进控制台 **cloud.oracle.com**。

## 第 2 步：本地先生成 SSH 密钥（在你的 Mac 上）

本地终端跑：

```bash
ssh-keygen -t ed25519 -C "oracle-web" -f ~/.ssh/oracle_web
```

一路回车。得到 `~/.ssh/oracle_web`（**私钥，绝不外传**）和 `~/.ssh/oracle_web.pub`
（**公钥，下一步上传**）。

## 第 3 步：创建 ARM 实例

1. 控制台左上汉堡菜单 → **Compute → Instances → Create instance**。
2. **Name**：如 `web-01`。
3. **Image and shape → Edit**：
   - **Image**：选 **Canonical Ubuntu 22.04**（或 24.04；比 Oracle Linux 顺手）。
   - **Shape → Change shape → Ampere（ARM）→ VM.Standard.A1.Flex**，设 **4 OCPU /
     24 GB**（免费上限；抢不到就先 1 OCPU / 6 GB 起）。
4. **Networking**：让它自动新建 VCN + 子网（公有子网、分配公网 IP）。确认
   **Assign a public IPv4 address** 勾着。
5. **Add SSH keys → Paste public keys**：贴 `~/.ssh/oracle_web.pub` 的全部内容。
6. Boot volume 默认（免费 200GB 内）。
7. **Create**。若报 **Out of capacity** → 换 Availability Domain（AD-1 / 2 / 3）重试、
   错峰再试、或先降到 1 OCPU。
8. 等状态变 **Running**，记下 **Public IP address**。

## 第 4 步：开放端口（两道闸都要过 —— 最常见的"连不上"坑）

Oracle 网络有**两层**要放行，只开一层不通。

### 4a 云端 Security List（VCN）

1. 实例详情 → 点它的 **Subnet** → 点 **Default Security List**。
2. **Add Ingress Rules**，各加一条：
   - Source `0.0.0.0/0`，TCP，Dest Port **80**（HTTP）
   - Source `0.0.0.0/0`，TCP，Dest Port **443**（HTTPS）
   - （SSH 22 默认已放行）

### 4b 实例内 iptables（Ubuntu 镜像默认拦 80/443，极易忽略）

SSH 进去：

```bash
chmod 600 ~/.ssh/oracle_web              # 私钥权限，否则 ssh 拒绝
ssh -i ~/.ssh/oracle_web ubuntu@<你的公网IP>   # Ubuntu 用户名固定 ubuntu；Oracle Linux 是 opc
```

放行 80 / 443（插到默认那条 REJECT 规则**前面**）：

```bash
sudo iptables -L INPUT --line-numbers     # 先看 REJECT 在第几行（默认约第 6 行）
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save            # 持久化，重启不丢（缺命令先 apt install netfilter-persistent）
```

## 第 5 步：装运行环境

```bash
sudo apt update && sudo apt -y upgrade
# 装 nvm（去 github.com/nvm-sh/nvm 复制最新版安装命令，别用可能过时的固定版本号）
# 装完重开终端，然后：
nvm install --lts && node -v
# 反向代理（可选，正式部署再配）
sudo apt -y install nginx
```

## 第 6 步（推荐）：防闲置回收 → 升级 PAYG

控制台右上账号菜单 → **Upgrade to Pay As You Go**。免费额度仍免费，只是不再被当
"纯免费"回收。绑卡后只要不开超出免费额度的资源，就不产生费用。

## 常见坑速查

| 症状 | 十有八九是 |
|---|---|
| 绑卡验证失败 | 换 VISA / MC 双币信用卡；虚拟卡 / 部分储蓄卡不行 |
| ARM 一直 Out of capacity | 换 AD、错峰、先开 1 OCPU 再改大 |
| 80 端口浏览器打不开 | 忘了第 **4b** 步的 iptables（4a 开了不够） |
| SSH 连不上 | 用户名用错（ubuntu / opc）、私钥没 `chmod 600` |
| Home Region 选错了 | 只能新开账号 —— 选前务必想清楚 |

## 开完之后

把 **公网 IP** 告诉我（私钥自己留着，别发）。接下来我给「一键推代码上去 + 真机验证」
的部署脚本和验证清单，从最轻的**周期表**里程碑开始，本地 + 真机双验证走起。
（关于海外节点对"嗷呜"这类国内专供源、以及视频流代理的影响，见
[012-网页版.md](../ideas/012-网页版.md) 的「服务器选型」「视频三选二」。）
