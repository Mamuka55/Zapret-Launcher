import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  batsDir: '',
  repo: 'Flowseal/zapret-discord-youtube',
  autoCheckUpdates: true,
  autoInstallUpdates: false,
  favorites: [],
  closeScriptsOnExit: true,
  launchAtStartup: false,
  onboardSeen: false,
  appRepo: 'Mamuka55/Zapret-Launcher',
  appAutoCheckUpdates: true,
  tgRepo: 'Flowseal/tg-ws-proxy',
  tgDir: '',
  tgAutoCheckUpdates: true,
  tgAutoStart: false,
  accentColor: '#ff2e4c',
  backgroundColor: '#14161b',
  proxyEnabled: false,
  proxyMode: 'proxy',
  proxySystem: true,
  proxySocksPort: 10808,
  proxyHttpPort: 10809,
  proxyRoute: 'Global',
  proxyAutoConnect: false,
  proxyAutoRefreshHours: 6
};

let cache = null;

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function defaultZapretDir() {
  return path.join(app.getPath('documents'), 'Zapret Launcher', 'zapret');
}

function defaultTgDir() {
  return path.join(app.getPath('documents'), 'Zapret Launcher', 'tg-ws-proxy');
}

function samePath(a, b) {
  return path.resolve(String(a || '')).toLowerCase() === path.resolve(String(b || '')).toLowerCase();
}

function migrateLegacyZapretDir() {
  const oldDir = path.join(app.getPath('documents'), 'zapret');
  const newDir = defaultZapretDir();
  if (!fs.existsSync(oldDir) || fs.existsSync(newDir)) return;
  try {
    const names = fs.readdirSync(oldDir);
    const looksLikeZapret = names.some((n) => /^service.*\.(bat|cmd)$/i.test(n)) || names.some((n) => /\.(bat|cmd)$/i.test(n));
    if (!looksLikeZapret) return;
    fs.mkdirSync(path.dirname(newDir), { recursive: true });
    fs.renameSync(oldDir, newDir);
  } catch (err) {
    console.warn('Legacy Zapret migration skipped:', err?.message || err);
  }
}

function normalizeConfig(cfg) {
  const out = { ...DEFAULTS, ...(cfg || {}) };
  out.favorites = Array.isArray(out.favorites) ? [...new Set(out.favorites.map(String))] : [];
  const defaultZapret = defaultZapretDir();
  const legacyZapret = path.join(app.getPath('documents'), 'zapret');
  if (!out.batsDir || samePath(out.batsDir, legacyZapret)) out.batsDir = defaultZapret;
  out.tgDir = String(out.tgDir || defaultTgDir());
  return out;
}

export function getConfig() {
  if (cache) return cache;
  migrateLegacyZapretDir();
  try {
    cache = normalizeConfig(JSON.parse(fs.readFileSync(file(), 'utf8')));
  } catch {
    cache = normalizeConfig({});
  }
  return cache;
}

export function saveConfig(patch = {}) {
  const cfg = normalizeConfig({ ...getConfig(), ...(patch || {}) });
  cache = cfg;
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    console.error('saveConfig failed:', err);
  }
  return cfg;
}

export function toggleFavorite(name) {
  const cfg = getConfig();
  const favs = new Set(cfg.favorites ?? []);
  if (favs.has(name)) favs.delete(name);
  else favs.add(name);
  return saveConfig({ favorites: [...favs] }).favorites;
}

export function defaultTgProxyDir() { return defaultTgDir(); }

export function appRoot() {
  return app.getAppPath();
}
