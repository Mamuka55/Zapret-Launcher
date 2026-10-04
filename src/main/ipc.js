import { ipcMain, dialog, shell, app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, saveConfig, toggleFavorite, appRoot } from './config.js';
import { listBats, watchBatsDir } from './scanner.js';
import { runner } from './runner.js';
import * as updater from './updater.js';
import * as service from './service.js';
import * as diag from './diagnostics.js';
import { isAdmin, serviceState } from './util.js';
import { defaultTgProxyDir } from './config.js';
import { TgProxyManager } from './tgProxy.js';
import * as proxy from './proxy.js';

let win = null;
let watcher = null;
let updateState = { busy: false };
let appUpdateState = { busy: false, info: null };
let tgManager = null;
let proxyRefreshTimer = null;

export function setWindow(w) { win = w; }

function notifyProxy() { send('evt:proxy-state', proxy.status()); }

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

export function notifyState() {
  send('evt:state', { running: runner.list() });
}

function notifyBats() {
  send('evt:bats', { bats: listBats(getConfig().batsDir) });
}

function getTgManager() {
  const cfg = getConfig();
  if (!tgManager || tgManager.repo !== cfg.tgRepo || tgManager.dir !== cfg.tgDir) {
    tgManager = new TgProxyManager({ repo: cfg.tgRepo, dir: cfg.tgDir || defaultTgProxyDir(), onState: (state) => send('evt:tg-state', state) });
  }
  return tgManager;
}

function setupWatcher() {
  try { watcher?.close(); } catch {}
  const dir = getConfig().batsDir;
  if (dir && fs.existsSync(dir)) {
    watcher = watchBatsDir(dir, () => notifyBats());
  }
}

/** Синхронизация флага utils/check_updates.enabled с настройкой приложения */
function syncCheckUpdatesFlag(enabled) {
  const dir = getConfig().batsDir;
  if (dir) { try { service.setCheckUpdatesFlag(dir, !!enabled); } catch {} }
}

export function registerIpc() {
  runner.on('state', notifyState);

  // батник завершился мгновенно: показываем его вывод, чтобы было понятно, что случилось
  runner.on('quick-exit', async ({ name, code, output }) => {
    const tail = output ? output.split(/\r?\n/).filter(Boolean).slice(-2).join(' | ') : 'вывода нет';
    let text = `«${name}» завершился сразу (код ${code}). ${tail}`;
    try {
      const elevated = await isAdmin();
      if (!elevated) text += ' Нет прав администратора — драйвер WinDivert не поднимется.';
    } catch {}
    send('evt:toast', { type: 'warn', text });
  });


  // ---------- proxy / VPN center ----------
  proxy.onState((state) => {
    try {
      const cfg = proxy.getSettings();
      saveConfig({ proxyEnabled: !!state.running, proxyMode: cfg.mode || 'proxy', proxySystem: !!cfg.systemProxy, proxySocksPort: cfg.socksPort, proxyHttpPort: cfg.httpPort, proxyRoute: cfg.routeProfile });
    } catch {}
    notifyProxy();
  });
  ipcMain.handle('proxy:status', () => proxy.status());
  ipcMain.handle('proxy:settings', () => proxy.getSettings());
  ipcMain.handle('proxy:setSettings', (_e, patch) => {
    const p = patch || {};
    const result = proxy.setSettings(p);
    saveConfig({ proxyMode: result.mode, proxySystem: result.systemProxy, proxySocksPort: result.socksPort, proxyHttpPort: result.httpPort, proxyRoute: result.routeProfile, proxyAutoRefreshHours: result.subscriptionIntervalHours });
    return result;
  });
  ipcMain.handle('proxy:servers', () => proxy.getServers());
  ipcMain.handle('proxy:addServer', (_e, value) => proxy.addServer(value));
  ipcMain.handle('proxy:deleteServer', (_e, id) => proxy.deleteServer(id));
  ipcMain.handle('proxy:selectServer', (_e, id) => proxy.selectServer(id));
  ipcMain.handle('proxy:toggleServer', (_e, id) => proxy.toggleServer(id));
  ipcMain.handle('proxy:updateServer', (_e, { id, patch }) => proxy.updateServer(id, patch));
  ipcMain.handle('proxy:favoriteServer', (_e, id) => proxy.toggleFavoriteServer(id));
  ipcMain.handle('proxy:ping', (_e, id) => proxy.pingServerReal(id));
  ipcMain.handle('proxy:pingAll', () => proxy.pingAll());
  ipcMain.handle('proxy:pingSubscription', (_e, id) => proxy.pingSubscription(id));
  ipcMain.handle('proxy:start', (_e, opts) => proxy.start(opts || {}));
  ipcMain.handle('proxy:stop', () => proxy.stop());
  ipcMain.handle('proxy:subscriptions', () => proxy.getSubscriptions());
  ipcMain.handle('proxy:addSubscription', (_e, { url, name }) => proxy.addSubscription(url, name || ''));
  ipcMain.handle('proxy:refreshSubscription', (_e, id) => proxy.refreshSubscription(id));
  ipcMain.handle('proxy:refreshAll', () => proxy.refreshAllSubscriptions());
  ipcMain.handle('proxy:deleteSubscription', (_e, id) => proxy.deleteSubscription(id));
  ipcMain.handle('proxy:routes', () => proxy.getRoutes());
  ipcMain.handle('proxy:addRoute', (_e, route) => proxy.addRoute(route));
  ipcMain.handle('proxy:deleteRoute', (_e, id) => proxy.deleteRoute(id));
  ipcMain.handle('proxy:setRoute', (_e, id) => proxy.setRoute(id));
  ipcMain.handle('proxy:importJson', (_e, raw) => proxy.importXrayJson(raw));
  ipcMain.handle('proxy:importWireguard', (_e, raw) => proxy.importWireguardConf(raw));
  ipcMain.handle('proxy:pickFile', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name:'Конфигурации', extensions:['json','conf','txt','yaml','yml'] }, { name:'Все файлы', extensions:['*'] }] });
    return res.canceled || !res.filePaths[0] ? null : fs.readFileSync(res.filePaths[0], 'utf8');
  });
  ipcMain.handle('proxy:cores', () => proxy.checkCores());

  // ---------- окно ----------
  ipcMain.on('win:minimize', () => win?.minimize());
  ipcMain.on('win:close', () => win?.close());

  // ---------- плитки / батники ----------
  ipcMain.handle('bats:list', () => listBats(getConfig().batsDir));

  ipcMain.handle('bats:toggle', async (_e, { name, batPath }) => {
    const action = runner.isRunning(name) ? 'stop' : 'start';
    if (action === 'stop') {
      return { action, ...runner.stop(name) };
    }
    // как в service.bat: предупреждаем, если сервис zapret уже запущен
    const st = await serviceState('zapret');
    if (st === 'RUNNING') {
      return { action, ok: false, error: 'service-running' };
    }
    if (!fs.existsSync(batPath)) return { action, ok: false, error: 'not-found' };
    return { action, ...runner.start(batPath, name) };
  });

  ipcMain.handle('bats:running', () => runner.list());

  ipcMain.handle('bats:stopAll', () => (runner.stopAll(), { ok: true }));

  // ---------- конфиг ----------
  ipcMain.handle('config:get', () => ({
    ...getConfig(),
    localVersion: updater.getLocalVersion(getConfig().batsDir),
    elevated: null
  }));

  ipcMain.handle('config:set', (_e, patch) => {
    const cfg = saveConfig(patch ?? {});
    if (patch && 'batsDir' in patch) setupWatcher();
    if (patch && ('tgDir' in patch || 'tgRepo' in patch)) { tgManager = null; send('evt:tg-state', getTgManager().status()); }
    if (patch && 'autoCheckUpdates' in patch) syncCheckUpdatesFlag(patch.autoCheckUpdates);
    if (patch && 'launchAtStartup' in patch) {
      try {
        app.setLoginItemSettings({ openAtLogin: !!patch.launchAtStartup, path: process.execPath });
      } catch {}
    }
    return cfg;
  });

  ipcMain.handle('config:toggleFavorite', (_e, name) => toggleFavorite(name));

  ipcMain.handle('config:chooseFolder', async () => {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Выберите папку zapret'
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('config:chooseTgFolder', async () => {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Выберите папку TG Proxy'
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('config:openFolder', async () => {
    const dir = getConfig().batsDir;
    if (dir && fs.existsSync(dir)) { await shell.openPath(dir); return true; }
    return false;
  });

  ipcMain.handle('paths:defaultBats', () => {
    // единый рабочий каталог компонентов: Documents\Zapret Launcher\zapret
    const dir = path.join(app.getPath('documents'), 'Zapret Launcher', 'zapret');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    return dir;
  });

  ipcMain.handle('paths:defaultTg', () => defaultTgProxyDir());

  // ---------- обновления ----------
  ipcMain.handle('updates:install', async () => {
    if (updateState.busy) return { ok: false, error: 'busy' };
    updateState.busy = true;
    try {
      const cfg = getConfig();
      const defaultDir = path.join(app.getPath('documents'), 'Zapret Launcher', 'zapret');
      const dir = cfg.batsDir || defaultDir;
      fs.mkdirSync(dir, { recursive: true });
      const info = await updater.checkUpdate(cfg.repo, dir);
      if (info?.error) return { ok: false, error: info.error };
      if (!info?.zipUrl) return { ok: false, error: 'GitHub не вернул архив релиза' };
      runner.stopAll();
      send('evt:update-progress', { percent: 0, stage: 'Загрузка Zapret…' });
      const zip = await updater.downloadZip(info.zipUrl, (percent) => send('evt:update-progress', { percent, stage: 'Загрузка Zapret…' }));
      await updater.installUpdate(zip, dir, (stage) => send('evt:update-progress', { percent: 100, stage }));
      saveConfig({ batsDir: dir, onboardSeen: true });
      setupWatcher();
      notifyBats();
      updateState.info = null;
      return { ok: true, version: info.remote, dir };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    } finally {
      updateState.busy = false;
      send('evt:update-progress', { percent: -1, stage: '' });
    }
  });
  ipcMain.handle('updates:check', async () => {
    const cfg = getConfig();
    const info = await updater.checkUpdate(cfg.repo, cfg.batsDir);
    updateState.info = info;
    send('evt:update', info);
    return info;
  });

  ipcMain.handle('updates:run', async () => {
    if (updateState.busy) return { ok: false, error: 'busy' };
    const cfg = getConfig();
    if (!cfg.batsDir) return { ok: false, error: 'no-folder' };
    updateState.busy = true;
    try {
      const info = updateState.info ?? await updater.checkUpdate(cfg.repo, cfg.batsDir);
      if (info?.error) return { ok: false, error: info.error };
      if (!info.zipUrl) return { ok: false, error: 'GitHub не вернул архив релиза' };
      runner.stopAll(); // освобождаем файлы
      send('evt:update-progress', { percent: 0, stage: 'Загрузка архива…' });
      const zip = await updater.downloadZip(info.zipUrl, (percent) => {
        send('evt:update-progress', { percent, stage: 'Загрузка архива…' });
      });
      await updater.installUpdate(zip, cfg.batsDir, (stage) => {
        send('evt:update-progress', { percent: 100, stage });
      });
      setupWatcher();
      notifyBats();
      updateState.info = null;
      return { ok: true, version: info.remote };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    } finally {
      updateState.busy = false;
      send('evt:update-progress', { percent: -1, stage: '' });
    }
  });

  // ---------- обновление самого лаунчера ----------
  ipcMain.handle('appUpdates:check', async () => {
    try {
      const cfg = getConfig();
      const local = app.getVersion();
      const latest = await updater.fetchLatestRelease(cfg.appRepo);
      const portable = !!process.env.PORTABLE_EXECUTABLE_DIR;
      const asset = updater.getAppUpdateAsset(latest, portable);
      const info = {
        hasUpdate: updater.isNewer(latest.version, local),
        local, remote: latest.version, htmlUrl: latest.htmlUrl,
        notes: latest.body || '', portable, asset: asset ? { name: asset.name, url: asset.browser_download_url, digest: asset.digest || null, size: asset.size || null } : null
      };
      appUpdateState.info = info;
      send('evt:app-update', info);
      return info;
    } catch (err) {
      return { hasUpdate: false, local: app.getVersion(), remote: null, error: String(err?.message ?? err) };
    }
  });

  ipcMain.handle('appUpdates:run', async () => {
    if (appUpdateState.busy) return { ok: false, error: 'busy' };
    appUpdateState.busy = true;
    try {
      const cfg = getConfig();
      const latest = await updater.fetchLatestRelease(cfg.appRepo);
      if (!updater.isNewer(latest.version, app.getVersion())) return { ok: true, updated: false, alreadyLatest: true, version: app.getVersion(), remote: latest.version };
      const portable = !!process.env.PORTABLE_EXECUTABLE_DIR;
      const asset = updater.getAppUpdateAsset(latest, portable);
      if (!asset?.browser_download_url) {
        const names = (latest.assets || []).map((a) => a?.name).filter(Boolean);
        const detail = names.length ? ` Найдены: ${names.join(', ')}` : ' GitHub не вернул ассеты.';
        return { ok: false, error: `В релизе не найден подходящий EXE для ${portable ? 'portable' : 'установщика'}.${detail}` };
      }
      send('evt:update-progress', { percent: 0, stage: 'Загрузка обновления приложения…' });
      const exe = await updater.downloadAsset(asset.browser_download_url, asset.name, (percent) => send('evt:update-progress', { percent, stage: 'Загрузка обновления приложения…' }), asset.digest || null);
      if (portable) {
        const current = process.execPath;
        const launcher = path.join(os.tmpdir(), `zapret-launcher-self-update-${Date.now()}.cmd`);
        const script = [
          '@echo off',
          'setlocal',
          'timeout /t 2 /nobreak >nul',
          `copy /y "${exe.replace(/"/g, '""')}" "${current.replace(/"/g, '""')}" >nul`,
          `start "" "${current.replace(/"/g, '""')}"`,
          `del /q "${exe.replace(/"/g, '""')}" >nul 2>&1`,
          `del /q "%~f0" >nul 2>&1`
        ].join('\r\n');
        fs.writeFileSync(launcher, script, 'utf8');
        spawn('cmd.exe', ['/d', '/c', launcher], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
      } else {
        spawn(exe, [], { detached: true, windowsHide: false, stdio: 'ignore' }).unref();
      }
      setTimeout(() => app.quit(), 250);
      return { ok: true, version: latest.version, mode: portable ? 'portable' : 'setup' };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    } finally {
      appUpdateState.busy = false;
      send('evt:update-progress', { percent: -1, stage: '' });
    }
  });

  // ---------- tg-ws-proxy ----------
  ipcMain.handle('tg:status', () => getTgManager().status());
  ipcMain.handle('tg:toggle', () => getTgManager().toggle());
  ipcMain.handle('tg:start', () => getTgManager().start());
  ipcMain.handle('tg:stop', () => getTgManager().stop());
  ipcMain.handle('tg:check', () => getTgManager().checkUpdate().then((info) => { send('evt:tg-update', info); return info; }));
  ipcMain.handle('tg:install', () => getTgManager().installLatest((p) => send('evt:tg-progress', p)));
  ipcMain.handle('tg:getConfig', () => getTgManager().getConfig());
  ipcMain.handle('tg:setConfig', (_e, patch) => getTgManager().setConfig(patch));
  ipcMain.handle('tg:openFolder', async () => { await shell.openPath(getTgManager().openFolder()); return true; });

  // ---------- сервис / статус ----------
  ipcMain.handle('service:status', async () => service.getServiceStatus(getConfig().batsDir));
  ipcMain.handle('service:install', async (_e, batName) => service.installService(getConfig().batsDir, batName));
  ipcMain.handle('service:remove', async () => service.removeServices());

  // ---------- фильтры ----------
  ipcMain.handle('filter:gameGet', () => service.getGameFilter(getConfig().batsDir));
  ipcMain.handle('filter:gameSet', (_e, payload) => service.setGameFilter(getConfig().batsDir, payload));
  ipcMain.handle('filter:ipsetGet', () => service.getIpset(getConfig().batsDir));
  ipcMain.handle('filter:ipsetSet', (_e, mode) => service.setIpsetMode(getConfig().batsDir, mode));
  ipcMain.handle('filter:ipsetUpdate', () => service.updateIpsetList(getConfig().batsDir, getConfig().repo));

  // ---------- фэйки ----------
  ipcMain.handle('fakes:get', () => service.getFakes(getConfig().batsDir));
  ipcMain.handle('fakes:replace', (_e, { type, file }) => service.replaceFake(getConfig().batsDir, type, file));

  // ---------- hosts ----------
  ipcMain.handle('hosts:check', () => service.checkHosts(getConfig().repo));
  ipcMain.handle('hosts:update', () => service.updateHosts(getConfig().repo));

  // ---------- диагностика и инструменты ----------
  ipcMain.handle('diag:run', () => diag.runDiagnostics(getConfig().batsDir));
  ipcMain.handle('diag:runnerLog', () => {
    try {
      const f = path.join(app.getPath('userData'), 'runner.log');
      return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).slice(-40);
    } catch {
      return [];
    }
  });
  ipcMain.handle('diag:fixWindivert', () => diag.fixWinDivert());
  ipcMain.handle('diag:fixConflicts', (_e, names) => service.removeConflictingServices(names));
  ipcMain.handle('diag:clearDiscord', () => service.clearDiscordCache());
  ipcMain.handle('tools:runTests', () => service.runTests(getConfig().batsDir));

  // ---------- прочее ----------
  ipcMain.handle('sys:info', async () => ({
    elevated: await isAdmin(),
    version: app.getVersion(),
    build: 'm1.4.6',
    platform: process.platform
  }));
}

export function initAfterReady() {
  setupWatcher();
}


export async function initProxyAfterReady() {
  try {
    const ps = proxy.getSettings();
    saveConfig({ proxyMode: ps.mode, proxySystem: ps.systemProxy, proxySocksPort: ps.socksPort, proxyHttpPort: ps.httpPort, proxyRoute: ps.routeProfile });
    notifyProxy();
    if (proxyRefreshTimer) clearInterval(proxyRefreshTimer);
    if (ps.subscriptionAutoUpdate !== false) {
      const hours = Math.max(1, Number(ps.subscriptionUpdateIntervalHours || ps.subscriptionIntervalHours || 6));
      proxyRefreshTimer = setInterval(() => proxy.refreshAllSubscriptions().catch(() => {}), hours * 3600 * 1000);
      proxy.refreshAllSubscriptions().catch(() => {});
    }
    if (ps.subscriptionPingOnOpen && proxy.getServers().length) proxy.pingAll().catch(() => {});
    // Автоподключение не включается по умолчанию; пользователь управляет VPN кликом по плитке.
    if (ps.subscriptionAutoconnect && ps.subscriptionAutoconnect !== 'off' && !proxy.status().running && proxy.getServers().length) {
      const list=proxy.getServers().filter(s=>!s.error);
      let target=null;
      if(ps.subscriptionAutoconnect==='lastused') target=list.find(s=>s.id===ps.activeServerId);
      if(ps.subscriptionAutoconnect==='lowestdelay') target=list.filter(s=>s.latency!=null).sort((a,b)=>a.latency-b.latency)[0]||list[0];
      if(ps.subscriptionAutoconnect==='random') target=list[Math.floor(Math.random()*list.length)];
      if(target){ proxy.selectServer(target.id); await proxy.start({mode:ps.mode}); }
    }
  } catch (e) { console.warn('[proxy-init]', e?.message || e); }
}
