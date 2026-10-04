import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import {
  parseGameFilterText, validatePortRange, ipsetStatusFromContent, hostsNeedsUpdate
} from './lib/pure.js';
import {
  sh, shCmd, spawnVisible, isAdmin, serviceState, isProcessRunning,
  readStrategyFromRegistry, listRunningServicesText, isWindows
} from './util.js';
import { findServiceBat } from './scanner.js';

// ------------------------------------------------------------------
// Полный перенос функций service.bat в приложение (требование 1)
// ------------------------------------------------------------------

const IPSET_PLACEHOLDER = '203.0.113.113/32';
const rawUrl = (repo, file) =>
  `https://raw.githubusercontent.com/${repo}/refs/heads/main/.service/${file}`;

const p = (dir, ...parts) => path.join(dir, ...parts);
const HOSTS_USER_AGENT = 'Zapret-Launcher/1.3.3';

function requestRemoteTextHttps(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Слишком много перенаправлений'));
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error(`Некорректный URL: ${url}`)); }
    if (parsed.protocol !== 'https:') return reject(new Error(`Неподдерживаемый протокол: ${parsed.protocol}`));
    const req = https.get(parsed, {
      family: 4, timeout: 20000,
      headers: { 'User-Agent': HOSTS_USER_AGENT, Accept: 'text/plain, */*', 'Cache-Control': 'no-cache' }
    }, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        return requestRemoteTextHttps(new URL(res.headers.location, parsed).toString(), redirects + 1).then(resolve, reject);
      }
      const chunks = [];
      res.setEncoding('utf8');
      res.on('data', (x) => chunks.push(x));
      res.on('end', () => {
        const body = chunks.join('');
        if (code < 200 || code >= 300) return reject(new Error(`HTTP ${code}${body ? `: ${body.replace(/\s+/g, ' ').trim().slice(0, 180)}` : ''}`));
        resolve(body);
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Таймаут соединения с GitHub')));
    req.on('error', reject);
  });
}

async function requestRemoteText(url) {
  try {
    const body = await requestRemoteTextHttps(url);
    if (!String(body).trim()) throw new Error('GitHub вернул пустой hosts-файл');
    return body;
  } catch (httpsErr) {
    const r = await sh('curl.exe', [
      '-4', '-L', '--fail', '--silent', '--show-error', '--ssl-no-revoke',
      '--connect-timeout', '15', '--max-time', '45', '-A', HOSTS_USER_AGENT, url
    ], { timeout: 55000 });
    if (r.code === 0 && String(r.stdout || '').trim()) return r.stdout;
    const detail = String(r.stderr || r.out || '').trim();
    throw new Error(detail || httpsErr?.message || 'Не удалось получить hosts-файл из GitHub');
  }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

// ---------------- СТАТУС (пункт 3 меню service.bat) ----------------

export async function getServiceStatus(batsDir) {
  const [zapret, windivert, winws, strategy, elevated] = await Promise.all([
    serviceState('zapret'),
    serviceState('WinDivert'),
    isProcessRunning('winws.exe'),
    readStrategyFromRegistry(),
    isAdmin()
  ]);
  let sysDriver = false;
  try {
    sysDriver = fs.readdirSync(p(batsDir, 'bin')).some((n) => /\.sys$/i.test(n));
  } catch {}
  return {
    zapret: zapret ?? 'NOT INSTALLED',
    windivert: windivert ?? 'NOT INSTALLED',
    winws,
    strategy,
    sysDriver,
    elevated
  };
}

// ---------------- TCP TIMESTAMPS (:tcp_enable) ----------------

export async function ensureTcpTimestamps() {
  if (!isWindows) return false;
  const check = await shCmd('netsh interface tcp show global');
  if (/timestamps/i.test(check.out) && /enabled/i.test(check.out)) return true;
  const set = await shCmd('netsh interface tcp set global timestamps=enabled');
  return set.code === 0;
}

// ---------------- УСТАНОВКА/УДАЛЕНИЕ СЕРВИСА (пункты 1-2 меню) ----------------

/** Установить сервис zapret с выбранной стратегией (через service.bat install_gui) */
export async function installService(batsDir, batFileName) {
  const serviceBat = findServiceBat(batsDir);
  if (!serviceBat) return { ok: false, error: 'service.bat не найден в папке' };
  const batPath = p(batsDir, batFileName);
  if (!fs.existsSync(batPath)) return { ok: false, error: 'Файл стратегии не найден' };
  await ensureTcpTimestamps();
  const safeService = serviceBat.replace(/'/g, "''");
  const safeBat = batPath.replace(/'/g, "''");
  const r = await sh('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-Command', `& '${safeService}' install_gui '${safeBat}'; exit $LASTEXITCODE`
  ], { cwd: batsDir, timeout: 90000 });
  return { ok: r.code === 0, code: r.code, out: r.out.slice(-1500) };
}

/** Удалить сервисы zapret / WinDivert / WinDivert14 и убить winws (пункт 2 меню) */
export async function removeServices() {
  const log = [];
  const run = async (cmdLine) => {
    const r = await shCmd(cmdLine, { timeout: 30000 });
    log.push(`${cmdLine} -> ${r.code}`);
    return r;
  };
  if ((await serviceState('zapret'))) await run('net stop zapret');
  await run('sc delete zapret');
  if (await isProcessRunning('winws.exe')) await run('taskkill /IM winws.exe /F');
  if ((await serviceState('WinDivert'))) await run('net stop WinDivert');
  await run('sc delete WinDivert');
  await run('net stop WinDivert14');
  await run('sc delete WinDivert14');
  return { ok: true, log };
}

// ---------------- GAME FILTER (пункт 4 меню) ----------------

export function getGameFilter(batsDir) {
  const file = p(batsDir, 'utils', 'game_filter.enabled');
  return parseGameFilterText(readText(file));
}

export function setGameFilter(batsDir, { mode, tcp, udp }) {
  const tcpV = validatePortRange(tcp);
  const udpV = validatePortRange(udp);
  if (!tcpV || !udpV) return { ok: false, error: 'Некорректный диапазон портов' };
  const file = p(batsDir, 'utils', 'game_filter.enabled');
  if (mode === 'disabled') {
    try { fs.rmSync(file, { force: true }); } catch {}
    return { ok: true };
  }
  writeText(file, `mode=${mode}\ntcp=${tcpV}\nudp=${udpV}\n`);
  return { ok: true };
}

// ---------------- IPSET FILTER (пункт 5 меню) ----------------

export function getIpset(batsDir) {
  const file = p(batsDir, 'lists', 'ipset-all.txt');
  return { status: ipsetStatusFromContent(readText(file)), backupExists: fs.existsSync(`${file}.backup`) };
}

export function setIpsetMode(batsDir, target) {
  const file = p(batsDir, 'lists', 'ipset-all.txt');
  const backup = `${file}.backup`;
  const current = getIpset(batsDir).status;
  try {
    if (target === 'none') {
      if (current !== 'none') {
        if (!fs.existsSync(backup)) fs.renameSync(file, backup);
        else { fs.rmSync(backup, { force: true }); fs.renameSync(file, backup); }
      }
      writeText(file, `${IPSET_PLACEHOLDER}\n`);
    } else if (target === 'any') {
      writeText(file, '');
    } else if (target === 'loaded') {
      if (!fs.existsSync(backup)) return { ok: false, error: 'Нет резервной копии списка. Сначала обновите список (пункт «Обновить IPSet список»)' };
      fs.rmSync(file, { force: true });
      fs.renameSync(backup, file);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/** Обновить lists/ipset-all.txt из репозитория (пункт 8 меню) */
export async function updateIpsetList(batsDir, repo) {
  try {
    const res = await fetch(rawUrl(repo, 'ipset-service.txt'), {
      headers: { 'User-Agent': 'zapret-launcher', 'Cache-Control': 'no-cache' }
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    writeText(p(batsDir, 'lists', 'ipset-all.txt'), await res.text());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

// ---------------- АВТОПРОВЕРКА ОБНОВЛЕНИЙ (пункт 6 меню) ----------------

export function getCheckUpdatesFlag(batsDir) {
  return fs.existsSync(p(batsDir, 'utils', 'check_updates.enabled'));
}

export function setCheckUpdatesFlag(batsDir, enabled) {
  const file = p(batsDir, 'utils', 'check_updates.enabled');
  if (enabled) writeText(file, 'ENABLED\n');
  else fs.rmSync(file, { force: true });
}

// ---------------- ПОДМЕНА ФЭЙКОВ (пункт 7 меню) ----------------

export function getFakes(batsDir) {
  const bin = p(batsDir, 'bin');
  const result = { files: [], currentDiscord: '(не найден)', currentGame: '(не найден)', error: null };
  let entries;
  try {
    entries = fs.readdirSync(bin).filter((n) => /\.bin$/i.test(n));
  } catch {
    result.error = 'Папка bin не найдена';
    return result;
  }
  const hashes = new Map();
  for (const f of entries) {
    try {
      const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(bin, f))).digest('hex');
      hashes.set(f, h);
    } catch {}
  }
  const discordHash = hashes.get('ACTIVE_DISCORD_UDP.bin');
  const gameHash = hashes.get('ACTIVE_GAME_UDP.bin');
  for (const [f, h] of hashes) {
    if (f === 'ACTIVE_DISCORD_UDP.bin' || f === 'ACTIVE_GAME_UDP.bin') continue;
    result.files.push({ name: f.replace(/\.bin$/i, ''), file: f, hash: h });
    if (discordHash && h === discordHash) result.currentDiscord = f.replace(/\.bin$/i, '');
    if (gameHash && h === gameHash) result.currentGame = f.replace(/\.bin$/i, '');
  }
  result.files.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return result;
}

export function replaceFake(batsDir, type, fileName) {
  const bin = p(batsDir, 'bin');
  const active = type === 'discord' ? 'ACTIVE_DISCORD_UDP.bin' : 'ACTIVE_GAME_UDP.bin';
  const src = path.join(bin, fileName);
  const dst = path.join(bin, active);
  if (!fs.existsSync(src)) return { ok: false, error: 'Файл фэйка не найден' };
  try {
    fs.rmSync(dst, { force: true });
    fs.copyFileSync(src, dst);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

// ---------------- HOSTS (пункт 9 меню) ----------------

export function systemHostsPath() {
  return p(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
}

export async function checkHosts(repo) {
  const url = `${rawUrl(repo, 'hosts')}?t=${Date.now()}`;
  try {
    const remote = await requestRemoteText(url);
    const local = readText(systemHostsPath());
    const current = hostsNeedsUpdate(local, remote);
    return {
      ok: true,
      needsUpdate: current,
      status: current ? 'needs-update' : 'current',
      statusLabel: current ? 'требуется обновление' : 'актуален',
      remote
    };
  } catch (err) {
    return { ok: false, status: 'error', statusLabel: 'ошибка сети', error: String(err?.message ?? err) };
  }
}

/** Обновить hosts автоматически с резервной копией (требуются права админа) */
export async function updateHosts(repo) {
  const chk = await checkHosts(repo);
  if (!chk.ok) return chk;
  if (!chk.needsUpdate) return { ok: true, updated: false };
  const hosts = systemHostsPath();
  try {
    const backup = `${hosts}.zapret-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    if (fs.existsSync(hosts)) fs.copyFileSync(hosts, backup);
    fs.writeFileSync(hosts, chk.remote, 'utf8');
    return { ok: true, updated: true, backup };
  } catch (err) {
    return { ok: false, error: `Не удалось записать hosts (нужны права администратора): ${err?.message ?? err}` };
  }
}

// ---------------- ТЕСТЫ (пункт 12 меню) ----------------

export function runTests(batsDir) {
  const ps1 = p(batsDir, 'utils', 'test zapret.ps1');
  if (!fs.existsSync(ps1)) return { ok: false, error: 'utils/test zapret.ps1 не найден' };
  const ok = spawnVisible('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1
  ], { cwd: batsDir });
  return { ok };
}

// ---------------- КОНФЛИКТЫ (используется диагностикой) ----------------

/** Остановить и удалить конфликтующие сервисы (+ WinDivert/WinDivert14) */
export async function removeConflictingServices(names) {
  const log = [];
  for (const name of names ?? []) {
    await shCmd(`net stop ${name}`, { timeout: 20000 });
    const r = await shCmd(`sc delete ${name}`, { timeout: 20000 });
    log.push(`${name}: ${r.code === 0 ? 'удалён' : 'ошибка'}`);
  }
  for (const name of ['WinDivert', 'WinDivert14']) {
    await shCmd(`net stop ${name}`, { timeout: 20000 });
    await shCmd(`sc delete ${name}`, { timeout: 20000 });
  }
  return { ok: true, log };
}

/** Очистка кэша Discord (как :clear_discord_cache в service.bat) */
export async function clearDiscordCache() {
  const log = [];
  const variants = [
    ['Discord.exe', 'discord'],
    ['DiscordPTB.exe', 'discordptb'],
    ['DiscordCanary.exe', 'discordcanary'],
    ['DiscordDevelopment.exe', 'discorddevelopment']
  ];
  let found = false;
  for (const [proc, dir] of variants) {
    const base = p(process.env.APPDATA ?? '', dir);
    if (!fs.existsSync(base)) continue;
    found = true;
    if (await isProcessRunning(proc)) {
      await shCmd(`taskkill /IM ${proc} /F`, { timeout: 20000 });
      log.push(`${dir}: процесс закрыт`);
    }
    for (const sub of ['Cache', 'Code Cache', 'GPUCache']) {
      const d = p(base, sub);
      try {
        fs.rmSync(d, { recursive: true, force: true });
        log.push(`${dir}/${sub}: удалено`);
      } catch {
        log.push(`${dir}/${sub}: ошибка удаления`);
      }
    }
  }
  if (!found) log.push('Установки Discord не найдены');
  return { ok: true, log };
}

/** Текст всех запущенных сервисов + поиск по подстроке (порт `sc query | findstr`) */
export async function findServicesByPattern(pattern) {
  const text = await listRunningServicesText();
  const found = [];
  const re = new RegExp(`SERVICE_NAME:\\s*(.+${pattern}.+)`, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) found.push(m[1].trim());
  return { text, found };
}
