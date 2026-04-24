@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

cd /d "%~dp0"
title Anime Tool v2.0

:: ======================== 主菜单 ========================
:main_menu
cls
echo ==============================================
echo           Anime Tool v2.0
echo ==============================================
echo(
echo( 1 一键搜索并下载动漫
echo( 2 动漫信息查询 (bgm.tv)
echo( 3 拉取个人音乐数据
echo( 4 推送个人音乐数据
echo( 5 exit
echo(
echo ==============================================
echo(
set "func_choice="
set /p "func_choice=请选择功能 (1/2/3/4/5): "

if "!func_choice!"=="1" goto full_pipeline
if "!func_choice!"=="2" goto search_bgm
if "!func_choice!"=="3" goto sync_biu
if "!func_choice!"=="4" goto push_biu
if "!func_choice!"=="5" goto exit_script

echo(
echo [错误] 无效选择，请输入 1-5 之间的数字
echo(
pause >nul
goto main_menu

:: ======================== 1. 一键流程 ========================
:full_pipeline
cls
echo ==============================================
echo        一键搜索并下载动漫
echo ==============================================
echo(
set "anime_name="
set /p "anime_name=请输入动漫名称: "
if "!anime_name!"=="" (
    echo [错误] 名称不能为空
    pause >nul
    goto main_menu
)

set "cache_choice="
set /p "cache_choice=是否更新本地缓存？(y/N，直接回车选 N): "
if "!cache_choice!"=="" set "cache_choice=n"

call :check_conda_env
if !errorlevel! equ 1 ( pause >nul & goto main_menu )

echo(
echo ── 步骤 1/3  搜索番剧 ──────────────────────────
echo(
"!PYTHON_EXE!" "%~dp0fetch_page.py" "!anime_name!" "!cache_choice!"
echo(
echo [步骤 1 完成]
echo 按任意键继续（Ctrl+C 可取消）...
pause >nul

echo(
echo ── 步骤 2/3  选择番剧并获取播放页 ─────────────
echo(
"!PYTHON_EXE!" "%~dp0parse_anime_list.py" "!anime_name!"
echo(
echo [步骤 2 完成]
echo 按任意键继续（Ctrl+C 可取消）...
pause >nul

echo(
echo ── 步骤 3/3  解析视频链接并下载 ───────────────
echo(
"!PYTHON_EXE!" "%~dp0parse_watch_page.py"
echo(
echo ==============================================
echo           流程结束
echo ==============================================
pause >nul
goto main_menu

:: ======================== 2. bgm.tv 信息查询 ========================
:search_bgm
cls
echo ==============================================
echo        动漫信息查询 (bgm.tv)
echo ==============================================
echo(
set "anime_name="
set /p "anime_name=请输入动漫名称: "
if "!anime_name!"=="" (
    echo [错误] 名称不能为空
    pause >nul
    goto search_bgm
)

:ask_cache
cls
echo 是否更新本地缓存？
echo( 1. 是
echo( 2. 否（默认）
echo(
set "cache_choice="
set /p "cache_choice=请选择 (1/2，直接回车选 2): "
if "!cache_choice!"=="1" ( set "update_cache=y" ) else ( set "update_cache=n" )

cls
call :check_conda_env
if !errorlevel! equ 1 ( pause >nul & goto main_menu )

"!PYTHON_EXE!" "%~dp0search_anime.py" "!anime_name!" "!update_cache!"
echo(
pause >nul
goto main_menu

:: ======================== 3. 拉取个人音乐数据 ========================
:sync_biu
cls
echo ==============================================
echo        拉取个人音乐数据
echo ==============================================
echo(
call :check_conda_env
if !errorlevel! equ 1 ( pause >nul & goto main_menu )

"!PYTHON_EXE!" "%~dp0sync_biu.py"
echo(
pause >nul
goto main_menu

:: ======================== 4. 推送个人数据到 E 盘 ========================
:push_biu
cls
echo ==============================================
echo        推送个人数据到 E 盘
echo ==============================================
echo(
call :check_conda_env
if !errorlevel! equ 1 ( pause >nul & goto main_menu )

"!PYTHON_EXE!" "%~dp0push_biu.py"
echo(
pause >nul
goto main_menu

:: ======================== 子函数：检查 Conda 环境 ========================
:check_conda_env
set "CONDA_ROOT=C:\Users\Alc29\anaconda3"
set "CONDA_ENV=py39"
set "PYTHON_EXE=!CONDA_ROOT!\envs\!CONDA_ENV!\python.exe"

if not exist "!CONDA_ROOT!\Scripts\conda.exe" (
    echo [错误] 未找到 conda，请检查路径: !CONDA_ROOT!
    exit /b 1
)
if not exist "!PYTHON_EXE!" (
    echo [错误] 未找到环境 !CONDA_ENV! 的 Python: !PYTHON_EXE!
    exit /b 1
)
exit /b 0

:: ======================== 退出 ========================
:exit_script
cls
echo 感谢使用，再见！
pause >nul
endlocal
exit /b 0