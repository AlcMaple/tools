// 接单评估两份资料的模版和用途说明，网页版和桌面版共用。
// 评估提示词（order-judge.ts）按「能 / 勉强 / 不能」三档对照能力档案，所以档案模版也按这三档分区；
// 项目日志在提示词里的优先级高于档案，模版写的是「做了什么、证明了什么」。

import type { DocKind } from './order-judge-api'

export interface DocTemplate {
  filename: string
  purpose: string
  body: string
}

export const DOC_TEMPLATES: Record<DocKind, DocTemplate> = {
  profile: {
    filename: '能力档案模版.md',
    purpose: '划定能接什么、不能接什么。评估时先按这份档案分档，核心需求落在「不能」就判不能。',
    body: `# 能力档案

> 这份文档决定评估的边界：派单的核心需求落在哪一档，结论就偏向哪边。
> 写技术栈和类型，不写项目流水账（那是项目日志的事）。写具体，别写「全栈开发」这种笼统的词。

## 基本情况

- 身份 / 工作年限：
- 每周可用于接单的时间：
- 常用开发平台：

## 能（独立完成，不用查资料）

- 技术栈：（例：React + TypeScript 网页前端，Node.js 接口，MySQL）
- 能做的类型：（例：企业官网、后台管理系统、爬虫脚本、Electron 桌面工具）
- 交付方式：（例：源码 + 部署文档，能上线到 Linux 服务器）

## 勉强（做过但不熟，需要时间摸索）

- （例：小程序，做过一个，没上过线）
- （例：Python 数据分析，只会基础）

## 不能（不接，或做不了）

- （例：iOS / Android 原生开发）
- （例：游戏外挂、需要自研算法的图像识别）
- （例：需要硬件设备或专业领域知识才能验收的项目）

## 接单偏好

- 预算低于多少不接：
- 工期最短多少天：
- 不想接的类型：
`,
  },
  log: {
    filename: '项目日志模版.md',
    purpose: '记录实际做过、学会的事。档案说不能、日志里做过的，评估按日志判能。',
    body: `# 项目日志

> 这份文档是能力的实际证据，建议每做完一件事就在最上面补一条，新的在上。
> 评估时以日志里的最新记录为准：档案写「不能」，但日志显示已经做过或学会，就按「能」判。
> 写做了什么、用了什么、花了多久、遇到什么坑，不写心情。

## 2026-01-01 项目或事项名称

- 做了什么：（一两句，写清楚交付的结果）
- 用到的技术：（例：Vue 3、WebSocket、ffmpeg）
- 耗时：（例：5 天，其中调试推流占了 2 天）
- 新学会 / 踩过的坑：（例：第一次接小程序支付，微信回调签名要注意…）
- 结果：（例：已上线 / 客户验收通过 / 做到一半放弃，原因是…）

## 2025-12-15 另一个项目

- 做了什么：
- 用到的技术：
- 耗时：
- 新学会 / 踩过的坑：
- 结果：
`,
  },
}

export function downloadDocTemplate(kind: DocKind): void {
  const t = DOC_TEMPLATES[kind]
  const url = URL.createObjectURL(new Blob([t.body], { type: 'text/markdown;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = t.filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
