import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeHexColor, splitFavoriteBats } from '../src/main/lib/pure.js';

const root = path.resolve(new URL('..', import.meta.url).pathname);

test('favorites are split from regular tiles', () => {
  const bats = [{ name: 'a.bat' }, { name: 'b.bat' }, { name: 'c.bat' }];
  const { favs, regular } = splitFavoriteBats(bats, ['b.bat']);
  assert.deepEqual(favs.map(x => x.name), ['b.bat']);
  assert.deepEqual(regular.map(x => x.name), ['a.bat', 'c.bat']);
});

test('colors are normalized', () => {
  assert.equal(normalizeHexColor('#FF2E4C'), '#ff2e4c');
  assert.equal(normalizeHexColor('14161B'), '#14161b');
  assert.equal(normalizeHexColor('nope', '#123456'), '#123456');
});

test('renderer references required settings ids', () => {
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
  const required = ['cfgFolder','cfgRepo','togCloseOnExit','togStartup','togAutoCheck','togAppAutoCheck','cfgTgRepo','cfgTgDir','btnTgChooseDir','btnTgOpenFolder','togTgAutoCheck','togTgAutoStart','tgStatus','tgVersion','btnTgToggle','btnTgInstall','btnTgCheck','tgUpdateText','tgProgressWrap','tgProgressBar','tgHost','tgPort','tgSecret','tgDcIp','tgBuffer','tgPool','tgKeepalive','tgCfproxy','tgForceDc','btnTgSave','accentColor','accentHex','backgroundColor','backgroundHex','btnResetColors','appUpdateText','btnAppCheck','btnAppUpdate'];
  for (const id of required) assert.match(html, new RegExp(`id=\"${id}\"`));
  for (const id of required) {
    if (/^(btn|tog|cfg|accent|background|appUpdateText|tg|ver|hosts|gf|ipset|fk|svc)/.test(id)) assert.ok(app.includes(`#${id}`) || app.includes(`'${id}'`) || app.includes(`\"${id}\"`), `renderer does not reference ${id}`);
  }
});


test('settings tabs and page ids match and HTML ids are unique', () => {
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const ids = [...html.matchAll(/id=["']([^"']+)["']/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'duplicate HTML id found');
  const tabs = [...html.matchAll(/class=["'][^"']*\btab\b[^"']*["'][^>]*data-tab=["']([^"']+)["']/g)].map(m => m[1]);
  for (const tab of tabs) assert.match(html, new RegExp(`id=["']page-${tab}["']`));
});

test('new IPC API is bridged in preload', () => {
  const preload = fs.readFileSync(path.join(root, 'src/preload/preload.cjs'), 'utf8');
  for (const channel of ['appUpdates:check','appUpdates:run','tg:status','tg:toggle','tg:check','tg:install','tg:getConfig','tg:setConfig','config:chooseTgFolder']) {
    assert.match(preload, new RegExp(channel.replace(':','\\:')));
  }
});


test('TG Proxy is below favorites and controls are settings-only', () => {
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  assert.ok(html.indexOf('id="favSection"') < html.indexOf('id="tgSection"'));
  const mainBeforeSettings = html.split('<div id="settings"')[0];
  assert.equal(mainBeforeSettings.includes('id="btnTgToggle"'), false);
  assert.equal(mainBeforeSettings.includes('id="btnTgInstall"'), false);
  assert.equal(mainBeforeSettings.includes('id="btnTgCheck"'), false);
  assert.match(html, /<h2 class="sec-title collapsible-head" data-collapse-target="tg"><span class="tg-title-icon">TG<\/span> TG Proxy/);
});

test('default download path uses Documents\\Zapret Launcher\\', () => {
  const ipc = fs.readFileSync(path.join(root, 'src/main/ipc.js'), 'utf8');
  assert.match(ipc, /path\.join\(app\.getPath\('documents'\), 'Zapret Launcher', 'zapret'\)/);
  const tg = fs.readFileSync(path.join(root, 'src/main/tgProxy.js'), 'utf8');
  assert.match(tg, /app\.getPath\('documents'\), 'Zapret Launcher', 'tg-ws-proxy'/);
});

test('TG renderer is null-safe for missing optional nodes', () => {
  const app = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
  assert.ok(app.includes("const statusEl = $('#tgStatus');"));
  assert.ok(app.includes("if (!s.installed) {"));
  assert.ok(app.includes("if (statusEl) statusEl.textContent"));
  assert.ok(app.includes("if (settingsStatus) settingsStatus.textContent"));
});


test('setup prompt offers installation when Zapret or TG Proxy is missing', () => {
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
  assert.ok(html.includes('id="btnOnboardDownload"'));
  assert.ok(html.includes('id="btnOnboardSettings"'));
  assert.ok(app.includes("const missingZapret = state.bats.length === 0;"));
  assert.ok(app.includes("const missingTg = !state.tg?.installed;"));
  assert.ok(app.includes("openSettings(true, state.tg?.installed ? 'general' : 'tg')"));
  assert.equal(html.split('<div id="settings"')[0].includes('id="btnTgInstall"'), false);
});


test('TG Proxy green state is independent from BAT running state', () => {
  const app = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
  assert.match(app, /function updateTgTile\(\)/);
  assert.match(app, /state\.tg\?\.running/);
  assert.match(app, /document\.querySelectorAll\('#favGrid \.tile, #batsGrid \.tile'\)/);
  assert.doesNotMatch(app, /document\.querySelectorAll\('\.tile'\)\.forEach\(updateTile\)/);
});

test('glass window background is opaque enough while native transparency remains enabled', () => {
  const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');
  assert.match(main, /transparent: true/);
  assert.match(css, /rgba\(var\(--app-bg-rgb\), 0\.90\)/);
  assert.match(css, /rgba\(var\(--app-bg-rgb\), 0\.82\)/);
});

test('all update controls are centralized in Обновления tab', () => {
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const updates = html.match(/<section class="page(?: active)?" id="page-updates">[\s\S]*?<\/section>/)?.[0] || '';
  const tg = html.match(/<section class="page" id="page-tg">[\s\S]*?<\/section>/)?.[0] || '';
  for (const id of ['btnCheckUpdate','btnTgInstall','btnTgCheck','btnAppCheck','btnAppUpdate','btnHostsCheck','btnHostsUpdate','togAutoCheck','togTgAutoCheck','togAppAutoCheck']) {
    assert.match(updates, new RegExp(`id=\"${id}\"`), `${id} should be in updates tab`);
    assert.doesNotMatch(tg, new RegExp(`id=\"${id}\"`), `${id} should not be in TG tab`);
  }
});

test('TG Proxy tray icon is explicitly removed after process start on Windows', () => {
  const tg = fs.readFileSync(path.join(root, 'src/main/tgProxy.js'), 'utf8');
  assert.match(tg, /function hideTrayIconForPid\(pid\)/);
  assert.match(tg, /Shell_NotifyIcon/);
  assert.match(tg, /SystrayClass/);
  assert.match(tg, /uID=id/);
  assert.match(tg, /hideTrayIconForPid\(childPid\)/);
});

test('all data update buttons live in Обновления tab', () => {
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const updates = html.match(/<section class="page" id="page-updates">[\s\S]*?<\/section>/)?.[0] ?? '';
  const filters = html.match(/<section class="page" id="page-filters">[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.match(updates, /id="btnIpsetUpdate"/);
  assert.doesNotMatch(filters, /id="btnIpsetUpdate"/);
  assert.match(updates, /id="btnHostsUpdate"/);
  assert.match(updates, /id="btnTgInstall"/);
});

test('hosts transport has HTTPS and curl fallback without relying on fetch()', () => {
  const js = fs.readFileSync(path.join(root, 'src/main/service.js'), 'utf8');
  assert.match(js, /function requestRemoteTextHttps\(/);
  assert.match(js, /curl\.exe/);
  assert.match(js, /ssl-no-revoke/);
  assert.doesNotMatch(js, /await\s+fetch\(rawUrl\(repo, 'hosts'/);
});



test('VPN main screen contains only subscription input plus icon controls; technical controls are in settings', () => {
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const main = html.split('<div id="settings"')[0];
  assert.ok(main.includes('id="vpnSection"'));
  assert.ok(main.includes('id="vpnSubInput"'));
  assert.ok(main.includes('id="btnVpnPingAll"'));
  assert.ok(main.includes('id="btnVpnRefreshAll"'));
  assert.doesNotMatch(main, /id="vpnServerInput"/);
  assert.doesNotMatch(main, /id="btnVpnAddServer"/);
  assert.doesNotMatch(main, /id="btnVpnAddSub"/);
  assert.doesNotMatch(main, /id="btnVpnToggle"/);
  assert.doesNotMatch(main, /id="btnVpnImportFile"/);
  assert.match(html, /data-tab="proxy"/);
  assert.match(html, /id="page-proxy"/);
});

test('VPN tiles expose name, ping and protocol information', () => {
  const app = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
  assert.match(app, /function vpnProtocolTags\(s\)/);
  assert.match(app, /vpn-server-name/);
  assert.match(app, /vpn-protocols/);
  assert.match(app, /vpn-ping/);
  assert.match(app, /proxyToggleServer\(id\)/);
});



test('VPN category matches the compact TG-style section and subscription is Enter-only', () => {
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');
  assert.match(html, /id="vpnSection" class="vpn-section category-section collapsible-section"/);
  assert.match(html, /class="tg-title-icon vpn-title-icon">VPN<\/span>/);
  assert.match(html, /placeholder="Вставьте ссылку VPN-подписки и нажмите Enter/);
  assert.doesNotMatch(html, /id="btnVpnAddSub"/);
  assert.doesNotMatch(app, /btnVpnAddSub/);
  assert.match(app, /e\.key === 'Enter'.*#vpnSubInput/);
  assert.match(css, /\.vpn-sub-input\{[\s\S]*background:linear-gradient/);
});

test('VPN subscription has Windows curl fallback for transient HTTP 502/503/504', () => {
  const proxy = fs.readFileSync(path.join(root, 'src/main/proxy.js'), 'utf8');
  assert.match(proxy, /async function requestTextWithCurl\(/);
  assert.match(proxy, /curl\.exe/);
  assert.match(proxy, /--retry/);
  assert.match(proxy, /HTTP \(\?:502\|503\|504\)/);
});


test('VPN parser contains native Xray JSON outbound support', () => {
  const proxy = fs.readFileSync(path.join(root, 'src/main/proxy.js'), 'utf8');
  assert.match(proxy, /function convertXrayOutboundObject\(/);
  assert.match(proxy, /vnext0/);
  assert.match(proxy, /streamSettings/);
  assert.match(proxy, /realitySettings/);
});
