# FieldTrace 维护与二次开发方案

> 项目根目录：`C:\Users\asus\AppData\Roaming\TRAE SOLO CN\ModularData\ai-agent\work-mode-projects\6a7ed0036041d0b10bcacb85\field-trace`
> 最终版（v1.0.0）修复记录：摄像头释放 / Windows 原生定位（精度 100m）/ 北京时间日志 / WGS84→GCJ02 转换 / 高德+腾讯建筑级逆地理

---

## 一、项目结构（改功能前先定位文件）

```
field-trace/
├── package.json          依赖管理 + electron-builder 打包入口配置
├── rebuild-all.js        ⭐ 一键打包脚本（日常用这个，不用跑 electron-builder）
├── dist/                 打包产物目录（ZIP 和 win-unpacked 在这里）
│   └── FieldTrace-1.0.0-portable.zip   ← 最终发给工程师的文件
└── src/                  源代码（全部改动集中在这里）
    ├── main.js           ⭐⭐ 主进程：托盘/定时任务/文件保存/定位IPC/逆地理
    ├── preload.js        渲染进程能调用哪些 IPC（增删 API Key 在这里）
    ├── capture.html      ⭐ 拍照+水印+定位链路调度（capture 页/隐藏窗口）
    ├── settings.html     设置窗口 UI（姓名/间隔/目录/Key/自启等）
    └── package.json      内嵌进 app.asar，入口 main=main.js
```

### 各功能对应的修改位置速查表

| 你想改什么 | 去改哪里 |
|---|---|
| 日志格式 / 日志时区 | `src/main.js` → `function log()` |
| 采集间隔默认值 / 补拍等待秒数 / 默认存储目录 | `src/main.js` → `loadConfig()` → `defaults` |
| 定时拍照逻辑 / 休眠恢复 / 失败补拍 | `src/main.js` → `startCapture / stopCapture / triggerCapture / scheduleRetry` |
| 文件名规则 / 目录结构（日/姓名） | `src/main.js` → `ipcMain.handle('capture:result', ...)` |
| 质量角标判定（G/M/B 三色） | `src/capture.html` → `doCapture()` 质量等级段 |
| 水印布局 / 字体 / 角标颜色 / 内容行 | `src/capture.html` → `drawWatermark()` |
| 摄像头参数（分辨率/等画面秒数）/ 释放逻辑 | `src/capture.html` → `releaseCamera() / acquireCamera()` |
| 定位优先级（Win原生 → IP → 缓存） | `src/capture.html` → `getLocation()` |
| Windows 原生定位（PowerShell .NET） | `src/main.js` → `ipcMain.handle('location:windows-native')` |
| WGS84 → GCJ02 坐标转换公式 | `src/main.js` → `function wgs84ToGcj02()` |
| 逆地理 3 级链路（高德→腾讯→兜底） | `src/main.js` → `ipcMain.handle('location:reverse')` |
| 设置窗口 UI（加/删输入框） | `src/settings.html` |
| 新增 IPC 接口 | 改 3 处：`main.js` 加 `ipcMain.handle` → `preload.js` 暴露 → `html` 用 `window.api.xxx` |

---

## 二、新设备开发环境搭建（仅第一次）

### 硬件/系统要求
- Windows 10/11（64 位）
- 必须有前置摄像头
- Windows 定位服务打开：设置 → 隐私和安全性 → 定位 → 开

### 步骤 1：装 Node.js 18+
- 下载：https://nodejs.org/zh-cn/download → Windows Installer (.msi)
- 安装时一路 Next，默认选项就行

### 步骤 2：复制项目目录
- 把整个 `field-trace/` 文件夹拷到新机器任意位置（路径不要带中文/空格/特殊字符）
- 建议路径：`C:\workspace\field-trace`

### 步骤 3：装依赖
- 打开 PowerShell 或 CMD，`cd` 到项目目录
```powershell
npm install
```
- 装 electron 过程会下载 100+MB 二进制，国内慢的话先设镜像：
```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install
```

### 步骤 4：本地调试（改代码前先跑起来确认）
```powershell
npm run dev
```
- 右下角出托盘图标 → 右键设置 → 填姓名/目录 → 立即拍照一张

---

## 三、改完代码 → 打包发布（标准流程）

### 推荐方法 A：一键 rebuild-all（日常用这个）

**rebuild-all 是什么：** 不走 electron-builder（慢，还会被策略限制），直接手动重打 `app.asar` + 复制 Electron 运行时 + 打 ZIP。稳定快 2 分钟搞定。

**坑：Windows PowerShell 默认 ExecutionPolicy=Restricted，RunCommand 执行不了。两种绕过方式二选一：**

#### 方式 A-1：外部 PowerShell 手动执行（稳定，推荐）
```powershell
# 1) 临时放开策略（跑完会恢复，不影响系统）
$orig = Get-ExecutionPolicy -Scope CurrentUser
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force

# 2) 打包
$project = "C:\workspace\field-trace"
$node = "C:\Program Files\nodejs\node.exe"   # 用你本机 node.exe 的真实路径
taskkill /F /IM FieldTrace.exe 2>$null
& $node "$project\rebuild-all.js"

# 3) 恢复策略
Set-ExecutionPolicy -Scope CurrentUser $orig -Force
Write-Host "Done. ZIP at $project\dist\FieldTrace-1.0.0-portable.zip"
```

#### 方式 A-2：Trae 里用 MCP integrated_code_mode 的 Shell 工具
如果 Assistant 里的 RunCommand 被策略拦截（报 "禁止运行脚本" / "& 运算符不允许"），走 MCP Shell：
- Assistant 会自动暴露 `run_mcp` → 调用 `integrated_code_mode` 的 `Exec` 工具
- 示例代码（把 `$p` 和 `$n` 改成你的真实路径即可复用）：
```javascript
const r = await tools.Shell({
  command: '$n="C:\\path\\to\\node.exe"; $p="C:\\path\\to\\field-trace"; & $n "$p\\rebuild-all.js"',
  cwd: 'C:\\path\\to\\field-trace',
  timeout: 300000,
  description: 'rebuild field-trace'
});
text(r.stdout || r.display_stdout)
```

### 不推荐方法 B：electron-builder 完整构建
```powershell
npx electron-builder --win portable
# 产物在 dist/
```
慢 3~5 倍，还会遇到 ExecutionPolicy 拦截，仅当 rebuild-all 流程坏了（比如 Electron 升级后运行时结构变了）才用。

### 打包成功后的核验清单
执行 `rebuild-all.js` 后控制台会打印 8 项 `>>> OK`，如果哪项 FAIL 了按下面修：
- ❌ `app.asar` FAIL → `src/package.json` 缺失或 main 字段写错（应为 `main: "main.js"`）
- ❌ `FieldTrace.exe` FAIL → `node_modules/electron/dist/electron.exe` 不存在（node_modules 没装齐，重跑 `npm install`）
- ❌ `ffmpeg.dll / libEGL.dll / etc` FAIL → Electron 版本升级，`rebuild-all.js` 的 `RUNTIME_FILES` 数组要加新文件名

最终 ZIP 路径：`dist/FieldTrace-1.0.0-portable.zip` 直接发工程师

---

## 四、常见维护场景 SOP

### SOP 1：改采集间隔默认值（比如从 30 分钟 → 45 分钟）
1. 打开 `src/main.js` → 找到 `loadConfig()` 的 `defaults`
2. 把 `intervalMin: 30` → `intervalMin: 45`
3. 打包 → 重新分发 ZIP（已部署的工程师电脑上设置里手动改也行，默认值只对新安装生效）

### SOP 2：新增/更换一个逆地理数据源（比如以后想加百度）
1. 打开 `src/main.js` → 找到 `location:reverse` IPC
2. 在腾讯那一段下面插入新的一段 `if (inChina) { try { ... } catch { errs.push('baidu:'+e.message) } }`，按高德/腾讯的结构照抄就行
3. 如果需要 Key：`loadConfig()` 的 defaults 加 `baiduKey: ''` + settings.html 加输入框 + saveConfig 带进去 + main.js 用 `config.baiduKey`
4. preload.js 不用改（逆地理已经封装成一个 IPC 了）

### SOP 3：把 G（绿）/M（黄）/B（红）的判定标准调严或调松
- 打开 `src/capture.html` 质量等级判定段
- 当前规则：非缓存 + source=wifi(wifi-native) + 精度 <2000m = G；其余有坐标 = M；全失败 = B
- 例如想收紧到精度 <100m 才算绿：把 `loc.accuracy < 2000` → `<100`

### SOP 4：加水印里加一个新字段（比如工单号）
1. 先加 UI：settings.html 加「工单号」输入框 + loadConfig/saveConfig 串起来
2. 从 settings 透传给 capture：triggerCapture 时带进去 或 在 capture 页读 config（capture 已经有 `getConfig()` 调了）
3. drawWatermark() 里加一行 `lines.push(...)`
4. `capture:result` 的 ipcMain.handle 里如果要把工单号加到文件名，也要同步加

### SOP 5：把 WGS84 转 BD09（百度坐标系）
- main.js 里已经有了 `wgs84ToGcj02`，再加一个 `gcj02ToBd09`（公式百度公开）即可
- 如果接入百度逆地理，在逆地理那一段把 `gcjLat/Lng` 再转成 `bdLat/Lng` 传进去

---

## 五、故障排查 Checklist

### 打包故障

| 现象 | 根因 | 修法 |
|---|---|---|
| `Electron failed to install correctly` | electron 二进制下载中断 | 删除 `node_modules/electron` + 设 ELECTRON_MIRROR 再 `npm install` |
| ZIP 里没有 FieldTrace.exe | rebuild-all copy electron.exe 步骤失败 | 检查 `node_modules/electron/dist/electron.exe` 是否存在 |
| ZIP 解压后 exe 在子目录里 | CreateFromDirectory 用了 includeBaseDirectory=true | 改 rebuild-all.js 传 `$false` |
| 启动 FieldTrace 秒退 | app.asar 里的 package.json main 字段错（指向不存在文件）| 确认 `src/package.json` main="main.js" |
| 启动报 ffmpeg.dll 缺失 | rebuild-all RUNTIME_FILES 数组少了文件名 | 加进去重打 |

### 功能故障（按 trace.log 关键词定位）

日志路径：`%AppData%\field-trace\trace.log`

| 日志里看到 | 含义 | 排查步骤 |
|---|---|---|
| `[LOCATION] Windows 原生定位失败: ERR status=Disabled` | Windows 定位服务没开 | 设置→隐私→定位→打开 |
| `[LOCATION] Windows 原生定位失败: ERR status=... perm=Denied` | 程序没定位权限 | 设置→隐私→定位→允许桌面应用访问 |
| `[REVGEO] amap:status=10001` | 高德 key 错了或没激活 | 检查 amapKey / 等新 Key 生效 5 分钟 |
| `[REVGEO] amap:status=10002` | 高德 key 类型选错（应该是"Web 服务"，选成 JS API 了） | 重新申请正确类型 |
| `[REVGEO] tencent:status=...` | 腾讯免费额度用完了/IP 限制 | 填个腾讯 Key 或等第二天重置 |
| `[CAPTURE] 摄像头失败` | 被其他程序占用了 | 关占用程序 / 重启电脑 |

---

## 六、20 人团队 Key 和配额管理

- 高德 Web 服务 Key：20 人共用 1 个，5000 次/日（20 人×24 次=480 次，远够）
- 腾讯：默认不填 Key，走 IP 免费额度 10000 次/日/IP，只有当部署在同一公司内网出口（20 人共 1 IP）且都在同地频繁拍时，才需要填 Key
- 并发：高德 3 次/秒，实际 20 人分散触发不可能超过，超出会自动降级腾讯，用户无感知

需要长期统计配额的话：每月 1 号登录高德 console → 数据中心 → 用量统计，看日调用量曲线即可。

---

## 七、最终部署 Checklist（20 人用，可直接发群）

### 管理者准备（1 次性，约 10 分钟）

**1. 申请高德 Web 服务 Key**（20 人共用 1 个）
- 打开 https://console.amap.com/ → 注册/登录
- 应用管理 → 我的应用 → 创建新应用 → 添加 Key
- **类型必须选「Web 服务」**（不要选 Web 端 JS API / Android / iOS）
- 复制 Key 字符串，发到部署群里让所有人填

**2. 绿联云 NAS 建目录**
- 建共享文件夹 `FieldTraceData/`
- 给 20 个工程师开 NAS 账号（或共用一个写入账号）
- 客户端同步模式选「仅向云端上传」（单向，不双向）

---

### 每位工程师部署（每人约 5 分钟）

**1. 解压**
- 把 ZIP 所有文件解压到 `C:\FieldTrace\`（纯英文路径，不要放 Program Files 或桌面）

**2. 启动**
- 双击 `C:\FieldTrace\FieldTrace.exe`
- 右下角托盘出现 FieldTrace 图标 → 右键 → 打开设置

**3. 填写设置**
- 工程师姓名：**张三**（必填）
- 存储目录：建一个 `D:\FieldTraceData\` 然后填进去
- 采集间隔：30 分钟（默认）
- 高德地图 Web 服务 Key：**粘贴管理者发的 Key**
- 点「保存设置」

**4. 开 Windows 定位服务**（拿绿色 G 必备）
- Windows 设置 → 隐私和安全性 → 定位 → 打开「定位服务」开关

**5. 放行防火墙**（拿定位 + 逆地理必备）
- 首次启动如果弹防火墙 → 点「允许访问」

**6. 启动采集 + 测试拍照**
- 点「启动采集」
- 点「立即拍照一张」→ 等 5~10 秒 → 看到「✅ 已保存」
- 点「打开本地目录」→ 进入今天的日期文件夹 → 双击照片
- 确认右下角水印：🟢 绿色 G + 地址到街道/建筑级

**7. 开机自启**
- 设置窗口勾选「开机自动启动」→ 保存
- 重启电脑确认托盘图标自动出现

**8. 绿联云同步**
- 安装绿联云客户端 → 登录
- 本地 `D:\FieldTraceData\` ↔ NAS `FieldTraceData/`
- 同步模式：仅上传 + 实时监控
