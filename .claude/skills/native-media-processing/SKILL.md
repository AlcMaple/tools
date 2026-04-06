# SKILL: Electron 视频处理

* **避免使用 `ffmpeg-static`**：在无代理或网络受限环境下，该包在 `postinstall` 阶段下载预编译二进制文件极易卡死或失败。不适合作为分发给普通用户的桌面端依赖。
* **推荐方案 (`fluent-ffmpeg`)**：直接使用 `fluent-ffmpeg`。它默认读取系统 `PATH` 环境变量中的 `ffmpeg` 可执行文件。
* **生产环境最佳实践**：不要预设用户的系统环境，最好的做法是在应用设置中提供一个配置项，让用户自行指定本地 `ffmpeg.exe` 的绝对路径，运行时通过 `ffmpeg.setFfmpegPath(customPath)` 动态挂载。