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

def pull_files():
    # 目标目录：C:\Users\<当前用户名>\Documents\Biu
    dest_dir = Path(os.path.expanduser("~/Documents/Biu"))
    
    # 源目录：E 盘搜索到的绝对路径
    source_dir = find_biu_path()

    if not source_dir:
        print("[错误] 未在 E 盘找到对应的 electron/Biu 目录作为数据源！")
        return

    print(f"源数据目录 (E盘): {source_dir}")
    print(f"准备拉取到 (本地): {dest_dir}")
    print("开始拉取并覆盖文件...")

    try:
        # 确保本地目标父目录存在，如果不存在则创建
        dest_dir.parent.mkdir(parents=True, exist_ok=True)
        # dirs_exist_ok=True 允许覆盖现有目录结构
        shutil.copytree(source_dir, dest_dir, dirs_exist_ok=True)
        print("\n[完成] 数据成功从 E 盘拉取到本地 Documents 目录！")
    except Exception as e:
        print(f"\n[错误] 拉取过程中出现异常: {e}")

if __name__ == "__main__":
    pull_files()