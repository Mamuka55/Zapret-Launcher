// Юнит-тесты чистой логики (node --test)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  naturalCompare, compareVersions, isNewer, cleanLabel, parseLocalVersion,
  validatePortRange, parseGameFilterText, ipsetStatusFromContent,
  hostsNeedsUpdate, isServiceBat, guessAssetUrl
} from '../src/main/lib/pure.js';

test('naturalCompare сортирует номера как человек', () => {
  const arr = ['10. YouTube.bat', '2. Discord.bat', '1. Discord & YouTube.bat'];
  assert.deepEqual([...arr].sort(naturalCompare), [
    '1. Discord & YouTube.bat', '2. Discord.bat', '10. YouTube.bat'
  ]);
});

test('compareVersions / isNewer', () => {
  assert.equal(compareVersions('1.10.3', '1.9.9'), 1);
  assert.equal(compareVersions('1.2.0', '1.2'), 0);
  assert.equal(compareVersions('v1.2.0', '1.3.0'), -1);
  assert.equal(isNewer('1.11.0', '1.10.3'), true);
  assert.equal(isNewer('1.10.3', '1.10.3'), false);
  assert.equal(isNewer('1.10.3', null), true);
});

test('cleanLabel убирает номер и расширение', () => {
  assert.equal(cleanLabel('1. Discord & YouTube.bat'), 'Discord & YouTube');
  assert.equal(cleanLabel('10) YouTube (alt).cmd'), 'YouTube (alt)');
  assert.equal(cleanLabel('run.bat'), 'run');
});

test('parseLocalVersion читает LOCAL_VERSION из service.bat', () => {
  const text = '@echo off\r\nset "LOCAL_VERSION=1.10.3"\r\n';
  assert.equal(parseLocalVersion(text), '1.10.3');
  assert.equal(parseLocalVersion('нет версии'), null);
});

test('validatePortRange как в service.bat', () => {
  assert.equal(validatePortRange('1024-65535'), '1024-65535');
  assert.equal(validatePortRange('1024-1934,1936-65535'), '1024-1934,1936-65535');
  assert.equal(validatePortRange('443'), '443');
  assert.equal(validatePortRange('0-80'), null);
  assert.equal(validatePortRange('70000'), null);
  assert.equal(validatePortRange('2000-1000'), null);
  assert.equal(validatePortRange('abc'), null);
  assert.equal(validatePortRange(''), null);
});

test('parseGameFilterText разбирает utils/game_filter.enabled', () => {
  const t1 = 'mode=all\ntcp=1024-65535\nudp=1024-65535\n';
  assert.equal(parseGameFilterText(t1).mode, 'all');
  const t2 = 'mode=udp\ntcp=12\nudp=1024-2000\n';
  const r2 = parseGameFilterText(t2);
  assert.equal(r2.mode, 'udp');
  assert.equal(r2.udp, '1024-2000');
  const r3 = parseGameFilterText(null);
  assert.equal(r3.mode, 'disabled');
  assert.equal(r3.enabled, false);
});

test('ipsetStatusFromContent: any / none / loaded', () => {
  assert.equal(ipsetStatusFromContent(null), 'any');
  assert.equal(ipsetStatusFromContent(''), 'any');
  assert.equal(ipsetStatusFromContent('203.0.113.113/32\n'), 'none');
  assert.equal(ipsetStatusFromContent('1.2.3.4/32\n5.6.7.8/32\n'), 'loaded');
});

test('hostsNeedsUpdate сравнивает первую и последнюю строки', () => {
  const remote = '# zapret hosts v1\nexample.com\n# end marker';
  assert.equal(hostsNeedsUpdate('# zapret hosts v1\nx\n# end marker', remote), false);
  assert.equal(hostsNeedsUpdate('старый файл', remote), true);
  assert.equal(hostsNeedsUpdate(null, remote), true);
});

test('isServiceBat исключает служебные файлы из плиток', () => {
  assert.equal(isServiceBat('service.bat'), true);
  assert.equal(isServiceBat('Service_gui.cmd'), true);
  assert.equal(isServiceBat('1. Discord.bat'), false);
});

test('guessAssetUrl собирает fallback-ссылку на zip', () => {
  assert.equal(
    guessAssetUrl('Flowseal/zapret-discord-youtube', '1.10.4'),
    'https://github.com/Flowseal/zapret-discord-youtube/releases/download/1.10.4/zapret-discord-youtube-1.10.4.zip'
  );
});

test('Windows system proxy uses one HTTP endpoint and refreshes WinINet after registry change', () => {
  const src = fs.readFileSync(new URL('../src/main/proxy.js', import.meta.url), 'utf8');
  assert.ok(src.includes("ProxyServer"));
  assert.ok(src.includes("`127.0.0.1:${settings.httpPort}`"));
  assert.ok(src.includes("InternetSetOption([IntPtr]::Zero,39"));
  assert.ok(src.includes("InternetSetOption([IntPtr]::Zero,37"));
  assert.ok(src.includes("systemProxyOriginal"));
});


test('Windows system proxy clears stale bypass/PAC and broadcasts settings change', () => {
  const src = fs.readFileSync(new URL('../src/main/proxy.js', import.meta.url), 'utf8');
  assert.ok(src.includes("writeWinReg(pathKey,'ProxyOverride','REG_SZ','<local>')"));
  assert.ok(src.includes("writeWinReg(pathKey,'MigrateProxy','REG_DWORD','0')"));
  assert.ok(src.includes('SendMessageTimeout'));
  assert.ok(src.includes('verifyWindowsSystemProxyEndpoint'));
  assert.ok(src.includes("[Convert]::ToUInt32('80000000',16)"));
});


test('System proxy is the default and is migrated once for legacy settings', () => {
  const proxySrc = fs.readFileSync(new URL('../src/main/proxy.js', import.meta.url), 'utf8');
  const cfgSrc = fs.readFileSync(new URL('../src/main/config.js', import.meta.url), 'utf8');
  assert.ok(proxySrc.includes("if (rawSettings.proxyDefaultModeVersion !== 'system-v1')"));
  assert.ok(proxySrc.includes("settings.mode = 'proxy'"));
  assert.ok(proxySrc.includes("settings.systemProxy = true"));
  assert.ok(cfgSrc.includes("proxyMode: 'proxy'"));
  assert.ok(cfgSrc.includes("proxySystem: true"));
});

test('Windows system proxy also uses WinINet per-connection API, not only registry values', () => {
  const src = fs.readFileSync(new URL('../src/main/proxy.js', import.meta.url), 'utf8');
  assert.ok(src.includes('INTERNET_OPTION_PER_CONNECTION_OPTION'));
  assert.ok(src.includes('applyWinInetSystemProxy'));
  assert.ok(src.includes("InternetSetOption([IntPtr]::Zero,75"));
  assert.ok(src.includes("$server='${escapedEndpoint}'"));
});

test('VPN mixed mode is exposed and combines TUN with Windows system proxy', () => {
  const proxySrc = fs.readFileSync(new URL('../src/main/proxy.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
  assert.ok(proxySrc.includes("['proxy','tun','mixed']"));
  assert.ok(proxySrc.includes("function isTunMode(mode) { return mode === 'tun' || mode === 'mixed'; }"));
  assert.ok(proxySrc.includes("if(mode==='mixed')"));
  assert.ok(html.includes('value="mixed">Смешанный — TUN + системный прокси'));
  assert.ok(app.includes("px.mode==='mixed'?'Смешанный режим подключён'"));
});

test('VPN mixed mode forces sing-box TUN on Windows for Xray 26.3.27 compatibility', () => {
  const src = fs.readFileSync(new URL('../src/main/proxy.js', import.meta.url), 'utf8');
  assert.ok(src.includes("if(isTunMode(mode) && process.platform==='win32' && core==='xray')"));
  assert.ok(src.includes("core='sing-box'"));
  assert.ok(src.includes("settings.tunCore='sing-box'"));
});

test('sing-box TUN excludes resolved upstream server IPs to prevent VLESS routing loops', () => {
  const src = fs.readFileSync(new URL('../src/main/proxy.js', import.meta.url), 'utf8');
  assert.ok(src.includes('async function resolveOutboundServerIps(server)'));
  assert.ok(src.includes('route_exclude_address'));
  assert.ok(src.includes('routeExclude.length ? {route_exclude_address:routeExclude} : {}'));
  assert.ok(src.includes('dns.promises.lookup(host,{all:true,verbatim:true})'));
  assert.ok(src.includes('TUN upstream route exclusions'));
});
