// ============================================================
// Чистые функции без зависимостей от Electron/Node-API.
// Легко тестируются (см. tests/unit.test.js)
// ============================================================

/** "Естественная" сортировка имён: "2. x.bat" < "10. y.bat" */
export function naturalCompare(a, b) {
  const ax = String(a).split(/(\d+)/);
  const bx = String(b).split(/(\d+)/);
  const len = Math.max(ax.length, bx.length);
  for (let i = 0; i < len; i++) {
    const s1 = ax[i] ?? '';
    const s2 = bx[i] ?? '';
    const n1 = /^\d+$/.test(s1);
    const n2 = /^\d+$/.test(s2);
    if (n1 && n2) {
      const d = Number(s1) - Number(s2);
      if (d !== 0) return d;
      if (s1.length !== s2.length) return s1.length - s2.length;
    } else {
      const c = s1.localeCompare(s2, 'ru');
      if (c !== 0) return c;
    }
  }
  return 0;
}

/** Сравнение версий вида 1.10.3 -> -1 | 0 | 1 */
export function compareVersions(a, b) {
  const pa = String(a ?? '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b ?? '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Есть ли более новая версия */
export function isNewer(remote, local) {
  if (!local) return true;
  if (!remote) return false;
  return compareVersions(remote, local) > 0;
}

/** "1. Discord & YouTube.bat" -> "Discord & YouTube" */
export function cleanLabel(fileName) {
  let s = String(fileName).replace(/\.(bat|cmd)$/i, '');
  s = s.replace(/^\s*\d+\s*[.)\-_:]\s*/, '');
  return s.trim() || fileName;
}

/** Достать LOCAL_VERSION из текста service.bat */
export function parseLocalVersion(text) {
  const m = /set\s+"?LOCAL_VERSION=([^"\r\n]+)"?/i.exec(String(text ?? ''));
  return m ? m[1].trim() : null;
}

/**
 * Валидация диапазонов портов как в service.bat (:validate_game_filter_range).
 * Примеры: "1024-65535", "1024-1934,1936-65535", "443".
 * Возвращает нормализованную строку или null.
 */
export function validatePortRange(input) {
  let s = String(input ?? '').replace(/\s+/g, '');
  if (!s) return null;
  const items = s.split(',');
  for (const raw of items) {
    const item = raw.trim();
    if (!/^\d+(-\d+)?$/.test(item)) return null;
    const [a, b] = item.split('-').map((x) => parseInt(x, 10));
    const start = a;
    const end = b === undefined || Number.isNaN(b) ? a : b;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start < 1 || end > 65535 || start > end) return null;
  }
  return s;
}

/**
 * Разбор utils/game_filter.enabled (порт :game_switch_status из service.bat)
 * Формат файла: mode=all / tcp=... / udp=... (или голые ключи all/tcp/udp)
 */
export function parseGameFilterText(text) {
  let mode = 'disabled';
  let tcp = null;
  let udp = null;

  if (text) {
    for (const line of String(text).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      const key = (eq === -1 ? trimmed : trimmed.slice(0, eq)).toLowerCase();
      const value = eq === -1 ? '' : trimmed.slice(eq + 1).trim();
      if (key === 'mode') { if (value) mode = value.toLowerCase(); }
      else if (key === 'all') { if (!value) mode = 'all'; }
      else if (key === 'tcp') { if (!value) mode = 'tcp'; else tcp = value; }
      else if (key === 'udp') { if (!value) mode = 'udp'; else udp = value; }
    }
  }

  const def = '1024-65535';
  const tcpRange = validatePortRange(tcp) ?? def;
  const udpRange = validatePortRange(udp) ?? def;

  let status;
  if (mode === 'all') status = 'включён (TCP и UDP)';
  else if (mode === 'tcp') status = 'включён (TCP)';
  else if (mode === 'udp') status = 'включён (UDP)';
  else { mode = 'disabled'; status = 'выключен'; }

  return {
    mode,
    tcp: mode === 'udp' ? def : tcpRange,
    udp: mode === 'tcp' ? def : udpRange,
    status,
    enabled: mode !== 'disabled'
  };
}

/**
 * Статус IPSet-фильтра по содержимому lists/ipset-all.txt
 * (порт :ipset_switch_status из service.bat)
 */
export function ipsetStatusFromContent(content) {
  if (content == null) return 'any';
  if (String(content).trim() === '') return 'any';
  if (String(content).includes('203.0.113.113/32')) return 'none';
  return 'loaded';
}

/**
 * Нуждается ли hosts-файл в обновлении (порт :hosts_update):
 * сравниваются первая и последняя строки файла из репозитория.
 */
export function hostsNeedsUpdate(localText, remoteText) {
  if (!localText || !remoteText) return true;
  const lines = String(remoteText).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return false;
  const first = lines[0];
  const last = lines[lines.length - 1];
  const local = String(localText);
  return !(local.includes(first) && local.includes(last));
}

/** Имя bat-файла, который нужно исключить из плиток (служебные) */
export function isServiceBat(fileName) {
  return /^service/i.test(String(fileName));
}

/** Из repo "owner/name" + tag собрать вероятный URL ассета zip (fallback) */
export function guessAssetUrl(repo, tag) {
  const name = String(repo).split('/').pop();
  return `https://github.com/${repo}/releases/download/${tag}/${name}-${tag}.zip`;
}

/** Нормализовать HEX-цвет для сохранения в настройках. */
export function normalizeHexColor(value, fallback = '#000000') {
  const raw = String(value ?? '').trim();
  const m = /^#?([0-9a-f]{6})$/i.exec(raw);
  return m ? `#${m[1].toLowerCase()}` : fallback;
}

/** HEX -> RGB-компоненты для CSS rgba/var. */
export function hexToRgb(value, fallback = '#000000') {
  const hex = normalizeHexColor(value, fallback).slice(1);
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  };
}

/** Разделить батники на избранные и обычные, без дубликатов. */
export function splitFavoriteBats(bats, favorites) {
  const favSet = favorites instanceof Set ? favorites : new Set(favorites || []);
  const favs = [];
  const regular = [];
  for (const bat of Array.isArray(bats) ? bats : []) {
    (favSet.has(bat?.name) ? favs : regular).push(bat);
  }
  return { favs, regular };
}
