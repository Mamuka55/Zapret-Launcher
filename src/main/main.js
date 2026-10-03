import { app, BrowserWindow, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { registerIpc, setWindow, initAfterReady } from './ipc.js';
import { runner } from './runner.js';
import { getConfig, saveConfig } from './config.js';
import { TgProxyManager } from './tgProxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SMOKE = process.argv.includes('--smoke');
const BUILD = 'm1.3.3';
let tgProxyProcess = null;

// имя приложения для диспетчера задач и панели задач Windows
app.setName('Zapret Launcher');

// -------- глобальный лок: только ОДНО окно лаунчера на всю систему --------
// (два окна из разных папок дают «фантомные» зелёные плитки и общий лог)
function acquireSingleInstanceLock() {
  const lockFile = path.join(app.getPath('userData'), 'instance.lock');
  const write = () => {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  };
  const alive = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  try {
    write();
    return true;
  } catch {
    let pid = 0;
    try { pid = parseInt(fs.readFileSync(lockFile, 'utf8'), 10) || 0; } catch {}
    if (pid && pid !== process.pid && alive(pid)) return false; // живой инстанс
    try { fs.rmSync(lockFile, { force: true }); } catch {}       // stale-лок
    try { write(); return true; } catch { return false; }
  }
}

// Только один экземпляр приложения
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 880,
    minHeight: 560,
    frame: false,              // без системной рамки и кнопок Windows
    transparent: true,         // скруглённые углы окна
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    autoHideMenuBar: true,
    title: 'Zapret Launcher',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // smoke-режим для автотестов: проверяем структуру окна и плитки, затем выходим
  if (SMOKE) {
    win.webContents.once('did-finish-load', async () => {
      try {
        await new Promise((r) => setTimeout(r, 500));
        const res = await win.webContents.executeJavaScript(`(() => {
          const q = (s) => !!document.querySelector(s);
          return {
            window: q('#window'),
            titlebar: q('#titlebar'),
            settings: q('#btnSettings'),
            minimize: q('#btnMin'),
            close: q('#btnClose'),
            tiles: document.querySelectorAll('#batsGrid .tile').length,
            favStar: q('#batsGrid .tile .star')
          };
        })()`);
        console.log('[smoke]', JSON.stringify(res));
        const ok = res.window && res.titlebar && res.settings && res.minimize && res.close && res.tiles >= 3 && res.favStar;
        app.exit(ok ? 0 : 1);
      } catch (err) {
        console.error('[smoke] error:', err);
        app.exit(1);
      }
    });
  }

  // ссылки — во внешний браузер
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      import('electron').then(({ shell }) => shell.openExternal(url));
    }
    return { action: 'deny' };
  });

  setWindow(win);
  return win;
}

app.whenReady().then(() => {
  try { app.setAppUserModelId('Zapret Launcher'); } catch {}
  // файл лога раннера: userData/runner.log
  try { process.env.ZL_LOG = path.join(app.getPath('userData'), 'runner.log'); } catch {}
  // только одно окно: иначе старое окно рисует фантомные статусы
  if (!SMOKE && !acquireSingleInstanceLock()) {
    dialog.showMessageBoxSync({
      type: 'warning',
      title: 'Zapret Launcher',
      message: 'Zapret Launcher уже запущен в другом окне.',
      detail: 'Закройте другое окно лаунчера (или снимите задачу в диспетчере задач) и попробуйте снова.'
    });
    app.exit(0);
    return;
  }
  if (SMOKE) {
    // smoke-режим: генерируем временные тестовые батники и не дёргаем сеть
    const dir = path.join(os.tmpdir(), 'zapret-smoke-bats');
    fs.mkdirSync(dir, { recursive: true });
    for (const b of ['1. Discord & YouTube.bat', '2. Discord.bat', '3. YouTube.bat']) {
      fs.writeFileSync(path.join(dir, b), '@echo off\r\nping -n 20 127.0.0.1 >nul\r\n');
    }
    fs.writeFileSync(path.join(dir, 'service.bat'), '@echo off\r\nset "LOCAL_VERSION=1.10.3"\r\n');
    saveConfig({ batsDir: dir, autoCheckUpdates: false });
  }
  registerIpc();
  initAfterReady();
  createWindow();
  const cfg = getConfig();
  if (cfg.tgAutoStart) {
    try {
      tgProxyProcess = new TgProxyManager({ repo: cfg.tgRepo, dir: cfg.tgDir });
      tgProxyProcess.start().catch(() => {});
    } catch {}
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  try { fs.rmSync(path.join(app.getPath('userData'), 'instance.lock'), { force: true }); } catch {}
});

// Закрываем запущенные батники вместе с приложением (настройка closeScriptsOnExit)
app.on('before-quit', () => {
  if (getConfig().closeScriptsOnExit !== false) runner.stopAllSync();
  if (getConfig().tgAutoStart && tgProxyProcess) {
    try { tgProxyProcess.stop(); } catch {}
  }
});
