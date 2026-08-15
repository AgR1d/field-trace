# FieldTrace - 外勤工程师位置留痕工具

纯 Windows 客户端，无后端无数据库。按设定间隔自动调用前置摄像头拍照，把**时间 + 坐标 + 工程师姓名 + 定位精度**打成水印存在本地，目录结构便于绿联云自动同步到 NAS。

## 特性

- 30 分钟（可改）自动拍照一张，带位置水印
- 定位优先走 Windows Wi-Fi/Geolocation API，失败降级 IP 定位
- 摄像头调用失败 / 保存失败后：N 秒（默认 60s）自动补拍一张，只补拍一次避免死循环
- 笔记本合盖→系统休眠→自动暂停；开盖恢复→3 秒后立即补采一张
- 文件按 `日期/工程师名/` 分层，文件名编码所有关键字段
- 系统托盘常驻，可"立即拍一张 / 启动停止 / 开目录 / 看日志"
- 可选开机自启
- 所有操作留本地日志（`%AppData%/FieldTrace/trace.log`）

## 目录结构

```
field-trace/
├─ package.json
├─ assets/                     # 放置 tray.png 托盘图标（16x16 透明 PNG，可省）
└─ src/
   ├─ main.js                  # 主进程：托盘、定时、电源事件、IPC、落盘、补拍调度
   ├─ preload.js               # IPC 安全桥
   ├─ capture.html             # 隐藏窗口：摄像头 + 定位 + Canvas 水印合成
   └─ settings.html            # 设置窗口
```

本地输出目录（可配置）：
```
D:\FieldTrace\
└─ 2026-08-14\
   └─ 张三\
      ├─ 20260814_1000_张三_39.904200_116.407400_精度85m.jpg
      ├─ 20260814_1030_张三_39.904210_116.407390_精度82m.jpg
      └─ ...
```

## 开发环境运行

前置：Node.js 18+（建议 20 LTS）

```bash
cd field-trace
npm install
npm run dev      # 带日志启动
npm start        # 普通启动
```

首次启动会弹设置窗口：
1. 填"工程师姓名"（必填）
2. 确认"本地存储目录"（建议放到一个专门目录，别和别的文件混）
3. 保存 → 自动开始采集

## 打包发布（推荐用便携 ZIP，不依赖 NSIS）

FieldTrace 有 3 种发布形态，优先选 **ZIP 便携版**（对环境要求最低、国内网络最稳）。

### 方式 A：便携 ZIP 版（最推荐，20 人分发首选）

产物：`dist/FieldTrace-1.0.0-portable.zip`（约 350 MB，因为把 Electron Runtime 一起打了）

> 打包命令里的 asar 工具路径统一用 `node_modules\@electron\asar\bin\asar.js`（新版 electron-builder 的安装路径），不是老的 `node_modules\asar\bin\asar`。

打包命令（PowerShell，当前项目目录执行）：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

# 1) 先把开发/调试时残留的 FieldTrace 进程杀干净，否则 app.asar 会被锁
taskkill /F /IM electron.exe 2>$null
taskkill /F /IM FieldTrace.exe 2>$null
Start-Sleep -Seconds 3

# 2) 重打 app.asar + 补 resources/package.json（必须做，保证打包进的是当前最新源码）
Remove-Item -Recurse -Force dist\win-unpacked\resources\app.asar -ErrorAction SilentlyContinue
& node .\node_modules\@electron\asar\bin\asar.js pack src dist\win-unpacked\resources\app.asar --unpack "*.node"
Copy-Item package.json dist\win-unpacked\resources\ -Force

# 3) 【关键】补齐 Electron 运行时文件（ffmpeg.dll / libEGL.dll / libGLESv2.dll / icudtl.dat /
#    d3dcompiler_47.dll / chrome_*_percent.pak / LICENSE / locales/ 等）。
#    electron-builder 生成的半成品 win-unpacked 可能缺这些（直接导致启动报
#    "找不到 ffmpeg.dll"），所以从 node_modules\electron\dist 完整同步一份。
$srcDir = (Resolve-Path dist\win-unpacked).Path
$electronDist = (Resolve-Path node_modules\electron\dist).Path
#    3a) 根目录所有文件（排除 electron.exe 本身 + resources 子目录，因为 resources
#        里已经有我们的 app.asar；electron.exe 下一步重命名为 FieldTrace.exe）
$runtimeFiles = Get-ChildItem $electronDist -File | Where-Object { $_.Name -ne "electron.exe" }
foreach ($f in $runtimeFiles) {
    Copy-Item $f.FullName (Join-Path $srcDir $f.Name) -Force
}
#    3b) locales/ 语言包目录（Electron 必须，否则 UI 文字会异常）
$localesSrc = Join-Path $electronDist "locales"
$localesDst = Join-Path $srcDir "locales"
if (Test-Path $localesSrc) { Copy-Item $localesSrc $localesDst -Recurse -Force }

# 4) 补启动器 FieldTrace.exe（electron-builder 半成品 win-unpacked 会缺它，
#    直接用 electron 发行版自带的 electron.exe 复制重命名，Electron 会读 resources/package.json
#    的 name/productName 作为应用名）
$electronExe = Join-Path $electronDist "electron.exe"
Copy-Item $electronExe (Join-Path $srcDir "FieldTrace.exe") -Force

# 5) 打便携 ZIP（includeBaseDirectory=$false，解压后根目录直接就能看到 FieldTrace.exe）
Add-Type -AssemblyName System.IO.Compression.FileSystem
$oldZip = Join-Path (Resolve-Path dist).Path "FieldTrace-1.0.0-portable.zip"
Remove-Item $oldZip -Force -ErrorAction SilentlyContinue
$newZip = Join-Path (Resolve-Path dist).Path "FieldTrace-1.0.0-portable.zip"
[System.IO.Compression.ZipFile]::CreateFromDirectory($srcDir, $newZip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

# 6) 核验（ZipEntry 结构必须是：
#       FieldTrace.exe + DLLs 直接在 zip 根
#       resources\app.asar + resources\package.json 在 resources 里）
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zp = [System.IO.Compression.ZipFile]::OpenRead($newZip)
$mustHave = @(
  @{P="^FieldTrace\.exe$";            N="启动器 FieldTrace.exe（根目录）"},
  @{P="^ffmpeg\.dll$";                N="ffmpeg.dll（缺这个会直接启动失败）"},
  @{P="^libEGL\.dll$";                N="libEGL.dll（渲染必备）"},
  @{P="^libGLESv2\.dll$";             N="libGLESv2.dll（渲染必备）"},
  @{P="^icudtl\.dat$";                N="icudtl.dat（Chromium i18n 数据）"},
  @{P="^locales[/\\]zh-CN\.pak$";     N="中文语言包"},
  @{P="^resources[/\\]app\.asar$";    N="源码 app.asar"},
  @{P="^resources[/\\]package\.json$";N="resources\package.json（Electron 读它找入口）"}
)
foreach ($it in $mustHave) {
  $hit = $zp.Entries | Where-Object { $_.FullName.Replace("\","/") -match $it.P }
  if ($hit) { Write-Host ("OK   {0}" -f $it.N) }
  else { Write-Host ("FAIL {0} - NOT FOUND IN ZIP - STOP HERE, DO NOT DEPLOY" -f $it.N) }
}
$zp.Dispose()

Get-ChildItem dist | Select-Object Name,@{N='SizeMB';E={[math]::Round($_.Length/1MB,1)}}
```

给工程师的安装步骤（**每台笔记本 1 分钟**）：
1. 把 `FieldTrace-1.0.0-portable.zip` 传过去，解压到例如 `C:\FieldTrace\`（路径尽量不带中文）
2. 解压后**在当前解压根目录**能直接看到 `FieldTrace.exe`（正确），不是还要再进入 `win-unpacked\` 子目录（错误）
3. **右键 FieldTrace.exe → 发送到 → 桌面快捷方式**
4. 双击运行 → 系统会弹两个权限："允许 FieldTrace 访问位置？"**要点允许**；"允许使用摄像头？"**要点允许**
5. 首次启动弹出设置窗口：
   - 填"工程师姓名"（必填）
   - "本地存储目录"选择 **绿联云同步盘**里专门给这台机器建的子目录（例如 `G:\绿联云同步\FieldTrace-张三\`）
   - "采集间隔分钟"默认 30，不用改
   - "补拍等待秒数"默认 60，不用改
   - 勾上"开机自启"
   - 点"保存设置并启动采集"
6. 验证：托盘里点「立即拍照一张」→ 去存储目录里等 10~20 秒出现 jpg，再去绿联云网页端/NAS 端确认照片已经同步过去；打开照片看右下角水印必须有工程师姓名+时间+坐标/地址角标颜色

### 方式 B：electron-builder 一把梭（NSIS / ZIP / Portable 三件套）

如果网络条件好（能下到 nsis 依赖），直接：

```bash
npm install
npm run build
```

会在 `dist/` 下产出：
- `FieldTrace Setup 1.0.0.exe`（NSIS 安装向导）
- `FieldTrace 1.0.0.exe`（单文件便携版，electron-builder 的 portable target）
- `FieldTrace-1.0.0-win32-x64.zip`（electron-builder 的 zip target）

安装后默认：桌面快捷方式 + 开始菜单项。开机自启在软件设置窗口勾。

## 绿联云 / 绿联 NAS 自动同步配置

前提：工程师笔记本装好了"绿联云"客户端并登录有权限的账号。

1. 打开绿联云客户端 → 左侧"同步空间"或"备份"
2. 新建一个 **本地 → NAS** 的单向同步任务（**别选双向，避免照片被 NAS 端误删回写**）
3. 本地源目录：选择设置里的"本地存储目录"（例如 `D:\FieldTrace\`）
4. NAS 目标目录：建议 `/home/field-trace-records/` 下再按"工程师姓名"建子目录；若多机共用同一大目录也可，因为本项目文件名已经带了姓名
5. 同步频率：**实时**（绿联云默认是实时监控文件变更）
6. 过滤选项：只同步 `.jpg`，忽略临时文件
7. 冲突策略：保留双方 / 本地版本优先都可以（因为本文件是一次落盘不再改，冲突极少）

验证方式：
- 在笔记本设置里点"立即拍照一张"
- 等 30 秒，去绿联云网页端看对应 NAS 目录是否出现新照片
- 打开照片看水印是否齐全（姓名/时间/坐标/精度）

## 管理者如何查看

没有管理后台（按"简化需求"约定砍掉了），管理者两种方式：

1. **绿联云网页端 / 客户端**：直接登录 NAS，按 `日期/姓名` 文件夹翻照片
2. **进阶（可选）**：在 NAS 侧部署一个轻量静态索引脚本（如定时用 Python 扫目录生成 `index.html` 缩略图墙），不做在本 MVP 范围内

## 日志与排错

每台笔记本本地日志位置：
```
%AppData%\Roaming\field-trace\trace.log
```

常见报错关键词：
- `[CAPTURE] 失败: 摄像头失败: ...` → 摄像头被视频会议占用 / 驱动异常 / 笔记本合上了。系统会自动补拍一次，后续等待下一轮周期。
- `[CAPTURE] ... (ip, 精度5000m)` → Wi-Fi 定位失败走了 IP 定位，精度只有 5km 级别。一般是第一次定位的权限弹窗没点允许。
- `[STORAGE] 创建目录失败` → 磁盘满了或目录无写权限。
- `[RETRY] 将在 60s 后补拍` → 看到这条之后下一条如果是 `补拍成功` 就正常，否则再结合前面的错误排查。

## 已知限制（与需求对齐的取舍）

1. **无 GPS，依赖 Wi-Fi/IP 定位**：室内精度约 50-100 米，地下/偏远可能 5000 米（IP 级）。如精度不达标，给笔记本配 USB GPS 模块并升级驱动，但本项目定位 API 不需要改（Windows Geolocation 会自动融合）。
2. **前置摄像头可能拍空画面**：需求已确认可接受。需要"明确有人在"的场景，工程师可以在托盘菜单点"立即拍照一张"手动触发。
3. **合盖时段不采集**：恢复后 3 秒自动补一张。时段留痕空白可从日志和缺失的时间点推断。
4. **无后端**：没有统计、没有地图、没有导出 Excel，管理者手工翻 NAS。需要这些时在"第二版"加后端。
