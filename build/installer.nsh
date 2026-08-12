; 安装/更新前静默结束正在运行的 MapleTools 进程
;
; 背景：MapleTools 有"关闭到托盘"设计（src/main/index.ts），用户点窗口的 × 只是
; 隐藏窗口、进程仍在后台/托盘运行。electron-builder 生成的 NSIS 安装包在覆盖安装前
; 会检测同名进程是否在运行，检测到就弹窗"MapleTools 无法关闭，请手动关闭它后重试"，
; 用户体验很差（见 docs/troubleshooting/mapletools更新失败-无法关闭旧程序.md）。
;
; preInit 是 electron-builder 提供的最早期钩子，在安装器自带的"进程占用检测"之前
; 执行，这里直接静默 taskkill 掉旧进程（含子进程），检测阶段就不会再发现运行中的实例。
!macro preInit
  nsExec::Exec 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /T'
!macroend
