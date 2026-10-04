import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
const root=path.resolve(new URL('..', import.meta.url).pathname);

test('VPN subscriptions are rendered as separate groups and each group has management actions',()=>{
  const app=fs.readFileSync(path.join(root,'src/renderer/app.js'),'utf8');
  assert.match(app,/function renderVpnServers\(\)/);
  assert.match(app,/data-subscription-id=/);
  assert.match(app,/data-proxy-sub-refresh=/);
  assert.match(app,/data-proxy-sub-del=/);
  assert.match(app,/servers\.filter\(s=>s\.subscriptionId===sub\.id\)/);
});

test('VPN favorites are placed into the common favorites section',()=>{
  const app=fs.readFileSync(path.join(root,'src/renderer/app.js'),'utf8');
  assert.match(app,/const favVpn = \(state\.proxy\.servers \|\| \[\]\)\.filter\(\(s\) => !!s\.favorite\)/);
  assert.match(app,/favVpn\.map\(vpnServerTileHtml\)/);
});

test('VPN ping-all emits only once after all servers are tested',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  assert.match(proxy,/pingServerReal\(s\.id, 6000, false\)/);
  assert.match(proxy,/save\(\);\s*emit\(\);\s*return out;/);
});

test('VPN active tiles use green state and custom app confirmation is used for deletes',()=>{
  const css=fs.readFileSync(path.join(root,'src/renderer/styles.css'),'utf8');
  const app=fs.readFileSync(path.join(root,'src/renderer/app.js'),'utf8');
  const html=fs.readFileSync(path.join(root,'src/renderer/index.html'),'utf8');
  assert.match(css,/\.vpn-server-tile\.active\{border-color:rgba\(46,224,106/);
  assert.match(css,/\.vpn-server-tile\{animation:none!important/);
  assert.match(app,/appConfirm\('Удалить сервер\?/);
  assert.doesNotMatch(app,/if\(del\)\{[^}]*confirm\(/);
  assert.match(html,/id="appConfirm"/);
});

test('VPN tiles expose a flag and never display generic Proxy as the server name',()=>{
  const app=fs.readFileSync(path.join(root,'src/renderer/app.js'),'utf8');
  assert.match(app,/function vpnServerFlag\(s\)/);
  assert.match(app,/function vpnServerDisplayName\(s\)/);
  assert.match(app,/GENERIC_RENDER_NAMES/);
});

test('toggleServer accepts object-shaped ids to prevent [object Object] failures',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  assert.match(proxy,/function normalizeEntityId\(value\)/);
  assert.match(proxy,/id = normalizeEntityId\(id\);\n  if\(!settings\) init\(\);/);
});


test('VPN subscription ping button is available per subscription',()=>{
  const app=fs.readFileSync(path.join(root,'src/renderer/app.js'),'utf8');
  const preload=fs.readFileSync(path.join(root,'src/preload/preload.cjs'),'utf8');
  const ipc=fs.readFileSync(path.join(root,'src/main/ipc.js'),'utf8');
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  assert.match(app,/data-proxy-sub-ping=/);
  assert.match(app,/proxyPingSubscription/);
  assert.match(preload,/proxyPingSubscription/);
  assert.match(ipc,/proxy:pingSubscription/);
  assert.match(proxy,/export async function pingSubscription\(/);
});

test('VPN flags convert ISO country codes such as NL/SE/US into emoji flags',()=>{
  const app=fs.readFileSync(path.join(root,'src/renderer/app.js'),'utf8');
  assert.match(app,/function normalizeFlagValue\(value\)/);
  assert.ok(app.includes('if(/^[a-z]{2}$/i.test(v)) return countryCodeToFlag(v)'));
  const css=fs.readFileSync(path.join(root,'src/renderer/styles.css'),'utf8');
  assert.match(css,/vpn-flag-img/);
  assert.match(app,/assets\/flags\/\$\{code\}\.svg/);
});

test('Main sections and VPN subscription groups are collapsible',()=>{
  const app=fs.readFileSync(path.join(root,'src/renderer/app.js'),'utf8');
  const html=fs.readFileSync(path.join(root,'src/renderer/index.html'),'utf8');
  assert.match(html,/data-collapse-target="favorites"/);
  assert.match(html,/data-collapse-target="vpn"/);
  assert.match(html,/data-collapse-target="tg"/);
  assert.match(html,/data-collapse-target="scripts"/);
  assert.match(app,/localStorage\.setItem\(storageKey, collapsed\?'1':'0'\)/);
  assert.match(app,/zl:vpn:sub/);
});

test('Core release JSON parses the requestText response body, not the wrapper object',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  assert.match(proxy,/const raw = \(info && typeof info === 'object' && 'body' in info\) \? info\.body : info/);
  assert.match(proxy,/typeof raw === 'string' \? JSON\.parse\(raw\) : raw/);
});

test('VPN status becomes connected after local proxy/TUN readiness; external check is best-effort',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  assert.match(proxy,/ready:\s*false/);
  assert.match(proxy,/waitForTcpListening\(settings\.httpPort,12000\)/);
  assert.match(proxy,/waitForTunAdapter\(tunAdapterName\(\),12000\)/);
  assert.match(proxy,/Внешняя проверка VPN не прошла; локальный прокси остаётся подключённым/);
  assert.match(proxy,/Внешняя проверка TUN не прошла; TUN остаётся подключённым/);
  assert.doesNotMatch(proxy,/if\(!runtime\.trafficSeen\) throw new Error/);
  assert.match(proxy,/running:\!\!runtime\.proc && runtime\.ready===true/);
});

test('VPN tiles do not move on hover or click',()=>{
  const css=fs.readFileSync(path.join(root,'src/renderer/styles.css'),'utf8');
  assert.match(css,/\.vpn-server-tile:hover\{transform:none;/);
  assert.match(css,/\.vpn-server-tile:active\{transform:none\}/);
});

test('VPN flags use bundled local SVG assets instead of regional-indicator letters',()=>{
  const app=fs.readFileSync(path.join(root,'src/renderer/app.js'),'utf8');
  assert.match(app,/assets\/flags\/\$\{code\}\.svg/);
  const flags=path.join(root,'src/renderer/assets/flags');
  assert.ok(fs.existsSync(path.join(flags,'nl.svg')));
  assert.ok(fs.existsSync(path.join(flags,'us.svg')));
  assert.ok(fs.existsSync(path.join(flags,'sg.svg')));
});

test('Technical subscription/server domains are converted into user-facing names',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  const app=fs.readFileSync(path.join(root,'src/renderer/app.js'),'utf8');
  assert.match(proxy,/known = \{ guava:'Guava'/);
  assert.match(proxy,/countryFromHost\(address\)/);
  assert.match(app,/Не показываем технический домен/);
});

test('TUN fixes: adapter name normalized, tunCore singbox alias mapped, wintun prepared for Xray',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  assert.match(proxy,/function normalizeTunName\(name\)/);
  assert.match(proxy,/interface_name:tunAdapterName\(\)/);
  assert.match(proxy,/name:tunAdapterName\(\)/);
  assert.match(proxy,/s\.tunCore === 'singbox' \|\| s\.tunCore === 'sing_box'\) s\.tunCore = 'sing-box'/);
  assert.match(proxy,/await ensureXrayWintunDll\(exe\)/);
  assert.doesNotMatch(proxy,/tunCore: 'singbox'/);
  const app=fs.readFileSync(path.join(root,'src/renderer/app.js'),'utf8');
  assert.doesNotMatch(app,/tunCore:[^,]*\|\|\s*'singbox'/);
});

test('Core log mojibake (CP866) is decoded and TUN errors get a readable message',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  assert.match(proxy,/TextDecoder\('cp866'\)/);
  assert.match(proxy,/Failed to find matching adapter name/);
  assert.match(proxy,/Не удалось создать TUN-адаптер/);
});
