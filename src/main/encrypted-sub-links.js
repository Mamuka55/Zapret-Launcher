import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';

const INCY_CRYPT1_KEY = Buffer.from(
  'f6d40ea0c8a8899d7c682d09ba0d4165dfe2b3dd45e6bb3e25cb233cf00c2462',
  'hex'
);
const INCY_PREFIX = /^incy:\/\/crypt1\/([\s\S]+)$/i;
const HAPP_PREFIX = /^happ:\/\/crypt3\/([\s\S]+)$/i;
const V2_PREFIX = /^v2raytun:\/\/crypt\/([\s\S]+)$/i;
const INCY_ADD_PREFIX = /^incy:\/\/add\/((?:https?:\/\/)[\s\S]+)$/i;
const HAPP_ADD_PREFIX = /^happ:\/\/add\/((?:https?:\/\/)[\s\S]+)$/i;
const KEY_SOURCES = [
  'https://cdn.jsdelivr.net/gh/Omegaplexx/hpwnr@main/src/keys.rs',
  'https://raw.githubusercontent.com/Omegaplexx/hpwnr/main/src/keys.rs'
];

let keyCacheFile = '';
let keyBundlePromise = null;

export function configureEncryptedLinkKeyCache(file) {
  keyCacheFile = String(file || '').trim();
  if (keyCacheFile) keyCacheFile = path.resolve(keyCacheFile);
}

function decodeBase64Flexible(value) {
  const clean = String(value || '').replace(/[\r\n\t ]+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!clean || !/^[A-Za-z0-9+/=]+$/.test(clean)) throw new Error('Некорректная зашифрованная ссылка');
  return Buffer.from(clean + '='.repeat((4 - clean.length % 4) % 4), 'base64');
}

function requestText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error('Слишком много перенаправлений при загрузке ключей'));
    const req = https.get(url, {
      family: 4,
      headers: { 'User-Agent': 'Zapret-Launcher/1.5.5', Accept: 'text/plain,*/*' },
      timeout: 5000
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return requestText(new URL(res.headers.location, url).toString(), redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode || 0} при загрузке crypto-ключей`));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error('Таймаут загрузки crypto-ключей')));
    req.on('error', reject);
  });
}

function extractKeyBundle(source) {
  const text = String(source || '');
  const pkcs1 = [...text.matchAll(/pub\s+const\s+PKCS1_KEYS\s*:\s*\[[^\]]*?\]\s*=\s*\[\s*((?:"[^"]*"\s*,?\s*){4})/s)][0]?.[1] || '';
  const allHapp = [...pkcs1.matchAll(/"([A-Za-z0-9+/=]+)"/g)].map(m => m[1]);
  const happCrypt3 = allHapp[2] || '';
  const v2Crypt3 = text.match(/\("crypt3"\s*,\s*"([A-Za-z0-9+/=]+)"\)/)?.[1] || '';
  if (!happCrypt3 || !v2Crypt3) throw new Error('Не удалось извлечь ключи HAPP/v2rayTun из опубликованного набора');
  // The published file uses PKCS#1 for Happ crypt..crypt4 and PKCS#8 for V2RayTun keys.
  crypto.createPrivateKey({ key: Buffer.from(happCrypt3, 'base64'), format: 'der', type: 'pkcs1' });
  crypto.createPrivateKey({ key: Buffer.from(v2Crypt3, 'base64'), format: 'der', type: 'pkcs8' });
  return { happCrypt3, v2Crypt3 };
}

async function loadKeyBundle() {
  if (keyBundlePromise) return keyBundlePromise;
  keyBundlePromise = (async () => {
    if (keyCacheFile) {
      try {
        const cached = JSON.parse(fs.readFileSync(keyCacheFile, 'utf8'));
        if (cached?.happCrypt3 && cached?.v2Crypt3) {
          crypto.createPrivateKey({ key: Buffer.from(cached.happCrypt3, 'base64'), format: 'der', type: 'pkcs1' });
          crypto.createPrivateKey({ key: Buffer.from(cached.v2Crypt3, 'base64'), format: 'der', type: 'pkcs8' });
          return cached;
        }
      } catch {}
    }
    let lastError = null;
    for (const url of KEY_SOURCES) {
      try {
        const bundle = extractKeyBundle(await requestText(url));
        if (keyCacheFile) {
          try {
            fs.mkdirSync(path.dirname(keyCacheFile), { recursive: true });
            fs.writeFileSync(keyCacheFile, JSON.stringify(bundle), 'utf8');
          } catch {}
        }
        return bundle;
      } catch (e) { lastError = e; }
    }
    throw new Error(`Не удалось загрузить ключи HAPP/v2rayTun. Проверьте интернет-соединение и повторите импорт.${lastError ? ` (${lastError.message})` : ''}`);
  })().catch(e => { keyBundlePromise = null; throw e; });
  return keyBundlePromise;
}

function base64UrlToBigInt(value) {
  const raw = Buffer.from(String(value || '').replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(value || '').length / 4) * 4, '='), 'base64');
  return BigInt(`0x${raw.toString('hex') || '0'}`);
}

function bigIntToFixedBuffer(value, size) {
  const hex = value.toString(16).padStart(size * 2, '0');
  return Buffer.from(hex.slice(-size * 2), 'hex');
}

function modPow(base, exponent, modulus) {
  if (modulus <= 0n) throw new Error('Некорректный RSA modulus');
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    e >>= 1n;
    b = (b * b) % modulus;
  }
  return result;
}

function rsaPkcs1v15DecryptBlock(block, keyObject) {
  const jwk = keyObject.export({ format: 'jwk' });
  const n = base64UrlToBigInt(jwk.n);
  const d = base64UrlToBigInt(jwk.d);
  const c = BigInt(`0x${block.toString('hex')}`);
  const em = bigIntToFixedBuffer(modPow(c, d, n), block.length);
  if (em[0] !== 0 || em[1] !== 2) throw new Error('RSA PKCS#1 v1.5 расшифровка не пройдена');
  let separator = -1;
  for (let i = 2; i < em.length; i++) {
    if (em[i] === 0) { separator = i; break; }
    if (em[i] === 0 || i < 10) continue;
  }
  if (separator < 10) throw new Error('RSA PKCS#1 v1.5: повреждён блок');
  return em.subarray(separator + 1);
}

function decryptRsaBlocks(payload, keyDer, keyType) {
  const cipher = decodeBase64Flexible(payload);
  if (!cipher.length) throw new Error('Пустой зашифрованный payload');
  const keyObject = crypto.createPrivateKey({ key: keyDer, format: 'der', type: keyType });
  const publicKey = crypto.createPublicKey(keyObject);
  const blockSize = Math.ceil(Number(publicKey.asymmetricKeyDetails?.modulusLength || 4096) / 8);
  if (cipher.length % blockSize !== 0) throw new Error('Повреждённая зашифрованная ссылка: размер RSA-блоков неверный');
  const out = [];
  for (let offset = 0; offset < cipher.length; offset += blockSize) {
    out.push(rsaPkcs1v15DecryptBlock(cipher.subarray(offset, offset + blockSize), keyObject));
  }
  return Buffer.concat(out).toString('utf8').trim();
}

export function decryptIncyCrypt1(input) {
  const m = INCY_PREFIX.exec(String(input || '').trim());
  if (!m) throw new Error('Не ссылка INCY crypt1');
  const wire = decodeBase64Flexible(m[1]);
  if (wire.length < 12 + 16) throw new Error('Повреждённая INCY crypt1 ссылка');
  const decipher = crypto.createDecipheriv('aes-256-gcm', INCY_CRYPT1_KEY, wire.subarray(0, 12));
  decipher.setAuthTag(wire.subarray(wire.length - 16));
  const plain = Buffer.concat([decipher.update(wire.subarray(12, wire.length - 16)), decipher.final()]).toString('utf8').trim();
  let obj;
  try { obj = JSON.parse(plain); } catch { throw new Error('INCY crypt1 содержит некорректный JSON'); }
  const url = String(obj?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('INCY crypt1 не содержит URL подписки http(s)://');
  return { url, name: String(obj?.n || '').trim().slice(0, 128), sourceType: 'incy://crypt1', userAgent: 'INCY/Windows' };
}

export async function decryptHappCrypt3(input) {
  const m = HAPP_PREFIX.exec(String(input || '').trim());
  if (!m) throw new Error('Не ссылка HAPP crypt3');
  const keys = await loadKeyBundle();
  const url = decryptRsaBlocks(m[1], Buffer.from(keys.happCrypt3, 'base64'), 'pkcs1');
  if (!/^https?:\/\//i.test(url)) throw new Error('HAPP crypt3 не содержит URL подписки http(s)://');
  return { url, name: '', sourceType: 'happ://crypt3', userAgent: 'Happ/3.26.1' };
}

export async function decryptV2RayTunCrypt(input) {
  const m = V2_PREFIX.exec(String(input || '').trim());
  if (!m) throw new Error('Не ссылка v2rayTun crypt');
  const keys = await loadKeyBundle();
  const url = decryptRsaBlocks(m[1], Buffer.from(keys.v2Crypt3, 'base64'), 'pkcs8');
  if (!/^https?:\/\//i.test(url)) throw new Error('v2rayTun crypt не содержит URL подписки http(s)://');
  return { url, name: '', sourceType: 'v2raytun://crypt', userAgent: 'v2raytun/5.24.76 Windows/10.0' };
}

export async function resolveEncryptedSubscription(input) {
  const text = String(input || '').trim();
  if (/^https?:\/\//i.test(text)) return { url: text, name: '', sourceType: 'http', userAgent: '' };

  // INCY/HAPP also expose a plain wrapper form used by their share buttons:
  //   incy://add/https://...
  //   happ://add/https://...
  // It is already a regular subscription URL, so do not invoke the encrypted
  // key loader for these links. This keeps imports instant and works offline.
  const incyAdd = INCY_ADD_PREFIX.exec(text);
  if (incyAdd) return { url: incyAdd[1], name: '', sourceType: 'incy://add', userAgent: 'INCY/Windows' };
  const happAdd = HAPP_ADD_PREFIX.exec(text);
  if (happAdd) return { url: happAdd[1], name: '', sourceType: 'happ://add', userAgent: 'Happ/3.26.1' };

  if (INCY_PREFIX.test(text)) return decryptIncyCrypt1(text);
  if (HAPP_PREFIX.test(text)) return decryptHappCrypt3(text);
  if (V2_PREFIX.test(text)) return decryptV2RayTunCrypt(text);
  throw new Error('Поддерживаются подписки http(s)://, incy://add/, happ://add/, incy://crypt1/, happ://crypt3/ и v2raytun://crypt/');
}

export function isEncryptedSubscriptionLink(input) {
  const text = String(input || '').trim();
  return /^(?:incy:\/\/(?:add\/|crypt1\/)|happ:\/\/(?:add\/|crypt3\/)|v2raytun:\/\/crypt\/)/i.test(text);
}
