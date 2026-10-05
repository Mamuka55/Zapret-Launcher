import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import https from 'node:https';
import { isNewer, parseLocalVersion, guessAssetUrl } from './lib/pure.js';
import { sh } from './util.js';

const API = (repo) => `https://api.github.com/repos/${repo}/releases/latest`;
const RAW_VERSION = (repo) => `https://raw.githubusercontent.com/${repo}/main/.service/version.txt`;

const USER_AGENT = 'Zapret-Launcher/1.5.6';
const MAX_REDIRECTS = 6;
const HTTPS_TIMEOUT = 30000;

function requestTextHttps(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) {
      reject(new Error('Слишком много перенаправлений'));
      return;
    }

    let parsed;
    try { parsed = new URL(url); } catch {
      reject(new Error(`Некорректный URL: ${url}`));
      return;
    }
    if (parsed.protocol !== 'https:') {
      reject(new Error(`Неподдерживаемый протокол: ${parsed.protocol}`));
      return;
    }

    const req = https.get(parsed, {
      family: 4,
      timeout: HTTPS_TIMEOUT,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/vnd.github+json, application/json, text/plain, */*',
        'Cache-Control': 'no-cache'
      }
    }, (res) => {
      const code = res.statusCode ?? 0;
      const location = res.headers.location;
      if (code >= 300 && code < 400 && location) {
        res.resume();
        const next = new URL(location, parsed).toString();
        requestTextHttps(next, redirects + 1).then(resolve, reject);
        return;
      }

      const chunks = [];
      res.setEncoding('utf8');
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = chunks.join('');
        if (code < 200 || code >= 300) {
          const detail = body.replace(/\s+/g, ' ').trim().slice(0, 300);
          reject(new Error(`HTTP ${code}${detail ? `: ${detail}` : ''}`));
          return;
        }
        resolve(body);
      });
      res.on('error', (err) => reject(err));
    });

    req.on('timeout', () => req.destroy(new Error('Таймаут соединения с GitHub')));
    req.on('error', (err) => reject(err));
  });
}

async function requestText(url) {
  try {
    return await requestTextHttps(url);
  } catch (httpsErr) {
    // Windows 10/11 почти всегда имеют системный curl.exe. Он часто
    // работает в тех сетях, где Electron/Node HTTPS блокируется политикой ОС.
    const r = await sh('curl.exe', [
      '-4', '-L', '--fail', '--silent', '--show-error',
      '--connect-timeout', '15', '--max-time', '45',
      '-A', USER_AGENT, url
    ], { timeout: 55000 });
    if (r.code === 0 && r.stdout) return r.stdout;
    const curlMsg = String(r.stderr || r.out || '').trim();
    throw new Error(`GitHub недоступен: ${curlMsg || httpsErr.message}`);
  }
}

async function downloadHttps(url, filePath, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) {
      reject(new Error('Слишком много перенаправлений при скачивании')); return;
    }
    let parsed;
    try { parsed = new URL(url); } catch {
      reject(new Error(`Некорректный URL: ${url}`)); return;
    }
    if (parsed.protocol !== 'https:') {
      reject(new Error(`Неподдерживаемый протокол: ${parsed.protocol}`)); return;
    }

    const req = https.get(parsed, {
      family: 4,
      timeout: 60000,
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }
    }, (res) => {
      const code = res.statusCode ?? 0;
      const location = res.headers.location;
      if (code >= 300 && code < 400 && location) {
        res.resume();
        const next = new URL(location, parsed).toString();
        downloadHttps(next, filePath, onProgress, redirects + 1).then(resolve, reject);
        return;
      }
      if (code < 200 || code >= 300) {
        const parts = [];
        res.setEncoding('utf8');
        res.on('data', (x) => parts.push(x));
        res.on('end', () => reject(new Error(`HTTP ${code}: ${parts.join('').replace(/\s+/g, ' ').trim().slice(0, 250)}`)));
        return;
      }

      const total = Number(res.headers['content-length'] ?? 0);
      let received = 0;
      const out = fs.createWriteStream(filePath);
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { out.destroy(); } catch {}
        try { fs.rmSync(filePath, { force: true }); } catch {}
        reject(err);
      };
      res.on('data', (chunk) => {
        received += chunk.length;
        if (total && onProgress) onProgress(Math.min(100, Math.round((received / total) * 100)), received, total);
      });
      res.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => {
        if (settled) return;
        settled = true;
        onProgress?.(100, received, total);
        resolve(filePath);
      });
      res.pipe(out);
    });
    req.on('timeout', () => req.destroy(new Error('Таймаут скачивания обновления')));
    req.on('error', (err) => reject(err));
  });
}

async function downloadWithCurl(url, filePath, onProgress) {
  const r = await sh('curl.exe', [
    '-4', '-L', '--fail', '--silent', '--show-error',
    '--connect-timeout', '15', '--max-time', '600',
    '-A', USER_AGENT, '-o', filePath, url
  ], { timeout: 620000 });
  if (r.code !== 0 || !fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    try { fs.rmSync(filePath, { force: true }); } catch {}
    throw new Error(String(r.stderr || r.out || `curl завершился с кодом ${r.code}`).trim());
  }
  onProgress?.(100);
  return filePath;
}

/**
 * Получить информацию о последней версии релиза GitHub.
 * Не используем Electron/Chromium fetch: запросы идут через Node HTTPS,
 * а при сетевой политике Windows автоматически используется curl.exe.
 */
export async function fetchLatest(repo) {
  let apiError = null;
  try {
    const body = await requestText(API(repo));
    const data = JSON.parse(body);
    const tag = String(data.tag_name ?? '').replace(/^v/i, '');
    const asset = (data.assets ?? []).find((a) => /^.+\.zip$/i.test(a.name ?? ''));
    if (!tag) throw new Error('GitHub не вернул tag_name');
    return {
      version: tag,
      zipUrl: asset?.browser_download_url ?? guessAssetUrl(repo, data.tag_name ?? tag),
      htmlUrl: data.html_url ?? `https://github.com/${repo}/releases/tag/${data.tag_name}`,
      source: 'api'
    };
  } catch (err) {
    apiError = err;
    console.error('fetchLatest(api):', err);
  }

  try {
    const version = (await requestText(RAW_VERSION(repo))).trim();
    if (version) {
      return {
        version: version.replace(/^v/i, ''),
        zipUrl: guessAssetUrl(repo, version.replace(/^v/i, '')),
        htmlUrl: `https://github.com/${repo}/releases/latest`,
        source: 'version.txt'
      };
    }
  } catch (err) {
    console.error('fetchLatest(version.txt):', err);
  }

  return null;
}

/** Локальная версия: LOCAL_VERSION из service.bat в папке */
export function getLocalVersion(batsDir) {
  if (!batsDir) return null;
  for (const name of ['service.bat', 'service.cmd']) {
    try {
      const p = path.join(batsDir, name);
      if (fs.existsSync(p)) return parseLocalVersion(fs.readFileSync(p, 'utf8'));
    } catch {}
  }
  try {
    const f = fs.readdirSync(batsDir).find((n) => /^service.*\.(bat|cmd)$/i.test(n));
    if (f) return parseLocalVersion(fs.readFileSync(path.join(batsDir, f), 'utf8'));
  } catch {}
  return null;
}

/** Проверка обновления */
export async function checkUpdate(repo, batsDir) {
  const local = getLocalVersion(batsDir);
  try {
    const latest = await fetchLatest(repo);
    if (!latest) return { hasUpdate: false, local, remote: null, error: 'Не удалось получить релиз с GitHub' };
    return {
      hasUpdate: isNewer(latest.version, local),
      local,
      remote: latest.version,
      zipUrl: latest.zipUrl,
      htmlUrl: latest.htmlUrl
    };
  } catch (err) {
    return { hasUpdate: false, local, remote: null, error: String(err?.message ?? err) };
  }
}

/** Скачать архив релиза с прогрессом. */
export async function downloadZip(url, onProgress) {
  const tmp = path.join(os.tmpdir(), `zapret-update-${Date.now()}.zip`);
  try {
    return await downloadHttps(url, tmp, onProgress);
  } catch (httpsErr) {
    console.error('downloadZip(https):', httpsErr);
    return await downloadWithCurl(url, tmp, onProgress).catch((curlErr) => {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      throw new Error(`Не удалось скачать обновление: ${curlErr?.message || httpsErr?.message || curlErr}`);
    });
  }
}

/** Распаковка zip: tar -> PowerShell. */
async function extractZip(zipPath, destDir) {
  const r = await sh('tar', ['-xf', zipPath, '-C', destDir], { timeout: 120000 });
  if (r.code === 0) return true;
  const ps = await sh('powershell', [
    '-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
  ], { timeout: 180000 });
  return ps.code === 0;
}

/** Установка обновления в папку BAT-файлов. */
export async function installUpdate(zipPath, batsDir, onStatus) {
  const work = path.join(os.tmpdir(), `zapret-update-src-${Date.now()}`);
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(batsDir, { recursive: true });
  try {
    onStatus?.('Распаковка архива…');
    const ok = await extractZip(zipPath, work);
    if (!ok) throw new Error('Не удалось распаковать архив обновления');

    let srcRoot = work;
    const top = fs.readdirSync(work, { withFileTypes: true });
    if (top.length === 1 && top[0].isDirectory()) srcRoot = path.join(work, top[0].name);

    onStatus?.('Замена файлов…');
    const rootBatsBefore = new Set(fs.readdirSync(batsDir).filter((n) => /\.(bat|cmd)$/i.test(n)));
    const newNames = new Set(fs.readdirSync(srcRoot).filter((n) => /\.(bat|cmd)$/i.test(n)));

    await fs.promises.cp(srcRoot, batsDir, { recursive: true, force: true });

    // Удаляем BAT/CMD из корня, которых больше нет в новом релизе.
    for (const old of rootBatsBefore) {
      if (!newNames.has(old)) {
        try { fs.rmSync(path.join(batsDir, old), { force: true }); } catch {}
      }
    }

    onStatus?.('Готово');
    return true;
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(zipPath, { force: true }); } catch {}
  }
}


/** Получить последний GitHub Release целиком (для обновления самого лаунчера). */
export async function fetchLatestRelease(repo) {
  const body = await requestText(`https://api.github.com/repos/${repo}/releases/latest`);
  const data = JSON.parse(body);
  const version = String(data.tag_name || '').replace(/^v/i, '');
  if (!version) throw new Error('GitHub не вернул tag_name');
  return {
    version,
    tagName: data.tag_name,
    name: data.name || data.tag_name,
    body: data.body || '',
    htmlUrl: data.html_url || `https://github.com/${repo}/releases/latest`,
    publishedAt: data.published_at || null,
    assets: Array.isArray(data.assets) ? data.assets : []
  };
}

export function findReleaseAsset(release, patterns = []) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const normalized = patterns.map((p) => p instanceof RegExp ? p : new RegExp(String(p), 'i'));
  return assets.find((a) => normalized.some((rx) => rx.test(String(a?.name || '')))) || null;
}

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

export function verifySha256(filePath, expected) {
  if (!expected) return true;
  const actual = sha256File(filePath);
  return actual.toLowerCase() === String(expected).replace(/^sha256:/i, '').toLowerCase();
}

/** Скачать отдельный release asset и при наличии digest проверить SHA-256. */
export async function downloadAsset(url, fileName, onProgress, expectedDigest = null) {
  const target = path.join(os.tmpdir(), `${Date.now()}-${String(fileName).replace(/[^a-z0-9._-]+/gi, '_')}`);
  try {
    await downloadHttps(url, target, onProgress);
  } catch (httpsErr) {
    console.error('downloadAsset(https):', httpsErr);
    try {
      await downloadWithCurl(url, target, onProgress);
    } catch (curlErr) {
      try { fs.rmSync(target, { force: true }); } catch {}
      throw new Error(`Не удалось скачать ${fileName}: ${curlErr?.message || httpsErr?.message || curlErr}`);
    }
  }
  if (!verifySha256(target, expectedDigest)) {
    try { fs.rmSync(target, { force: true }); } catch {}
    throw new Error(`Проверка SHA-256 не пройдена: ${fileName}`);
  }
  return target;
}

export function getAppUpdateAsset(release, portable = false) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const version = String(release?.version || '').replace(/^v/i, '');
  const tagVersion = String(release?.tagName || '').replace(/^v/i, '');
  const wantedVersion = version || tagVersion;
  const versionEscaped = wantedVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const versionRx = versionEscaped ? new RegExp(`(?:^|[^0-9])(?:v)?${versionEscaped}(?:[^0-9]|$)`, 'i') : null;
  const exeAssets = assets.filter((a) => /\.exe$/i.test(String(a?.name || '')) && a?.browser_download_url);
  if (!exeAssets.length) return null;

  const matchesVersion = (a) => !versionRx || versionRx.test(String(a?.name || ''));
  const isPortable = (a) => /portable/i.test(String(a?.name || ''));
  const isInstaller = (a) => /(setup|installer|install)/i.test(String(a?.name || ''));
  const isOtherComponent = (a) => /(tg[-_ ]?ws|tgproxy|proxy|winws|windivert)/i.test(String(a?.name || ''));

  // Предпочтительный вариант: совпадает версия и явно указан тип сборки.
  const preferred = exeAssets.find((a) => matchesVersion(a) && (portable ? isPortable(a) : isInstaller(a)));
  if (preferred) return preferred;

  // Для portable ищем любой EXE с нужной версией и словом portable.
  if (portable) {
    const portableAsset = exeAssets.find((a) => matchesVersion(a) && isPortable(a));
    if (portableAsset) return portableAsset;
  }

  // Для setup допускаем нестандартное название, если это явно не другой компонент.
  if (!portable) {
    const setupLike = exeAssets.find((a) => matchesVersion(a) && !isPortable(a) && !isOtherComponent(a));
    if (setupLike) return setupLike;
  }

  // Если релиз содержит только один EXE, тип определить невозможно — используем его.
  if (exeAssets.length === 1) return exeAssets[0];

  // Последний fallback для старых релизов без версии в имени: setup/installer,
  // а для portable — явно помеченный portable.
  if (portable) return exeAssets.find(isPortable) || null;
  return exeAssets.find((a) => !isPortable(a) && !isOtherComponent(a)) || exeAssets.find(isInstaller) || null;
}

export { isNewer };
