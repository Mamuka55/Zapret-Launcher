import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Socket } from 'node:net';
import { app } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const execFileAsync = promisify(execFile);
const DATA_DIR = () => path.join(app.getPath('userData'), 'proxy');
const SERVERS_FILE = () => path.join(DATA_DIR(), 'servers.json');
const SUBS_FILE = () => path.join(DATA_DIR(), 'subscriptions.json');
const ROUTES_FILE = () => path.join(DATA_DIR(), 'routes.json');
const CORES_DIR = () => path.join(DATA_DIR(), 'cores');
const CFG_DIR = () => path.join(DATA_DIR(), 'configs');
const XRAY_DIR = () => path.join(CORES_DIR(), 'xray');
const SINGBOX_DIR = () => path.join(CORES_DIR(), 'sing-box');

const DEFAULTS = {
  enabled: false,
  mode: 'proxy', // proxy | tun
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

let runtime = { proc: null, core: null, mode: 'proxy', configPath: null, systemProxyChanged: false, ready: false, trafficSeen: false };
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
  settings = { ...DEFAULTS, ...(readJson(path.join(DATA_DIR(), 'settings.json'), {}) || {}) };
  normalizeTunSettings(settings);
  servers = Array.isArray(readJson(SERVERS_FILE(), [])) ? readJson(SERVERS_FILE(), []) : [];
  // Удаляем старые служебные/заглушечные VLESS-записи вида 0.0.0.0:1.
  servers = servers.filter(s => !isPlaceholderServer(s));
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

function normalizeServer(s) {
  const protocol = String(s.protocol || '').toLowerCase();
  const address = String(s.address || '').trim();
  const base = {
    id: s.id || idFor(s.source || JSON.stringify(s)),
    name: meaningfulServerName(s.name || s.remarks || s.ps || s.tag, address, protocol),
    protocol, core: s.core || 'xray',
    address, port: Number(s.port || 0),
    source: s.source || '', createdAt: s.createdAt || Date.now(), latency: Number.isFinite(s.latency) ? s.latency : null,
    favorite: !!s.favorite, subscriptionId: s.subscriptionId || null, countryCode: s.countryCode || countryFromHost(address) || ''
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
  const seed = [process.platform, process.arch, os.hostname(), app.getPath('userData')].join('|');
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
      security:user0?.security || (tls.enabled ? 'tls' : (reality.enabled ? 'reality' : 'none')),
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
  const s=server;
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
  return { routing:{domainStrategy:'IPIfNonMatch',rules} };
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
  const inbounds= mode==='tun' ? [{tag:'tun-in',port:0,protocol:'tun',settings:{name:tunAdapterName(),mtu:Number(settings.mtu||1500),gateway:['198.18.0.1/15','fdfe:dcba:9876::1/126'],address:['198.18.0.1/15','fdfe:dcba:9876::1/126'],dns:settings.dns||['1.1.1.1','8.8.8.8'],poolSize:2,onDropped:'bypass'}}] :[{tag:'socks-in',listen:'127.0.0.1',port:Number(settings.socksPort||10808),protocol:'socks',settings:{udp:true,accounts:settings.socksAuthMode==='manual'&&settings.socksAuthUser?[{user:settings.socksAuthUser,pass:settings.socksAuthPassword||''}]:undefined},sniffing:{enabled:true,destOverride:['http','tls','quic']}},{tag:'http-in',listen:'127.0.0.1',port:Number(settings.httpPort||10809),protocol:'http',settings:{accounts:settings.httpAuthMode==='manual'&&settings.httpAuthUser?[{user:settings.httpAuthUser,pass:settings.httpAuthPassword||''}]:undefined}}];
  const outbounds=[{tag:'proxy',...xrayOutbound(server)},{tag:'direct',protocol:'freedom',settings:{}},{tag:'block',protocol:'blackhole',settings:{}}];
  return {log:{loglevel:'warning'},dns:{servers:[...(settings.dns||['1.1.1.1','8.8.8.8'])]},inbounds,outbounds:{}, routing:route.routing};
}

// Xray accepts outbounds as an array; kept separate to make generated config easy to inspect.
function finalizeXrayConfig(cfg, server) { cfg.outbounds=[{tag:'proxy',...xrayOutbound(server)},{tag:'direct',protocol:'freedom',settings:{}},{tag:'block',protocol:'blackhole',settings:{}}]; return cfg; }

function buildSingboxConfig(server, mode='tun') {
  const outbound=singboxOutbound(server);
  if (mode==='proxy') {
    return {log:{level:'warn'},inbounds:[{type:'mixed',tag:'mixed-in',listen:'127.0.0.1',listen_port:Number(settings.httpPort||10809)}],outbounds:[outbound,{type:'direct',tag:'direct'},{type:'block',tag:'block'}],route:{auto_detect_interface:true}};
  }
  return {log:{level:'warn'},inbounds:[{type:'tun',tag:'tun-in',interface_name:tunAdapterName(),address:['172.19.0.1/30','fdfe:dcba:9876::1/126'],mtu:Number(settings.mtu||1500),auto_route:true,strict_route:false}],outbounds:[outbound,{type:'direct',tag:'direct'},{type:'block',tag:'block'}],route:{auto_detect_interface:true}};
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
    let msg = raw;
    try {
      if (/[\u2500-\u2513\u2500-\u257F]{2}/.test(raw)) {
        const bytes = Uint8Array.from(Buffer.from(raw, 'binary'));
        const fixed = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        if (/[\u0400-\u04FF]/.test(fixed)) msg = fixed;
      }
    } catch {}
    throw new Error(`Проверка конфигурации не пройдена: ${msg.slice(0, 1200)}`);
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

async function setWindowsSystemProxy(enabled) {
  if(process.platform!=='win32') return false;
  const pathKey='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  if(enabled){
    await execFileAsync('reg.exe',['add',pathKey,'/v','ProxyEnable','/t','REG_DWORD','/d','1','/f'],{windowsHide:true});
    await execFileAsync('reg.exe',['add',pathKey,'/v','ProxyServer','/t','REG_SZ','/d',`http=127.0.0.1:${settings.httpPort};https=127.0.0.1:${settings.httpPort};socks=127.0.0.1:${settings.socksPort}`,'/f'],{windowsHide:true});
  } else {
    await execFileAsync('reg.exe',['add',pathKey,'/v','ProxyEnable','/t','REG_DWORD','/d','0','/f'],{windowsHide:true});
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

async function waitForTunAdapter(name, timeoutMs=12000) {
  if(process.platform!=='win32') return true;
  // Адаптер может называться иначе, чем запрошено (Wintun переименовывает его при
  // пересоздании), поэтому ищем и по имени, и по описанию; кириллические символы
  // в описании сравниваются через транслитерацию.
  const wanted=String(name||'EpicTunnel').replace(/'/g,"''");
  const latin=latinizeName(String(name||'EpicTunnel')).replace(/'/g,"''");
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    try {
      const {stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
        `$n='${wanted}';$l='${latin}';$a=@(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -like '*Wintun*' -or $_.Name -eq $n -or $_.Name -like "*$l*" }); if(($a | Where-Object { $_.Status -eq 'Up' })){ 'UP' }elseif($a.Count -gt 0){ 'DOWN' }`],{windowsHide:true,timeout:4000,maxBuffer:10240});
      const st=String(stdout).trim();
      if(st.includes('UP')) return true;
      lastTunState = st==='DOWN' ? 'down' : 'none';
    } catch { lastTunState='probe-error'; }
    await new Promise(r=>setTimeout(r,250));
  }
  return false;
}
let lastTunState='none';

function latinizeName(s){
  const map={а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'};
  return String(s).toLowerCase().split('').map(ch=>map[ch]!==undefined?map[ch]:ch).join('');
}

async function verifyOutboundViaHttpProxy(port, timeoutMs=12000) {
  if(process.platform!=='win32') return true;
  try {
    await execFileAsync('curl.exe',[
      '--silent','--show-error','--fail','--noproxy','',
      '--proxy',`http://127.0.0.1:${port}`,
      '--connect-timeout','5','--max-time',String(Math.ceil(timeoutMs/1000)),
      '--output',process.platform==='win32'?'NUL':'/dev/null',
      'https://cp.cloudflare.com/generate_204'
    ],{windowsHide:true,timeout:timeoutMs+2500,maxBuffer:64*1024});
    return true;
  } catch { return false; }
}

async function verifyTunOutbound(timeoutMs=12000) {
  if(process.platform!=='win32') return true;
  try {
    await execFileAsync('curl.exe',[
      '--silent','--show-error','--fail','--noproxy','*',
      '--connect-timeout','5','--max-time',String(Math.ceil(timeoutMs/1000)),
      '--output','NUL','https://cp.cloudflare.com/generate_204'
    ],{windowsHide:true,timeout:timeoutMs+2500,maxBuffer:64*1024});
    return true;
  } catch { return false; }
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
      let core = mode==='tun' && settings.tunCore ? settings.tunCore : server.core;
      if(core==='auto') core=['hysteria2','wireguard'].includes(server.protocol)?'sing-box':'xray';
      if(['hysteria2','wireguard'].includes(server.protocol)) core='sing-box';
      const exe=await ensureCore(core);
      if(mode==='tun' && core==='xray') await ensureXrayWintunDll(exe);
      if(mode==='proxy' && core==='xray') {
        const socks=await findFreeTcpPort(settings.socksPort, new Set());
        const http=await findFreeTcpPort(settings.httpPort, new Set([socks]));
        settings.socksPort=socks; settings.httpPort=http; save();
      }
      const cfg=core==='sing-box'?buildSingboxConfig(server,mode):finalizeXrayConfig(buildXrayConfig(server,mode),server);
      const configPath=path.join(CFG_DIR(),`active-${core}.json`); fs.writeFileSync(configPath,JSON.stringify(cfg,null,2),'utf8');
      await validateCore(exe,configPath);
      runtime.core=core; runtime.mode=mode; runtime.configPath=configPath; runtime.ready=false; runtime.trafficSeen=false;
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
        (warn?console.warn:console.log)('[proxy]',decoded.trim());
      };
      proc.stdout?.on('data',d=>onCoreOutput(d,false));
      proc.stderr?.on('data',d=>onCoreOutput(d,true));
      proc.once('error',err=>console.warn('[proxy] process error',err));
      proc.once('exit',()=>{ if(runtime.proc===proc) runtime.proc=null; runtime.core=null; runtime.configPath=null; runtime.ready=false; runtime.trafficSeen=false; if(runtime.systemProxyChanged){setWindowsSystemProxy(false).catch(()=>{});runtime.systemProxyChanged=false;} if(settings){settings.enabled=false;save();} emit(); });

      let ready=false;
      if(mode==='proxy') {
        const listening=await waitForTcpListening(settings.httpPort,12000);
        if(!listening) throw new Error(`VPN-ядро запущено, но локальный HTTP-порт ${settings.httpPort} не открылся`);
        // Локальный HTTP-in уже поднят. Не блокируем подключение внешним health-check:
        // он зависит от DNS/Cloudflare и мог ложно считать рабочий VPN нерабочим.
        ready=true;
        if(settings.systemProxy){ await setWindowsSystemProxy(true); runtime.systemProxyChanged=true; }
        // Best-effort проверка: только логируем результат, но не отменяем рабочий запуск.
        try {
          const ok=await verifyOutboundViaHttpProxy(settings.httpPort,5000);
          if(!ok) console.warn('[proxy] Внешняя проверка VPN не прошла; локальный прокси остаётся подключённым.');
        } catch {}
      } else {
        const adapter=await waitForTunAdapter(tunAdapterName(),12000);
        if(!adapter) throw new Error(`TUN-интерфейс «${tunAdapterName()}» не перешёл в состояние Up${lastTunState==='none'?'; проверьте, что драйвер Wintun доступен (для ядра Xray нужна wintun.dll рядом с xray.exe), или выберите ядро sing-box для режима TUN':''}`);
        // Для TUN главным критерием готовности является поднятый адаптер и живой процесс.
        // Внешний curl оставляем только диагностическим, чтобы не блокировать рабочий TUN.
        ready=true;
        try {
          const ok=await verifyTunOutbound(5000);
          if(!ok) console.warn('[proxy] Внешняя проверка TUN не прошла; TUN остаётся подключённым.');
        } catch {}
      }
      settings.enabled=ready; settings.mode=mode; runtime.ready=ready; save(); emit(); return status();
    } catch (e) {
      if(proc && runtime.proc===proc) { try{proc.kill()}catch{}; if(process.platform==='win32' && proc.pid){try{await execFileAsync('taskkill.exe',['/PID',String(proc.pid),'/T','/F'],{windowsHide:true})}catch{}} }
      runtime.proc=null; runtime.core=null; runtime.configPath=null; runtime.ready=false; runtime.trafficSeen=false;
      if(runtime.systemProxyChanged){try{await setWindowsSystemProxy(false)}catch{};runtime.systemProxyChanged=false;}
      settings.enabled=false; save(); emit();
      throw e;
    }
  })();
  try { return await startPromise; } finally { startPromise=null; }
}
export async function stop() {
  const proc=runtime.proc;
  runtime.ready=false;
  if(proc){ try{proc.kill();}catch{}; if(process.platform==='win32'){try{await execFileAsync('taskkill.exe',['/PID',String(proc.pid),'/T','/F'],{windowsHide:true});}catch{}} if(runtime.proc===proc) runtime.proc=null; }
  runtime.core=null; runtime.configPath=null;
  if(runtime.systemProxyChanged){ try{await setWindowsSystemProxy(false);}catch{}; runtime.systemProxyChanged=false; }
  settings.enabled=false; save(); emit(); return status();
}
export async function toggle(){ return runtime.proc?stop():start(); }

export function status() {
  if(!settings) init(); const a=servers.find(s=>s.id===settings.activeServerId)||null;
  return {running:!!runtime.proc && runtime.ready===true, starting:!!runtime.proc && runtime.ready!==true, pid:runtime.proc?.pid||null, core:runtime.core, mode:runtime.mode, selected:a?{...a}:null, settings:getSettings(), servers:getServers(), subscriptions:getSubscriptions(), routes:getRoutes()};
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
      const latency=m?Number(m[1]||m[2]):Date.now()-started; s.latency=latency; save(); if (emitState) emit(); return {id,ok:true,latency,error:null};
    } catch(e) { s.latency=null; save(); if (emitState) emit(); return {id,ok:false,latency:null,error:String(e?.message||'timeout')}; }
  }
  if(settings.pingType==='proxy') {
    try {
      const result=await requestText(settings.pingUrl||'https://cp.cloudflare.com/generate_204',{'User-Agent':'Zapret-Launcher/1.4.5'},0);
      const latency=Date.now()-started; s.latency=latency; save(); if (emitState) emit(); return {id,ok:true,latency,error:null};
    } catch {}
  }
  const { Socket } = await import('node:net');
  const result=await new Promise(resolve=>{const sock=new Socket();let done=false;const finish=r=>{if(done)return;done=true; sock.destroy();resolve(r)};sock.setTimeout(timeout,()=>finish({ok:false,latency:null,error:'timeout'}));sock.once('connect',()=>finish({ok:true,latency:Date.now()-started,error:null}));sock.once('error',e=>finish({ok:false,latency:null,error:e.message}));sock.connect(Number(s.port),s.address);});
  s.latency=result.latency; save(); if (emitState) emit(); return {id,...result};
}

export async function pingAll() {
  if (!settings) init();
  for (const s of servers) s.latency=null;
  save(); emit();
  const out=[];
  for(const s of servers){ try { out.push(await pingServerReal(s.id, 6000, false)); } catch(e) { out.push({id:s.id,ok:false,error:String(e?.message||e)}); } }
  save();
  emit();
  return out;
}

export async function pingSubscription(subscriptionId) {
  subscriptionId = normalizeEntityId(subscriptionId);
  if (!settings) init();
  const list = servers.filter(s => s.subscriptionId === subscriptionId);
  for (const s of list) s.latency=null;
  save(); emit();
  const out=[];
  for (const s of list) {
    try { out.push(await pingServerReal(s.id, 6000, false)); }
    catch (e) { out.push({ id:s.id, ok:false, latency:null, error:String(e?.message||e) }); }
  }
  save();
  emit();
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
