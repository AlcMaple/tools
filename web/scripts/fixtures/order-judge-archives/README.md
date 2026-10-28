# 压缩包回归样本

仅用于离线测试，不包含用户材料。ZIP/DOCX/图片组合由测试脚本生成。

- `rar4.rar`：原样取自 [node-unrar.js FolderTest.rar](https://github.com/YuJianrong/node-unrar.js/blob/master/testFiles/FolderTest.rar)，含中文目录、中文文件名和长文本（MIT）。
- `rar4-small.rar`：本项目生成的 RAR4 store 样本，包含 `requirements/spec.txt`，正文为「客户已有小程序，修复登录错误。RAR4_FIXTURE」。文件数据与头部均带 CRC32，已用 bsdtar 独立验证。
- `encrypted.rar`：原样取自 [node-unrar.js HeaderEnc1234.rar](https://github.com/YuJianrong/node-unrar.js/blob/master/testFiles/HeaderEnc1234.rar)，验证加密头错误（MIT）。
- `rar5-unicode.rar`：由 [libarchive test_read_format_rar5_unicode.rar.uu](https://github.com/libarchive/libarchive/blob/master/libarchive/test/test_read_format_rar5_unicode.rar.uu) 解 UU 编码得到，含 Unicode 文本名和链接。libarchive 测试样本许可证见 [COPYING](https://github.com/libarchive/libarchive/blob/master/COPYING)。
- `rar5.rar`：由 [libarchive test_read_format_rar5_multiple_files_solid.rar.uu](https://github.com/libarchive/libarchive/blob/master/libarchive/test/test_read_format_rar5_multiple_files_solid.rar.uu) 解 UU 编码得到，包含四个 `.bin`，用于确认不把未支持的二进制文件当需求文字。
