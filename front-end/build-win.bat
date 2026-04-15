@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul

echo ========================================
echo  MapleTools Windows Build Script
echo ========================================

cd /d "%~dp0"

echo.
echo [1/4] 结束残留的 MapleTools / electron 进程...
taskkill /F /IM MapleTools.exe >nul 2>&1
taskkill /F /IM electron.exe >nul 2>&1
echo   done.

echo.
echo [2/4] 清理旧构建产物 (dist, out)...
set RETRY=0
:retry_dist
if exist "dist" (
    rmdir /s /q "dist" >nul 2>&1
    if exist "dist" (
        set /a RETRY+=1
        if !RETRY! geq 5 (
            echo   [ERROR] 无法删除 dist 目录，仍被进程占用。
            echo   请手动关闭资源管理器 / 终端中打开 dist 的窗口，
            echo   或临时关闭杀毒软件实时防护后重试。
            exit /b 1
        )
        echo   dist 被占用，2 秒后重试 !RETRY!/5 ...
        timeout /t 2 /nobreak >nul
        goto retry_dist
    )
)
if exist "out" rmdir /s /q "out" >nul 2>&1
echo   done.

echo.
echo [3/4] 检查依赖...
if not exist "node_modules" (
    echo   node_modules 不存在，执行 npm install ...
    call npm install
    if errorlevel 1 (
        echo   [ERROR] npm install 失败
        exit /b 1
    )
) else (
    echo   node_modules 已存在，跳过。
)

echo.
echo [4/4] 打包 Windows 安装器...
call npm run dist
if errorlevel 1 (
    echo.
    echo   [ERROR] 打包失败，请查看上方日志。
    exit /b 1
)

echo.
echo ========================================
echo  打包完成！输出目录: front-end\dist\
echo ========================================
exit /b 0
