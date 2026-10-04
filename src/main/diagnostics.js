import fs from 'node:fs';
import path from 'node:path';
import {
  sh, shCmd, serviceState, isProcessRunning, isWindows
} from './util.js';
import { systemHostsPath, findServicesByPattern } from './service.js';

// ------------------------------------------------------------------
// Диагностика — порт :service_diagnostics из service.bat (пункт 11 меню)
// Каждый чек возвращает { id, title, level: 'pass'|'warn'|'fail'|'info', lines: string[], link? }
// ------------------------------------------------------------------

const R = (title, level, lines, link) => ({ id: slug(title), title, level, lines: lines ?? [], link });
const slug = (s) => String(s).toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-');

async function checkPath(batsDir) {
  return R('Путь установки', 'info', [`Zapret установлен в: ${batsDir || '(папка не выбрана)'}`]);
}

async function checkBFE() {
  const st = await serviceState('BFE');
  return st === 'RUNNING'
    ? R('Base Filtering Engine', 'pass', ['Служба BFE запущена'])
    : R('Base Filtering Engine', 'fail', ['Служба BFE не запущена — она обязательна для работы zapret']);
}

async function checkProxy() {
  const r = await sh('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable'], { timeout: 8000 });
  const m = /ProxyEnable\s+REG_DWORD\s+(0x[0-9a-f]+)/i.exec(r.out);
  if (m && m[1].toLowerCase() === '0x1') {
    const r2 = await sh('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'], { timeout: 8000 });
    const m2 = /ProxyServer\s+REG_SZ\s+(.+)\r?$/im.exec(r2.out);
    return R('Системный прокси', 'warn', [
      `Системный прокси включён: ${m2 ? m2[1].trim() : '(сервер не указан)'}`,
      'Убедитесь, что он корректен, или отключите, если не используете прокси'
    ]);
  }
  return R('Системный прокси', 'pass', ['Прокси выключен']);
}

async function checkTcpTimestamps() {
  if (!isWindows) return R('TCP timestamps', 'info', ['Проверка доступна только на Windows']);
  const check = await shCmd('netsh interface tcp show global');
  if (/timestamps/i.test(check.out) && /enabled/i.test(check.out)) {
    return R('TCP timestamps', 'pass', ['TCP timestamps включены']);
  }
  const set = await shCmd('netsh interface tcp set global timestamps=enabled');
  return set.code === 0
    ? R('TCP timestamps', 'warn', ['TCP timestamps были выключены — включены автоматически'])
    : R('TCP timestamps', 'fail', ['Не удалось включить TCP timestamps']);
}

async function checkAdguard() {
  return (await isProcessRunning('AdguardSvc.exe'))
    ? R('Adguard', 'fail', ['Найден процесс Adguard — он может ломать Discord'], 'https://github.com/Flowseal/zapret-discord-youtube/issues/417')
    : R('Adguard', 'pass', ['Adguard не обнаружен']);
}

async function checkKiller() {
  const { found } = await findServicesByPattern('Killer');
  return found.length
    ? R('Killer', 'fail', ['Найдены сервисы Killer — они конфликтуют с zapret'], 'https://github.com/Flowseal/zapret-discord-youtube/issues/2512#issuecomment-2821119513')
    : R('Killer', 'pass', ['Сервисы Killer не найдены']);
}

async function checkIntelConnectivity() {
  const { text } = await findServicesByPattern('');
  const bad = /intel[^\n]*connectivity[^\n]*network/i.test(text);
  return bad
    ? R('Intel Connectivity Network Service', 'fail', ['Найден конфликтующий сервис Intel Connectivity'], 'https://github.com/ValdikSS/GoodbyeDPI/issues/541#issuecomment-2661670952')
    : R('Intel Connectivity Network Service', 'pass', ['Конфликтующих сервисов Intel не найдено']);
}

async function checkCheckPoint() {
  const a = await findServicesByPattern('TracSrvWrapper');
  const b = await findServicesByPattern('EPWD');
  return (a.found.length || b.found.length)
    ? R('Check Point', 'fail', ['Найдены сервисы Check Point — они конфликтуют с zapret. Попробуйте удалить Check Point'])
    : R('Check Point', 'pass', ['Сервисы Check Point не найдены']);
}

async function checkSmartByte() {
  const { found } = await findServicesByPattern('SmartByte');
  return found.length
    ? R('SmartByte', 'fail', ['Найдены сервисы SmartByte — отключите их через services.msc'])
    : R('SmartByte', 'pass', ['Сервисы SmartByte не найдены']);
}

async function checkCyrillicPath(batsDir) {
  return /[а-яА-ЯёЁ]/.test(batsDir ?? '')
    ? R('Кириллица в пути', 'warn', ['Путь содержит кириллицу. Если обход не работает — переместите в C:\\zapret'])
    : R('Кириллица в пути', 'pass', ['Путь не содержит кириллицы']);
}

async function checkOneDrive(batsDir) {
  const od = process.env.OneDrive;
  if (!od) return R('OneDrive', 'pass', ['Папка не находится в OneDrive']);
  const norm = (s) => s.replace(/[\\/]+$/g, '').toLowerCase();
  return norm(batsDir ?? '').startsWith(norm(od))
    ? R('OneDrive', 'fail', ['Zapret установлен в папке OneDrive — переместите, например в C:\\zapret'])
    : R('OneDrive', 'pass', ['Папка не находится в OneDrive']);
}

async function checkWinDivertDriver(batsDir) {
  let ok = false;
  try {
    ok = fs.readdirSync(path.join(batsDir, 'bin')).some((n) => /\.sys$/i.test(n));
  } catch {}
  return ok
    ? R('WinDivert64.sys', 'pass', ['Файл драйвера найден в bin'])
    : R('WinDivert64.sys', 'fail', ['WinDivert64.sys НЕ найден в папке bin']);
}

async function checkVpn() {
  const { found } = await findServicesByPattern('VPN');
  return found.length
    ? R('VPN-сервисы', 'warn', [`Найдены VPN-сервисы: ${found.join(', ')}. Некоторые VPN конфликтуют с zapret — убедитесь, что они выключены`])
    : R('VPN-сервисы', 'pass', ['VPN-сервисы не найдены']);
}

async function checkDoh() {
  if (!isWindows) return R('Secure DNS (DoH)', 'info', ['Проверка доступна только на Windows']);
  const r = await sh('powershell', ['-NoProfile', '-Command',
    "Get-ChildItem -Recurse -Path 'HKLM:System\\CurrentControlSet\\Services\\Dnscache\\InterfaceSpecificParameters\\' -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object { $_.DohFlags -gt 0 } | Measure-Object | Select-Object -ExpandProperty Count"
  ], { timeout: 20000 });
  const n = parseInt((r.out || '').trim(), 10) || 0;
  return n > 0
    ? R('Secure DNS (DoH)', 'pass', ['Зашифрованный DNS настроен в системе'])
    : R('Secure DNS (DoH)', 'warn', [
      'Убедитесь, что в браузере настроен secure DNS с нестандартным DNS-провайдером;',
      'в Windows 11 зашифрованный DNS можно включить в параметрах системы'
    ]);
}

async function checkHostsEntries() {
  const hosts = systemHostsPath();
  let text = '';
  try { text = fs.readFileSync(hosts, 'utf8'); } catch {}
  const bad = /youtube\.com/i.test(text) || /youtu\.be/i.test(text);
  return bad
    ? R('hosts-файл', 'warn', ['В hosts есть записи youtube.com / youtu.be — это может ломать доступ к YouTube'])
    : R('hosts-файл', 'pass', ['Проблемных записей в hosts не найдено']);
}

async function checkWinDivertOrphan() {
  const winws = await isProcessRunning('winws.exe');
  const wd = await serviceState('WinDivert');
  if (!winws && (wd === 'RUNNING' || wd === 'STOP_PENDING')) {
    return R('WinDivert без winws', 'warn', [
      'winws.exe не запущен, но сервис WinDivert активен.',
      'Нажмите кнопку «Починить WinDivert», чтобы удалить конфликтующий сервис'
    ]);
  }
  return R('WinDivert без winws', 'pass', ['Конфликта WinDivert не обнаружено']);
}

const CONFLICTING = ['GoodbyeDPI', 'discordfix_zapret', 'winws1', 'winws2'];

async function checkConflictingBypasses() {
  const { text } = await findServicesByPattern('');
  const found = CONFLICTING.filter((name) =>
    new RegExp(`SERVICE_NAME:\\s*${name}\\s*(?:\\r?$|\\r?\\n)`, 'im').test(text)
  );
  return found.length
    ? { ...R('Конфликтующие обходы', 'fail', [`Найдены конфликтующие сервисы: ${found.join(', ')}. Используйте кнопку «Удалить конфликтующие сервисы»`]), names: found }
    : R('Конфликтующие обходы', 'pass', ['Конфликтующих обходов не найдено']);
}

/**
 * Запустить всю диагностику.
 * @returns {Promise<Array>} список результатов
 */
export async function runDiagnostics(batsDir) {
  const checks = [
    checkPath(batsDir),
    checkBFE(),
    checkProxy(),
    checkTcpTimestamps(),
    checkAdguard(),
    checkKiller(),
    checkIntelConnectivity(),
    checkCheckPoint(),
    checkSmartByte(),
    checkCyrillicPath(batsDir),
    checkOneDrive(batsDir),
    checkWinDivertDriver(batsDir),
    checkVpn(),
    checkDoh(),
    checkHostsEntries(),
    checkWinDivertOrphan(),
    checkConflictingBypasses()
  ];
  return Promise.all(checks);
}

/** Удаление «осиротевшего» WinDivert + известных конфликтов (GoodbyeDPI и т.п.) */
export async function fixWinDivert() {
  const log = [];
  for (const name of ['WinDivert', 'GoodbyeDPI', 'WinDivert14']) {
    const stop = await shCmd(`net stop ${name}`, { timeout: 20000 });
    const del = await shCmd(`sc delete ${name}`, { timeout: 20000 });
    log.push(`${name}: stop=${stop.code}, delete=${del.code}`);
  }
  return { ok: true, log };
}
