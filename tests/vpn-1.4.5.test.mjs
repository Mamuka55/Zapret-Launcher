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
  assert.match(proxy,/pingServersParallel\(servers, Number\(settings\.pingTimeoutMs\)\|\|6000, 8\)/);
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

test('VPN status becomes connected only after a real end-to-end check through the tunnel',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  assert.match(proxy,/ready:\s*false/);
  assert.match(proxy,/waitForTcpListening\(settings\.httpPort,6000\)/);
  assert.match(proxy,/waitForTunAdapter\(adapterName,12000\)/);
  // Реальная проверка туннеля обязательна: без неё UI врал «работает»,
  // а реальный IP не менялся.
  assert.match(proxy,/const check=await verifyOutboundViaHttpProxy\(settings\.httpPort,5000\)/);
  assert.match(proxy,/const check=await verifyTunOutbound\(15000,core\)/);
  assert.match(proxy,/if\(!check\.ok\)/);
  assert.match(proxy,/Проверка VPN не пройдена: через локальный прокси не удалось выйти в интернет/);
  assert.match(proxy,/Проверка VPN не пройдена: Windows не направил тестовый IPv4 через TUN или TUN не вернул HTTP-ответ/);
  assert.doesNotMatch(proxy,/Внешняя проверка VPN не прошла; локальный прокси остаётся подключённым/);
  assert.doesNotMatch(proxy,/Внешняя проверка TUN не прошла; TUN остаётся подключённым/);
  assert.doesNotMatch(proxy,/if\(!runtime\.trafficSeen\) throw new Error/);
  assert.match(proxy,/running:\!\!runtime\.proc && runtime\.ready===true/);
});

test('Xray config contains non-empty outbounds array (empty object meant no proxy outbound => fake "working" VPN)',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  assert.doesNotMatch(proxy,/outbounds\s*:\s*\{\}/);
  assert.match(proxy,/inbounds,outbounds,routing:route\.routing/);
});

test('VPN health monitor disconnects when tunnel stops carrying traffic',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  assert.match(proxy,/function startHealthMonitor\(\)/);
  assert.match(proxy,/consecutiveHealthFails>=3/);
  assert.match(proxy,/if\(ready\) startHealthMonitor\(\)/);
  assert.match(proxy,/stopHealthMonitor\(\);\n  await cleanupWindowsTunRoutes\(runtime\.tunIfIndex\|\|null\);\n  const proc=runtime\.proc/);
  assert.match(proxy,/publicIp:runtime\.publicIp\|\|''/);
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

test('Xray TUN config uses physical outbound binding and manual Windows /1 routes for deterministic routing',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  assert.doesNotMatch(proxy,/tunSettings\.autoSystemRoutingTable=/);
  assert.match(proxy,/tunSettings\.autoOutboundsInterface='auto'/);
  assert.match(proxy,/ensureWindowsTunRoutes/);
  assert.match(proxy,/tunSettings\.autoOutboundsInterface='auto'/);
  assert.match(proxy,/execFileAsync\('curl\.exe'/);
  assert.match(proxy,/system-tun-http/);
  assert.doesNotMatch(proxy,/--interface',source/);
  assert.match(proxy,/--resolve','example\.com:80:93\.184\.216\.34/);
  assert.match(proxy,/tunRouteDiagnostics/);
  assert.match(proxy,/verifyTunRouteSelection/);
  assert.doesNotMatch(proxy,/Find-NetRoute -RemoteIPAddress '93\.184\.216\.34'/);
  assert.match(proxy,/Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0\.0\.0\.0\/1'/);
});



test('Windows TUN routing targets the exact adapter and removes stale default route',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  assert.match(proxy,/Name -eq \$n/);
  assert.match(proxy,/New-NetRoute -DestinationPrefix \$d -InterfaceIndex \$idx -NextHop 0\.0\.0\.0/);
  assert.match(proxy,/0\.0\.0\.0\/0/);
  assert.match(proxy,/cleanupWindowsTunRoutes/);
});
test('TUN route diagnostics groups PowerShell pipeline before -join',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  assert.match(proxy, /\(\$r \| ForEach-Object \{ \$_\.DestinationPrefix\+':\'\+\$\_\.RouteMetric \}\) -join ','/);
  assert.doesNotMatch(proxy, /ForEach-Object \{ \$_\.DestinationPrefix\+':\'\+\$\_\.RouteMetric \} -join ','/);
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

test('Core log mojibake (CP866-as-UTF8) is decoded and TUN errors get a readable message',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  // Логи ядер приходят как UTF-8, отображённый в CP866 (символы ╨..╤ из U+2500-U+2513).
  // Декодирование: восстановление байтов + TextDecoder('utf-8').
  assert.match(proxy,/Buffer\.from\(\s*\w+\s*,\s*'binary'\s*\)/);
  assert.match(proxy,/new TextDecoder\('utf-8'/);
  assert.match(proxy,/\\u2500-\\u2513/);
  assert.match(proxy,/Failed to find matching adapter name/);
  assert.match(proxy,/Не удалось создать TUN-адаптер/);
});

test('validateCore uses correct CLI flags per core (sing-box: check -c, xray: -test -config)',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  // sing-box не поддерживает `run -test` / `-t` — только `check -c`
  assert.match(proxy,/async function validateCore\(exe, configPath\)/);
  assert.match(proxy,/path\.basename\(exe\)\.toLowerCase\(\)/);
  assert.match(proxy,/\['check',\s*'-c',\s*configPath\]/);
  // xray проверяется без подкоманды run
  assert.match(proxy,/\['-test',\s*'-config',\s*configPath\]/);
  assert.doesNotMatch(proxy,/exe,\s*\[\s*'run',\s*'-test'/);
});


test('sing-box 1.14+ uses current route actions and no removed sniff fields',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  assert.match(proxy,/action:'sniff'/);
  assert.match(proxy,/action:'route', outbound:'proxy'/);
  assert.match(proxy,/action:'route', outbound:'direct'/);
  assert.match(proxy,/action:'route', outbound:'block'/);
  assert.doesNotMatch(proxy,/route:\{[^}]*sniff:true/);
  assert.doesNotMatch(proxy,/strict_route:false,sniff:true/);
  assert.doesNotMatch(proxy,/outbound_tag:/);
});

test('System-proxy mode applies Windows proxy before remote readiness check and uses curl for the probe',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  const applyPos=proxy.indexOf("if(settings.systemProxy){ await setWindowsSystemProxy(true); runtime.systemProxyChanged=true; }");
  const checkPos=proxy.indexOf("const check=await verifyOutboundViaHttpProxy(settings.httpPort,5000)",applyPos);
  assert.ok(applyPos>=0 && checkPos>applyPos);
  assert.match(proxy,/async function verifyOutboundViaHttpProxy\(port, timeoutMs=12000\)/);
  assert.match(proxy,/execFileAsync\('curl\.exe'/);
  assert.match(proxy,/'http:\/\/example\.com\/'/);
});

test('VPN verification diagnoses local ports before stopping the core',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  const verifyPos=proxy.indexOf("const check=await verifyOutboundViaHttpProxy(settings.httpPort,5000)");
  const detailPos=proxy.indexOf('const detail=await describeVerifyFailure()', verifyPos);
  const killPos=proxy.indexOf('proc.kill()', detailPos);
  assert.ok(verifyPos>=0 && detailPos>verifyPos && killPos>detailPos);
});

test('saved VLESS servers are normalized on startup so Vision cannot remain security=none', () => {
  const proxy = fs.readFileSync(path.join(root, 'src/main/proxy.js'), 'utf8');
  assert.match(proxy, /servers = servers\.filter\(s => !isPlaceholderServer\(s\)\)\.map\(s => normalizeServer\(s\)\)/);
  assert.match(proxy, /const s = server\?\.protocol === 'vless' \? normalizeServer\(server\) : server/);
});

test('proxy CONNECT preserves bytes already read past the CONNECT header before TLS wrapping',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  assert.match(proxy,/const remainder = raw\.subarray\(end \+ marker\.length\);/);
  assert.match(proxy,/socket\.unshift\(remainder\)/);
  assert.match(proxy,/if \(buffer\.length\) \{ try \{ socket\.unshift\(buffer\);/);
});

test('VPN readiness completes target TLS through HTTP CONNECT before declaring transport ready',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  assert.match(proxy,/function connectViaHttpProxy\(proxyUrl, target, timeoutMs\)/);
  assert.match(proxy,/CONNECT \${host}:\${port} HTTP\/1\.1/);
  assert.match(proxy,/const secure = tls\.connect\(\{\s*socket,\s*servername: target\.hostname/);
  assert.match(proxy,/secure\.once\('secureConnect', \(\) => finish\(null, secure\)\)/);
  assert.match(proxy,/async function probeProxyTransport\(proxyUrl, targetUrl, timeoutMs\)/);
  assert.match(proxy,/connectViaHttpProxy\(proxyUrl, target, timeoutMs\)/);
  assert.match(proxy,/connectViaSocks5Proxy\(proxyUrl, target, timeoutMs\)/);
});

test('HTTP proxy readiness has a plain-HTTP fallback matching a real curl proxy check',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  assert.match(proxy,/function fetchPlainHttpThroughHttpProxy\(url, proxyUrl, timeoutMs\)/);
  assert.match(proxy,/GET \$\{target\.toString\(\)\} HTTP\/1\.1/);
  assert.match(proxy,/const PLAIN_HTTP_VERIFY_ENDPOINTS = \[/);
  assert.match(proxy,/\['http:\/\/example\.com\/', 'status'\]/);
  assert.match(proxy,/startsWith\('http:\/\/'\)/);
  assert.match(proxy,/fetchPlainHttpThroughHttpProxy\(url, proxyUrl/);
});

test('VPN health-check closes a successful local proxy connection gracefully instead of resetting it',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  assert.match(proxy,/const closeGracefully = \(\) => \{/);
  assert.match(proxy,/socket\.end\(\);/);
  assert.match(proxy,/finish\(\{status:parsed\.status, body:'', headers:parsed\.headers\}, true\);/);
});


test('Windows TUN automatically falls back from Xray 26.3.27 to sing-box',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  assert.match(proxy,/async function getCoreVersion\(exe\)/);
  assert.match(proxy,/version==='26\.3\.27'/);
  assert.match(proxy,/core='sing-box'/);
  assert.match(proxy,/settings\.tunCore='sing-box'/);
});

test('sing-box VLESS Vision leaves TCP/UDP both enabled and uses XUDP for UDP',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  const fnStart=proxy.indexOf('function singboxOutbound(s)');
  const fnEnd=proxy.indexOf("  if(s.protocol==='vmess')",fnStart);
  assert.ok(fnStart>=0 && fnEnd>fnStart);
  const fn=proxy.slice(fnStart,fnEnd);
  assert.match(fn,/if\(s\.network === 'udp'\) o\.network='udp'/);
  assert.match(fn,/o\.packet_encoding='xudp'/);
  assert.doesNotMatch(fn,/o\.network=s\.network\|\|'tcp'/);
});

test('sing-box VLESS outbound carries UUID, Vision, TLS/Reality and transport',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  assert.match(proxy,/if\(s\.protocol==='vless'\)/);
  assert.match(proxy,/o\.uuid=s\.uuid\|\|''/);
  assert.match(proxy,/o\.flow=s\.flow/);
  assert.match(proxy,/public_key:s\.publicKey\|\|''/);
  assert.match(proxy,/short_id:s\.shortId\|\|''/);
  assert.match(proxy,/transport=\{type:'ws'/);
  assert.match(proxy,/service_name:s\.serviceName/);
});

test('sing-box TUN readiness does not require Xray-specific /1 routes',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  assert.match(proxy,/verifyTunOutbound\(timeoutMs=12000, core='xray'\)/);
  assert.match(proxy,/if\(core==='xray'\) \{/);
  assert.match(proxy,/const adapter=await getTunAdapterInfo\(tunAdapterName\(\)\)/);
});


test('VPN startup proxy readiness uses one fast critical endpoint and shorter timeout',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  assert.match(proxy,/verifyOutboundViaHttpProxy\(settings\.httpPort,5000\)/);
  assert.match(proxy,/const targets = \[\{url:'http:\/\/example\.com\/', kind:'status'\}\]/);
  assert.match(proxy,/WinINet system proxy probe: deferred to background health monitor/);
});

test('parallel VPN ping workers defer persistence until aggregate completion',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  assert.match(proxy,/pingServerReal\(s\.id, timeout, false\)/);
  assert.match(proxy,/if \(emitState\) \{ save\(\); emit\(\); \}/);
  assert.match(proxy,/export async function pingAll\(\)\s*\{[\s\S]*await pingServersParallel\(servers/);
});

test('VPN pings run in parallel and UI has connection/ping/refresh animation hooks',()=>{
  const proxy=fs.readFileSync(path.join(root,'src/main/proxy.js'),'utf8');
  const app=fs.readFileSync(path.join(root,'src/renderer/app.js'),'utf8');
  const css=fs.readFileSync(path.join(root,'src/renderer/styles.css'),'utf8');
  assert.match(proxy,/async function pingServersParallel/);
  assert.match(proxy,/Promise\.all\(/);
  assert.match(app,/proxyConnectingId/);
  assert.match(app,/classList\.add\('pinging'\)/);
  assert.match(app,/classList\.add\('refreshing'\)/);
  assert.match(css,/\.vpn-server-tile\.connecting/);
  assert.match(css,/\.vpn-server-tile\.pinging/);
  assert.match(css,/\.vpn-sub-group\.refreshing/);
});

test('VPN server rendering is keyed to preserve existing tile DOM and prevent favorite blinking',()=>{
  const app=fs.readFileSync(path.join(root,'src/renderer/app.js'),'utf8');
  assert.match(app,/grid\.dataset\.structureKey===key/);
  assert.match(app,/grid\.innerHTML=groups\.join\(''\)/);
  assert.match(app,/function updateVpnTile/);
});


test('VPN controls use redesigned action buttons and SVG collapse controls',()=>{
  const html=fs.readFileSync(path.join(root,'src/renderer/index.html'),'utf8');
  const css=fs.readFileSync(path.join(root,'src/renderer/styles.css'),'utf8');
  assert.match(html,/class="icon-btn action-btn" id="btnVpnPingAll"/);
  assert.match(html,/class="icon-btn action-btn" id="btnVpnRefreshAll"/);
  assert.match(html,/section-collapse-btn[^>]*aria-label="Свернуть\/развернуть"/);
  assert.match(css,/\.icon-btn\.action-btn/);
  assert.match(css,/\.section-collapse-btn svg/);
});
