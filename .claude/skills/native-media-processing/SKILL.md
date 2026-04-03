# SKILL: Electron 视频处理与本地安全策略 (ffmpeg & protocol.handle)

## 1. 依赖选择与环境踩坑
* **避免使用 `ffmpeg-static`**：在无代理或网络受限环境下，该包在 `postinstall` 阶段下载预编译二进制文件极易卡死或失败。不适合作为分发给普通用户的桌面端依赖。
* **推荐方案 (`fluent-ffmpeg`)**：直接使用 `fluent-ffmpeg`。它默认读取系统 `PATH` 环境变量中的 `ffmpeg` 可执行文件。
* **生产环境最佳实践**：不要预设用户的系统环境，最好的做法是在应用设置中提供一个配置项，让用户自行指定本地 `ffmpeg.exe` 的绝对路径，运行时通过 `ffmpeg.setFfmpegPath(customPath)` 动态挂载。

## 2. 视频封面截取逻辑
使用 `fluent-ffmpeg` 截取视频封面的核心代码：
```javascript
ffmpeg(videoPath)
  .screenshots({
    timestamps: ['10%'], // 截取特定进度百分比，避免片头黑屏
    filename: 'thumbnail.jpg',
    folder: outputDir,
    size: '400x?' // 锁定宽度，高度自适应
  })
  .on('end', () => console.log('截取成功'))
  .on('error', (err) => console.error('截取失败', err)) // 必须捕获错误，防止阻塞进程