import os
import shutil
from pathlib import Path

def find_biu_path(drive_letter="E:\\", target_suffix="Web前端开发/electron/Biu"):
    print(f"正在 {drive_letter} 盘搜索目标路径 '{target_suffix}'，请稍候...")
    target_path = Path(target_suffix.replace("/", os.sep))

    for root, dirs, files in os.walk(drive_letter):
        current_dir = Path(root)
        if current_dir.parts[-len(target_path.parts):] == target_path.parts:
            return current_dir
    return None

def push_files():
    # 源目录：C:\Users\<当前用户名>\Documents\Biu
    source_dir = Path(os.path.expanduser("~/Documents/Biu"))

    if not source_dir.exists():
        print(f"[错误] 源目录不存在: {source_dir}")
        return

    # 目标目录：E 盘搜索到的绝对路径
    dest_dir = find_biu_path()

    if not dest_dir:
        print("[错误] 未在 E 盘找到对应的 electron/Biu 目录作为覆盖目标！")
        return

    print(f"源数据目录 (本地): {source_dir}")
    print(f"准备覆盖到 (E盘): {dest_dir}")
    print("开始推送并覆盖文件...")

    try:
        # dirs_exist_ok=True 允许覆盖现有目录结构
        shutil.copytree(source_dir, dest_dir, dirs_exist_ok=True)
        print("\n[完成] 数据成功推送到 E 盘 electron 项目！")
    except Exception as e:
        print(f"\n[错误] 推送过程中出现异常: {e}")

if __name__ == "__main__":
    push_files()