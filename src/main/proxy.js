// Тестуемость: при импорте вне Electron (NODE_ENV=test) пути к данным берутся из
// переменной окружения, а не из app.getPath('userData') — иначе модуль нельзя
// проверить в юнит-тестах генерации конфигов.
const IS_TEST = process.env.NODE_ENV === 'test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import tls from 'node:tls';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Socket } from 'node:net';
import { execFile } from 'node:child_process';
import dns from 'node:dns';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const execFileAsync = promisify(execFile);
// В тестовой среде Electron недоступен — используем ZAPRET_TEST_DATA_DIR.
let appMod = null;
if (!IS_TEST) ({ app: appMod } = await import('electron'));
const userDataDir = () => IS_TEST ? (process.env.ZAPRET_TEST_DATA_DIR || path.join(os.tmpdir(), 'zapret-test')) : appMod.getPath('userData');
const DATA_DIR = () => path.join(userDataDir(), 'proxy');
const SERVERS_FILE = () => path.join(DATA_DIR(), 'servers.json');
const SUBS_FILE = () => path.join(DATA_DIR(), 'subscriptions.json');
const ROUTES_FILE = () => path.join(DATA_DIR(), 'routes.json');
const CORES_DIR = () => path.join(DATA_DIR(), 'cores');
const CFG_DIR = () => path.join(DATA_DIR(), 'configs');
const XRAY_DIR = () => path.join(CORES_DIR(), 'xray');
const SINGBOX_DIR = () => path.join(CORES_DIR(), 'sing-box');

const DEFAULTS = {
  enabled: false,
  mode: 'proxy', // proxy | tun | mixed
  systemProxy: true,
  socksPort: 10808,
  httpPort: 10809,
  tunName: 'EpicTunnel',
  mtu: 1500,
  dns: ['1.1.1.1', '8.8.8.8'],
  routeProfile: 'Global',
  autoSelect: false,
  subscriptionIntervalHours: 6,
  activeServerId: null,
  activeSubscriptionId: null,
  core: 'auto',
  pingType: 'tcp',
  pingUrl: 'https://cp.cloudflare.com/generate_204',
  subscriptionUserAgent: '',
  subscriptionAutoUpdate: true,
  subscriptionUpdateIntervalHours: 6,
  subscriptionPingOnOpen: false,
  pingParallel: false,
  pingTimeoutMs: 6000,
  subscriptionAutoconnect: 'off',
  serverResolveEnable: false,
  serverResolveDnsIp: '1.1.1.1',
  serverResolveDnsDomain: 'cloudflare.com',
  socksAuthMode: 'disable',
  socksAuthUser: '',
  socksAuthPassword: '',
  httpAuthMode: 'disable',
  httpAuthUser: '',
  httpAuthPassword: '',
  tunCore: 'sing-box'
};

let runtime = { proc: null, core: null, mode: 'proxy', configPath: null, systemProxyChanged: false, systemProxyOriginal: null, ready: false, trafficSeen: false };
let startPromise = null;
let settings = null;
let servers = [];
let subscriptions = [];
let routes = [];
let listeners = new Set();

function emit() {
  const state = status();
  for (const cb of listeners) { try { cb(state); } catch {} }
}
export function onState(cb) { listeners.add(cb); return () => listeners.delete(cb); }

function ensureDirs() {
  for (const d of [DATA_DIR(), CORES_DIR(), CFG_DIR(), XRAY_DIR(), SINGBOX_DIR()]) fs.mkdirSync(d, { recursive: true });
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); }
function normalizeName(s, fallback='Server') { return String(s || fallback).replace(/[\x00-\x1f<>:"/\\|?*]+/g, ' ').trim().slice(0, 120) || fallback; }
function idFor(seed) { return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16); }

function init() {
  ensureDirs();
  const rawSettings = readJson(path.join(DATA_DIR(), 'settings.json'), {}) || {};
  settings = { ...DEFAULTS, ...rawSettings };
  // System proxy is the default connection mode. On upgrade from versions that
  // predated the explicit default marker, migrate once to the requested default
  // without changing it again after the user selects another mode.
  if (rawSettings.proxyDefaultModeVersion !== 'system-v1') {
    settings.mode = 'proxy';
    settings.systemProxy = true;
    settings.proxyDefaultModeVersion = 'system-v1';
  }
  settings.mode = normalizeVpnMode(settings.mode);
  normalizeTunSettings(settings);
  servers = Array.isArray(readJson(SERVERS_FILE(), [])) ? readJson(SERVERS_FILE(), []) : [];
  // Нормализуем и мигрируем сохранённые серверы при старте. Это важно для старых
  // записей: ранее VLESS Vision мог сохраняться с security=none и затем напрямую
  // попадать в Xray, где outbound отклонялся ещё до подключения к серверу.
  servers = servers.filter(s => !isPlaceholderServer(s)).map(s => normalizeServer(s));
  subscriptions = Array.isArray(readJson(SUBS_FILE(), [])) ? readJson(SUBS_FILE(), []) : [];
  subscriptions = subscriptions.map(sub => ({ ...sub, name: subscriptionDisplayName(sub.url, sub.name) }));
  routes = Array.isArray(readJson(ROUTES_FILE(), [])) ? readJson(ROUTES_FILE(), []) : [];
  if (!routes.length) {
    routes = [
      { id: 'Global', name: 'Глобальный прокси', mode: 'proxy', domains: [], direct: [], block: [], dnsRemote: '1.1.1.1', dnsDomestic: '8.8.8.8' },
      { id: 'Split', name: 'Раздельная маршрутизация', mode: 'split', domains: ['geosite:category-ads-all'], direct: ['geosite:private'], block: [], dnsRemote: '1.1.1.1', dnsDomestic: '8.8.8.8' }
    ];
    writeJson(ROUTES_FILE(), routes);
  }
  return status();
}

function save() {
  ensureDirs();
  writeJson(path.join(DATA_DIR(), 'settings.json'), settings);
  writeJson(SERVERS_FILE(), servers);
  writeJson(SUBS_FILE(), subscriptions);
  writeJson(ROUTES_FILE(), routes);
}

export function getSettings() { if (!settings) init(); return structuredClone(settings); }
export function setSettings(patch = {}) {
  if (!settings) init();
  settings = { ...settings, ...patch };
  settings.mode = normalizeVpnMode(settings.mode);
  normalizeTunSettings(settings);
  save();
  return getSettings();
}
export function getServers() { if (!settings) init(); return structuredClone(servers); }
export function getSubscriptions() { if (!settings) init(); return structuredClone(subscriptions); }
export function getRoutes() { if (!settings) init(); return structuredClone(routes); }

function base64urlDecode(s) {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(t + '='.repeat((4 - t.length % 4) % 4), 'base64').toString('utf8');
}
function decodeMaybeBase64(s) {
  const raw = String(s || '').replace(/^\uFEFF/, '').trim();
  if (!raw) return '';
  try {
    const compact = raw.replace(/\s+/g, '');
    if (compact.length >= 8 && /^[A-Za-z0-9+/_=-]+$/.test(compact)) {
      const d = Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8').replace(/^\uFEFF/, '').trim();
      if (d && (/^(?:\{|\[)/.test(d) || /(?:vless|vmess|trojan|ss|socks5?|hysteria2|hy2|wireguard|wg):\/\//i.test(d) || /\r?\n/.test(d))) return d;
    }
  } catch {}
  return raw;
}
function decodeSsUserInfo(userInfo) {
  const s = decodeMaybeBase64(userInfo);
  const idx = s.indexOf(':');
  if (idx <= 0) return { method: '', password: s };
  return { method: s.slice(0, idx), password: s.slice(idx + 1) };
}
function hashPasswordName(input) { return crypto.createHash('md5').update(input).digest('hex').slice(0, 8); }

export function parseShareLink(input) {
  const text = String(input || '').trim();
  if (!text) throw new Error('Пустая ссылка');
  if (/^https?:\/\//i.test(text)) throw new Error('Это URL подписки. Используйте «Добавить подписку».');
  if (/^incy:\/\/routing\/(add|onadd)\//i.test(text) || /^happ:\/\/routing\/(add|onadd)\//i.test(text)) {
    const b64 = text.split('/').pop();
    const json = JSON.parse(base64urlDecode(b64));
    return { kind: 'route', route: json };
  }
  const u = new URL(text);
  const scheme = u.protocol.replace(':', '').toLowerCase();
  const name = decodeURIComponent(u.hash.replace(/^#/, '') || '') || '';
  if (scheme === 'vless') {
    const q = Object.fromEntries(u.searchParams.entries());
    const stream = q.type || q.network || 'tcp';
    return { kind: 'server', server: normalizeServer({
      name: name || 'VLESS', protocol: 'vless', core: 'xray', address: u.hostname,
      port: Number(u.port || 443), uuid: decodeURIComponent(u.username),
      security: q.security || 'none', flow: q.flow || '', network: stream,
      sni: q.sni || q.serverName || '', fingerprint: q.fp || q.fingerprint || '',
      publicKey: q.pbk || q.publicKey || '', shortId: q.sid || q.shortId || '',
      spiderX: q.spx || q.spiderX || '', path: q.path || '', host: q.host || '',
      serviceName: q.serviceName || q.serviceName || '', alpn: q.alpn || '',
      headerType: q.headerType || q.type || '', encryption: q.encryption || 'none',
      fragment: q.fragment || '', noise: q.noise || '',
      source: text
    })};
  }
  if (scheme === 'vmess') {
    const obj = JSON.parse(base64urlDecode(u.pathname));
    return { kind: 'server', server: normalizeServer({
      name: name || obj.ps || 'VMess', protocol: 'vmess', core: 'xray', address: obj.add,
      port: Number(obj.port || 443), uuid: obj.id, alterId: Number(obj.aid || 0),
      security: obj.scy || 'auto', network: obj.net || 'tcp', path: obj.path || '',
      host: obj.host || '', tls: obj.tls || '', sni: obj.sni || '', alpn: obj.alpn || '',
      fingerprint: obj.fp || '', source: text
    })};
  }
  if (scheme === 'trojan') {
    const q = Object.fromEntries(u.searchParams.entries());
    return { kind: 'server', server: normalizeServer({
      name: name || 'Trojan', protocol: 'trojan', core: 'xray', address: u.hostname,
      port: Number(u.port || 443), password: decodeURIComponent(u.username),
      network: q.type || 'tcp', security: q.security || 'tls', sni: q.sni || q.peer || '',
      fingerprint: q.fp || '', path: q.path || '', host: q.host || '', serviceName: q.serviceName || '',
      source: text
    })};
  }
  if (scheme === 'ss') {
    const qname = name;
    let userInfo = u.username;
    if (!userInfo && u.hostname === '') {
      const payload = decodeMaybeBase64(u.pathname.replace(/^\//, ''));
      const at = payload.lastIndexOf('@');
      if (at > 0) { userInfo = payload.slice(0, at); const rest = payload.slice(at + 1); const [host, port] = rest.split(':');
        return { kind:'server', server: normalizeServer({ name:qname || 'Shadowsocks', protocol:'shadowsocks', core:'xray', address:host, port:Number(port||8388), ...decodeSsUserInfo(userInfo), source:text }) };
      }
    }
    const creds = decodeSsUserInfo(userInfo);
    return { kind:'server', server: normalizeServer({ name:qname || 'Shadowsocks', protocol:'shadowsocks', core:'xray', address:u.hostname, port:Number(u.port||8388), ...creds, source:text })};
  }
  if (scheme === 'socks5' || scheme === 'socks') {
    return { kind:'server', server: normalizeServer({ name:name || 'SOCKS5', protocol:'socks', core:'xray', address:u.hostname, port:Number(u.port||1080), username:decodeURIComponent(u.username||''), password:decodeURIComponent(u.password||''), source:text })};
  }
  if (scheme === 'http') {
    if (!u.username && !u.password && !u.hostname) throw new Error('HTTP-ссылка не содержит сервера');
    return { kind:'server', server: normalizeServer({ name:name || 'HTTP Proxy', protocol:'http', core:'xray', address:u.hostname, port:Number(u.port||80), username:decodeURIComponent(u.username||''), password:decodeURIComponent(u.password||''), source:text })};
  }
  if (scheme === 'wireguard' || scheme === 'wg') {
    const q = Object.fromEntries(u.searchParams.entries());
    return { kind:'server', server: normalizeServer({ name:name || 'WireGuard', protocol:'wireguard', core:'sing-box', address:u.hostname, port:Number(u.port||51820), privateKey:decodeURIComponent(u.username||''), publicKey:q.publickey || q.publicKey || '', preSharedKey:q.psk || q.presharedkey || q.preSharedKey || '', localAddress:q.address ? String(q.address).split(',').map(x=>x.trim()).filter(Boolean) : ['10.0.0.2/32'], source:text })};
  }
  if (scheme === 'hysteria2' || scheme === 'hy2') {
    const q = Object.fromEntries(u.searchParams.entries());
    return { kind:'server', server: normalizeServer({ name:name || 'Hysteria2', protocol:'hysteria2', core:'sing-box', address:u.hostname, port:Number(u.port||443), password:decodeURIComponent(u.username || ''), sni:q.sni || '', insecure:q.insecure === '1' || q.insecure === 'true', obfs:q.obfs || '', obfsPassword:q['obfs-password'] || '', pinSHA256:q.pinSHA256 || '', source:text })};
  }
  throw new Error(`Неподдерживаемая схема: ${scheme}`);
}

const GENERIC_SERVER_NAMES = new Set([
  'proxy', 'vpn', 'server', 'vless', 'vmess', 'trojan', 'shadowsocks', 'ss',
  'socks', 'socks5', 'http', 'hysteria2', 'hy2', 'wireguard', 'wg', 'direct', 'block'
]);

function isGenericServerName(name) {
  const n = String(name || '').trim().toLowerCase().replace(/[ _-]+/g, ' ');
  return !n || GENERIC_SERVER_NAMES.has(n);
}
const COUNTRY_CODES = new Set(['ru','ua','de','nl','fi','se','no','dk','pl','cz','fr','gb','uk','us','ca','tr','ge','kz','am','by','lt','lv','ee','ch','at','es','it','jp','sg','hk','ae','il','in','kr','au','br']);
const COUNTRY_NAMES_MAIN = {ru:'Россия',ua:'Украина',de:'Германия',nl:'Нидерланды',fi:'Финляндия',se:'Швеция',no:'Норвегия',dk:'Дания',pl:'Польша',cz:'Чехия',fr:'Франция',gb:'Великобритания',uk:'Великобритания',us:'США',ca:'Канада',tr:'Турция',ge:'Грузия',kz:'Казахстан',am:'Армения',by:'Беларусь',lt:'Литва',lv:'Латвия',ee:'Эстония',ch:'Швейцария',at:'Австрия',es:'Испания',it:'Италия',jp:'Япония',sg:'Сингапур',hk:'Гонконг',ae:'ОАЭ',il:'Израиль',in:'Индия',kr:'Южная Корея',au:'Австралия',br:'Бразилия'};
function countryFromHost(address) {
  const host = String(address || '').trim().toLowerCase();
  const first = host.split('.')[0] || '';
  const m = first.match(/^(ru|ua|de|nl|fi|se|no|dk|pl|cz|fr|gb|uk|us|ca|tr|ge|kz|am|by|lt|lv|ee|ch|at|es|it|jp|sg|hk|ae|il|in|kr|au|br)(?:[-_]?\d+)?$/i);
  if (m) return m[1].toLowerCase() === 'uk' ? 'gb' : m[1].toLowerCase();
  return '';
}
function looksLikeHostname(value) {
  const v = String(value || '').trim();
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(v);
}
function meaningfulServerName(name, address, protocol) {
  const candidate = normalizeName(name, '');
  if (!isGenericServerName(candidate) && !looksLikeHostname(candidate)) return candidate;
  const code = countryFromHost(address) || countryFromHost(candidate);
  if (code) return COUNTRY_NAMES_MAIN[code] || code.toUpperCase();
  if (candidate && !looksLikeHostname(candidate)) return candidate;
  return normalizeName(String(protocol || 'Server').toUpperCase(), 'Server');
}
function subscriptionDisplayName(url, supplied='') {
  const given = normalizeName(supplied, '');
  // Технические доменные имена и служебные профили никогда не показываем пользователю.
  if (given && !looksLikeHostname(given) && !/^(?:sub|subscription|subscribe|www|api)(?:[._ -])/i.test(given)) return given;
  try {
    const host = new URL(url).hostname.toLowerCase();
    const labels = host.split('.').filter(Boolean);
    const meaningful = labels.filter(x => !['sub','subscription','subscribe','www','api'].includes(x));
    const brand = meaningful.length >= 2 ? meaningful[meaningful.length - 2] : (meaningful[0] || 'VPN');
    const known = { guava:'Guava', happ:'HAPP', incy:'INCY', v2raytun:'V2RayTun', v2rayn:'v2rayN', nekobox:'NekoBox', streisand:'Streisand' };
    const pretty = known[brand] || brand.replace(/[-_]+/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
    return `${pretty} VPN`;
  } catch { return 'VPN подписка'; }
}

function inferVlessSecurity(s) {
  if (String(s?.protocol || '').toLowerCase() !== 'vless') return s?.security || '';
  const current = String(s?.security || '').trim().toLowerCase();
  const flow = String(s?.flow || '').trim().toLowerCase();
  const hasRealityParams = !!(s?.publicKey || s?.shortId || s?.spiderX);
  // VLESS Vision (XTLS) is valid only with TLS/REALITY underneath. A number of
  // subscription formats omit `security` while still carrying `flow=xtls-rprx-vision`
  // or REALITY parameters, which previously normalized to `none` and produced the
  // Xray runtime error: "XTLS only supports TLS and REALITY directly".
  if ((current === '' || current === 'none') && hasRealityParams) return 'reality';
  if ((current === '' || current === 'none') && /^xtls-rprx-vision(?:-udp443)?$/.test(flow)) return 'tls';
  return current || 'none';
}

function normalizeServer(s) {
  const protocol = String(s.protocol || '').toLowerCase();
  const address = String(s.address || '').trim();
  const normalizedSecurity = protocol === 'vless' ? inferVlessSecurity(s) : s.security;
  const base = {
    id: s.id || idFor(s.source || JSON.stringify(s)),
    name: meaningfulServerName(s.name || s.remarks || s.ps || s.tag, address, protocol),
    protocol, core: s.core || 'xray',
    address, port: Number(s.port || 0),
    source: s.source || '', createdAt: s.createdAt || Date.now(), latency: Number.isFinite(s.latency) ? s.latency : null,
    favorite: !!s.favorite, subscriptionId: s.subscriptionId || null, countryCode: s.countryCode || countryFromHost(address) || '',
    ...(protocol === 'vless' ? { security: normalizedSecurity } : {})
  };
  return { ...s, ...base };
}

function normalizeEntityId(value) {
  if (value && typeof value === 'object') {
    if (value.id != null) return String(value.id);
    if (value.serverId != null) return String(value.serverId);
  }
  const id = String(value ?? '').trim();
  if (!id || id === '[object Object]') throw new Error('Некорректный идентификатор сервера');
  return id;
}

const SUBSCRIPTION_USER_AGENTS = [
  'Happ/3.26.1',
  'Happ/3.10.0',
  'Happ/3.0.0',
  'Happ/Windows',
  'INCY/Windows',
  'v2raytun/5.24.76 Windows/10.0',
  'v2raytun/Windows',
  'v2rayN/Windows',
  'v2rayNG/Windows',
  'sing-box/Windows',
  'ClashMeta/Windows',
  'NekoBox/Windows',
  'Streisand/Windows',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0 Safari/537.36'
];

const SUPPORTED_PROTOCOLS = new Set(['vless','vmess','trojan','shadowsocks','ss','socks','socks5','http','hysteria2','hy2','wireguard','wg']);

function protocolFromType(type) {
  const t=String(type||'').toLowerCase();
  if (t==='ss') return 'shadowsocks';
  if (t==='socks5' || t==='socks') return 'socks';
  if (t==='hy2') return 'hysteria2';
  if (t==='wg') return 'wireguard';
  return t;
}

function convertGenericProxyObject(obj, fallbackName='Server') {
  if (!obj || typeof obj!=='object') return null;
  if (typeof obj.config==='string' && /^(?:vless|vmess|trojan|ss|socks5?|hysteria2|hy2|wireguard|wg):\/\//i.test(obj.config)) {
    try { const r=parseShareLink(obj.config); return r.kind==='server' ? {...r.server,name:normalizeName(obj.name || r.server.name, r.server.name)} : null; } catch {}
  }
  const p=protocolFromType(obj.protocol || obj.type || obj.scheme || obj.proto || '');
  if (!SUPPORTED_PROTOCOLS.has(p)) return null;
  const address=obj.address || obj.server || obj.add || obj.host || obj.hostname || '';
  const port=Number(obj.port || obj.server_port || obj.serverPort || 0);
  if (!address || !port) return null;
  const tls=obj.tls && typeof obj.tls==='object' ? obj.tls : {};
  const reality=obj.reality && typeof obj.reality==='object' ? obj.reality : (obj['reality-opts'] || {});
  const ws=obj['ws-opts'] || obj.ws_opts || {};
  const grpc=obj['grpc-opts'] || obj.grpc_opts || {};
  return normalizeServer({
    name: normalizeName(obj.name || obj.remarks || obj.ps || obj.tag || fallbackName, String(p).toUpperCase()),
    protocol:p,
    core:['hysteria2','wireguard'].includes(p)?'sing-box':'xray',
    address, port,
    uuid:obj.uuid || obj.id || '', password:obj.password || obj.pass || '',
    method:obj.method || obj.cipher || '', username:obj.username || obj.user || '',
    security:obj.security || (tls.enabled ? 'tls' : ''),
    flow:obj.flow || '', network:obj.network || obj.net || (ws.path ? 'ws' : (grpc.service_name || grpc.serviceName ? 'grpc' : 'tcp')),
    sni:obj.sni || obj.servername || obj.server_name || tls.server_name || '',
    fingerprint:obj.fp || obj.fingerprint || '',
    publicKey:obj.publicKey || obj.public_key || reality.public_key || reality.pbk || '',
    shortId:obj.shortId || obj.short_id || reality.short_id || reality.sid || '',
    spiderX:obj.spiderX || obj.spider_x || reality.spider_x || reality.spx || '',
    path:obj.path || ws.path || '', host:obj.host || ws.headers?.Host || ws.headers?.host || '',
    serviceName:obj.serviceName || obj.service_name || grpc.service_name || grpc.serviceName || '',
    alpn:Array.isArray(tls.alpn)?tls.alpn.join(','):obj.alpn || '',
    insecure:obj.insecure===true || tls.insecure===true,
    privateKey:obj.privateKey || obj.private_key || '',
    preSharedKey:obj.preSharedKey || obj.pre_shared_key || '',
    localAddress:obj.localAddress || obj.local_address || ['10.0.0.2/32'],
    source: typeof obj.source==='string' ? obj.source : ''
  });
}

function convertSingboxOutbounds(outbounds) {
  const list=[];
  const walk=(item,fallback='Server')=>{
    if (!item) return;
    if (Array.isArray(item)) { for (const x of item) walk(x,fallback); return; }
    if (typeof item==='string') {
      if (/^(?:vless|vmess|trojan|ss|socks5?|hysteria2|hy2|wireguard|wg):\/\//i.test(item)) {
        try { const r=parseShareLink(item); if(r.kind==='server') pushSubscriptionServer(list,r.server); } catch {}
      }
      return;
    }
    if (typeof item!=='object') return;
    const type=protocolFromType(item.type || item.protocol);
    if (SUPPORTED_PROTOCOLS.has(type)) { const s=convertGenericProxyObject(item,fallback); if(s) pushSubscriptionServer(list,s); return; }
    if (Array.isArray(item.outbounds)) walk(item.outbounds,fallback);
    if (Array.isArray(item.proxies)) walk(item.proxies,fallback);
    if (Array.isArray(item.servers)) walk(item.servers,fallback);
    if (Array.isArray(item.nodes)) walk(item.nodes,fallback);
    if (Array.isArray(item.configs)) walk(item.configs,fallback);
    if (Array.isArray(item.profiles)) walk(item.profiles,fallback);
    for (const [k,v] of Object.entries(item)) {
      if (['outbounds','proxies','servers','nodes','configs','profiles'].includes(k)) continue;
      if (v && typeof v==='object') walk(v, item.name || item.remarks || k);
    }
  };
  walk(outbounds);
  return list;
}

export function addServer(input) {
  if (!settings) init();
  if (typeof input === 'string' && /^https?:\/\//i.test(input.trim())) return addSubscription(input.trim(), '');
  let parsed;
  if (typeof input === 'string') parsed = parseShareLink(input);
  else if (input?.protocol) parsed = { kind: 'server', server: normalizeServer(input) };
  else throw new Error('Некорректный сервер');
  if (parsed.kind !== 'server') throw new Error('Это не серверная ссылка');
  const existing = servers.findIndex(s => s.id === parsed.server.id || (s.address === parsed.server.address && s.port === parsed.server.port && s.uuid === parsed.server.uuid && s.password === parsed.server.password));
  if (existing >= 0) servers[existing] = { ...servers[existing], ...parsed.server };
  else servers.push(parsed.server);
  if (!settings.activeServerId) settings.activeServerId = parsed.server.id;
  save(); emit(); return structuredClone(parsed.server);
}
export function deleteServer(id) {
  id = normalizeEntityId(id);
  if (!settings) init();
  if (runtime.proc && settings.activeServerId === id) stop();
  servers = servers.filter(s => s.id !== id);
  if (settings.activeServerId === id) settings.activeServerId = servers[0]?.id || null;
  save(); emit(); return getServers();
}
export function updateServer(id, patch) {
  id = normalizeEntityId(id);
  if (!settings) init();
  const i = servers.findIndex(s => s.id === id); if (i < 0) throw new Error('Сервер не найден');
  servers[i] = normalizeServer({ ...servers[i], ...patch, id }); save(); emit(); return structuredClone(servers[i]);
}
export function selectServer(id) {
  id = normalizeEntityId(id);
  if (!settings) init(); if (!servers.some(s => s.id === id)) throw new Error('Сервер не найден');
  settings.activeServerId = id; save(); emit(); return structuredClone(servers.find(s=>s.id===id));
}

export async function toggleServer(id) {
  id = normalizeEntityId(id);
  if (!settings) init();
  const server=servers.find(s=>s.id===id);
  if(!server) throw new Error('Сервер не найден');
  if(runtime.proc && settings.activeServerId===id) return stop();
  if(runtime.proc) await stop();
  settings.activeServerId=id;
  save(); emit();
  return start({mode:settings.mode});
}
export function toggleFavoriteServer(id) {
  id = normalizeEntityId(id);
  const s = servers.find(x => x.id === id); if (!s) throw new Error('Сервер не найден'); s.favorite = !s.favorite; save(); emit(); return structuredClone(s);
}


function localDeviceId() {
  const seed = [process.platform, process.arch, os.hostname(), userDataDir()].join('|');
  return crypto.createHash('sha256').update(seed).digest('hex');
}
function subscriptionRequestHeaders(ua, extra={}) {
  return {
    'User-Agent': ua,
    'Accept': 'application/json, text/uri-list, text/plain, */*',
    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    'X-HWID': localDeviceId(),
    'X-Device-OS': process.platform === 'win32' ? 'windows' : process.platform,
    'X-Ver-OS': process.getSystemVersion?.() || '',
    'X-Device-Model': `Zapret Launcher ${process.arch}`,
    'Cache-Control': 'no-cache',
    ...extra
  };
}

async function requestText(url, headers = {}, attempt = 0) {
  return new Promise((resolve, reject) => {
    let current;
    try { current = new URL(url); } catch { reject(new Error('Некорректный URL')); return; }
    const lib = current.protocol === 'https:' ? https : http;
    const req = lib.get(current, { family: 4, timeout: 30000, headers: {
      'User-Agent':'Zapret-Launcher/1.4.5',
      Accept:'application/json, text/uri-list, text/plain, */*',
      'Accept-Language':'ru-RU,ru;q=0.9,en;q=0.8',
      'Accept-Encoding':'gzip, deflate, br',
      'Cache-Control':'no-cache',
      'X-HWID':localDeviceId(),
      'X-Device-OS':process.platform === 'win32' ? 'windows' : process.platform,
      'X-Ver-OS':process.getSystemVersion?.() || '',
      'X-Device-Model':`Zapret Launcher ${process.arch}`,
      ...headers
    } }, res => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        requestText(new URL(res.headers.location, current).toString(), headers, 0).then(resolve, reject);
        return;
      }
      if (code === 502 || code === 503 || code === 504) {
        const chunks=[]; res.setEncoding('utf8'); res.on('data',d=>chunks.push(d));
        res.on('end',()=>{
          const body=chunks.join('').trim();
          if (body && /(?:vless|vmess|trojan|ss|socks5?|hysteria2|hy2|wireguard|wg):\/\//i.test(body) || /^\s*[\[{]/.test(body)) {
            resolve({body,headers:res.headers,status:code}); return;
          }
          if (attempt < 2) {
            setTimeout(() => requestText(url, {...headers, 'Cache-Control':'no-cache', 'X-ZL-Retry':String(attempt+1)}, attempt+1).then(resolve, reject), 900 * (attempt + 1));
            return;
          }
          reject(new Error(`HTTP ${code}`));
        });
        return;
      }
      if (code < 200 || code >= 300) { res.resume(); reject(new Error(`HTTP ${code}`)); return; }
      let stream=res;
      const enc=String(res.headers['content-encoding']||'').toLowerCase();
      try {
        if (enc.includes('br')) stream=res.pipe(zlib.createBrotliDecompress());
        else if (enc.includes('gzip')) stream=res.pipe(zlib.createGunzip());
        else if (enc.includes('deflate')) stream=res.pipe(zlib.createInflate());
      } catch (e) { res.resume(); reject(e); return; }
      const chunks=[]; stream.setEncoding('utf8');
      stream.on('data', d=>chunks.push(d));
      stream.on('end', ()=>resolve({body:chunks.join(''), headers:res.headers, status:code}));
      stream.on('error', reject);
    });
    req.on('timeout', ()=>req.destroy(new Error('Таймаут')));
    req.on('error', reject);
  });
}

function parseCurlHeaders(raw) {
  const text=String(raw||'').replace(/\r/g,'');
  const blocks=text.split(/\n\n(?=HTTP\/)/i);
  const block=blocks[blocks.length-1]||text;
  const lines=block.split('\n');
  const headers={};
  for(const line of lines.slice(1)){
    const i=line.indexOf(':');
    if(i>0) headers[line.slice(0,i).trim().toLowerCase()]=line.slice(i+1).trim();
  }
  const m=/^HTTP\/\S+\s+(\d{3})/i.exec(lines[0]||'');
  return {status:m?Number(m[1]):0,headers};
}

async function requestTextWithCurl(url, headers = {}) {
  if(process.platform!=='win32') throw new Error('curl fallback доступен только в Windows');
  const ua=headers['User-Agent'] || headers['user-agent'] || 'Zapret-Launcher/1.4.5';
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zl-sub-'));
  const bodyFile=path.join(dir,'body.dat');
  const headersFile=path.join(dir,'headers.txt');
  const args=['-4','-L','--http2','--compressed','--max-time','45','--connect-timeout','15','--retry','3','--retry-delay','1','--retry-all-errors','-A',ua,'-H','Accept: application/json, text/uri-list, text/plain, */*','-H','Accept-Language: ru-RU,ru;q=0.9,en;q=0.8','-H',`X-HWID: ${headers['X-HWID']||localDeviceId()}`,'-H',`X-Device-OS: ${headers['X-Device-OS']||'windows'}`,'-H',`X-Ver-OS: ${headers['X-Ver-OS']||process.getSystemVersion?.()||''}`,'-H',`X-Device-Model: ${headers['X-Device-Model']||`Zapret Launcher ${process.arch}`}`,'-H','Cache-Control: no-cache','-D',headersFile,'-o',bodyFile,url];
  try{
    await execFileAsync('curl.exe',args,{windowsHide:true,timeout:50000,maxBuffer:1024*1024});
    const parsed=parseCurlHeaders(fs.readFileSync(headersFile,'utf8'));
    if(parsed.status<200 || parsed.status>=300) throw new Error(`HTTP ${parsed.status||0}`);
    let body=fs.readFileSync(bodyFile);
    const enc=String(parsed.headers['content-encoding']||'').toLowerCase();
    if(enc.includes('br')) body=zlib.brotliDecompressSync(body);
    else if(enc.includes('gzip')) body=zlib.gunzipSync(body);
    else if(enc.includes('deflate')) body=zlib.inflateSync(body);
    return {body:body.toString('utf8'),headers:parsed.headers,status:parsed.status};
  }finally{
    try{fs.rmSync(dir,{recursive:true,force:true})}catch{}
  }
}

function isPlaceholderServer(s) {
  const address = String(s?.address || '').trim().toLowerCase();
  const name = String(s?.name || '').trim().toLowerCase();
  const port = Number(s?.port || 0);
  return address === '0.0.0.0' || address === '::' || port === 1 || /данное приложение не поддерживается|this app is not supported|not supported/i.test(name);
}

function pushSubscriptionServer(out, s) {
  if (!s || isPlaceholderServer(s)) return;
  const normalized = normalizeServer(s);
  if (!normalized.address || !normalized.port || normalized.port < 1 || normalized.port > 65535) return;
  const key = JSON.stringify([normalized.protocol, normalized.address, normalized.port, normalized.uuid || '', normalized.password || '', normalized.publicKey || '']);
  if (!out.some(x => JSON.stringify([x.protocol, x.address, x.port, x.uuid || '', x.password || '', x.publicKey || '']) === key)) out.push(normalized);
}

function convertXrayOutboundObject(obj, fallbackName='Server') {
  if (!obj || typeof obj !== 'object') return null;
  const p = protocolFromType(obj.protocol || obj.type || '');
  if (!SUPPORTED_PROTOCOLS.has(p)) return null;
  const st = obj.settings && typeof obj.settings === 'object' ? obj.settings : {};
  const stream = obj.streamSettings && typeof obj.streamSettings === 'object' ? obj.streamSettings : {};
  const tls = stream.tlsSettings && typeof stream.tlsSettings === 'object' ? stream.tlsSettings : {};
  const reality = stream.realitySettings && typeof stream.realitySettings === 'object' ? stream.realitySettings : {};
  const ws = stream.wsSettings && typeof stream.wsSettings === 'object' ? stream.wsSettings : {};
  const grpc = stream.grpcSettings && typeof stream.grpcSettings === 'object' ? stream.grpcSettings : {};
  const http2 = stream.httpSettings && typeof stream.httpSettings === 'object' ? stream.httpSettings : {};
  const server0 = Array.isArray(st.servers) ? st.servers[0] : null;
  const vnext0 = Array.isArray(st.vnext) ? st.vnext[0] : null;
  const user0 = vnext0 && Array.isArray(vnext0.users) ? vnext0.users[0] : null;
  const address = vnext0?.address || server0?.address || obj.address || obj.server || '';
  const port = Number(vnext0?.port || server0?.port || obj.port || 0);
  if (!address || !port) return null;

  if (p === 'vless' || p === 'vmess') {
    return normalizeServer({
      name: meaningfulServerName(obj.remarks || obj.name || (obj.tag && !isGenericServerName(obj.tag) ? obj.tag : '') || fallbackName, address, p), protocol:p, core:'xray',
      address, port, uuid:user0?.id || obj.uuid || '', alterId:Number(user0?.alterId || 0),
      security:p === 'vless' ? inferVlessSecurity({
        protocol:'vless',
        security:user0?.security || '',
        flow:user0?.flow || '',
        publicKey:reality.publicKey || '', shortId:reality.shortId || '', spiderX:reality.spiderX || '',
      }) : (user0?.security || (tls.enabled ? 'tls' : (reality.enabled ? 'reality' : 'none'))),
      flow:user0?.flow || '', network:stream.network || 'tcp',
      sni:tls.serverName || reality.serverName || '', fingerprint:tls.fingerprint || reality.fingerprint || '',
      publicKey:reality.publicKey || '', shortId:reality.shortId || '', spiderX:reality.spiderX || '',
      path:ws.path || http2.path || '', host:Array.isArray(ws.headers?.Host)?ws.headers.Host[0]:ws.headers?.Host || (Array.isArray(http2.host)?http2.host[0]:http2.host || ''),
      serviceName:grpc.serviceName || '', alpn:Array.isArray(tls.alpn)?tls.alpn.join(','): '',
      insecure:tls.allowInsecure === true, source: typeof obj.source==='string' ? obj.source : ''
    });
  }
  if (p === 'trojan') {
    return normalizeServer({
      name:meaningfulServerName(obj.remarks || obj.name || (obj.tag && !isGenericServerName(obj.tag) ? obj.tag : '') || fallbackName, address, 'trojan'), protocol:'trojan', core:'xray', address, port,
      password:server0?.password || obj.password || '', network:stream.network || 'tcp', security:'tls',
      sni:tls.serverName || '', fingerprint:tls.fingerprint || '', path:ws.path || http2.path || '',
      host:Array.isArray(ws.headers?.Host)?ws.headers.Host[0]:ws.headers?.Host || (Array.isArray(http2.host)?http2.host[0]:http2.host || ''),
      serviceName:grpc.serviceName || '', alpn:Array.isArray(tls.alpn)?tls.alpn.join(','):'',
      insecure:tls.allowInsecure===true, source:typeof obj.source==='string'?obj.source:''
    });
  }
  if (p === 'shadowsocks') {
    return normalizeServer({name:meaningfulServerName(obj.remarks || obj.name || (obj.tag && !isGenericServerName(obj.tag) ? obj.tag : '') || fallbackName, address, 'shadowsocks'),protocol:'shadowsocks',core:'xray',address,port,method:server0?.method || '',password:server0?.password || '',source:typeof obj.source==='string'?obj.source:''});
  }
  if (p === 'socks' || p === 'http') {
    return normalizeServer({name:meaningfulServerName(obj.remarks || obj.name || (obj.tag && !isGenericServerName(obj.tag) ? obj.tag : '') || fallbackName, address, p),protocol:p,core:'xray',address,port,username:server0?.users?.[0]?.user || '',password:server0?.users?.[0]?.pass || '',source:typeof obj.source==='string'?obj.source:''});
  }
  return null;
}

function parseXrayJsonValue(value, out, fallbackName='Server') {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) parseXrayJsonValue(item,out,fallbackName);
    return;
  }
  if (typeof value === 'string') {
    const t=value.trim();
    if (/^(?:vless|vmess|trojan|ss|socks5?|hysteria2|hy2|wireguard|wg):\/\//i.test(t)) {
      try { const r=parseShareLink(t); if(r.kind==='server') pushSubscriptionServer(out,r.server); } catch {}
      return;
    }
    const decoded=decodeMaybeBase64(t).trim();
    if (decoded && decoded!==t) {
      if (/^(?:vless|vmess|trojan|ss|socks5?|hysteria2|hy2|wireguard|wg):\/\//i.test(decoded)) {
        try { const r=parseShareLink(decoded); if(r.kind==='server') pushSubscriptionServer(out,r.server); } catch {}
      } else if (/^[\[{]/.test(decoded)) {
        try { parseXrayJsonValue(JSON.parse(decoded),out,fallbackName); } catch {}
      }
    }
    return;
  }
  if (typeof value !== 'object') return;

  const xrayDirect=convertXrayOutboundObject(value,fallbackName);
  if (xrayDirect) { pushSubscriptionServer(out,xrayDirect); return; }
  const direct=convertGenericProxyObject(value,fallbackName);
  if (direct) { pushSubscriptionServer(out,direct); return; }

  if (Array.isArray(value.outbounds)) {
    for (const outbound of value.outbounds) {
      const xray=convertXrayOutboundObject(outbound, outbound?.tag || value.name || fallbackName);
      if (xray) pushSubscriptionServer(out,xray);
      else parseXrayJsonValue(outbound,out,outbound?.tag || value.name || fallbackName);
    }
  }

  for (const key of ['outbounds','proxies','servers','nodes','configs','profiles','items','data','configs_json','links']) {
    if (value[key] != null) parseXrayJsonValue(value[key],out,value.name || value.remarks || key);
  }

  // Путь для JSON, где сервер лежит в произвольном поле объекта.
  for (const [key,val] of Object.entries(value)) {
    if (['outbounds','proxies','servers','nodes','configs','profiles','items','data','configs_json','links'].includes(key)) continue;
    if (val && typeof val === 'object') parseXrayJsonValue(val,out,value.name || value.remarks || key);
    else if (typeof val === 'string' && /^(?:vless|vmess|trojan|ss|socks5?|hysteria2|hy2|wireguard|wg):\/\//i.test(val.trim())) parseXrayJsonValue(val,out,key);
  }
}

function looksLikeHtml(raw) { return /^<!doctype html|^<html[\s>]/i.test(String(raw||'').trim()); }

function parseSubscriptionBody(body) {
  const source = String(body||'');
  const decoded = decodeMaybeBase64(source).replace(/^\uFEFF/,'').trim();
  const out=[];

  if (/^[\[{]/.test(decoded)) {
    try { parseXrayJsonValue(JSON.parse(decoded),out,'VPN'); } catch {}
  }

  // Иногда провайдер возвращает JSON внутри строки/поля data.
  if (!out.length && /\"(?:outbounds|proxies|servers|configs|nodes|links)\"\s*:/.test(decoded)) {
    try { parseXrayJsonValue(JSON.parse(decoded),out,'VPN'); } catch {}
  }

  const lines = decoded.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^#|^;/.test(line)) continue;
    const matches=line.match(/(?:vless|vmess|trojan|ss|socks5?|hysteria2|hy2|wireguard|wg):\/\/[^\s"'<>]+/ig)||[];
    for(const link of matches){
      try { const r=parseShareLink(link); if(r.kind==='server') pushSubscriptionServer(out,r.server); } catch {}
    }
  }

  if (!out.length && looksLikeHtml(decoded)) {
    throw new Error('Сервер вернул HTML вместо VPN-подписки. Будет выполнена попытка с другим User-Agent.');
  }
  if (!out.length) throw new Error('В подписке не найдено поддерживаемых серверов. Проверьте формат подписки или User-Agent.');
  return out;
}

async function fetchSubscription(url, preferredUserAgent='') {
  const agents=[preferredUserAgent, settings?.subscriptionUserAgent, ...SUBSCRIPTION_USER_AGENTS, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0 Safari/537.36'].filter(Boolean);
  const unique=[...new Set(agents)];
  let lastError=null;
  const transports=[];
  if(process.platform==='win32') transports.push(requestTextWithCurl);
  transports.push(requestText);
  for(const ua of unique){
    const hdr=subscriptionRequestHeaders(ua);
    for(const transport of transports){
      try{
        const result=await transport(url,hdr);
        if(result.status===304) continue;
        const list=parseSubscriptionBody(result.body);
        const remoteUa=result.headers?.['change-user-agent']||result.headers?.['x-change-user-agent']||''; return {list,userAgent:remoteUa||ua,headers:result.headers,body:result.body};
      }catch(e){ lastError=e; }
    }
  }
  const code=String(lastError?.message||'');
  if(/^HTTP (?:502|503|504)$/.test(code)) {
    throw new Error(`Сервер подписки вернул HTTP 502/503/504. Zapret Launcher уже попробовал HAPP, INCY и v2rayTun User-Agent, X-HWID и резервный транспорт Windows. Это означает, что сам endpoint сейчас не отдает конфигурацию или отклоняет запрос. Проверьте User-Agent в Настройки → VPN и повторите обновление.`);
  }
  throw lastError || new Error('Не удалось получить подписку');
}

export async function addSubscription(url, name = '') {
  if (!settings) init();
  const id = idFor(`sub:${url}`);
  const sub = { id, name: subscriptionDisplayName(url, name), url, createdAt: Date.now(), updatedAt: 0, count: 0, error: null };
  const old = subscriptions.findIndex(x=>x.id===id);
  if (old>=0) subscriptions[old] = { ...subscriptions[old], ...sub }; else subscriptions.push(sub);
  save();
  return refreshSubscription(id);
}
export async function refreshSubscription(id) {
  if (!settings) init();
  const sub=subscriptions.find(x=>x.id===id); if(!sub) throw new Error('Подписка не найдена');
  try {
    const fetched=await fetchSubscription(sub.url,sub.userAgent||'');
    const previous = new Map(servers.filter(s=>s.subscriptionId===id).map(s=>[s.id, s]));
    const list=fetched.list.map(s=>{
      const seed = [id, s.id || '', s.source || '', s.protocol || '', s.address || '', s.port || 0].join('|');
      const next=normalizeServer({...s, id:idFor(seed), subscriptionId:id});
      const old=previous.get(next.id);
      return old ? {...next, favorite:!!old.favorite, latency:old.latency} : next;
    });
    servers = servers.filter(s=>s.subscriptionId!==id);
    servers.push(...list);
    sub.updatedAt=Date.now(); sub.count=list.length; sub.error=null; sub.userAgent=fetched.userAgent; sub.contentType=fetched.headers?.['content-type']||''; sub.profileTitle=fetched.headers?.['profile-title']||fetched.headers?.['subscription-title']||sub.name; sub.trafficInfo=fetched.headers?.['subscription-userinfo']||''; sub.supportUrl=fetched.headers?.['support-url']||''; sub.websiteUrl=fetched.headers?.['profile-web-page-url']||''; sub.announce=fetched.headers?.['announce']||'';
    if (!settings.activeServerId || !servers.some(s => s.id===settings.activeServerId)) settings.activeServerId=list[0]?.id || servers[0]?.id || null;
    save(); emit(); return structuredClone(sub);
  } catch (e) {
    sub.error=String(e?.message||e); save(); throw e;
  }
}
export async function refreshAllSubscriptions() {
  if (!settings) init();
  const results=[];
  for (const s of subscriptions) { try { results.push(await refreshSubscription(s.id)); } catch (e) { results.push({ ...s, error:String(e?.message||e) }); } }
  return results;
}
export function deleteSubscription(id) {
  subscriptions = subscriptions.filter(s=>s.id!==id); servers=servers.filter(s=>s.subscriptionId!==id); if(settings.activeServerId && !servers.some(s=>s.id===settings.activeServerId)) settings.activeServerId=servers[0]?.id||null; save(); emit(); return getSubscriptions();
}

function xrayOutbound(server) {
  const s = server?.protocol === 'vless' ? normalizeServer(server) : server;
  if (s.protocol === 'vless') {
    const out={ protocol:'vless', settings:{ vnext:[{address:s.address, port:s.port, users:[{id:s.uuid, encryption:s.encryption||'none', flow:s.flow||undefined}]}] }, streamSettings:{ network:s.network||'tcp' } };
    if (s.security === 'reality') {
      out.streamSettings.security='reality'; out.streamSettings.realitySettings={show:false, fingerprint:s.fingerprint||'chrome', serverName:s.sni||s.address, publicKey:s.publicKey||'', shortId:s.shortId||'', spiderX:s.spiderX||''};
    } else if (s.security === 'tls') {
      out.streamSettings.security='tls'; out.streamSettings.tlsSettings={serverName:s.sni||s.address, fingerprint:s.fingerprint||undefined, allowInsecure:!!s.insecure, alpn:s.alpn?s.alpn.split(','):undefined};
    }
    applyTransport(out.streamSettings,s); return out;
  }
  if (s.protocol === 'vmess') {
    const out={protocol:'vmess', settings:{vnext:[{address:s.address,port:s.port,users:[{id:s.uuid,alterId:Number(s.alterId||0),security:s.security||'auto'}]}]}, streamSettings:{network:s.network||'tcp'}};
    if (s.tls==='tls' || s.security==='tls') { out.streamSettings.security='tls'; out.streamSettings.tlsSettings={serverName:s.sni||s.address, allowInsecure:!!s.insecure, fingerprint:s.fingerprint||undefined}; }
    applyTransport(out.streamSettings,s); return out;
  }
  if (s.protocol === 'trojan') {
    const out={protocol:'trojan',settings:{servers:[{address:s.address,port:s.port,password:s.password,level:0}],},streamSettings:{network:s.network||'tcp'}};
    out.streamSettings.security='tls'; out.streamSettings.tlsSettings={serverName:s.sni||s.address, allowInsecure:!!s.insecure, fingerprint:s.fingerprint||undefined};
    applyTransport(out.streamSettings,s); return out;
  }
  if (s.protocol === 'shadowsocks') return {protocol:'shadowsocks',settings:{servers:[{address:s.address,port:s.port,method:s.method,password:s.password,level:0}]}};
  if (s.protocol === 'socks') return {protocol:'socks',settings:{servers:[{address:s.address,port:s.port,users:s.username?[{user:s.username,pass:s.password||''}]:undefined}]}};
  if (s.protocol === 'http') return {protocol:'http',settings:{servers:[{address:s.address,port:s.port,users:s.username?[{user:s.username,pass:s.password||''}]:undefined}]}};
  throw new Error(`Xray не поддерживает ${s.protocol}`);
}
function applyTransport(ss, s) {
  const n=ss.network||'tcp';
  if (n==='ws') ss.wsSettings={path:s.path||'/', headers:s.host?{Host:s.host}:undefined};
  else if (n==='grpc') ss.grpcSettings={serviceName:s.serviceName||'', multiMode:false};
  else if (n==='http' || n==='h2') ss.httpSettings={path:s.path||'/',host:s.host?[s.host]:undefined};
  else if (n==='tcp' && s.headerType && s.headerType!=='none') ss.tcpSettings={header:{type:s.headerType}};
  if (s.fragment) { ss.sockopt=ss.sockopt||{}; ss.sockopt.tcpFastOpen=true; }
}

function singboxOutbound(s) {
  const o={tag:'proxy',type:s.protocol,server:s.address,server_port:s.port};
  if(s.protocol==='vless') {
    o.uuid=s.uuid||'';
    if(s.flow) o.flow=s.flow;
    // Do not force sing-box VLESS to TCP-only just because the link declares
    // network=tcp. With no `network` field sing-box allows both TCP and UDP;
    // this is required for UDP traffic from a TUN inbound (especially DNS).
    // Keep an explicit UDP request, while WS/gRPC/HTTP transports remain TCP.
    if(s.network === 'udp') o.network='udp';
    if(s.flow === 'xtls-rprx-vision' || /^xtls-rprx-vision-udp443$/.test(s.flow||'')) o.packet_encoding='xudp';
    const security=s.security||'';
    if(security==='reality') {
      o.tls={enabled:true,server_name:s.sni||s.address,insecure:!!s.insecure,reality:{enabled:true,public_key:s.publicKey||'',short_id:s.shortId||''}};
    } else if(security==='tls') {
      o.tls={enabled:true,server_name:s.sni||s.address,insecure:!!s.insecure};
    }
    if(s.alpn) o.tls={...(o.tls||{enabled:true}),alpn:String(s.alpn).split(',').map(x=>x.trim()).filter(Boolean)};
    if(s.fingerprint) o.tls={...(o.tls||{enabled:true}),utls:{enabled:true,fingerprint:s.fingerprint}};
    if(s.network==='ws') o.transport={type:'ws',path:s.path||'/',headers:s.host?{Host:s.host}:undefined};
    else if(s.network==='grpc') o.transport={type:'grpc',service_name:s.serviceName||''};
    else if(s.network==='http' || s.network==='h2') o.transport={type:'http',path:s.path||'',host:s.host?[s.host]:undefined};
    return o;
  }
  if(s.protocol==='vmess') {
    o.uuid=s.uuid||''; o.security=s.security||'auto'; o.alter_id=Number(s.alterId||0); o.network=s.network||'tcp';
    if(s.security==='tls' || s.tls==='tls') o.tls={enabled:true,server_name:s.sni||s.address,insecure:!!s.insecure};
    if(s.network==='ws') o.transport={type:'ws',path:s.path||'/',headers:s.host?{Host:s.host}:undefined};
    else if(s.network==='grpc') o.transport={type:'grpc',service_name:s.serviceName||''};
    return o;
  }
  if(s.protocol==='trojan') {
    o.password=s.password||''; o.network=s.network||'tcp'; o.tls={enabled:true,server_name:s.sni||s.address,insecure:!!s.insecure};
    if(s.alpn) o.tls.alpn=String(s.alpn).split(',').map(x=>x.trim()).filter(Boolean);
    if(s.fingerprint) o.tls.utls={enabled:true,fingerprint:s.fingerprint};
    if(s.network==='ws') o.transport={type:'ws',path:s.path||'/',headers:s.host?{Host:s.host}:undefined};
    else if(s.network==='grpc') o.transport={type:'grpc',service_name:s.serviceName||''};
    return o;
  }
  if(s.protocol==='hysteria2') { o.password=s.password||''; o.tls={enabled:true,server_name:s.sni||s.address,insecure:!!s.insecure}; if(s.obfs) o.obfs={type:s.obfs,password:s.obfsPassword||''}; return o; }
  if(s.protocol==='wireguard') return {...o,private_key:s.privateKey||'',peer_public_key:s.publicKey||'',pre_shared_key:s.preSharedKey||'',local_address:s.localAddress||['10.0.0.2/32']};
  return o;
}

function routeForConfig(routeProfile) {
  const r=routes.find(x=>x.id===routeProfile) || routes[0];
  const rules=[];
  if (r?.mode==='split') {
    if (r.block?.length) rules.push({domain:r.block,outboundTag:'block'});
    if (r.direct?.length) rules.push({domain:r.direct,outboundTag:'direct'});
    if (r.domains?.length) rules.push({domain:r.domains,outboundTag:'proxy'});
  }
  // final:'proxy' обязателен: без него весь остальной трафик шёл бы напрямую,
  // и при «Глобальном» профиле реальный IP не менялся бы.
  return { routing:{domainStrategy:'IPIfNonMatch', final:'proxy', rules} };
}

// Те же правила в формате sing-box (route.rules + route.final).
function singboxRouteRules({includeTunSniff=false} = {}) {
  const r=routes.find(x=>x.id===settings.routeProfile) || routes[0];
  const rules=[];

  // sing-box 1.13+ removed legacy route/inbound sniff fields.
  // In TUN mode sniffing is now an explicit route action.
  if (includeTunSniff) rules.push({inbound:['tun-in'], action:'sniff'});

  if (r?.mode==='split') {
    // sing-box 1.11+ uses route actions instead of the legacy outbound_tag field.
    if (r.block?.length) rules.push({domain:r.block, action:'route', outbound:'block'});
    if (r.direct?.length) rules.push({domain:r.direct, action:'route', outbound:'direct'});
    if (r.domains?.length) rules.push({domain:r.domains, action:'route', outbound:'proxy'});
  }
  return rules;
}

// Имя TUN-адаптера должно соответствовать требованиям Windows (Wintun/tun2socks):
// только латиница/цифры/-/_ , длина до 31 символа. Пользовательское значение
// («Имя TUN» в настройках) нормализуется, иначе ядро падает с
// "Failed to find matching adapter name: Элемент не найден. (Code 0x00000490)".
function normalizeTunName(name) {
  const cleaned = String(name || '').trim().replace(/[^A-Za-z0-9\-_ ]/g, '').replace(/\s+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 31);
  return cleaned || 'Zapret';
}
function tunAdapterName() { return normalizeTunName(settings?.tunName || DEFAULTS.tunName); }

function normalizeVpnMode(mode) {
  return ['proxy','tun','mixed'].includes(mode) ? mode : 'proxy';
}

function isTunMode(mode) { return mode === 'tun' || mode === 'mixed'; }

function normalizeTunSettings(s) {
  if (!s) return;
  s.tunName = normalizeTunName(s.tunName);
  // «singbox» из старых версий настроек — недопустимое значение ядра: приводим к «sing-box».
  if (s.tunCore === 'singbox' || s.tunCore === 'sing_box') s.tunCore = 'sing-box';
  if (!['sing-box', 'xray'].includes(s.tunCore)) s.tunCore = DEFAULTS.tunCore;
}

// Xray ищет wintun.dll рядом с xray.exe (или в System32). Без неё режим TUN на
// свежем Xray не поднимает интерфейс — копируем DLL из каталога sing-box при необходимости.
async function ensureXrayWintunDll(xrayExePath) {
  try {
    const dir = path.dirname(xrayExePath);
    const dst = path.join(dir, 'wintun.dll');
    if (fs.existsSync(dst)) return true;
    const found = findExe(CORES_DIR(), 'wintun.dll');
    if (found) { fs.copyFileSync(found, dst); console.log('[proxy] wintun.dll скопирована в каталог Xray для режима TUN'); return true; }
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wintun.dll');
    if (fs.existsSync(sys)) { fs.copyFileSync(sys, dst); return true; }
    console.warn('[proxy] wintun.dll не найдена: режим TUN на ядре Xray может быть недоступен (используйте ядро sing-box)');
  } catch (e) { console.warn('[proxy] Не удалось подготовить wintun.dll:', e?.message || e); }
  return false;
}

function buildXrayConfig(server, mode='proxy') {
  const route=routeForConfig(settings.routeProfile);
  const tunSettings={name:tunAdapterName(),mtu:Number(settings.mtu||1500),gateway:['198.18.0.1/15'],address:['198.18.0.1/15'],dns:settings.dns||['1.1.1.1','8.8.8.8'],poolSize:2,onDropped:'bypass'};
  settings.tunAddress=tunSettings.gateway;
  if(isTunMode(mode)){
    // Keep Xray's outbound sockets on the physical interface. On Windows, this build
    // reliably creates the Wintun adapter but does not consistently materialize the
    // requested /1 routes; the Launcher therefore installs the two IPv4 routes itself
    // immediately after the exact adapter is confirmed Up.
    tunSettings.autoOutboundsInterface='auto';
  }
  const inbounds= isTunMode(mode) ? [{tag:'tun-in',port:0,protocol:'tun',settings:tunSettings}] : [{tag:'socks-in',listen:'127.0.0.1',port:Number(settings.socksPort||10808),protocol:'socks',settings:{udp:true,accounts:settings.socksAuthMode==='manual'&&settings.socksAuthUser?[{user:settings.socksAuthUser,pass:settings.socksAuthPassword||''}]:undefined},sniffing:{enabled:true,destOverride:['http','tls','quic']}},{tag:'http-in',listen:'127.0.0.1',port:Number(settings.httpPort||10809),protocol:'http',settings:{accounts:settings.httpAuthMode==='manual'&&settings.httpAuthUser?[{user:settings.httpAuthUser,pass:settings.httpAuthPassword||''}]:undefined}}];
  const outbounds=[{tag:'proxy',...xrayOutbound(server)},{tag:'direct',protocol:'freedom',settings:{}},{tag:'block',protocol:'blackhole',settings:{}}];
  // ВАЖНО: поле называется `outbounds` и это массив. Ранее сюда попадал пустой объект {},
  // из-за чего Xray запускался без outbound'а `proxy`, правила маршрутизации TUN не
  // применялись (весь трафик шёл напрямую), а UI показывал «работает».
  return {log:{loglevel:'info'},dns:{servers:[...(settings.dns||['1.1.1.1','8.8.8.8'])]},inbounds,outbounds,routing:route.routing};
}

// Xray принимает outbounds только как массив; finalize гарантирует, что в конфиге
// всегда есть outbound `proxy` (без него трафик шёл бы напрямую, а UI — «работает»).
function finalizeXrayConfig(cfg, server) { cfg.outbounds=[{tag:'proxy',...xrayOutbound(server)},{tag:'direct',protocol:'freedom',settings:{}},{tag:'block',protocol:'blackhole',settings:{}}]; return cfg; }

async function resolveOutboundServerIps(server) {
  const host=String(server?.address||'').trim();
  if (!host) return [];
  // IP literals need no DNS lookup.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    return [host];
  }
  try {
    const rows=await dns.promises.lookup(host,{all:true,verbatim:true});
    return rows.map(x=>String(x.address||'').trim()).filter(Boolean);
  } catch (e) {
    console.warn('[proxy] Не удалось заранее разрешить адрес upstream-сервера для TUN route_exclude_address:', e?.message||e);
    return [];
  }
}

async function buildSingboxConfig(server, mode='tun') {
  const outbound=singboxOutbound(server);
  const localInbounds=[
    {type:'mixed',tag:'mixed-http-in',listen:'127.0.0.1',listen_port:Number(settings.httpPort||10809)},
    {type:'mixed',tag:'mixed-socks-in',listen:'127.0.0.1',listen_port:Number(settings.socksPort||10808)}
  ];
  if (!isTunMode(mode)) {
    return {
      log:{level:'warn'},
      inbounds:localInbounds,
      outbounds:[outbound,{type:'direct',tag:'direct'},{type:'block',tag:'block'}],
      route:{final:'proxy',auto_detect_interface:true,rules:singboxRouteRules()}
    };
  }

  // sing-box 1.13+ removed legacy inbound.sniff and route.sniff fields.
  // Sniffing is configured through an explicit route action instead.
  // interface_name — normalized Windows-safe name (Latin letters/digits/-/_).
  // Exclude the actual upstream server IPs from the TUN routes.
  // Without this, Windows can route the VLESS connection itself back into TUN,
  // producing the characteristic `unknown version: 72` loop symptom.
  const upstreamIps=await resolveOutboundServerIps(server);
  const routeExclude=[...new Set(upstreamIps.map(ip => ip.includes(':') ? `${ip}/128` : `${ip}/32`))];
  if (routeExclude.length) {
    console.log('[proxy] TUN upstream route exclusions:', routeExclude.join(', '));
  }
  return {
    log:{level:'warn'},
    inbounds:[
      ...localInbounds,
      {
        type:'tun',
        tag:'tun-in',
        interface_name:tunAdapterName(),
        address:['172.19.0.1/30','fdfe:dcba:9876::1/126'],
        mtu:Number(settings.mtu||1500),
        auto_route:true,
        strict_route:false,
        ...(routeExclude.length ? {route_exclude_address:routeExclude} : {})
      }
    ],
    outbounds:[outbound,{type:'direct',tag:'direct'},{type:'block',tag:'block'}],
    route:{final:'proxy',auto_detect_interface:true,rules:singboxRouteRules({includeTunSniff:true})}
  };
}

async function powerShellExpand(zip, dest) {
  const ps = `Expand-Archive -LiteralPath ${quotePs(zip)} -DestinationPath ${quotePs(dest)} -Force`;
  await execFileAsync(process.env.ComSpec || 'cmd.exe', process.platform==='win32' ? ['/c','powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-Command',ps] : [''], {windowsHide:true});
}
function quotePs(s) { return `'${String(s).replace(/'/g,"''")}'`; }

async function fetchLatestAsset(repo, matcher) {
  const info = await requestText(`https://api.github.com/repos/${repo}/releases/latest`, {'User-Agent':'Zapret-Launcher/1.4.6','Accept':'application/vnd.github+json'});
  const raw = (info && typeof info === 'object' && 'body' in info) ? info.body : info;
  let j;
  try { j = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw new Error(`GitHub API вернул некорректный JSON для ${repo}`); }
  if (!j || typeof j !== 'object') throw new Error(`GitHub API не вернул данные релиза ${repo}`);
  const arr=(Array.isArray(j.assets)?j.assets:[]).filter(a=>a && matcher.test(String(a.name||'')));
  if(!arr.length) throw new Error(`В релизе ${repo} нет подходящего Windows x64 архива`);
  return {version:j.tag_name, ...arr[0]};
}
async function download(url, dest) {
  return new Promise((resolve,reject)=>{
    const lib=url.startsWith('https:')?https:http; const f=fs.createWriteStream(dest);
    const req=lib.get(url,{headers:{'User-Agent':'Zapret-Launcher/1.4.0'},family:4},res=>{
      if(res.statusCode>=300&&res.statusCode<400&&res.headers.location){f.close();fs.rmSync(dest,{force:true});return download(new URL(res.headers.location,url).toString(),dest).then(resolve,reject);}
      if((res.statusCode||0)<200||(res.statusCode||0)>=300){f.close();fs.rmSync(dest,{force:true});return reject(new Error(`HTTP ${res.statusCode||0}`));}
      res.pipe(f);f.on('finish',()=>f.close(resolve));
    });
    req.on('error',e=>{try{f.close()}catch{};fs.rmSync(dest,{force:true});reject(e);});
  });
}
async function getCoreVersion(exe) {
  try {
    const name=path.basename(exe||'').toLowerCase();
    const args=name.startsWith('sing-box')?['version']:['version'];
    const {stdout,stderr}=await execFileAsync(exe,args,{windowsHide:true,timeout:8000,maxBuffer:16*1024});
    const text=String(stdout||stderr||'');
    const m=text.match(/(?:Xray|sing-box)\s+v?(\d+\.\d+\.\d+)/i);
    return m?m[1]:'';
  } catch { return ''; }
}

async function ensureCore(core) {
  ensureDirs();
  if(process.platform!=='win32') throw new Error('Прокси-ядро для этой сборки рассчитано на Windows.');
  if(core==='sing-box') {
    const exe=path.join(SINGBOX_DIR(),'sing-box.exe'); if(fs.existsSync(exe)) return exe;
    const a=await fetchLatestAsset('SagerNet/sing-box',/windows-amd64\.zip$/i);
    const zip=path.join(os.tmpdir(),`sing-box-${Date.now()}.zip`); await download(a.browser_download_url,zip); await powerShellExpand(zip,SINGBOX_DIR()); fs.rmSync(zip,{force:true});
    const found=findExe(SINGBOX_DIR(),'sing-box.exe'); if(!found) throw new Error('После распаковки sing-box.exe не найден'); return found;
  }
  const exe=path.join(XRAY_DIR(),'xray.exe'); if(fs.existsSync(exe)) return exe;
  const a=await fetchLatestAsset('XTLS/Xray-core',/Xray-windows-64\.zip$/i);
  const zip=path.join(os.tmpdir(),`xray-${Date.now()}.zip`); await download(a.browser_download_url,zip); await powerShellExpand(zip,XRAY_DIR()); fs.rmSync(zip,{force:true});
  const found=findExe(XRAY_DIR(),'xray.exe'); if(!found) throw new Error('После распаковки xray.exe не найден'); return found;
}
function findExe(root,name){if(fs.existsSync(path.join(root,name)))return path.join(root,name); for(const ent of fs.readdirSync(root,{withFileTypes:true})){if(ent.isDirectory()){const p=findExe(path.join(root,ent.name),name);if(p)return p;}}return null;}

function decodeOemText(raw) {
  // Логи ядер на Windows пишутся в OEM-кодировке (CP866) — при перенаправлении
  // кириллица превращается в «╨Т╨╜╨╡╤И╨╜╤П...». Восстанавливаем байты и читаем как UTF-8.
  let msg = String(raw || '');
  try {
    if (/[\u2500-\u257F]{2}/.test(msg)) {
      const bytes = Uint8Array.from(Buffer.from(msg, 'binary'));
      const fixed = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      if (/[\u0400-\u04FF]/.test(fixed)) msg = fixed;
    }
  } catch {}
  return msg;
}

async function validateCore(exe, configPath) {
  // Флаги проверки конфигурации различаются у ядер:
  //   xray      : `xray -test -config <файл>`        (без подкоманды run!)
  //   sing-box  : `sing-box check -c <файл>`          (`-t`/`-test` не поддерживаются)
  const name = path.basename(exe).toLowerCase();
  const args = name.startsWith('sing-box')
    ? ['check', '-c', configPath]
    : ['-test', '-config', configPath];
  try {
    await execFileAsync(exe, args, { windowsHide: true, timeout: 25000 });
    return true;
  } catch (e) {
    const raw = String(e?.stderr || e?.stdout || e?.message || e);
    // Не показываем в UI «кракозябры»: байты CP866/OEM декодируем в читаемый текст.
    const msg = decodeOemText(raw);
    // Предупреждения о деприкации WebSocket/host не должны выглядеть как ошибка.
    const lines = msg.split(/\r?\n/).map(x=>x.trim()).filter(Boolean)
      .filter(x => !/^Xray \d|A unified platform|^sing-box version|^$/.test(x))
      // Деприкационные предупреждения (WebSocket, host в headers и т.п.) — не ошибки:
      // конфиг рабочий, показывать их как причину сбоя проверки нельзя.
      .filter(x => !/\[Warning\]|deprecated|migrate to|Please update your config/i.test(x));
    const fatal = lines.filter(x => /error|fatal|failed|invalid|unknown/i.test(x));
    if (!lines.length && !fatal.length) return true; // остались только warnings — ок
    const detail = (fatal.length ? fatal : lines).join('\n').slice(0, 1200) || 'неизвестная ошибка';
    throw new Error(`Проверка конфигурации не пройдена: ${detail}`);
  }
}

async function findFreeTcpPort(startPort, reserved=new Set()) {
  let port=Math.max(1024, Number(startPort)||10808);
  for(let i=0;i<100;i++,port++){
    if(reserved.has(port)) continue;
    const free=await new Promise(resolve=>{
      const tester=new Socket(); let done=false;
      const finish=v=>{if(done)return;done=true;tester.destroy();resolve(v)};
      tester.setTimeout(250,()=>finish(true));
      tester.once('connect',()=>finish(false));
      tester.once('error',()=>finish(true));
      tester.connect(port,'127.0.0.1');
    });
    if(free) return port;
  }
  throw new Error('Не удалось найти свободный локальный порт');
}

async function readWinRegValue(pathKey, name) {
  try {
    const r=await execFileAsync('reg.exe',['query',pathKey,'/v',name],{windowsHide:true});
    const m=/\s+REG_(?:DWORD|SZ|EXPAND_SZ)\s+(.+?)\s*$/im.exec(r.stdout||'');
    return m ? m[1].trim() : null;
  } catch { return null; }
}

async function writeWinReg(pathKey, name, type, value) {
  await execFileAsync('reg.exe',['add',pathKey,'/v',name,'/t',type,'/d',String(value),' /f'.trim()],{windowsHide:true});
}

async function deleteWinReg(pathKey, name) {
  try { await execFileAsync('reg.exe',['delete',pathKey,'/v',name,'/f'],{windowsHide:true}); } catch {}
}

async function refreshWinInetProxy() {
  if(process.platform!=='win32') return;
  const ps = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WinInetProxyRefresh {
  [DllImport("wininet.dll", SetLastError=true)]
  public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
}
'@
$z=[UIntPtr]::Zero
[WinInetProxyRefresh]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0) | Out-Null
[WinInetProxyRefresh]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0) | Out-Null
$r=New-Object UIntPtr
[WinInetProxyRefresh]::SendMessageTimeout([IntPtr]0xffff,0x1a,[UIntPtr]::Zero,"Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",2,3000,[ref]$r) | Out-Null
`;
  try { await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',ps],{windowsHide:true,timeout:10000}); } catch (e) { console.warn('[proxy] WinINet refresh failed:',e?.message||e); }
}

async function applyWinInetSystemProxy(endpoint, enabled=true, bypass='<local>') {
  if(process.platform!=='win32') return {ok:true,detail:'non-windows'};
  // Use the documented INTERNET_OPTION_PER_CONNECTION_OPTION API so the
  // active WinINet configuration is updated, not just the backing registry.
  // Chromium on Windows reads the WinINet system proxy configuration.
  const escapedEndpoint=String(endpoint||'').replace(/'/g,"''");
  const escapedBypass=String(bypass||'').replace(/'/g,"''");
  const ps = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WinInetConnectionOptions {
  [StructLayout(LayoutKind.Sequential)] public struct Option { public int dwOption; public IntPtr Value; }
  [StructLayout(LayoutKind.Sequential)] public struct OptionList { public int dwSize; public IntPtr pszConnection; public int dwOptionCount; public int dwOptionError; public IntPtr pOptions; }
  [DllImport("wininet.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
}
'@
$server='${escapedEndpoint}'
$bypass='${escapedBypass}'
$serverMem=[Runtime.InteropServices.Marshal]::StringToHGlobalUni($server)
$bypassMem=[Runtime.InteropServices.Marshal]::StringToHGlobalUni($bypass)
try {
  $flagValue=[IntPtr]::new($(if($enabled){2}else{1}))
  $opts=New-Object WinInetConnectionOptions+Option[] 3
  $opts[0].dwOption=1; $opts[0].Value=$flagValue
  $opts[1].dwOption=2; $opts[1].Value=$(if($enabled){'$serverMem'}else{'[IntPtr]::Zero'})
  $opts[2].dwOption=3; $opts[2].Value=$(if($enabled){'$bypassMem'}else{'[IntPtr]::Zero'})
  $optSize=[Runtime.InteropServices.Marshal]::SizeOf([type]'WinInetConnectionOptions+Option')
  $arrMem=[Runtime.InteropServices.Marshal]::AllocHGlobal($optSize*3)
  try {
    for($i=0;$i -lt 3;$i++){[Runtime.InteropServices.Marshal]::StructureToPtr($opts[$i],[IntPtr]::Add($arrMem,$i*$optSize),$false)}
    $list=New-Object WinInetConnectionOptions+OptionList
    $list.dwSize=[Runtime.InteropServices.Marshal]::SizeOf([type]'WinInetConnectionOptions+OptionList')
    $list.pszConnection=[IntPtr]::Zero
    $list.dwOptionCount=3
    $list.dwOptionError=0
    $list.pOptions=$arrMem
    $listSize=[Runtime.InteropServices.Marshal]::SizeOf($list)
    $listMem=[Runtime.InteropServices.Marshal]::AllocHGlobal($listSize)
    try {
      [Runtime.InteropServices.Marshal]::StructureToPtr($list,$listMem,$false)
      if(-not [WinInetConnectionOptions]::InternetSetOption([IntPtr]::Zero,75,$listMem,$listSize)) { throw "InternetSetOption(PER_CONNECTION_OPTION) failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($listMem) }
  } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($arrMem) }
} finally {
  [Runtime.InteropServices.Marshal]::FreeHGlobal($serverMem)
  [Runtime.InteropServices.Marshal]::FreeHGlobal($bypassMem)
}
[WinInetConnectionOptions]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0) | Out-Null
[WinInetConnectionOptions]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0) | Out-Null
'APPLIED'
`;
  try {
    const r=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',ps],{windowsHide:true,timeout:12000});
    return {ok:true,detail:String(r.stdout||'').trim()};
  } catch(e){
    return {ok:false,detail:e?.stderr||e?.message||String(e)};
  }
}

async function verifyWindowsSystemProxyEndpoint(endpoint) {
  if(process.platform!=='win32') return {ok:true, detail:'non-windows'};
  // WinINet PRECONFIG is the same registry-backed system proxy model used by
  // desktop browsers on Windows. Do a real request after writing the settings.
  const ps = `
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WinInetProbe {
  [DllImport("wininet.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr InternetOpen(string lpszAgent, uint dwAccessType, IntPtr lpszProxy, IntPtr lpszProxyBypass, uint dwFlags);
  [DllImport("wininet.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr InternetOpenUrl(IntPtr hInternet, string lpszUrl, string lpszHeaders, uint dwHeadersLength, uint dwFlags, UIntPtr dwContext);
  [DllImport("wininet.dll", SetLastError=true)]
  public static extern bool InternetReadFile(IntPtr hFile, byte[] lpBuffer, int dwNumberOfBytesToRead, out int lpdwNumberOfBytesRead);
  [DllImport("wininet.dll", SetLastError=true)]
  public static extern bool InternetCloseHandle(IntPtr hInternet);
}
'@
$h=[WinInetProbe]::InternetOpen('ZapretLauncher/1.0',0,[IntPtr]::Zero,[IntPtr]::Zero,0)
if($h -eq [IntPtr]::Zero){ throw 'InternetOpen failed' }
try {
  $inetFlagNoCache=[Convert]::ToUInt32('80000000',16)
  $u=[WinInetProbe]::InternetOpenUrl($h,'http://example.com/','',0,$inetFlagNoCache, [UIntPtr]::Zero)
  if($u -eq [IntPtr]::Zero){ throw 'InternetOpenUrl failed' }
  try {
    $buf=New-Object byte[] 512; $n=0; [WinInetProbe]::InternetReadFile($u,$buf,$buf.Length,[ref]$n) | Out-Null
    'BYTES='+$n
  } finally { [WinInetProbe]::InternetCloseHandle($u) | Out-Null }
} finally { [WinInetProbe]::InternetCloseHandle($h) | Out-Null }
`;
  try {
    const r=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',ps],{windowsHide:true,timeout:12000});
    return {ok:true, detail:String(r.stdout||'').trim()};
  } catch(e){
    return {ok:false, detail:e?.stderr||e?.message||String(e)};
  }
}

async function setWindowsSystemProxy(enabled) {
  if(process.platform!=='win32') return false;
  const pathKey='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  if(enabled){
    if(!runtime.systemProxyOriginal){
      runtime.systemProxyOriginal={
        ProxyEnable: await readWinRegValue(pathKey,'ProxyEnable'),
        ProxyServer: await readWinRegValue(pathKey,'ProxyServer'),
        ProxyOverride: await readWinRegValue(pathKey,'ProxyOverride'),
        AutoConfigURL: await readWinRegValue(pathKey,'AutoConfigURL'),
        AutoDetect: await readWinRegValue(pathKey,'AutoDetect')
      };
    }
    // Use one plain HTTP proxy endpoint for both HTTP and HTTPS CONNECT.
    // Protocol-specific `https=` here can make Windows/browser clients treat the
    // local listener as an HTTPS proxy, although it is an HTTP CONNECT proxy.
    const endpoint=`127.0.0.1:${settings.httpPort}`;
    await writeWinReg(pathKey,'ProxyEnable','REG_DWORD','1');
    await writeWinReg(pathKey,'ProxyServer','REG_SZ',endpoint);
    // Do not preserve a bypass list while Launcher owns the system proxy.
    // A stale ProxyOverride can silently send sites directly around Xray.
    await writeWinReg(pathKey,'ProxyOverride','REG_SZ','<local>');
    await writeWinReg(pathKey,'MigrateProxy','REG_DWORD','0');
    await writeWinReg(pathKey,'AutoDetect','REG_DWORD','0');
    await deleteWinReg(pathKey,'AutoConfigURL');
    const apiApply=await applyWinInetSystemProxy(endpoint,true,'<local>');
    console.log('[proxy] WinINet system proxy API:',apiApply);
    await refreshWinInetProxy();
    const verifyEnable=await readWinRegValue(pathKey,'ProxyEnable');
    const verifyServer=await readWinRegValue(pathKey,'ProxyServer');
    const verifyOverride=await readWinRegValue(pathKey,'ProxyOverride');
    console.log('[proxy] Windows system proxy active:', {enabled:verifyEnable, server:verifyServer, override:verifyOverride||''});
    if(verifyEnable!=='0x1' && verifyEnable!=='1') throw new Error('Windows не применил ProxyEnable=1');
    if(verifyServer!==endpoint) throw new Error(`Windows не применил ProxyServer=${endpoint}`);
    // Avoid a second external network round-trip during startup.
    // The local listener is checked below; real connectivity is covered by the
    // background health monitor after the connection is marked ready.
    console.log('[proxy] WinINet system proxy probe: deferred to background health monitor');
  } else {
    const o=runtime.systemProxyOriginal;
    if(o){
      if(o.ProxyEnable!=null) await writeWinReg(pathKey,'ProxyEnable','REG_DWORD',o.ProxyEnable); else await deleteWinReg(pathKey,'ProxyEnable');
      if(o.ProxyServer!=null) await writeWinReg(pathKey,'ProxyServer','REG_SZ',o.ProxyServer); else await deleteWinReg(pathKey,'ProxyServer');
      if(o.ProxyOverride!=null) await writeWinReg(pathKey,'ProxyOverride','REG_SZ',o.ProxyOverride); else await deleteWinReg(pathKey,'ProxyOverride');
      if(o.AutoConfigURL!=null) await writeWinReg(pathKey,'AutoConfigURL','REG_SZ',o.AutoConfigURL); else await deleteWinReg(pathKey,'AutoConfigURL');
      if(o.AutoDetect!=null) await writeWinReg(pathKey,'AutoDetect','REG_DWORD',o.AutoDetect); else await deleteWinReg(pathKey,'AutoDetect');
    } else {
      await writeWinReg(pathKey,'ProxyEnable','REG_DWORD','0');
    }
    const restored=runtime.systemProxyOriginal||{};
    const wasProxy=String(restored.ProxyEnable||'')==='0x1' || String(restored.ProxyEnable||'')==='1';
    const restoreServer=restored.ProxyServer||'';
    const restoreBypass=restored.ProxyOverride||'';
    const apiRestore=wasProxy && restoreServer
      ? await applyWinInetSystemProxy(restoreServer,true,restoreBypass)
      : await applyWinInetSystemProxy('',false,'');
    console.log('[proxy] WinINet system proxy restore API:',apiRestore);
    await refreshWinInetProxy();
    runtime.systemProxyOriginal=null;
  }
  return true;
}

async function waitForTcpListening(port, timeoutMs=12000) {
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const ok=await new Promise(resolve=>{
      const sock=new Socket(); let done=false;
      const finish=v=>{if(done)return;done=true;try{sock.destroy()}catch{};resolve(v)};
      sock.setTimeout(500,()=>finish(false));
      sock.once('connect',()=>finish(true));
      sock.once('error',()=>finish(false));
      sock.connect(Number(port),'127.0.0.1');
    });
    if(ok) return true;
    await new Promise(r=>setTimeout(r,150));
  }
  return false;
}

async function getTunAdapterInfo(name){
  if(process.platform!=='win32') return {up:true,index:null,name:String(name||''),description:'',status:'Up'};
  const wanted=String(name||'EpicTunnel').replace(/'/g,"''");
  const latin=latinizeName(String(name||'EpicTunnel')).replace(/'/g,"''");
  const ps = `$n='${wanted}';$l='${latin}';$a=@(Get-NetAdapter -ErrorAction SilentlyContinue | Sort-Object @{Expression={if($_.Name -eq $n){0}elseif($_.Name -like \"*$l*\"){1}elseif($_.InterfaceDescription -like '*Wintun*'){2}else{9}}},ifIndex);$u=$a|Select-Object -First 1;if($u){'IDX='+$u.ifIndex; 'NAME='+$u.Name; 'DESC='+$u.InterfaceDescription; 'STATUS='+$u.Status}`;
  try {
    const {stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{windowsHide:true,timeout:4000,maxBuffer:16*1024});
    const out=String(stdout||'').trim();
    const im=out.match(/(?:^|\r?\n)IDX=(\d+)/);
    const nm=out.match(/(?:^|\r?\n)NAME=(.*)/); const dm=out.match(/(?:^|\r?\n)DESC=(.*)/); const sm=out.match(/(?:^|\r?\n)STATUS=(.*)/);
    return {up:sm?.[1]?.trim()==='Up',index:im?Number(im[1]):null,name:nm?.[1]?.trim()||'',description:dm?.[1]?.trim()||'',status:sm?.[1]?.trim()||'',raw:out};
  } catch(e) { return {up:false,index:null,name:'',description:'',status:'',error:e?.message||String(e),raw:''}; }
}

async function waitForTunAdapter(name, timeoutMs=12000) {
  if(process.platform!=='win32') return {up:true,index:null,name:String(name||''),description:'',status:'Up'};
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const info=await getTunAdapterInfo(name);
    if(info.up) return info;
    lastTunState=info.status==='Down'?'down':(info.error?'probe-error':'none');
    await new Promise(r=>setTimeout(r,250));
  }
  return null;
}
let lastTunState='none';

function latinizeName(s){
  const map={а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'};
  return String(s).toLowerCase().split('').map(ch=>map[ch]!==undefined?map[ch]:ch).join('');
}

async function ensureWindowsTunRoutes(ifIndex){
  if(process.platform!=='win32' || !ifIndex) return {ok:true,index:ifIndex,routes:[]};
  const idx=Number(ifIndex); const ps = `$idx=${idx};$p=@('0.0.0.0/1','128.0.0.0/1'); foreach($d in @('0.0.0.0/0')+$p){Get-NetRoute -AddressFamily IPv4 -InterfaceIndex $idx -DestinationPrefix $d -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue}; foreach($d in $p){New-NetRoute -DestinationPrefix $d -InterfaceIndex $idx -NextHop 0.0.0.0 -RouteMetric 1 -PolicyStore ActiveStore -ErrorAction Stop | Out-Null}; 'ROUTES='+((Get-NetRoute -AddressFamily IPv4 -InterfaceIndex $idx -ErrorAction SilentlyContinue | ForEach-Object { $_.DestinationPrefix+':'+$_.RouteMetric }) -join ',')`;
  try {
    const {stdout,stderr}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{windowsHide:true,timeout:6000,maxBuffer:32*1024});
    const out=String(stdout||'').trim(); const rm=out.match(/ROUTES=([^\r\n]*)/); const routes=(rm?.[1]||'').split(',').filter(Boolean);
    const hasA=routes.some(x=>x.startsWith('0.0.0.0/1:')); const hasB=routes.some(x=>x.startsWith('128.0.0.0/1:'));
    if(!hasA||!hasB) return {ok:false,index:idx,routes,raw:out,error:String(stderr||'automatic route install did not produce both /1 routes')};
    return {ok:true,index:idx,routes,raw:out};
  } catch(e) { return {ok:false,index:idx,routes:[],raw:'',error:e?.message||String(e)}; }
}

async function cleanupWindowsTunRoutes(ifIndex){
  if(process.platform!=='win32' || !ifIndex) return;
  const idx=Number(ifIndex); const ps=`$idx=${idx};foreach($d in @('0.0.0.0/1','128.0.0.0/1')){Get-NetRoute -AddressFamily IPv4 -InterfaceIndex $idx -DestinationPrefix $d -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue}`;
  try{ await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{windowsHide:true,timeout:5000,maxBuffer:16*1024}); }catch{}
}

async function tunRouteDiagnostics(timeoutMs=5000, expectedIfIndex=null) {
  if (process.platform!=='win32') return {ok:true,index:null,route:true};
  const sec=Math.max(3,Math.min(10,Math.ceil((Number(timeoutMs)||5000)/1000)));
  try {
    const idxArg=expectedIfIndex?`$want=${Number(expectedIfIndex)};`:'';
    const ps = String.raw`${idxArg}$a=@(Get-NetAdapter -ErrorAction SilentlyContinue | Sort-Object @{Expression={if($want -and $_.ifIndex -eq $want){0}elseif($_.InterfaceDescription -like '*Wintun*' -or $_.Name -like '*EpicTunnel*'){1}else{9}}},ifIndex); $u=if($want){$a|Where-Object {$_.ifIndex -eq $want}|Select-Object -First 1}else{$a|Where-Object {$_.Status -eq 'Up'}|Select-Object -First 1}; if($u){$r=@(Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {$_.InterfaceIndex -eq $u.ifIndex}); 'IDX='+$u.ifIndex; 'NAME='+$u.Name; if($r.Count){'ROUTES='+ (($r | ForEach-Object { $_.DestinationPrefix+':'+$_.RouteMetric }) -join ',')}else{'ROUTES='}}`;
    const {stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{windowsHide:true,timeout:sec*1000,maxBuffer:16*1024});
    const out=String(stdout||''); const im=out.match(/IDX=(\d+)/); const nm=out.match(/NAME=([^\r\n]*)/); const rm=out.match(/ROUTES=([^\r\n]*)/); const routes=rm?.[1]||'';
    const hasA=routes.split(',').some(x=>x.startsWith('0.0.0.0/1:')); const hasB=routes.split(',').some(x=>x.startsWith('128.0.0.0/1:')); const hasDefault=routes.split(',').some(x=>x.startsWith('0.0.0.0/0:'));
    return {ok:true,index:im?Number(im[1]):null,name:nm?.[1]||'',route:hasA&&hasB,halfRoutes:hasA&&hasB,defaultRoute:hasDefault,routes,raw:out.trim()};
  } catch (e) { return {ok:false,index:null,name:'',route:false,halfRoutes:false,defaultRoute:false,routes:'',error:e?.message||String(e)}; }
}

async function verifyTunRouteSelection(ifIndex, timeoutMs=5000) {
  if(process.platform!=='win32') return {ok:true,index:ifIndex};
  const sec=Math.max(3,Math.min(10,Math.ceil((Number(timeoutMs)||5000)/1000)));
  // Do not use Find-NetRoute here. On some Windows builds it calls the routing
  // provider/CIM path and can fail with System Error 1232 even when the routes
  // are present and usable. We already installed the two specific /1 routes;
  // ask Get-NetRoute which interface owns the best instance of each prefix.
  const ps = String.raw`$a=Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/1' -ErrorAction SilentlyContinue | Sort-Object RouteMetric,InterfaceMetric | Select-Object -First 1; $b=Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '128.0.0.0/1' -ErrorAction SilentlyContinue | Sort-Object RouteMetric,InterfaceMetric | Select-Object -First 1; if($a){'IDX0='+$a.InterfaceIndex; 'DEST0='+$a.DestinationPrefix; 'METRIC0='+$a.RouteMetric}; if($b){'IDX1='+$b.InterfaceIndex; 'DEST1='+$b.DestinationPrefix; 'METRIC1='+$b.RouteMetric}`;
  try{
    const {stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{windowsHide:true,timeout:sec*1000,maxBuffer:16*1024});
    const out=String(stdout||'');
    const a=out.match(/IDX0=(\d+)/); const b=out.match(/IDX1=(\d+)/);
    const selected0=a?Number(a[1]):null; const selected1=b?Number(b[1]):null;
    return {ok:selected0===Number(ifIndex)&&selected1===Number(ifIndex),selectedIndex:selected0,selectedIndex2:selected1,raw:out.trim()};
  } catch(e){return {ok:false,selectedIndex:null,selectedIndex2:null,raw:'',error:e?.message||String(e)};}
}

// Реальная проверка работоспособности VPN-туннеля: HTTP(S)-запрос через локальный
// прокси к нескольким независимым endpoint'ам. Если ядро запущено, но удалённый
// сервер недоступен (неверный ключ/порт/TLS), запросы не пройдут — и мы обязаны
// показать «не работает», а не «работает».
const VERIFY_ENDPOINTS = [
  [DEFAULTS.pingUrl, 'status'],
  ['https://api.ip.sb/geoip', 'ip'],
  ['https://ipinfo.io/json', 'ip'],
  ['https://myexternalip.com/raw', null],
  ['https://ifconfig.co/ip', null]
];

function decodeChunkedBody(buf) {
  let pos = 0;
  const out = [];
  while (pos < buf.length) {
    const lineEnd = buf.indexOf(Buffer.from('\r\n'), pos);
    if (lineEnd < 0) return null;
    const line = buf.subarray(pos, lineEnd).toString('ascii').split(';', 1)[0].trim();
    const size = Number.parseInt(line, 16);
    if (!Number.isFinite(size) || size < 0) return null;
    pos = lineEnd + 2;
    if (size === 0) return Buffer.concat(out);
    if (pos + size + 2 > buf.length) return null;
    out.push(buf.subarray(pos, pos + size));
    pos += size;
    if (buf[pos] !== 0x0d || buf[pos + 1] !== 0x0a) return null;
    pos += 2;
  }
  return Buffer.concat(out);
}

function parseRawHttpResponse(buffer) {
  const sep = Buffer.from('\r\n\r\n');
  const headerEnd = buffer.indexOf(sep);
  if (headerEnd < 0) return null;
  const headerText = buffer.subarray(0, headerEnd).toString('latin1');
  const lines = headerText.split('\r\n');
  const first = /^HTTP\/1\.[01]\s+(\d{3})/.exec(lines.shift() || '');
  if (!first) return { status: 0, headers: {}, body: Buffer.alloc(0) };
  const headers = {};
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  let body = buffer.subarray(headerEnd + sep.length);
  if (String(headers['transfer-encoding'] || '').toLowerCase().includes('chunked')) {
    body = decodeChunkedBody(body) || Buffer.alloc(0);
  } else if (headers['content-length'] != null) {
    const n = Number(headers['content-length']);
    if (Number.isFinite(n) && n >= 0) body = body.subarray(0, n);
  }
  return { status: Number(first[1]), headers, body };
}

function requestOverConnectedSocket(socket, requestText, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    const timeout = Math.min(12000, Math.max(1500, Number(timeoutMs) || 8000));
    const closeGracefully = () => {
      // `destroy()` sends an immediate reset and can make Xray report
      // `failed to transfer response payload` while it is still writing the
      // already-available HTTP response to localhost. A health-check should
      // half-close normally after it has received a valid response.
      try {
        if (socket && !socket.destroyed) {
          socket.end();
          setTimeout(() => { try { socket.destroy(); } catch {} }, 1500).unref?.();
        }
      } catch {}
    };
    const finish = (value, graceful=false) => {
      if (settled) return;
      settled = true;
      if (graceful) closeGracefully();
      else { try { socket.destroy(); } catch {} }
      resolve(value);
    };
    socket.setTimeout(timeout, () => finish(null));
    socket.once('error', () => finish(null));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 512 * 1024) { finish(null); return; }
      const parsed = parseRawHttpResponse(buffer);
      if (!parsed) return;
      if (parsed.status >= 100 && parsed.status < 200) return;
      if ([204, 205, 304].includes(parsed.status) || parsed.headers['content-length'] === '0') {
        finish({status:parsed.status, body:'', headers:parsed.headers}, true);
        return;
      }
      if (parsed.headers['content-length'] != null) {
        const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'));
        const wanted = Number(parsed.headers['content-length']);
        if (Number.isFinite(wanted) && wanted >= 0 && headerEnd >= 0 && buffer.length >= headerEnd + 4 + wanted) {
          finish({status:parsed.status, body:parsed.body.toString('utf8'), headers:parsed.headers}, true);
        }
      }
    });
    socket.once('end', () => {
      const parsed = parseRawHttpResponse(buffer);
      if (!parsed) { finish(null); return; }
      finish({status:parsed.status, body:parsed.body.toString('utf8'), headers:parsed.headers}, true);
    });
    // Listeners are attached BEFORE writing the request, otherwise a very fast
    // endpoint can answer and close the socket before the data/end handlers exist.
    socket.write(requestText);
  });
}

function connectViaHttpProxy(proxyUrl, target, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket = null;
    let header = '';
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) { try { socket?.destroy(); } catch {} reject(err); }
      else resolve(value);
    };
    try {
      const p = new URL(proxyUrl);
      const timeout = Math.min(12000, Math.max(1500, Number(timeoutMs) || 8000));
      socket = new Socket();
      socket.setTimeout(timeout, () => finish(new Error('proxy connection timeout')));
      socket.once('error', e => finish(e));
      socket.connect(Number(p.port || 80), p.hostname, () => {
        const host = target.hostname;
        const port = Number(target.port || 443);
        // Keep the CONNECT tunnel alive during the health probe; closing it here can race with the first tunneled bytes on Windows.
        const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`, 'Connection: keep-alive', 'Proxy-Connection: keep-alive'];
        if (p.username) {
          const user = decodeURIComponent(p.username);
          const pass = decodeURIComponent(p.password || '');
          lines.push(`Proxy-Authorization: Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`);
        }
        socket.write(lines.join('\r\n') + '\r\n\r\n');
      });
      const onData = chunk => {
        const raw = Buffer.concat([Buffer.from(header, 'latin1'), chunk]);
        const marker = Buffer.from('\r\n\r\n', 'ascii');
        const end = raw.indexOf(marker);
        if (end < 0) {
          header = raw.toString('latin1');
          if (header.length > 16384) finish(new Error('proxy CONNECT header too large'));
          return;
        }
        socket.removeListener('data', onData);
        const headerBuf = raw.subarray(0, end);
        const remainder = raw.subarray(end + marker.length);
        const firstLine = headerBuf.toString('latin1').split('\r\n', 1)[0];
        if (!/^HTTP\/1\.[01] 200(?:\s|$)/.test(firstLine)) {
          finish(new Error(`proxy CONNECT failed: ${firstLine || 'no response'}`));
          return;
        }
        // A proxy and the target can put the CONNECT response and the first TLS
        // record into the same TCP read. The previous implementation discarded
        // those trailing bytes, which made the TLS handshake hang until timeout.
        // Put the bytes back into the socket before wrapping it with TLS.
        if (remainder.length) {
          try { socket.unshift(remainder); } catch {}
        }
        const secure = tls.connect({
          socket,
          servername: target.hostname,
          rejectUnauthorized: true,
          ALPNProtocols: ['http/1.1']
        });
        secure.once('secureConnect', () => finish(null, secure));
        secure.once('error', e => finish(e));
      };
      socket.on('data', onData);
    } catch (e) { finish(e); }
  });
}

function connectViaSocks5Proxy(proxyUrl, target, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new Socket();
    let phase = 'greeting';
    let buffer = Buffer.alloc(0);
    const p = new URL(proxyUrl);
    const username = decodeURIComponent(p.username || '');
    const password = decodeURIComponent(p.password || '');
    const timeout = Math.min(12000, Math.max(1500, Number(timeoutMs) || 8000));
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) { try { socket.destroy(); } catch {} reject(err); }
      else resolve(value);
    };
    const sendTarget = () => {
      const hostBuf = Buffer.from(target.hostname, 'utf8');
      if (hostBuf.length > 255) return finish(new Error('SOCKS target hostname too long'));
      const port = Number(target.port || 443);
      const msg = Buffer.alloc(7 + hostBuf.length);
      msg[0] = 0x05; msg[1] = 0x01; msg[2] = 0x00; msg[3] = 0x03; msg[4] = hostBuf.length;
      hostBuf.copy(msg, 5); msg.writeUInt16BE(port, 5 + hostBuf.length);
      phase = 'connect'; socket.write(msg);
    };
    const sendAuth = () => {
      const user = Buffer.from(username, 'utf8'); const pass = Buffer.from(password, 'utf8');
      if (user.length > 255 || pass.length > 255) return finish(new Error('SOCKS credentials too long'));
      phase = 'auth'; socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
    };
    const onData = chunk => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        while (!settled) {
          if (phase === 'greeting') {
            if (buffer.length < 2) return;
            if (buffer[0] !== 0x05) return finish(new Error('SOCKS bad greeting'));
            const method = buffer[1]; buffer = buffer.subarray(2);
            if (method === 0x00) { sendTarget(); continue; }
            if (method === 0x02 && username) { sendAuth(); continue; }
            return finish(new Error('SOCKS authentication required'));
          }
          if (phase === 'auth') {
            if (buffer.length < 2) return;
            if (buffer[0] !== 0x01 || buffer[1] !== 0x00) return finish(new Error('SOCKS authentication failed'));
            buffer = buffer.subarray(2); sendTarget(); continue;
          }
          if (phase === 'connect') {
            if (buffer.length < 5) return;
            if (buffer[0] !== 0x05) return finish(new Error('SOCKS bad CONNECT response'));
            const rep = buffer[1], atyp = buffer[3];
            let need;
            if (atyp === 0x01) need = 4;
            else if (atyp === 0x03) { if (buffer.length < 5) return; need = 1 + buffer[4]; }
            else if (atyp === 0x04) need = 16;
            else return finish(new Error('SOCKS unsupported address type'));
            const total = 6 + need;
            if (buffer.length < total) return;
            buffer = buffer.subarray(total);
            if (rep !== 0x00) return finish(new Error(`SOCKS CONNECT refused (${rep})`));
            socket.removeListener('data', onData);
            // The SOCKS CONNECT reply and the first TLS record can arrive in the same
            // TCP read. Preserve those already-read bytes before wrapping the socket
            // with TLS, otherwise the ClientHello/ServerHello tail is lost.
            if (buffer.length) { try { socket.unshift(buffer); } catch {} }
            const secure = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] }, () => finish(null, secure));
            secure.once('error', e => finish(e));
            return;
          }
          return finish(new Error('SOCKS invalid state'));
        }
      } catch (e) { finish(e); }
    };
    socket.setTimeout(timeout, () => finish(new Error('SOCKS connect timeout')));
    socket.once('error', e => finish(e));
    socket.on('data', onData);
    try { socket.connect(Number(p.port || 1080), p.hostname, () => socket.write(username ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]))); } catch (e) { finish(e); }
  });
}

async function fetchThroughProxy(url, proxyUrl, timeoutMs) {
  let socket = null;
  try {
    const target = new URL(url);
    const proxy = new URL(proxyUrl);
    socket = proxy.protocol.toLowerCase().startsWith('socks')
      ? await connectViaSocks5Proxy(proxyUrl, target, timeoutMs)
      : await connectViaHttpProxy(proxyUrl, target, timeoutMs);
    if (!socket) return null;
    const secure = target.protocol === 'https:';
    if (!secure) {
      const pathName = `${target.pathname || '/'}${target.search || ''}`;
      return await requestOverConnectedSocket(socket, [`GET ${pathName} HTTP/1.1`, `Host: ${target.host}`, 'User-Agent: Zapret-Launcher/1.4.10', 'Accept: */*', 'Accept-Encoding: identity', 'Connection: close', '', ''].join('\r\n'), timeoutMs);
    }
    const secureSocket = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('target TLS handshake timeout')), Math.min(12000, Math.max(1500, Number(timeoutMs) || 8000)));
      secureSocket.once('secureConnect', () => { clearTimeout(timer); resolve(); });
      secureSocket.once('error', e => { clearTimeout(timer); reject(e); });
    });
    return await requestOverConnectedSocket(secureSocket, [`GET ${target.pathname || '/'}${target.search || ''} HTTP/1.1`, `Host: ${target.host}`, 'User-Agent: Zapret-Launcher/1.4.10', 'Accept: application/json, text/plain, */*', 'Accept-Encoding: identity', 'Connection: close', '', ''].join('\r\n'), timeoutMs);
  } catch (e) {
    try { socket?.destroy(); } catch {}
    return null;
  }
}
async function probeProxyTransport(proxyUrl, targetUrl, timeoutMs) {
  const target = new URL(targetUrl);
  if (!proxyUrl) return null;
  const p = new URL(proxyUrl);
  let socket = null;
  try {
    socket = p.protocol.toLowerCase().startsWith('socks')
      ? await connectViaSocks5Proxy(proxyUrl, target, timeoutMs)
      : await connectViaHttpProxy(proxyUrl, target, timeoutMs);
    // connectVia* already performs a full TLS handshake for HTTPS targets. That is
    // enough to prove that the local proxy accepted CONNECT, Xray established the
    // outbound VLESS path, and the remote endpoint completed TLS. Do NOT send an
    // application-level GET here: some health-check endpoints keep HTTP connections
    // open or behave differently behind proxies, which used to cause false negatives.
    try { socket?.end(); } catch {}
    return { ok:!!socket, ip:'', via:targetUrl };
  } catch {
    try { socket?.destroy(); } catch {}
    return null;
  }
}

function fetchPlainHttpThroughHttpProxy(url, proxyUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket = null;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) { try { socket?.destroy(); } catch {} reject(err); }
      else resolve(value);
    };
    try {
      const target = new URL(url);
      const p = new URL(proxyUrl);
      if (p.protocol !== 'http:') return finish(new Error('plain HTTP probe requires an HTTP proxy'));
      const timeout = Math.min(8000, Math.max(1500, Number(timeoutMs) || 6000));
      socket = new Socket();
      socket.setTimeout(timeout, () => finish(new Error('HTTP proxy request timeout')));
      socket.once('error', e => finish(e));
      socket.connect(Number(p.port || 80), p.hostname, () => {
        const headers = [
          `GET ${target.toString()} HTTP/1.1`,
          `Host: ${target.host}`,
          'User-Agent: Zapret-Launcher/1.4.10',
          'Accept: */*',
          'Accept-Encoding: identity',
          'Connection: close'
        ];
        if (p.username) {
          const user = decodeURIComponent(p.username);
          const pass = decodeURIComponent(p.password || '');
          headers.push(`Proxy-Authorization: Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`);
        }
        socket.write(headers.join('\r\n') + '\r\n\r\n');
      });
      let buffer = Buffer.alloc(0);
      const onData = chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 256 * 1024) return finish(new Error('HTTP proxy response too large'));
        const parsed = parseRawHttpResponse(buffer);
        if (!parsed) return;
        if (parsed.status >= 100 && parsed.status < 200) return;
        finish(null, parsed);
      };
      socket.on('data', onData);
      socket.once('end', () => {
        const parsed = parseRawHttpResponse(buffer);
        finish(parsed ? null : new Error('HTTP proxy closed without a response'), parsed || null);
      });
    } catch (e) { finish(e); }
  });
}

const PLAIN_HTTP_VERIFY_ENDPOINTS = [
  ['http://example.com/', 'status'],
  ['http://neverssl.com/', 'status']
];

async function fetchPublicIpVia(proxyUrl, timeoutMs) {
  const endpoints = [...VERIFY_ENDPOINTS];
  if (settings?.pingUrl) {
    const custom=String(settings.pingUrl).trim();
    if (custom && !endpoints.some(([u])=>u===custom)) endpoints.unshift([custom,'status']);
  }
  // For an HTTP local proxy, first perform the same plain-HTTP request that a
  // normal client uses with an HTTP proxy. This proves end-to-end TCP forwarding
  // without introducing a second TLS handshake, and mirrors the successful manual
  // curl check (`GET http://example.com/`). It is intentionally tried before the
  // HTTPS CONNECT probes because some endpoints delay or hold their TLS response.
  if (proxyUrl) {
    if (String(proxyUrl).toLowerCase().startsWith('http://')) {
      for (const [url] of PLAIN_HTTP_VERIFY_ENDPOINTS) {
        try {
          const r = await fetchPlainHttpThroughHttpProxy(url, proxyUrl, Math.min(5000, timeoutMs));
          if (r && r.status >= 200 && r.status < 400) return { ok:true, ip:'', via:url };
        } catch {}
      }
    }
    // Fallback/stronger validation: HTTPS CONNECT + full target TLS handshake.
    // This is useful where plain HTTP is blocked, but it is no longer the sole
    // readiness signal for the local HTTP proxy.
    for (const [url] of endpoints) {
      const r = await probeProxyTransport(proxyUrl, url, Math.min(6000, timeoutMs));
      if (r?.ok) return r;
    }
    return { ok:false, ip:'', via:'' };
  }
  // Direct mode keeps the existing public-IP check.
  for (const [url, ipField] of endpoints) {
    const r = await directRequest(url, Math.min(6000, timeoutMs));
    if (!r || r.status < 200 || r.status >= 400) continue;
    if (ipField === 'status') return { ok:true, ip:'', via:url };
    let ip = '';
    if (ipField) { try { ip = String(JSON.parse(r.body)?.[ipField]||'').trim(); } catch { ip = ''; } }
    else ip = String(r.body||'').trim().split('\n')[0];
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || /^[0-9a-f:]+$/i.test(ip)) return { ok:true, ip, via:url };
  }
  return { ok:false, ip:'', via:'' };
}

async function probeVpnEndpoints(proxyUrl, timeoutMs) {
  // Прокси в формате socks5:// принимается и через SOCKS5, и через HTTP-порт ядра
  // (Xray/sing-box слушают на одном порту mixed-протокол), поэтому просто
  // перебираем оба варианта.
  const variants = !proxyUrl ? [''] : (proxyUrl.startsWith('socks') ? [proxyUrl, proxyUrl.replace(/^socks\d?/, 'http')] : [proxyUrl]);
  for (const v of variants) {
    const res = await fetchPublicIpVia(v, timeoutMs);
    if (res.ok) return res;
  }
  return { ok:false, ip:'', via:'' };
}

function localProxyCredentialUrl(scheme, port, authMode, username, password) {
  const base=`${scheme}://127.0.0.1:${port}`;
  if(authMode!=='manual' || !username) return base;
  const u=encodeURIComponent(String(username));
  const p=encodeURIComponent(String(password||''));
  return `${scheme}://${u}:${p}@127.0.0.1:${port}`;
}

async function verifyOutboundViaHttpProxy(port, timeoutMs=12000) {
  // Use the real Windows curl binary for the final proxy readiness check. This
  // mirrors the exact manual test that has been proven to work on the target
  // machine and avoids the custom socket/parser path being a second failure mode.
  const auth = settings.httpAuthMode==='manual' && settings.httpAuthUser
    ? `${encodeURIComponent(String(settings.httpAuthUser))}:${encodeURIComponent(String(settings.httpAuthPassword||''))}@`
    : '';
  const proxy = `http://${auth}127.0.0.1:${Number(port)}`;
  const limit = Math.min(6000, Math.max(2500, Number(timeoutMs)||5000));
  // One fast HTTP request proves local proxy -> outbound -> Internet.
  // Do not block connection startup on additional public-IP endpoints.
  const targets = [{url:'http://example.com/', kind:'status'}];
  let last='';
  for (const t of targets) {
    try {
      const {stdout,stderr}=await execFileAsync('curl.exe',[
        '-4','-sS','--proxy',proxy,
        '--connect-timeout','3','--max-time',String(Math.ceil(limit/1000)),
        '-o', t.kind==='ip' ? '-' : 'NUL',
        ...(t.kind==='ip' ? [] : ['-w','%{http_code}']),
        t.url
      ],{windowsHide:true,timeout:limit+3000,maxBuffer:32*1024});
      const out=String(stdout||'').trim();
      const err=String(stderr||'').trim();
      if (t.kind==='ip' && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(out)) {
        return {ok:true,ip:out,via:t.url};
      }
      const code=Number(out);
      if (t.kind==='status' && code>=200 && code<400) return {ok:true,ip:'',via:t.url,httpStatus:code};
      last=`${t.url}: ${err||out||'no response'}`;
    } catch (e) {
      last=`${t.url}: ${e?.stderr||e?.message||String(e)}`;
    }
  }
  console.warn('[proxy] curl system-proxy health-check failed:',last);
  return {ok:false,ip:'',via:'',error:last};
}

// Быстрая проверка «порт ядра вообще слушает» — чтобы отличить мёртвое ядро/занятый
// порт от ситуации «ядро работает, но до сервера нет связи».
function tcpConnectOk(host, port, timeoutMs=2500) {
  return new Promise(resolve=>{
    let done=false; const finish=v=>{if(!done){done=true;sock.destroy();resolve(v)}};
    const sock=new Socket();
    sock.setTimeout(timeoutMs,()=>finish(false));
    sock.once('connect',()=>finish(true));
    sock.once('error',()=>finish(false));
    sock.connect(Number(port),host);
  });
}

async function verifyTunOutbound(timeoutMs=12000, core='xray') {
  // Xray 26.3.27 имеет известные проблемы с Windows TUN; sing-box использует
  // собственный auto_route и потому проверяется без ручного ожидания /1 маршрутов.
  // Для Xray оставляем строгую проверку /1 + /1 только как compatibility path.
  if (process.platform === 'win32') {
    const sec=Math.max(5,Math.min(20,Math.ceil((Number(timeoutMs)||12000)/1000)));
    let route={ok:true,index:null,route:true,halfRoutes:false};
    const adapter=await getTunAdapterInfo(tunAdapterName());
    if(!adapter.up){
      return {ok:false,ip:'',via:'',route:{ok:false,index:adapter.index,route:false,raw:adapter.raw||adapter.error||'TUN adapter is not up'}};
    }
    route.index=adapter.index;
    if(core==='xray') {
      route=await tunRouteDiagnostics(Math.min(5000,sec*1000));
      if (!route.route) {
        console.warn('[proxy] TUN IPv4 /1 routes not detected yet:',route.raw||route.error||'unknown');
        await new Promise(r=>setTimeout(r,750));
        route=await tunRouteDiagnostics(2500);
      }
      if (!route.route) {
        return { ok:false, ip:'', via:'', route };
      }
      const selected=await verifyTunRouteSelection(route.index,3000);
      if(!selected.ok){
        console.warn('[proxy] Windows route lookup does not select the TUN interface for the probe:',selected.raw||selected.error||'unknown');
        return {ok:false,ip:'',via:'',route,selected};
      }
    }
    try {
      const {stdout,stderr}=await execFileAsync('curl.exe',[
        '-4','-sS','--noproxy','*',
        '--resolve','example.com:80:93.184.216.34',
        '--connect-timeout',String(Math.min(8,sec)),
        '--max-time',String(sec),
        '-o','NUL','-w','%{http_code}',
        'http://example.com/'
      ],{windowsHide:true,timeout:(sec+3)*1000,maxBuffer:32*1024});
      const code=Number(String(stdout||'').trim());
      if (code>=200 && code<400) return {ok:true,ip:'',via:'system-tun-http',httpStatus:code,route};
      console.warn('[proxy] TUN HTTP health-check returned status',code,stderr||'');
    } catch (e) {
      console.warn('[proxy] TUN HTTP health-check failed:',e?.message||e);
    }
  }
  return { ok:false, ip:'', via:'' };
}

// Человекочитаемая диагностика неудачной проверки: различаем «ядро не слушает порт»
// (тогда ошибка точно локальная) и «до сервера нет связи» (классический случай).
async function describeVerifyFailure(){
  const httpOk = await tcpConnectOk('127.0.0.1', settings.httpPort||10809);
  const socksOk = await tcpConnectOk('127.0.0.1', settings.socksPort||10808);
  if(!httpOk && !socksOk){
    return 'VPN-ядро запущено, но локальные HTTP/SOCKS-порты не отвечают. Проверьте, не заняты ли порты другим приложением, и повторите запуск.';
  }
  return 'Проверка VPN не пройдена: через локальный прокси не удалось выйти в интернет. Локальный прокси при этом отвечает, поэтому проблема, скорее всего, на удалённом сервере: проверьте адрес, порт и ключ, доступность сервера и тип подключения (WS/Reality/gRPC), затем попробуйте другой сервер.';
}

export async function start(opts={}) {
  if(!settings) init();
  if(runtime.proc) return status();
  if(startPromise) return startPromise;
  startPromise=(async()=>{
    let proc=null;
    try {
      let server=servers.find(s=>s.id===settings.activeServerId);
      if(!server && subscriptions.length) {
        await refreshAllSubscriptions();
        server=servers.find(s=>s.id===settings.activeServerId) || servers.find(s=>s.favorite) || servers[0];
        if(server) settings.activeServerId=server.id;
      }
      if(!server) { server=servers.find(s=>s.favorite) || servers[0]; if(server) settings.activeServerId=server.id; }
      if(!server) throw new Error('Сначала добавьте VPN-сервер или подписку');
      const mode=opts.mode || settings.mode || 'proxy';
      normalizeTunSettings(settings);
      let core = isTunMode(mode) && settings.tunCore ? settings.tunCore : server.core;
      if(core==='auto') core=['hysteria2','wireguard'].includes(server.protocol)?'sing-box':'xray';
      if(['hysteria2','wireguard'].includes(server.protocol)) core='sing-box';
      let exe=await ensureCore(core);
      // Xray 26.3.27 имеет подтверждённые проблемы с Windows TUN (в том числе
      // отсутствие корректно настроенного gateway/DNS/маршрутов). Для этой версии
      // автоматически используем sing-box TUN, оставляя Xray для proxy-режима.
      if(isTunMode(mode) && process.platform==='win32' && core==='xray') {
        const version=await getCoreVersion(exe);
        if(version==='26.3.27') {
          console.warn('[proxy] Xray 26.3.27: переключаю Windows TUN на sing-box из-за совместимости TUN');
          core='sing-box';
          settings.tunCore='sing-box';
          save();
          exe=await ensureCore(core);
        }
      }
      // Xray в режиме TUN требует wintun.dll рядом с xray.exe.
      if(isTunMode(mode) && core==='xray') await ensureXrayWintunDll(exe);
      // Локальные порты прокси поднимаем в обоих режимах: они нужны и для
      // реальной проверки туннеля (Electron/приложения не всегда ходят через маршруты TUN).
      {
        const socks=await findFreeTcpPort(settings.socksPort, new Set());
        const http=await findFreeTcpPort(settings.httpPort, new Set([socks]));
        settings.socksPort=socks; settings.httpPort=http; save();
      }
      const cfg=core==='sing-box'?await buildSingboxConfig(server,mode):finalizeXrayConfig(buildXrayConfig(server,mode),server);
      const configPath=path.join(CFG_DIR(),`active-${core}.json`); fs.writeFileSync(configPath,JSON.stringify(cfg,null,2),'utf8');
      await validateCore(exe,configPath);
      runtime.core=core; runtime.mode=mode; runtime.configPath=configPath; runtime.ready=false; runtime.trafficSeen=false; runtime.logTail=[];
      proc=spawn(exe,['run','-c',configPath],{cwd:path.dirname(exe),windowsHide:true,stdio:['ignore','pipe','pipe']});
      runtime.proc=proc;
      const onCoreOutput=(d, warn=false)=>{
        const text=String(d||'');
        if(/\baccepted\b|\[tun-in\s*>>\s*proxy\]|\[http-in\s*>>\s*proxy\]|\[socks-in\s*>>\s*proxy\]/i.test(text)) runtime.trafficSeen=true;
        // Логи ядер на Windows пишутся в OEM-кодировке (CP866) — при перенаправлении
        // в консоль Electron кириллица превращается в «╨Т╨╜╨╡╤И╨╜╤П...». Декодируем:
        // символы ╨-╙ из диапазона U+2500-U+2513 — это байты 0xD0-0xD3, то есть
        // UTF-8, показанный как CP866. Восстанавливаем байты и читаем как UTF-8.
        let decoded=text;
        try {
          if(/[\u2500-\u2513]{2}/.test(text)){
            const bytes=Uint8Array.from(Buffer.from(text,'binary'));
            const fixed=new TextDecoder('utf-8',{fatal:false}).decode(bytes);
            if(/[\u0400-\u04FF]/.test(fixed)) decoded=fixed;
          }
        } catch {}
        // Ошибки создания TUN-адаптера показываем явно и недвусмысленно.
        if(/Failed to find matching adapter name|create.*tun.*fail|wintun/i.test(decoded)){
          if(/wintun\.dll/i.test(decoded) && !/Failed to find matching adapter/i.test(decoded)){
            console.warn('[proxy] Xray не может создать TUN: отсутствует wintun.dll рядом с xray.exe. Переключите «Ядро TUN» на sing-box или повторите подключение (DLL скопируется автоматически).');
          } else {
            console.warn('[proxy] Не удалось создать TUN-адаптер. Проверьте, что имя TUN состоит только из латинских букв/цифр и не длиннее 31 символа (Настройки → VPN), а также что драйвер Wintun установлен.');
          }
          return;
        }
        if(decoded.trim()){ runtime.logTail.push(decoded.trim()); if(runtime.logTail.length>30) runtime.logTail.shift(); }
        (warn?console.warn:console.log)('[proxy]',decoded.trim());
      };
      proc.stdout?.on('data',d=>onCoreOutput(d,false));
      proc.stderr?.on('data',d=>onCoreOutput(d,true));
      proc.once('error',err=>console.warn('[proxy] process error',err));
      proc.once('exit',()=>{ if(runtime.proc===proc) runtime.proc=null; runtime.core=null; runtime.configPath=null; runtime.ready=false; runtime.trafficSeen=false; if(runtime.systemProxyChanged){setWindowsSystemProxy(false).catch(()=>{});runtime.systemProxyChanged=false;} if(settings){settings.enabled=false;save();} emit(); });

      let ready=false;
      if(!isTunMode(mode)) {
        const listening=await waitForTcpListening(settings.httpPort,6000);
        if(!listening) throw new Error(`VPN-ядро запущено, но локальный HTTP-порт ${settings.httpPort} не открылся`);
        // Apply the Windows system proxy BEFORE the remote readiness check.
        // Otherwise a slow remote handshake could fail first and the code would
        // kill Xray before the browser ever receives a usable system proxy.
        if(settings.systemProxy){ await setWindowsSystemProxy(true); runtime.systemProxyChanged=true; }
        const check=await verifyOutboundViaHttpProxy(settings.httpPort,5000);
        if(!check.ok){
          // Диагностируем до остановки процесса: после kill локальные порты закономерно
          // закрыты, поэтому старый порядок всегда выдавал ложное «локальные порты не отвечают».
          const detail=await describeVerifyFailure();
          const recent=Array.isArray(runtime.logTail)?runtime.logTail.slice(-8).join(' | '):'';
          const serverHint=` Сервер: ${server.address}:${server.port}, протокол ${server.protocol}, сеть ${server.network||'tcp'}, security ${server.security||'none'}${server.sni?`, SNI ${server.sni}`:''}.`;
          try{proc.kill()}catch{}; if(process.platform==='win32' && proc.pid){try{await execFileAsync('taskkill.exe',['/PID',String(proc.pid),'/T','/F'],{windowsHide:true})}catch{}}
          throw new Error(detail + serverHint + (recent ? ` Последние сообщения Xray: ${recent}` : ''));
        }
        runtime.publicIp=check.ip;
        ready=true;
      } else {
        const adapterName=tunAdapterName();
        const adapter=await waitForTunAdapter(adapterName,12000);
        if(!adapter) throw new Error(`TUN-интерфейс «${adapterName}» не перешёл в состояние Up${lastTunState==='none'?'; проверьте, что драйвер Wintun доступен (для ядра Xray нужна wintun.dll рядом с xray.exe), или выберите ядро sing-box для режима TUN':''}`);
        if(isTunMode(mode) && core==='xray'){
          if(!adapter.index) throw new Error(`Не удалось определить индекс TUN-интерфейса «${adapterName}»`);
          runtime.tunIfIndex=adapter.index;
          const routes=await ensureWindowsTunRoutes(adapter.index);
          if(!routes.ok) throw new Error(`Не удалось установить IPv4-маршруты TUN: ${routes.error||'неизвестная ошибка'}`);
          console.log('[proxy] Installed Windows TUN IPv4 routes on interface',adapter.index, routes.routes.join(', '));
        }
        // Адаптер поднят и, для Xray, маршруты явно привязаны к точному интерфейсу —
        // теперь проверяем, что Windows выбирает этот интерфейс для внешнего IPv4.
        // Обязательная проверка: без неё UI показывал бы «подключено», а реальный
        // IP не менялся бы (адаптер есть, до сервера связи нет).
        const check=await verifyTunOutbound(15000,core);
        if(!check.ok){
          const route=await tunRouteDiagnostics(3000,runtime.tunIfIndex||null);
          const recent=Array.isArray(runtime.logTail)?runtime.logTail.slice(-8).join(' | '):'';
          await cleanupWindowsTunRoutes(runtime.tunIfIndex||route.index||null);
          try{proc.kill()}catch{}; if(process.platform==='win32' && proc.pid){try{await execFileAsync('taskkill.exe',['/PID',String(proc.pid),'/T','/F'],{windowsHide:true})}catch{}}
          const routeHint=route.ok ? ` IPv4-маршруты TUN (/1+/1): ${route.halfRoutes?'найдены':'не найдены'}${route.index!==null?`, индекс ${route.index}`:''}.` : ` Не удалось определить IPv4-маршруты TUN: ${route.error||'неизвестная ошибка'}.`;
          throw new Error('Проверка VPN не пройдена: Windows не направил тестовый IPv4 через TUN или TUN не вернул HTTP-ответ.' + routeHint + (recent ? ` Последние сообщения Xray: ${recent}` : ''));
        }
        runtime.publicIp=check.ip;
        if(mode==='mixed') {
          settings.systemProxy=true;
          await setWindowsSystemProxy(true);
          runtime.systemProxyChanged=true;
          console.log('[proxy] Mixed mode: TUN + Windows system proxy enabled');
        }
        ready=true;
      }
      settings.enabled=ready; settings.mode=normalizeVpnMode(mode); runtime.ready=ready; if(ready) startHealthMonitor(); save(); emit(); return status();
    } catch (e) {
      stopHealthMonitor();
      await cleanupWindowsTunRoutes(runtime.tunIfIndex||null);
      if(proc && runtime.proc===proc) { try{proc.kill()}catch{}; if(process.platform==='win32' && proc.pid){try{await execFileAsync('taskkill.exe',['/PID',String(proc.pid),'/T','/F'],{windowsHide:true})}catch{}} }
      runtime.proc=null; runtime.core=null; runtime.configPath=null; runtime.ready=false; runtime.trafficSeen=false; runtime.tunIfIndex=null;
      if(runtime.systemProxyChanged){try{await setWindowsSystemProxy(false)}catch{};runtime.systemProxyChanged=false;}
      settings.enabled=false; save(); emit();
      throw e;
    }
  })();
  try { return await startPromise; } finally { startPromise=null; }
}
export async function stop() {
  stopHealthMonitor();
  await cleanupWindowsTunRoutes(runtime.tunIfIndex||null);
  const proc=runtime.proc;
  runtime.ready=false;
  if(proc){ try{proc.kill();}catch{}; if(process.platform==='win32'){try{await execFileAsync('taskkill.exe',['/PID',String(proc.pid),'/T','/F'],{windowsHide:true});}catch{}} if(runtime.proc===proc) runtime.proc=null; }
  runtime.core=null; runtime.configPath=null; runtime.publicIp=''; runtime.tunIfIndex=null;
  if(runtime.systemProxyChanged){ try{await setWindowsSystemProxy(false);}catch{}; runtime.systemProxyChanged=false; }
  settings.enabled=false; save(); emit(); return status();
}
export async function toggle(){ return runtime.proc?stop():start(); }

export function status() {
  if(!settings) init(); const a=servers.find(s=>s.id===settings.activeServerId)||null;
  return {running:!!runtime.proc && runtime.ready===true, starting:!!runtime.proc && runtime.ready!==true, pid:runtime.proc?.pid||null, core:runtime.core, mode:runtime.mode, publicIp:runtime.publicIp||'', lastCheck:runtime.lastCheckAt||0, selected:a?{...a}:null, settings:getSettings(), servers:getServers(), subscriptions:getSubscriptions(), routes:getRoutes()};
}

// Периодическая проверка живости туннеля. Без неё UI продолжал показывать
// «работает», даже когда удалённый сервер обрывал связь уже после подключения.
let healthTimer = null;
let consecutiveHealthFails = 0;
function stopHealthMonitor() { if(healthTimer){clearInterval(healthTimer);healthTimer=null;} consecutiveHealthFails=0; }
function startHealthMonitor() {
  stopHealthMonitor();
  healthTimer=setInterval(async()=>{
    if(!runtime.proc || !runtime.ready) return;
    try {
      const res = isTunMode(runtime.mode) ? await verifyTunOutbound(10000, runtime.core||'sing-box') : await verifyOutboundViaHttpProxy(settings.httpPort,10000);
      if(res.ok){ consecutiveHealthFails=0; runtime.publicIp=res.ip; runtime.lastCheckAt=Date.now(); emit(); }
      else if(++consecutiveHealthFails>=3){
        console.warn('[proxy] VPN перестал отвечать — соединение помечено как разорванное');
        consecutiveHealthFails=0;
        stop().catch(()=>{});
      }
    } catch { /* сеть недоступна — не убиваем подключение из-за одной ошибки проверки */ }
  },60000);
  if(healthTimer.unref) healthTimer.unref();
}

export async function pingServerReal(id, timeout=6000, emitState=true) {
  id = normalizeEntityId(id);
  if(!settings) init();
  const s=servers.find(x=>x.id===id); if(!s) throw new Error('Сервер не найден');
  const started=Date.now();
  if(settings.pingType==='icmp' && process.platform==='win32') {
    try {
      const {stdout}=await execFileAsync('ping.exe',['-n','1','-w',String(timeout),s.address],{windowsHide:true,timeout:timeout+1500,maxBuffer:1024*64});
      const m=/[<]\s*(\d+)\s*ms|=\s*(\d+)ms/i.exec(String(stdout));
      const latency=m?Number(m[1]||m[2]):Date.now()-started; s.latency=latency; if (emitState) { save(); emit(); } return {id,ok:true,latency,error:null};
    } catch(e) { s.latency=null; if (emitState) { save(); emit(); } return {id,ok:false,latency:null,error:String(e?.message||'timeout')}; }
  }
  if(settings.pingType==='proxy') {
    try {
      const result=await requestText(settings.pingUrl||'https://cp.cloudflare.com/generate_204',{'User-Agent':'Zapret-Launcher/1.4.5'},0);
      const latency=Date.now()-started; s.latency=latency; if (emitState) { save(); emit(); } return {id,ok:true,latency,error:null};
    } catch {}
  }
  const { Socket } = await import('node:net');
  const result=await new Promise(resolve=>{const sock=new Socket();let done=false;const finish=r=>{if(done)return;done=true; sock.destroy();resolve(r)};sock.setTimeout(timeout,()=>finish({ok:false,latency:null,error:'timeout'}));sock.once('connect',()=>finish({ok:true,latency:Date.now()-started,error:null}));sock.once('error',e=>finish({ok:false,latency:null,error:e.message}));sock.connect(Number(s.port),s.address);});
  s.latency=result.latency; if (emitState) { save(); emit(); } return {id,...result};
}

async function pingServersParallel(list, timeout=6000, limit=8) {
  const out = new Array(list.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= list.length) return;
      const s = list[i];
      try { out[i] = await pingServerReal(s.id, timeout, false); }
      catch (e) { out[i] = { id:s.id, ok:false, latency:null, error:String(e?.message||e) }; }
    }
  };
  await Promise.all(Array.from({length:Math.min(limit, Math.max(1,list.length))}, worker));
  return out;
}

export async function pingAll() {
  if (!settings) init();
  for (const s of servers) s.latency=null;
  save(); emit();
  const out=await pingServersParallel(servers, Number(settings.pingTimeoutMs)||6000, 8);
  save(); emit();
  return out;
}

export async function pingSubscription(subscriptionId) {
  subscriptionId = normalizeEntityId(subscriptionId);
  if (!settings) init();
  const list = servers.filter(s => s.subscriptionId === subscriptionId);
  for (const s of list) s.latency=null;
  save(); emit();
  const out=await pingServersParallel(list, Number(settings.pingTimeoutMs)||6000, 8);
  save(); emit();
  return out;
}

export async function importXrayJson(raw) {
  const j=typeof raw==='string'?JSON.parse(raw):raw;
  if(!j || typeof j!=='object') throw new Error('Некорректный JSON');
  const outs=Array.isArray(j.outbounds)?j.outbounds:[]; const list=convertSingboxOutbounds(outs);
  for(const s of list) addServer(s);
  return list;
}
export async function importWireguardConf(raw) {
  const text=String(raw||''); const get=(k)=>{const r=new RegExp(`^\\s*${k}\\s*=\\s*(.+)\\s*$`,'im').exec(text);return r?r[1].trim():''};
  const addr=get('Address').split(',')[0].trim(); const priv=get('PrivateKey'); const pub=get('PublicKey'); const psk=get('PresharedKey'); const endpoint=get('Endpoint');
  if(!priv||!pub||!endpoint) throw new Error('WireGuard .conf: не хватает PrivateKey/PublicKey/Endpoint');
  const m=/^(.+):(\d+)$/.exec(endpoint); if(!m) throw new Error('WireGuard Endpoint некорректен');
  return addServer({name:'WireGuard',protocol:'wireguard',core:'sing-box',address:m[1],port:Number(m[2]),privateKey:priv,publicKey:pub,preSharedKey:psk,localAddress:addr?[addr]:['10.0.0.2/32'],source:'wireguard.conf'});
}
export function addRoute(route) { const r={id:route.id||idFor(JSON.stringify(route)),name:normalizeName(route.name,'Маршрутизация'),mode:route.mode||'split',domains:Array.isArray(route.domains)?route.domains:[],direct:Array.isArray(route.direct)?route.direct:[],block:Array.isArray(route.block)?route.block:[],dnsRemote:route.dnsRemote||'1.1.1.1',dnsDomestic:route.dnsDomestic||'8.8.8.8'}; const i=routes.findIndex(x=>x.id===r.id); if(i>=0)routes[i]=r;else routes.push(r); save(); emit(); return r; }
export function deleteRoute(id){routes=routes.filter(r=>r.id!==id); if(!routes.length)addRoute({id:'Global',name:'Глобальный прокси',mode:'proxy'}); if(settings.routeProfile===id)settings.routeProfile=routes[0].id; save(); return getRoutes();}
export function setRoute(id){if(!routes.some(r=>r.id===id))throw new Error('Профиль маршрутизации не найден');settings.routeProfile=id;save();emit();return id;}

export async function checkCores() {
  const out=[];
  for(const [name,dir,exe] of [['xray',XRAY_DIR(),'xray.exe'],['sing-box',SINGBOX_DIR(),'sing-box.exe']]) out.push({name,installed:fs.existsSync(path.join(dir,exe)),path:fs.existsSync(path.join(dir,exe))?path.join(dir,exe):null});
  return out;
}

export async function shutdown(){ if(runtime.proc) await stop(); }

init();

