// 独立打包脚本：重打 app.asar → 补齐运行时 → 打 ZIP
// 直接用 node 执行，绕过 PowerShell ExecutionPolicy
const path = require('path');
const fs = require('fs');
const child_process = require('child_process');

const PROJECT = __dirname;
const SRC = path.join(PROJECT, 'dist', 'win-unpacked');
const NODE_E_DIST = path.join(PROJECT, 'node_modules', 'electron', 'dist');
const ASAR_TOOL = path.join(PROJECT, 'node_modules', '@electron', 'asar', 'bin', 'asar.js');
const ZIP_OUT = path.join(PROJECT, 'dist', 'FieldTrace-1.0.0-portable.zip');

function say(m) { process.stdout.write('>>> ' + m + '\n'); }
function die(m) { process.stderr.write('!!! 失败: ' + m + '\n'); process.exit(1); }

say('项目目录: ' + PROJECT);

// Step 0: 检查路径
for (const p of [SRC, NODE_E_DIST, ASAR_TOOL]) {
  if (!fs.existsSync(p)) die('路径不存在: ' + p);
}
say('路径检查通过');

// Step 1: 重打 app.asar（官方标准模式：asar 内部自带 package.json，main 指向同目录 main.js）
const appAsarDst = path.join(SRC, 'resources', 'app.asar');
const resourcesDir = path.join(SRC, 'resources');
const tmpPackDir = path.join(PROJECT, 'dist', '_pack_tmp');

// 清理旧
try { fs.unlinkSync(appAsarDst); } catch (_) {}
try { fs.rmSync(tmpPackDir, { recursive: true, force: true }); } catch (_) {}
fs.mkdirSync(tmpPackDir, { recursive: true });

// 复制源码文件
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
copyDir(path.join(PROJECT, 'src'), tmpPackDir);

// 生成 asar 内部的 package.json（main 与 package.json 同级，写 main.js）
const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT, 'package.json'), 'utf8'));
pkg.main = 'main.js';  // 因为 asar 内部 package.json 和 main.js 同级
fs.writeFileSync(path.join(tmpPackDir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');

say('重打 app.asar（内含 package.json，main=' + pkg.main + '）...');
child_process.execFileSync(
  process.execPath,
  [ASAR_TOOL, 'pack', tmpPackDir, appAsarDst, '--unpack', '*.node'],
  { stdio: 'inherit' }
);
if (!fs.existsSync(appAsarDst)) die('app.asar 生成失败');
const asarKb = Math.round(fs.statSync(appAsarDst).size / 1024);
say('app.asar 生成成功: ' + asarKb + ' KB');
// 清理临时打包目录
try { fs.rmSync(tmpPackDir, { recursive: true, force: true }); } catch (_) {}

// Step 2: 补齐 Electron 运行时自带的 resources 内容（default_app.asar/electron.asar 等）
// 这些是 Electron 原生运行需要的内部文件，缺少会导致 native crash 且无日志
const eRuntimeRes = path.join(NODE_E_DIST, 'resources');
if (fs.existsSync(eRuntimeRes)) {
  let resCopied = 0;
  for (const ent of fs.readdirSync(eRuntimeRes, { withFileTypes: true })) {
    // 只复制不冲突的文件：不能覆盖我们的 app.asar
    if (ent.name === 'app.asar' || ent.name === 'package.json') continue;
    const s = path.join(eRuntimeRes, ent.name);
    const d = path.join(resourcesDir, ent.name);
    try {
      if (ent.isDirectory()) copyDir(s, d);
      else fs.copyFileSync(s, d);
      resCopied++;
    } catch (_) {}
  }
  say('已同步 Electron 运行时 resources: ' + resCopied + ' 项');
}

// Step 3: 删除 resources 下的外部 package.json（避免与 app.asar 内部的 package.json 产生双入口冲突）
// 这是 Electron 官方推荐：单 app.asar 包模式不需要外部 package.json
const extPkgJson = path.join(resourcesDir, 'package.json');
if (fs.existsSync(extPkgJson)) {
  fs.unlinkSync(extPkgJson);
  say('已删除 resources/package.json（使用 app.asar 内部 package.json）');
}

// Step 3: 补齐 Electron 运行时文件（根目录所有非 electron.exe 的文件）
const nodeEFiles = fs.readdirSync(NODE_E_DIST, { withFileTypes: true });
let copied = 0;
for (const ent of nodeEFiles) {
  if (!ent.isFile()) continue;
  if (ent.name === 'electron.exe') continue;
  const s = path.join(NODE_E_DIST, ent.name);
  const d = path.join(SRC, ent.name);
  fs.copyFileSync(s, d);
  copied++;
}
say('已复制 ' + copied + ' 个运行时文件 (ffmpeg.dll/libEGL/等)');

// Step 4: 补齐 locales/ 目录
const localesSrc = path.join(NODE_E_DIST, 'locales');
const localesDst = path.join(SRC, 'locales');
if (fs.existsSync(localesDst)) { fs.rmSync(localesDst, { recursive: true, force: true }); }
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}
copyDir(localesSrc, localesDst);
say('locales/ 目录已同步 (' + fs.readdirSync(localesDst).length + ' 个语言包)');

// Step 5: 复制 electron.exe → FieldTrace.exe
const exeSrc = path.join(NODE_E_DIST, 'electron.exe');
const exeDst = path.join(SRC, 'FieldTrace.exe');
fs.copyFileSync(exeSrc, exeDst);
say('FieldTrace.exe 启动器已就位 (' + Math.round(fs.statSync(exeDst).size/1024/1024) + ' MB)');

// Step 6: 核验关键文件（app.asar 内嵌 package.json 模式，不需要外部 resources/package.json）
const mustHave = [
  'FieldTrace.exe',
  'ffmpeg.dll',
  'libEGL.dll',
  'libGLESv2.dll',
  'icudtl.dat',
  'locales/zh-CN.pak',
  'resources/app.asar',
  'resources/default_app.asar'
];
say('\n=== 核验 win-unpacked 关键文件 ===');
for (const f of mustHave) {
  const full = path.join(SRC, ...f.split('/'));
  if (fs.existsSync(full)) {
    say('OK   ' + f + '  (' + Math.round(fs.statSync(full).size/1024) + ' KB)');
  } else {
    die('缺失关键文件: ' + f);
  }
}

// Step 7: 打 ZIP（用 System.IO.Compression 或直接调用 PowerShell，如果不行就用 Node 的简单实现）
say('\n正在打 ZIP...');
try { fs.unlinkSync(ZIP_OUT); } catch (_) {}

// 用 Node 的 archiver 或者直接调用 powershell（这次绝对路径 + Bypass）
const psScript = `
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem
$src = '${SRC.replace(/'/g, "''")}'
$zip = '${ZIP_OUT.replace(/'/g, "''")}'
[System.IO.Compression.ZipFile]::CreateFromDirectory($src, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
Write-Host "ZIP 完成: $zip"
Get-Item $zip | Select-Object Name,@{N='SizeMB';E={[math]::Round($_.Length/1MB,1)}} | Format-Table -AutoSize
`;
const psFile = path.join(PROJECT, 'dist', '_pack_tmp.ps1');
fs.writeFileSync(psFile, psScript, 'utf8');
child_process.execFileSync(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile],
  { stdio: 'inherit' }
);
try { fs.unlinkSync(psFile); } catch (_) {}

// 核验 ZIP
say('\n=== ZIP 内部核验 ===');
// 用 PowerShell 快速核验
const verifyScript = `
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = '${ZIP_OUT.replace(/'/g, "''")}'
$zp = [System.IO.Compression.ZipFile]::OpenRead($zip)
$checks = @('ffmpeg.dll','FieldTrace.exe','resources/app.asar','resources/default_app.asar','locales/zh-CN.pak')
foreach ($c in $checks) {
  $hit = $zp.Entries | Where-Object { $_.FullName.Replace('\\','/') -like "*$c" }
  if ($hit) { Write-Host "OK   $c" } else { Write-Host "FAIL $c <-- 缺失!" }
}
$zp.Dispose()
`;
const vFile = path.join(PROJECT, 'dist', '_verify_tmp.ps1');
fs.writeFileSync(vFile, verifyScript, 'utf8');
child_process.execFileSync(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', vFile],
  { stdio: 'inherit' }
);
try { fs.unlinkSync(vFile); } catch (_) {}

say('\n✅ 打包完成！ZIP 路径:');
say('   ' + ZIP_OUT);
