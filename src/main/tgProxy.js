import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { app } from 'electron';
import * as updater from './updater.js';
import { validatePortRange } from './lib/pure.js';

const EXE_NAME = 'TgWsProxy_windows.exe';
const DATA_DIR = 'TgWsProxy_data';
const CONFIG_NAME = 'config.json';
const VERSION_NAME = '.launcher-version.json';

const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  port: 1443,
  secret: '',
  dc_ip: '',
  buffer_size: 128,
  pool_size: 5,
  verbose: false,
  autostart: false,
  buf_kb: 32,
  log_max_mb: 10,
  check_updates: true,
  cfproxy: false,
  cfproxy_user_domain: '',
  cfproxy_workers: 4,
  force_test_dc: false,
  ws_keepalive_interval: 30,
  appearance: 'system',
  language: 'ru'
};

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }

function safeJsonRead(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function mergeConfig(value) { return { ...DEFAULT_CONFIG, ...(value && typeof value === 'object' ? value : {}) }; }

function validPort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}


/** Remove only tg-ws-proxy's notification-area icon on Windows. */
function hideTrayIconForPid(pid) {
  if (!pid || process.platform !== 'win32') return Promise.resolve(false);
  const ps = `
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ZLTrayHider {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct NOTIFYICONDATA {
    public uint cbSize; public IntPtr hWnd; public uint uID; public uint uFlags; public uint uCallbackMessage; public IntPtr hIcon;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string szTip;
    public uint dwState; public uint dwStateMask;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string szInfo;
    public uint uVersion;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string szInfoTitle;
    public uint dwInfoFlags; public Guid guidItem; public IntPtr hBalloonIcon;
  }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern bool Shell_NotifyIcon(uint dwMessage, ref NOTIFYICONDATA lpData);
  const uint NIM_DELETE = 2;
  public static int Hide(uint pid) {
    int removed = 0;
    EnumWindows((hWnd, lParam) => {
      GetWindowThreadProcessId(hWnd, out uint owner);
      if (owner != pid) return true;
      var cls = new StringBuilder(256); GetClassName(hWnd, cls, cls.Capacity);
      string name = cls.ToString();
      // Flowseal/tg-ws-proxy uses the Windows systray implementation built
      // on getlantern/systray: class SystrayClass, icon ID 100.
      if (!name.Equals("SystrayClass", StringComparison.OrdinalIgnoreCase)) return true;
      for (uint id = 100; id <= 110; id++) {
        var data = new NOTIFYICONDATA {
          cbSize=(uint)Marshal.SizeOf(typeof(NOTIFYICONDATA)), hWnd=hWnd, uID=id,
          uFlags=0, uCallbackMessage=0, hIcon=IntPtr.Zero, szTip="", szInfo="", szInfoTitle=""
        };
        if (Shell_NotifyIcon(NIM_DELETE, ref data)) removed++;
      }
      return true;
    }, IntPtr.Zero);
    return removed;
  }
}
'@
[void][ZLTrayHider]::Hide(${pid})
`;
  return new Promise((resolve) => {
    try {
      const child = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-Command', ps], { windowsHide:true, stdio:'ignore' });
      child.once('exit', () => resolve(true));
      child.once('error', () => resolve(false));
    } catch { resolve(false); }
  });
}
function normalizeProxyConfig(value) {
  const cfg = mergeConfig(value);
  cfg.host = String(cfg.host || '127.0.0.1').trim();
  cfg.port = Number(cfg.port);
  cfg.secret = String(cfg.secret || '').trim();
  cfg.dc_ip = String(cfg.dc_ip || '').trim();
  cfg.buffer_size = Math.max(1, Number(cfg.buffer_size) || DEFAULT_CONFIG.buffer_size);
  cfg.pool_size = Math.max(1, Number(cfg.pool_size) || DEFAULT_CONFIG.pool_size);
  cfg.buf_kb = Math.max(1, Number(cfg.buf_kb) || DEFAULT_CONFIG.buf_kb);
  cfg.log_max_mb = Math.max(1, Number(cfg.log_max_mb) || DEFAULT_CONFIG.log_max_mb);
  cfg.cfproxy_workers = Math.max(1, Number(cfg.cfproxy_workers) || DEFAULT_CONFIG.cfproxy_workers);
  cfg.ws_keepalive_interval = Math.max(0, Number(cfg.ws_keepalive_interval) || DEFAULT_CONFIG.ws_keepalive_interval);
  return cfg;
}

export class TgProxyManager {
  constructor({ repo, dir, onState } = {}) {
    this.repo = repo || 'Flowseal/tg-ws-proxy';
    this.dir = dir || path.join(app.getPath('documents'), 'Zapret Launcher', 'tg-ws-proxy');
    this.onState = onState || (() => {});
    this.trayHiderTimer = null;
  }

  get exePath() { return path.join(this.dir, EXE_NAME); }
  get dataPath() { return path.join(this.dir, DATA_DIR); }
  get configPath() { return path.join(this.dataPath, CONFIG_NAME); }
  get versionPath() { return path.join(this.dir, VERSION_NAME); }

  installed() { return fs.existsSync(this.exePath); }

  processRunning() {
    const r = spawnSync('tasklist.exe', ['/FI', `IMAGENAME eq ${EXE_NAME}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) return false;
    return String(r.stdout || '').toLowerCase().includes(EXE_NAME.toLowerCase());
  }

  status() {
    const meta = safeJsonRead(this.versionPath, {});
    return {
      installed: this.installed(),
      running: this.processRunning(),
      dir: this.dir,
      exe: this.exePath,
      version: meta.version || null
    };
  }

  setDir(dir) {
    this.dir = dir || path.join(app.getPath('documents'), 'Zapret Launcher', 'tg-ws-proxy');
    ensureDir(this.dir);
    return this.status();
  }

  async checkUpdate() {
    const latest = await updater.fetchLatestRelease(this.repo);
    const asset = updater.findReleaseAsset(latest, [/^TgWsProxy_windows\.exe$/i]);
    if (!asset) throw new Error('В последнем релизе tg-ws-proxy нет TgWsProxy_windows.exe');
    const local = safeJsonRead(this.versionPath, {}).version || null;
    return {
      hasUpdate: !local || updater.isNewer(latest.version, local),
      local,
      remote: latest.version,
      asset: {
        name: asset.name,
        url: asset.browser_download_url,
        digest: asset.digest || null,
        size: asset.size || null
      },
      htmlUrl: latest.htmlUrl
    };
  }

  async installLatest(onProgress) {
    ensureDir(this.dir);
    const latest = await updater.fetchLatestRelease(this.repo);
    const asset = updater.findReleaseAsset(latest, [/^TgWsProxy_windows\.exe$/i]);
    if (!asset?.browser_download_url) throw new Error('GitHub не вернул TgWsProxy_windows.exe');
    const wasRunning = this.processRunning();
    if (wasRunning) await this.stop();
    const tmp = await updater.downloadAsset(asset.browser_download_url, asset.name, (percent, got, total) => {
      onProgress?.({ percent, stage: 'Загрузка tg-ws-proxy…', received: got, total });
    }, asset.digest || null);
    try {
      ensureDir(this.dataPath);
      fs.copyFileSync(tmp, this.exePath);
      fs.writeFileSync(this.versionPath, JSON.stringify({ version: latest.version, tag: latest.tagName, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
    } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
    onProgress?.({ percent: 100, stage: 'tg-ws-proxy обновлён' });
    this.onState(this.status());
    return this.status();
  }

  async start() {
    if (!this.installed()) return { ok: false, error: 'not-installed' };
    if (this.trayHiderTimer) { clearInterval(this.trayHiderTimer); this.trayHiderTimer = null; }
    if (this.processRunning()) return { ok: true, action: 'already-running' };
    ensureDir(this.dataPath);
    const child = spawn(this.exePath, ['--portable'], {
      cwd: this.dir, detached: true, windowsHide: true, stdio: 'ignore'
    });
    const childPid = child.pid;
    child.unref();
    await new Promise((r) => setTimeout(r, 500));
    if (childPid) {
      await hideTrayIconForPid(childPid);
      this.trayHiderTimer = setInterval(async () => {
        if (!this.processRunning()) { clearInterval(this.trayHiderTimer); this.trayHiderTimer = null; return; }
        await hideTrayIconForPid(childPid);
      }, 650);
    }
    const running = this.processRunning();
    this.onState(this.status());
    return running ? { ok: true, action: 'start' } : { ok: false, error: 'start-failed' };
  }

  async stop() {
    if (this.trayHiderTimer) { clearInterval(this.trayHiderTimer); this.trayHiderTimer = null; }
    const r = spawnSync('taskkill.exe', ['/IM', EXE_NAME, '/T', '/F'], { encoding: 'utf8', windowsHide: true });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const running = this.processRunning();
    this.onState(this.status());
    return { ok: !running, action: 'stop', output: String(r.stdout || r.stderr || '').trim() };
  }

  async toggle() { return this.processRunning() ? this.stop() : this.start(); }

  getConfig() {
    ensureDir(this.dataPath);
    return normalizeProxyConfig(safeJsonRead(this.configPath, {}));
  }

  setConfig(patch = {}) {
    const cfg = normalizeProxyConfig({ ...this.getConfig(), ...(patch || {}) });
    if (!validPort(cfg.port)) throw new Error('Порт должен быть числом от 1 до 65535');
    if (cfg.host.length > 255) throw new Error('Адрес host слишком длинный');
    if (cfg.secret && !/^[A-Za-z0-9_-]{1,128}$/.test(cfg.secret)) throw new Error('Secret содержит недопустимые символы');
    ensureDir(this.dataPath);
    fs.writeFileSync(this.configPath, JSON.stringify(cfg, null, 2), 'utf8');
    return cfg;
  }

  openFolder() { return this.dir; }
}

export const TG_PROXY_EXE = EXE_NAME;
export { hideTrayIconForPid };
export const TG_PROXY_DATA = DATA_DIR;
