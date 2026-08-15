// 崩溃捕获（必须放在任何其他代码之前，保证即使后续代码 require 失败也能写堆栈）
const _fs = require('fs');
const _path = require('path');
const _os = require('os');
const _APPDATA = process.env.APPDATA || _path.join(_os.homedir(), 'AppData', 'Roaming');
const _CRASH_DIR = _path.join(_APPDATA, 'field-trace');
try { _fs.mkdirSync(_CRASH_DIR, { recursive: true }); } catch (_) {}
const _CRASH_FILE = _path.join(_CRASH_DIR, 'crash.log');
function _writeCrash(msg) {
  try { _fs.appendFileSync(_CRASH_FILE, `[${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false })}+08] ${msg}\n`, 'utf8'); } catch (_) {}
}
process.on('uncaughtException', (e) => {
  const s = e && e.stack ? e.stack : String(e);
  _writeCrash('uncaughtException: ' + s);
  console.error(s);
  process.exit(1);
});
process.on('unhandledRejection', (r) => {
  const s = r && r.stack ? r.stack : String(r);
  _writeCrash('unhandledRejection: ' + s);
  console.error(s);
});
_writeCrash('main.js bootstrap 开始加载');

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, powerMonitor, session } = require('electron');
const path = _path;
const fs = _fs;
const os = _os;

// 调试/沙箱环境可用 FIELDTRACE_USERDATA 重定向配置目录；不设则用系统默认 %APPDATA%\field-trace
// 注意：Electron 30+ 中 app.getPath('userData') 必须在 ready 之后调用，所以此处用环境变量直接拼路径
const APPDATA_DIR = _APPDATA;
const USERDATA_DIR = process.env.FIELDTRACE_USERDATA || _CRASH_DIR;

const CONFIG_DIR = USERDATA_DIR;
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const LOG_FILE = path.join(CONFIG_DIR, 'trace.log');

let mainWindow = null;
let captureWindow = null;
let tray = null;
let captureTimer = null;
let retryTimeout = null;
let isSuspended = false;
let pendingRetry = null;
let pendingManual = null;

function pad(n) { return String(n).padStart(2, '0'); }
function formatDateTime(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}
function formatDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function log(msg) {
  const ts = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }) + '+08';
  const line = `[${ts}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch (_) {}
  console.log(line.trim());
}

function loadConfig() {
  const defaults = {
    engineerName: '',
    storageDir: path.join(os.homedir(), 'Documents', 'FieldTrace'),
    intervalMin: 30,
    retryAfterSec: 60,
    autoStart: true,
    amapKey: '',
    tencentKey: ''
  };
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return { ...defaults, ...saved };
    }
  } catch (e) {
    log(`[CONFIG] 读取失败，用默认: ${e.message}`);
  }
  return defaults;
}

function saveConfig(cfg) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch (e) {
    log(`[CONFIG] 写入失败: ${e.message}`);
    return false;
  }
}

let config = loadConfig();

function ensureStorageDir() {
  const todayDir = path.join(config.storageDir, formatDate(new Date()), config.engineerName || '未知');
  try {
    if (!fs.existsSync(todayDir)) fs.mkdirSync(todayDir, { recursive: true });
    return todayDir;
  } catch (e) {
    log(`[STORAGE] 创建目录失败: ${e.message}`);
    return null;
  }
}

function setAutoStart(enable) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enable,
      path: app.getPath('exe')
    });
  } catch (e) {
    log(`[AUTOSTART] 设置失败: ${e.message}`);
  }
}

function createCaptureWindow() {
  if (captureWindow) return captureWindow;
  captureWindow = new BrowserWindow({
    width: 720,
    height: 560,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  captureWindow.loadFile(path.join(__dirname, 'capture.html'));
  captureWindow.on('closed', () => { captureWindow = null; });
  return captureWindow;
}

function createMainWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 520,
    height: 520,
    resizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'settings.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, '..', 'assets', 'tray.png');
    let image;
    if (fs.existsSync(iconPath)) {
      image = nativeImage.createFromPath(iconPath);
    } else {
      image = nativeImage.createEmpty();
    }
    tray = new Tray(image.resize({ width: 16, height: 16 }));
    tray.setToolTip('FieldTrace 位置留痕');
    updateTrayMenu();
    tray.on('click', () => createMainWindow());
  } catch (e) {
    log(`[TRAY] 创建失败: ${e.message}`);
  }
}

function updateTrayMenu() {
  if (!tray) return;
  const name = config.engineerName || '未设置工程师姓名';
  const status = captureTimer ? '采集进行中' : '采集已停止';
  const menu = Menu.buildFromTemplate([
    { label: `工程师: ${name}`, enabled: false },
    { label: `状态: ${status}`, enabled: false },
    { label: `间隔: ${config.intervalMin} 分钟`, enabled: false },
    { type: 'separator' },
    { label: '立即拍照一张', click: () => triggerCapture(true) },
    { label: '打开设置', click: () => createMainWindow() },
    { label: '打开本地目录', click: () => shell.openPath(config.storageDir) },
    { label: '打开日志文件', click: () => shell.openPath(LOG_FILE) },
    { type: 'separator' },
    { label: captureTimer ? '停止采集' : '启动采集', click: toggleCapture },
    { label: '退出', click: () => { app.isQuiting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
}

function toggleCapture() {
  if (captureTimer) {
    stopCapture();
  } else {
    startCapture();
  }
}

function startCapture() {
  if (!config.engineerName) {
    log('[CAPTURE] 未设置工程师姓名，无法启动');
    createMainWindow();
    return;
  }
  if (captureTimer) return;
  log(`[CAPTURE] 启动，间隔 ${config.intervalMin} 分钟`);
  triggerCapture(false);
  captureTimer = setInterval(() => triggerCapture(false), config.intervalMin * 60 * 1000);
  updateTrayMenu();
}

function stopCapture() {
  if (captureTimer) {
    clearInterval(captureTimer);
    captureTimer = null;
    log('[CAPTURE] 停止');
  }
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
    pendingRetry = null;
  }
  updateTrayMenu();
}

function triggerCapture(isManual) {
  if (isSuspended) {
    const r = { ok: false, error: '系统处于休眠状态', filePath: null, loc: null };
    if (isManual && pendingManual) { pendingManual.resolve(r); pendingManual = null; }
    return Promise.resolve(r);
  }
  const win = createCaptureWindow();
  win.webContents.send('trigger-capture', {
    isManual,
    retryAfterSec: config.retryAfterSec
  });
  if (!isManual) return Promise.resolve(null);
  // 手动触发：30 秒等待 capture:result 回写结果
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (pendingManual) { pendingManual = null; resolve({ ok: false, error: '超时（可能定位未完成）', filePath: null, loc: null }); }
    }, 45000);
    pendingManual = { resolve, timeout };
  });
}

ipcMain.handle('capture:result', (_evt, payload) => {
  const { ok, isManual, imageBuffer, lat, lng, accuracy, source, note, error, takenAt, address, quality, cacheAgeMin } = payload;
  const ts = new Date(takenAt);
  const noteSuffix = note ? ` | 链:${note}` : '';
  const extras = [];
  if (quality) extras.push('质:' + quality);
  if (cacheAgeMin != null) extras.push('缓存' + cacheAgeMin + 'min前');
  if (address) extras.push('地址:' + String(address).replace(/\s+/g, ' ').slice(0, 60));
  const extraSuffix = extras.length ? ` | ${extras.join(' | ')}` : '';
  let ret = { ok: false, error: error || '未知错误', filePath: null, loc: { lat, lng, accuracy, source, note, address, quality, cacheAgeMin } };
  if (ok) {
    const dir = ensureStorageDir();
    if (!dir) {
      const reason = '存储目录创建失败' + noteSuffix + extraSuffix;
      ret.error = reason;
      if (pendingManual) { clearTimeout(pendingManual.timeout); pendingManual.resolve(ret); pendingManual = null; }
      return scheduleRetry(isManual, reason);
    }
    const accStr = accuracy != null ? `精度${Math.round(accuracy)}m` : '精度NA';
    const latStr = lat != null ? Number(lat).toFixed(6) : 'NANA';
    const lngStr = lng != null ? Number(lng).toFixed(6) : 'NANA';
    const name = config.engineerName || 'unknown';
    const qualityStr = quality ? { good: 'G', mid: 'M', bad: 'B' }[quality] : 'B';
    const addrSafe = (address || '').replace(/[\\/:*?"<>|\r\n\t]+/g, '').slice(0, 20);
    const fnameExtra = addrSafe ? `_${addrSafe}` : '';
    const fname = `${formatDateTime(ts)}_${name}_${latStr}_${lngStr}_${accStr}_${qualityStr}${fnameExtra}.jpg`;
    const fpath = path.join(dir, fname);
    try {
      fs.writeFileSync(fpath, Buffer.from(imageBuffer));
      ret = { ok: true, error: null, filePath: fpath, loc: ret.loc };
      log(`[CAPTURE] 已保存 ${fname} (${source}, 精度${accuracy != null ? Math.round(accuracy) : '?'}m, ${isManual ? '手动' : '自动'})${noteSuffix}${extraSuffix}`);
      if (pendingRetry && !isManual) {
        log('[RETRY] 补拍成功，清理待重试状态');
        pendingRetry = null;
      }
    } catch (e) {
      ret.error = `保存失败: ${e.message}` + noteSuffix + extraSuffix;
      log(`[CAPTURE] 保存失败: ${e.message}${noteSuffix}${extraSuffix}`);
      if (pendingManual) { clearTimeout(pendingManual.timeout); pendingManual.resolve(ret); pendingManual = null; }
      return scheduleRetry(isManual, `保存失败: ${e.message}` + noteSuffix + extraSuffix);
    }
  } else {
    ret.error = (error || '未知原因') + noteSuffix + extraSuffix;
    log(`[CAPTURE] 失败: ${error || '未知原因'} (${isManual ? '手动' : '自动'})${noteSuffix}${extraSuffix}`);
    if (!isManual) {
      scheduleRetry(false, (error || 'CAPTURE_ERROR') + noteSuffix + extraSuffix);
    }
  }
  if (isManual && pendingManual) {
    clearTimeout(pendingManual.timeout);
    pendingManual.resolve(ret);
    pendingManual = null;
  }
});

function scheduleRetry(isManual, reason) {
  if (pendingRetry) {
    log('[RETRY] 已有待重试任务，跳过本次重复排队');
    return;
  }
  pendingRetry = { reason, at: Date.now() };
  const delay = config.retryAfterSec * 1000;
  log(`[RETRY] 将在 ${config.retryAfterSec}s 后补拍 (原因: ${reason || 'NA'})`);
  retryTimeout = setTimeout(() => {
    retryTimeout = null;
    pendingRetry = null;
    triggerCapture(true); // 补拍标记为手动，失败不再重试
  }, delay);
}

ipcMain.handle('config:get', () => config);
ipcMain.handle('config:save', (_evt, newCfg) => {
  const needRestart = config.intervalMin !== newCfg.intervalMin;
  config = { ...config, ...newCfg };
  saveConfig(config);
  setAutoStart(config.autoStart);
  log(`[CONFIG] 已更新: ${JSON.stringify(config)}`);
  if (needRestart && captureTimer) {
    stopCapture();
    startCapture();
  }
  updateTrayMenu();
  return true;
});

ipcMain.handle('config:openStorage', () => {
  if (!fs.existsSync(config.storageDir)) {
    fs.mkdirSync(config.storageDir, { recursive: true });
  }
  shell.openPath(config.storageDir);
});

ipcMain.handle('capture:start', () => { startCapture(); return !!captureTimer; });
ipcMain.handle('capture:stop', () => { stopCapture(); return true; });
ipcMain.handle('capture:triggerNow', async () => { return triggerCapture(true) || Promise.resolve({ ok: false, error: '内部错误', filePath: null, loc: null }); });
ipcMain.handle('capture:status', () => ({
  running: !!captureTimer,
  hasRetry: !!pendingRetry,
  engineerName: config.engineerName,
  storageDir: config.storageDir,
  intervalMin: config.intervalMin
}));

// Windows 原生高精度定位（PowerShell 调 System.Device.Location，绕开 Chromium 被墙的 Google 网络定位）
ipcMain.handle('location:windows-native', async () => {
  const { execFile } = require('child_process');
  const os = require('os');
  try {
    // 写到临时 .ps1 文件执行，避免 -Command 多行脚本被截断
    const tmpPs1 = path.join(os.tmpdir(), `ft-geo-${Date.now()}.ps1`);
    const script = `$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Device
  $w = New-Object System.Device.Location.GeoCoordinateWatcher
  $w.Start()
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  do { Start-Sleep -Milliseconds 500 } while ($w.Status -ne 'Ready' -and $w.Status -ne 'Disabled' -and $sw.ElapsedMilliseconds -lt 15000)
  $st = $w.Status
  $perm = $w.Permission
  if ($w.Position -and $w.Position.Location -and -not $w.Position.Location.IsUnknown) {
    $p = $w.Position.Location
    if (-not [double]::IsNaN($p.Latitude) -and -not [double]::IsNaN($p.Longitude)) {
      Write-Output ('OK ' + $p.Latitude + ' ' + $p.Longitude + ' ' + $p.HorizontalAccuracy)
      $w.Stop()
      exit
    }
  }
  Write-Output ('ERR status=' + $st + ' perm=' + $perm + ' no-fix')
  $w.Stop()
} catch {
  Write-Output ('ERR ' + $_.Exception.Message)
}`;
    fs.writeFileSync(tmpPs1, script, 'utf8');
    const out = await new Promise((resolve) => {
      execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpPs1],
        { encoding: 'utf8', timeout: 22000, maxBuffer: 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          const combined = (stdout || '').trim();
          resolve({ out: combined, stderr: (stderr || '').trim(), err });
        }
      );
    });
    try { fs.unlinkSync(tmpPs1); } catch (_) {}
    log(`[LOCATION] Windows 原生输出: "${out.out}" | stderr: "${out.stderr}"`);
    const match = out.out.match(/^OK\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/);
    if (match) {
      const lat = parseFloat(match[1]);
      const lng = parseFloat(match[2]);
      const accuracy = parseFloat(match[3]) || 9999;
      log(`[LOCATION] Windows 原生定位成功 (${lat}, ${lng}) 精度 ${Math.round(accuracy)}m`);
      return { ok: true, lat, lng, accuracy, source: 'wifi-native', note: 'windows-native-ok' };
    } else {
      log(`[LOCATION] Windows 原生定位失败: ${out.out || out.stderr || '(空输出)'}`);
      return { ok: false, lat: null, lng: null, accuracy: null, source: 'none', note: 'win-native-fail' };
    }
  } catch (e) {
    log(`[LOCATION] Windows 原生定位异常: ${e.message}`);
    return { ok: false, lat: null, lng: null, accuracy: null, source: 'none', note: 'win-native-ex' };
  }
});

// IP 定位（在主进程执行，绕过渲染进程的 CORS 限制）
ipcMain.handle('location:ip', async () => {
  const https = require('https');
  const http = require('http');

  function fetchJson(url) {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, { timeout: 6000, headers: { 'User-Agent': 'FieldTrace/1.0' } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('bad-json')); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  const sources = [
    {
      name: 'ipwho.is',
      url: 'https://ipwho.is/',
      pick: (j) => {
        if (!j || !j.success) throw new Error('fail');
        return { lat: j.latitude, lng: j.longitude, accuracy: 5000, source: 'ip-whois' };
      }
    },
    {
      name: 'ipapi.co',
      url: 'https://ipapi.co/json/',
      pick: (j) => ({ lat: j.latitude, lng: j.longitude, accuracy: 5000, source: 'ip-api' })
    },
    {
      name: 'ipapi.is',
      url: 'https://api.ipapi.is/',
      pick: (j) => {
        const lat = j.location && j.location.latitude;
        const lng = j.location && j.location.longitude;
        if (lat == null) throw new Error('no-lat');
        return { lat, lng, accuracy: 10000, source: 'ip-ipapiis' };
      }
    }
  ];

  for (const s of sources) {
    try {
      const j = await fetchJson(s.url);
      const r = s.pick(j);
      if (r.lat != null && r.lng != null) {
        log(`[LOCATION] IP 定位成功: ${s.name} (${r.lat}, ${r.lng})`);
        return { ok: true, ...r, note: s.name + '-ok' };
      }
    } catch (e) {
      log(`[LOCATION] IP 定位 ${s.name} 失败: ${e.message}`);
    }
  }
  return { ok: false, lat: null, lng: null, accuracy: null, source: 'none', note: 'ip-all-fail' };
});

// ====== 逆地理编码（返回详细到建筑/街道/POI 的中文地址）======
// 坐标系说明：
//   Windows 原生定位 = WGS84（国际通用）
//   高德/腾讯 = GCJ02（中国大陆加密坐标系，偏移约 300~700m，必须先转换）
//   bigdatacloud/nominatim = WGS84，不用转
function outOfChina(lat, lng) {
  return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);
}
function wgs84ToGcj02(lat, lng) {
  if (outOfChina(lat, lng)) return [lat, lng];
  const a = 6378245.0;
  const ee = 0.00669342162296594323;
  const PI = Math.PI;
  function transformLat(x, y) {
    let r = -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*Math.sqrt(Math.abs(x));
    r += (20*Math.sin(6*x*PI) + 20*Math.sin(2*x*PI)) * 2 / 3;
    r += (20*Math.sin(y*PI) + 40*Math.sin(y/3*PI)) * 2 / 3;
    r += (160*Math.sin(y/12*PI) + 320*Math.sin(y*PI/30)) * 2 / 3;
    return r;
  }
  function transformLng(x, y) {
    let r = 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*Math.sqrt(Math.abs(x));
    r += (20*Math.sin(6*x*PI) + 20*Math.sin(2*x*PI)) * 2 / 3;
    r += (20*Math.sin(x*PI) + 40*Math.sin(x/3*PI)) * 2 / 3;
    r += (150*Math.sin(x/12*PI) + 300*Math.sin(x/30*PI)) * 2 / 3;
    return r;
  }
  let dLat = transformLat(lng - 105, lat - 35);
  let dLng = transformLng(lng - 105, lat - 35);
  const radLat = lat / 180 * PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / ((a * (1 - ee)) / (magic * sqrtMagic) * PI);
  dLng = (dLng * 180) / (a / sqrtMagic * Math.cos(radLat) * PI);
  return [lat + dLat, lng + dLng];
}
function fetchJsonHttp(url, timeoutMs) {
  const https = require('https');
  const http = require('http');
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs || 5000, headers: { 'User-Agent': 'FieldTrace/1.0' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('bad-json: ' + data.slice(0, 120))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}
// 逆地理主链路：高德(填key优先) → 腾讯(免费，每日额度够20人) → 降级国际数据源(wgs84)
ipcMain.handle('location:reverse', async (_evt, payload) => {
  const { lat, lng, source } = payload || {};
  if (lat == null || lng == null) return null;
  const inChina = !outOfChina(lat, lng);
  const amapKey = (config && config.amapKey) ? String(config.amapKey).trim() : '';
  const tencentKey = (config && config.tencentKey) ? String(config.tencentKey).trim() : '';
  const errs = [];

  // 中国境内：先做 WGS84 → GCJ02 转换
  const [gcjLat, gcjLng] = inChina ? wgs84ToGcj02(lat, lng) : [lat, lng];
  const useGcj = inChina;

  // 1) 高德逆地理（优先级最高，需 web 服务 key；免费配额 5000 次/日）
  if (inChina && amapKey) {
    try {
      const url = `https://restapi.amap.com/v3/geocode/regeo?key=${encodeURIComponent(amapKey)}&location=${encodeURIComponent(useGcj?gcjLng:lng)},${encodeURIComponent(useGcj?gcjLat:lat)}&extensions=base&radius=300&roadlevel=0&output=JSON`;
      const j = await fetchJsonHttp(url, 4500);
      if (j && j.status === '1' && j.regeocode) {
        const rd = j.regeocode;
        const parts = [];
        if (rd.addressComponent) {
          const a = rd.addressComponent;
          if (a.province && a.province !== a.city) parts.push(a.province);
          if (a.city && !Array.isArray(a.city)) parts.push(a.city);
          if (a.district) parts.push(a.district);
          if (a.township) parts.push(a.township);
          // 结构化街道门牌
          if (a.streetNumber && typeof a.streetNumber === 'object' && !Array.isArray(a.streetNumber)) {
            const sn = a.streetNumber;
            let s = '';
            if (sn.street) s += sn.street;
            if (sn.number && sn.number !== '[]') s += (sn.number && sn.street ? sn.number : sn.number);
            if (s) parts.push(s);
            else if (sn.street) parts.push(sn.street);
          } else if (a.street && typeof a.street === 'string') {
            parts.push(a.street);
          }
          // building / neighborhood / POI
          const building = a.building && a.building.name && !Array.isArray(a.building.name) ? a.building.name : null;
          const neighborhood = a.neighborhood && a.neighborhood.name && !Array.isArray(a.neighborhood.name) ? a.neighborhood.name : null;
          const poi = a.businessAreas && Array.isArray(a.businessAreas) && a.businessAreas[0] ? a.businessAreas[0].name : null;
          if (building) parts.push(building);
          else if (poi) parts.push(poi);
          if (neighborhood && neighborhood !== building) parts.push(neighborhood);
        }
        let text = parts.filter(Boolean).join(' ').trim();
        // 最后加 formatted_address 的精华段
        if (rd.formatted_address && typeof rd.formatted_address === 'string') {
          const fa = String(rd.formatted_address).trim();
          if (!text) text = fa;
          else if (fa.length > text.length + 2 && fa.indexOf(text) < 0) text = fa;
        }
        if (text) {
          log(`[REVGEO] 高德成功: ${text.slice(0, 80)}`);
          return text.slice(0, 80);
        }
      } else {
        errs.push('amap:status=' + (j && j.status) + ':' + String((j && (j.info || j.reason)) || '').slice(0, 50));
      }
    } catch (e) { errs.push('amap:' + e.message); }
  }

  // 2) 腾讯地图逆地理（不用key也可调用，免费额度 10000 次/日/IP，覆盖全国 20 人足够）
  if (inChina) {
    try {
      const keyParam = tencentKey ? `&key=${encodeURIComponent(tencentKey)}` : '';
      const url = `https://apis.map.qq.com/ws/geocoder/v1/?location=${encodeURIComponent(useGcj?gcjLat:lat)},${encodeURIComponent(useGcj?gcjLng:lng)}&get_poi=1&poi_options=policy=2;radius=200;page_size=3&output=json${keyParam}`;
      const j = await fetchJsonHttp(url, 5500);
      if (j && j.status === 0 && j.result) {
        const r = j.result;
        const parts = [];
        const a = r.address_component || {};
        if (a.province && a.province !== a.city) parts.push(a.province);
        if (a.city) parts.push(a.city);
        if (a.district) parts.push(a.district);
        if (a.street) parts.push(a.street + (a.street_number ? a.street_number : ''));
        if (r.formatted_addresses && r.formatted_addresses.recommend && typeof r.formatted_addresses.recommend === 'string') {
          // recommend 通常是 区/街道/地标，最贴近建筑级
          const rec = String(r.formatted_addresses.recommend).trim();
          log(`[REVGEO] 腾讯成功(recommend): ${rec.slice(0, 80)}`);
          return rec.slice(0, 80);
        }
        // 兜底：拿附近 POI 第一个
        if (r.pois && Array.isArray(r.pois) && r.pois[0]) {
          const p = r.pois[0];
          const pname = p.title || p.name;
          const padr = p.address;
          const join = [r.address, padr, pname].filter(Boolean).join(' ').trim();
          if (join) { log(`[REVGEO] 腾讯成功(poi): ${join.slice(0, 80)}`); return join.slice(0, 80); }
        }
        if (r.address && typeof r.address === 'string') {
          log(`[REVGEO] 腾讯成功(address): ${String(r.address).slice(0, 80)}`);
          return String(r.address).slice(0, 80);
        }
        const text = parts.filter(Boolean).join(' ').trim();
        if (text) return text.slice(0, 80);
      } else {
        errs.push('tencent:status=' + (j && j.status) + ':' + String((j && j.message) || '').slice(0, 50));
      }
    } catch (e) { errs.push('tencent:' + e.message); }
  }

  // 3) bigdatacloud / nominatim 国际兜底（WGS84 直接传）
  const fallbacks = [
    {
      name: 'bigdatacloud',
      url: `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}&localityLanguage=zh`,
      pick: (j) => {
        if (!j || typeof j !== 'object') throw new Error('bad');
        const parts = [];
        if (j.countryName) parts.push(j.countryName);
        if (j.principalSubdivision) parts.push(j.principalSubdivision);
        if (j.city) parts.push(j.city);
        if (j.locality && j.locality !== j.city) parts.push(j.locality);
        if (j.neighbourhood) parts.push(j.neighbourhood);
        let tail = [];
        if (j.street && !Array.isArray(j.street)) tail.push(j.street);
        else if (j.street && j.street.name) tail.push(j.street.name + (j.street.houseNumber ? ' ' + j.street.houseNumber : ''));
        if (j.landmark && !Array.isArray(j.landmark)) tail.push(j.landmark);
        const text = (parts.join(' ') + ' ' + tail.join(' ')).trim();
        if (!text) throw new Error('no-text');
        return text;
      }
    },
    {
      name: 'nominatim',
      delayMs: 1000,
      url: `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=18&addressdetails=1&accept-language=zh-CN`,
      pick: (j) => {
        if (!j) throw new Error('bad');
        if (j.display_name) return String(j.display_name).slice(0, 80);
        if (j.error) throw new Error(j.error);
        throw new Error('no-text');
      }
    }
  ];
  for (const s of fallbacks) {
    try {
      if (s.delayMs) await new Promise(r => setTimeout(r, s.delayMs));
      const j = await fetchJsonHttp(s.url, 6000);
      const text = s.pick(j);
      if (text) { log(`[REVGEO] ${s.name} 成功: ${text.slice(0, 80)}`); return text.slice(0, 80); }
    } catch (e) {
      errs.push(s.name + ':' + (e.message || 'err'));
    }
  }
  if (errs.length) log(`[REVGEO] 全部失败: ${errs.join(' / ')}`);
  return null;
});

app.whenReady().then(() => {
  try { app.setPath('userData', CONFIG_DIR); } catch (_) {}

  // powerMonitor 必须在 ready 之后使用（Electron 30）
  try {
    powerMonitor.on('suspend', () => {
      isSuspended = true;
      log('[POWER] 系统休眠，暂停采集');
    });
    powerMonitor.on('resume', () => {
      isSuspended = false;
      log('[POWER] 系统恢复，立即补采一张');
      setTimeout(() => triggerCapture(false), 3000);
    });
  } catch (e) {
    log('[POWER] 电源事件监听失败: ' + e.message);
  }

  // 自动允许定位权限（Electron 默认会静默拒绝 geolocation，不弹窗）
  try {
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      if (permission === 'geolocation') {
        callback(true);
      } else if (permission === 'media') {
        callback(true);
      } else {
        callback(false);
      }
    });
  } catch (e) {
    log('[SESSION] 权限处理器设置失败: ' + e.message);
  }

  log('[APP] 启动');
  _writeCrash('[APP] whenReady complete, Electron 启动正常');
  setAutoStart(config.autoStart);
  createTray();
  if (!config.engineerName) {
    log('[APP] 首次运行，打开设置');
    createMainWindow();
  } else {
    startCapture();
  }
});

app.on('window-all-closed', (e) => {
  if (!app.isQuiting) {
    e.preventDefault();
  }
});
app.on('before-quit', () => {
  app.isQuiting = true;
  stopCapture();
});
