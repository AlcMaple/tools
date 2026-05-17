#!/usr/bin/env node
// recycle.js -- 全自动 Windows 删除工具（送回收站 / 永久删除）
//
// 用法:
//   node recycle.js <path> [path2 ...] [-v] [--admin] [--purge]
//
// 退出码：
//   0  完整删除成功
//   1  失败
//   2  参数错误
//   4  内容已删除 + 空目录进了回收站（典型于 AV 阻止整目录回收的场景）

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HELPER = path.join(__dirname, 'recycle-helper.ps1');
const EXIT = { OK: 0, FAILED: 1, BAD_ARGS: 2, EMPTIED_AND_RECYCLED: 4 };

function recycleOne(target, opts = {}) {
  if (os.platform() !== 'win32') throw new Error('仅支持 Windows');
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) return { status: 'already-absent', path: abs };
  if (!fs.existsSync(HELPER)) throw new Error(`找不到 helper 脚本: ${HELPER}`);

  const psArgs = [
    '-NoProfile', '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', HELPER,
    '-Path', abs,
  ];
  if (opts.maxRetries) psArgs.push('-MaxRetries', String(opts.maxRetries));
  if (opts.verbose)    psArgs.push('-Verbose');
  if (opts.purge)      psArgs.push('-Purge');

  const r = spawnSync('powershell.exe', psArgs, {
    encoding: 'utf8',
    stdio: opts.silent ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  if (r.error) throw r.error;

  if (r.status === EXIT.OK) return { status: 'deleted', path: abs };
  if (r.status === EXIT.EMPTIED_AND_RECYCLED) return { status: 'emptied-and-recycled', path: abs };
  if (!fs.existsSync(abs)) return { status: 'deleted', path: abs };

  const msg = (opts.silent ? r.stderr : '') || `exit ${r.status}`;
  const e = new Error(`删除失败: ${abs} (${msg})`);
  e.exitCode = r.status;
  throw e;
}

function recycle(targets, opts = {}) {
  const list = Array.isArray(targets) ? targets : [targets];
  const results = [];
  const errors = [];
  for (const t of list) {
    try { results.push(recycleOne(t, opts)); }
    catch (e) { errors.push({ target: t, error: e.message, exitCode: e.exitCode }); }
  }
  if (errors.length) {
    const msg = errors.map(e => `  - ${e.target}: ${e.error}`).join('\n');
    const err = new Error(`部分目标失败:\n${msg}`);
    err.errors = errors;
    err.results = results;
    throw err;
  }
  return results;
}

function relaunchAsAdmin(paths, opts) {
  const stamp = `${Date.now()}-${process.pid}`;
  const tmpBat = path.join(os.tmpdir(), `recycle-admin-${stamp}.bat`);
  const tmpLog = path.join(os.tmpdir(), `recycle-admin-${stamp}.log`);
  const cmdQ = s => `"${String(s).replace(/"/g, '""')}"`;
  const psQ  = s => "'" + String(s).replace(/'/g, "''") + "'";

  const innerArgs = [__filename, ...paths];
  if (opts.verbose) innerArgs.push('-v');
  if (opts.purge)   innerArgs.push('--purge');
  const argStr = innerArgs.map(cmdQ).join(' ');

  const innerInvoke =
    `powershell -NoProfile -ExecutionPolicy Bypass -Command ` +
    `"& ${cmdQ(process.execPath)} ${argStr} 2>&1 | Tee-Object -FilePath ${cmdQ(tmpLog)}; exit $LASTEXITCODE"`;

  const batContent = [
    '@echo off',
    'chcp 65001 > nul 2>&1',
    'title Recycle (Administrator)',
    innerInvoke,
    'set EXIT_CODE=%ERRORLEVEL%',
    'echo.',
    'echo ============================================================',
    'echo  Done (exit %EXIT_CODE%). Press any key to close.',
    'echo ============================================================',
    'pause > nul',
    'exit /b %EXIT_CODE%',
  ].join('\r\n');
  fs.writeFileSync(tmpBat, batContent, { encoding: 'utf8' });

  const psCmd =
    `$p = Start-Process cmd.exe -ArgumentList '/c',${psQ(tmpBat)} -Verb RunAs -Wait -PassThru; ` +
    `exit $p.ExitCode`;

  console.log('正在请求管理员权限（会弹 UAC，新窗口运行）...');
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', psCmd,
  ], { stdio: 'inherit', windowsHide: true });

  if (fs.existsSync(tmpLog)) {
    console.log('\n========== 管理员窗口日志 ==========');
    try { process.stdout.write(fs.readFileSync(tmpLog)); }
    catch (e) { console.error('读取日志失败：', e.message); }
    console.log('========== 日志结束 ==========\n');
  }
  try { fs.unlinkSync(tmpBat); } catch {}
  try { fs.unlinkSync(tmpLog); } catch {}
  process.exit(r.status || 0);
}

function printUsage() {
  console.error('用法: node recycle.js <path> [path2 ...] [选项]');
  console.error('  -v, --verbose   显示详细处理过程');
  console.error('  --admin, -a     管理员身份重启（弹 UAC，新窗口）');
  console.error('  --purge         永久删除（不进回收站）');
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (!argv.length) { printUsage(); process.exit(EXIT.BAD_ARGS); }
  const verbose = argv.includes('-v') || argv.includes('--verbose');
  const admin   = argv.includes('-a') || argv.includes('--admin');
  const purge   = argv.includes('--purge');
  const paths   = argv.filter(a => !a.startsWith('-'));
  if (!paths.length) { printUsage(); process.exit(EXIT.BAD_ARGS); }
  if (admin) { relaunchAsAdmin(paths, { verbose, purge }); return; }

  try {
    const results = recycle(paths, { verbose, purge });
    const deleted = results.filter(r => r.status === 'deleted').length;
    const emptied = results.filter(r => r.status === 'emptied-and-recycled').length;
    const absent  = results.filter(r => r.status === 'already-absent').length;

    if (deleted) {
      console.log(`✓ ${purge ? '已永久删除' : '已送入回收站'}：${deleted} 个目标。`);
    }
    if (emptied) {
      console.log(`⚠ ${emptied} 个目标因被防护进程阻止整体回收，已按"分片回收"模式将每个文件/子目录单独送入回收站。`);
      console.log(`  （回收站里会看到散开的条目，全选后右键"还原"可重建原结构）`);
    }
    if (absent) {
      console.log(`ℹ ${absent} 个目标本来就不存在。`);
    }
    process.exit(emptied > 0 ? EXIT.EMPTIED_AND_RECYCLED : EXIT.OK);
  } catch (e) {
    console.error(e.message);
    if (!purge) {
      console.error('\n提示：');
      console.error(`  node recycle.js --admin --purge ${paths.map(p => `"${p}"`).join(' ')}`);
    }
    process.exit(EXIT.FAILED);
  }
}

module.exports = { recycle, recycleOne, EXIT };