/* ================================================================
   Zapret Launcher — логика интерфейса
   Плитки (вкл/выкл), избранное, настройки (шестерёнка),
   обновления GitHub, сервис, фильтры, фэйки, диагностика, тосты
   ================================================================ */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// маркер сборки рендера: виден в бейдже шапки (самодиагностика старых файлов)
const RENDERER_BUILD = 'r1.4.9';
const EXPECT_BUILD = { m: 'm1.4.9', r: 'r1.4.9', p: 'p1.4.9', h: 'h1.4.9' };
const BUILD_LABEL = { m: 'src/main', r: 'app.js', p: 'preload.cjs', h: 'index.html' };

// любую ошибку UI — в тост, чтобы «тихие» падения больше не были невидимыми
window.addEventListener('error', (e) => {
  toast(`Ошибка UI: ${e.message}`, 'warn', 10000);
});

const ICON_BOLT = '<svg viewBox="0 0 24 24"><path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2z"/></svg>';
const ICON_STAR = '<svg viewBox="0 0 24 24"><path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1L12 2z"/></svg>';

const state = {
  bats: [],
  running: new Set(),
  favorites: new Set(),
  seenTiles: new Set(),
  cfg: {},
  sys: {},
  update: null,
  conflicts: [],
  busy: false,
  proxyPingBusy: false,
  proxyConnectingId: null,
  svcBats: [],
  tg: { installed: false, running: false, version: null },
  tgUpdate: null,
  appUpdate: null,
  theme: { accent: '#ff2e4c', background: '#14161b' },
  setupPromptDismissed: false,
  proxy: { running: false, mode: 'proxy', selected: null, servers: [], subscriptions: [], routes: [], settings: {}, cores: [] }
};

/* ==================== Тосты ==================== */

function toast(text, type = '', ms = 4600) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, ms);
}

/* ==================== Плитки ==================== */

function tileHtml(bat) {
  const running = state.running.has(bat.name);
  const fav = state.favorites.has(bat.name);
  return `
    <div class="tile ${running ? 'running' : ''}" data-name="${esc(bat.name)}" data-path="${esc(bat.path)}" role="button" tabindex="0">
      <button class="star ${fav ? 'on' : ''}" data-fav="${esc(bat.name)}" title="В избранное">${ICON_STAR}</button>
      <div class="t-icon">${ICON_BOLT}</div>
      <div class="t-label">${esc(bat.name)}</div>
      <div class="t-status"><span class="dot"></span>${running ? 'Запущен' : 'Остановлен'}</div>
    </div>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function updateVpnTile(tile, server = null) {
  if (!tile) return;
  const s = server || (state.proxy.servers || []).find(x => x.id === tile.dataset.proxyId);
  if (!s) return;
  const active = !!state.proxy.running && state.proxy.selected?.id === s.id;
  const connecting = state.proxyConnectingId === s.id;
  tile.classList.toggle('active', active);
  tile.classList.toggle('running', active);
  tile.classList.toggle('connecting', connecting);
  const stateEl = tile.querySelector('.vpn-state');
  if (stateEl) stateEl.textContent = connecting ? 'Подключение…' : active ? 'Подключено' : 'Готов';
  const pingEl = tile.querySelector('.vpn-ping');
  if (pingEl) {
    pingEl.textContent = s.latency == null ? 'Пинг —' : `${s.latency} ms`;
    pingEl.classList.toggle('good', s.latency != null && s.latency < 180);
    pingEl.classList.toggle('bad', s.latency != null && s.latency >= 180);
  }
  const star=tile.querySelector('[data-proxy-fav]');
  if(star) star.textContent=s.favorite?'★':'☆';
}

function updateVpnTiles() {
  document.querySelectorAll('.vpn-server-tile[data-proxy-id]').forEach(t=>updateVpnTile(t));
}

function renderFavorites() {
  const favBats = state.bats.filter((b) => state.favorites.has(b.name));
  const favVpn = (state.proxy.servers || []).filter((s) => !!s.favorite);
  const key=[favBats.map(b=>`${b.name}:${b.path}`).join('|'),favVpn.map(s=>s.id).join('|')].join('§');
  const grid=$('#favGrid');
  if(!grid)return;
  if(grid.dataset.structureKey!==key){
    grid.innerHTML = [...favBats.map(tileHtml), ...favVpn.map(vpnServerTileHtml)].join('');
    grid.dataset.structureKey=key;
  }
  const favSection=$('#favSection');
  favSection.classList.toggle('hidden', favBats.length === 0 && favVpn.length === 0);
  if (!favSection.classList.contains('hidden')) favSection.classList.toggle('collapsed', localStorage.getItem('zl:collapse:favorites')==='1');
  grid.querySelectorAll('.tile').forEach(updateTile);
  grid.querySelectorAll('.vpn-server-tile[data-proxy-id]').forEach(t=>updateVpnTile(t));
}

function renderBats() {
  const regular = state.bats.filter((b) => !state.favorites.has(b.name));
  renderFavorites();
  $('#batsGrid').innerHTML = regular.map(tileHtml).join('');

  const missingZapret = state.bats.length === 0;
  const missingTg = !state.tg?.installed;
  const showSetup = (missingZapret || missingTg) && !state.setupPromptDismissed;
  $('#onboard').classList.toggle('hidden', !showSetup);
  if (showSetup) {
    try { forceOverlayGeometry('#onboard', 'card'); } catch {}
    const zapStatus = $('#setupZapretStatus');
    const tgStatus = $('#setupTgStatus');
    const text = $('#onboardText');
    if (zapStatus) {
      zapStatus.textContent = missingZapret ? '✕ Zapret: не установлен' : `✓ Zapret: ${state.cfg?.batsDir || 'установлен'}`;
      zapStatus.className = `setup-status ${missingZapret ? 'bad' : 'ok'}`;
    }
    if (tgStatus) {
      tgStatus.textContent = missingTg ? '✕ TG Proxy: не установлен' : `✓ TG Proxy: ${state.tg?.version || 'установлен'}`;
      tgStatus.className = `setup-status ${missingTg ? 'bad' : 'ok'}`;
    }
    if (text) text.textContent = missingZapret && missingTg
      ? 'Не установлены Zapret и TG Proxy. Установите нужные компоненты прямо из лаунчера.'
      : (missingZapret ? 'Zapret не установлен. Выберите папку или скачайте свежий релиз.' : 'TG Proxy не установлен. Нажмите «Установить TG Proxy», чтобы добавить его на главный экран.');
    const folderBtn = $('#btnOnboardFolder');
    const zapBtn = $('#btnOnboardDownload');
    const settingsBtn = $('#btnOnboardSettings');
    const tgInstallBtn = $('#btnOnboardTgInstall');
    if (folderBtn) folderBtn.classList.toggle('hidden', !missingZapret);
    if (zapBtn) zapBtn.classList.toggle('hidden', !missingZapret);
    if (tgInstallBtn) tgInstallBtn.classList.toggle('hidden', !missingTg);
    if (settingsBtn) settingsBtn.classList.toggle('hidden', !(missingTg || missingZapret));
  }
  $('#emptyState').classList.toggle('hidden', !missingZapret || showSetup);
  $('#allTitle').classList.toggle('hidden', regular.length === 0);
  document.querySelectorAll('.tile').forEach((tile) => {
    if (state.seenTiles.has(tile.dataset.name)) tile.style.animation = 'none';
    state.seenTiles.add(tile.dataset.name);
  });
  applyRunningState();
}

/** Обновить одну плитку по текущему state.running (класс + inline-вид + статус) */
function updateTile(tile) {
  if (!tile || tile.id === 'tgTile') return;
  const running = state.running.has(tile.dataset.name);
  tile.classList.toggle('running', running);
  if (running) {
    tile.style.background = 'linear-gradient(150deg, rgba(46,224,106,0.16), rgba(46,224,106,0.045))';
    tile.style.borderColor = 'rgba(46,224,106,0.55)';
    tile.style.boxShadow = '0 10px 30px rgba(46,224,106,0.22), inset 0 1px 0 rgba(255,255,255,0.1)';
  } else {
    tile.style.background = '';
    tile.style.borderColor = '';
    tile.style.boxShadow = '';
  }
  const st = tile.querySelector('.t-status');
  if (st) st.innerHTML = `<span class="dot"></span>${running ? 'Запущен' : 'Остановлен'}`;
}

function updateTgTile() {
  const tile = $('#tgTile');
  if (!tile) return;
  const running = !!state.tg?.running;
  tile.classList.toggle('running', running);
  tile.dataset.running = running ? '1' : '0';
  if (running) {
    tile.style.background = 'linear-gradient(150deg, rgba(46,224,106,0.16), rgba(46,224,106,0.045))';
    tile.style.borderColor = 'rgba(46,224,106,0.55)';
    tile.style.boxShadow = '0 10px 30px rgba(46,224,106,0.22), inset 0 1px 0 rgba(255,255,255,0.1)';
  } else {
    tile.style.background = '';
    tile.style.borderColor = '';
    tile.style.boxShadow = '';
  }
}

/** Точечное обновление статуса батников без изменения TG Proxy */
function applyRunningState() {
  document.querySelectorAll('#favGrid .tile, #batsGrid .tile').forEach(updateTile);
  updateTgTile();
}

/* клик по плитке = вкл/выкл скрипта */
async function onTileClick(tile) {
  if (state.busy) return;
  const name = tile.dataset.name;
  const path = tile.dataset.path;
  state.busy = true;
  try {
    const res = await window.api.toggleBat(name, path);
    // статус берём НАПРЯМУЮ из main-процесса (source of truth), без домыслов
    const list = await window.api.runningList();
    state.running = new Set(list);
    applyRunningState();
    updateTile(tile); // страховка: обновляем именно кликнутую плитку сразу
    if (res && res.error === 'service-running') {
      toast('Сервис zapret уже запущен. Сначала удалите его: настройки → «Сервис» → «Удалить сервисы».', 'warn');
    } else if (res && res.error) {
      toast(`Ошибка: ${res.error}`, 'warn');
    } else if (res && res.action === 'stop') {
      toast(`■ «${name}»: остановлен`, 'ok', 2600);
    } else if (res && res.action === 'start') {
      toast(`▶ «${name}»: запущен`, 'ok', 2600);
    }
  } finally {
    state.busy = false;
  }
}

/* ==================== Избранное ==================== */

async function onStarClick(star) {
  const name = star.dataset.fav;
  const favs = await window.api.toggleFavorite(name); // main возвращает массив избранных
  state.favorites = new Set(Array.isArray(favs) ? favs : (favs && favs.favorites) || []);
  renderBats();
}

/* ==================== Баннер обновлений ==================== */

function renderUpdateBanner() {
  const u = state.update;
  const banner = $('#bannerUpdate');
  if (!u || !u.hasUpdate) {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
  $('#updTitle').textContent = `Доступна версия ${u.remote}`;
  $('#updSub').textContent = u.updateNotes || `Установлена версия ${u.local || '—'}. Будут скачаны и заменены файлы, новые батники появятся на плитках.`;
}

function renderProgress(p) {
  const wrap = $('#updProgressWrap');
  if (!p || p.percent < 0) {
    wrap.classList.add('hidden');
    $('#updProgressBar').style.width = '0';
    return;
  }
  wrap.classList.remove('hidden');
  $('#updProgressBar').style.width = `${Math.min(100, p.percent)}%`;
}

/* ==================== Настройки ==================== */

function openSettings(show = true, tabName = null) {
  $('#settings').classList.toggle('hidden', !show);
  if (show) {
    try { forceOverlayGeometry('#settings', 'modal'); } catch {}
    if (tabName) {
      $$('.tab').forEach((tab) => { tab.classList.toggle('active', tab.dataset.tab === tabName); });
      $$('.page').forEach((page) => { page.classList.toggle('active', page.id === `page-${tabName}`); });
    }
    refreshSettings();
  }
}

/**
 * Гарантированная геометрия оверлеев inline-стилями:
 * даже если таблица стилей не применилась, панели будут по центру.
 */
function forceOverlayGeometry(overlaySel, mode) {
  const ov = $(overlaySel);
  if (!ov) return;
  ov.style.position = 'absolute';
  ov.style.inset = '0';
  ov.style.zIndex = '60';
  ov.style.display = 'grid';
  ov.style.placeItems = 'center';
  ov.style.background = 'transparent';
  const panel = ov.querySelector('.panel');
  if (!panel) return;
  if (mode === 'modal') {
    panel.style.width = 'min(920px, calc(100% - 48px))';
    panel.style.height = 'min(640px, calc(100% - 48px))';
  } else {
    panel.style.width = 'min(480px, 92vw)';
    panel.style.height = 'auto';
  }
}

function applyTheme(accent, background) {
  const a = /^#[0-9a-f]{6}$/i.test(String(accent || '')) ? accent : '#ff2e4c';
  const bg = /^#[0-9a-f]{6}$/i.test(String(background || '')) ? background : '#14161b';
  const hex = a.slice(1);
  const rgb = [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16)].join(', ');
  const br = bg.slice(1);
  const bgRgb = [parseInt(br.slice(0,2),16), parseInt(br.slice(2,4),16), parseInt(br.slice(4,6),16)].join(', ');
  document.documentElement.style.setProperty('--accent', a);
  document.documentElement.style.setProperty('--accent-rgb', rgb);
  document.documentElement.style.setProperty('--app-bg', bg);
  document.documentElement.style.setProperty('--app-bg-rgb', bgRgb);
  state.theme = { accent: a, background: bg };
}

function setColorRow(inputId, hexId, patchKey) {
  const input = $(inputId);
  const hex = $(hexId);
  if (!input || !hex) return;
  const apply = async () => {
    const val = input.value;
    hex.value = val;
    applyTheme(patchKey === 'accentColor' ? val : state.theme.accent, patchKey === 'backgroundColor' ? val : state.theme.background);
    state.cfg = await window.api.setConfig({ [patchKey]: val });
  };
  input.oninput = apply;
  hex.onchange = () => {
    const value = String(hex.value || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(value)) { input.value = value; apply(); }
    else hex.value = input.value;
  };
}

function renderTg() {
  const s = state.tg || {};
  const section = $('#tgSection');
  const statusEl = $('#tgStatus');
  const versionEl = $('#tgVersion');
  const settingsStatus = $('#tgSettingsStatus');
  const settingsVersion = $('#tgSettingsVersion');
  if (!s.installed) {
    section?.classList.add('hidden');
    if (settingsStatus) settingsStatus.textContent = 'Не установлен';
    if (settingsVersion) settingsVersion.textContent = '—';
    return;
  }
  section?.classList.remove('hidden');
  const status = s.running ? 'Запущен' : 'Остановлен';
  if (statusEl) statusEl.textContent = status;
  if (versionEl) versionEl.textContent = s.version || '—';
  if (settingsStatus) settingsStatus.textContent = status;
  if (settingsVersion) settingsVersion.textContent = s.version || '—';
  updateTgTile();
}

function renderTgUpdate() {
  const u = state.tgUpdate;
  const el = $('#tgUpdateText');
  if (!el) return;
  if (!u) { el.textContent = '—'; return; }
  el.textContent = u.hasUpdate ? `Доступна версия ${u.remote}` : `Установлена ${u.local || u.remote || '—'}`;
}

function renderAppUpdate() {
  const u = state.appUpdate;
  const el = $('#appUpdateText');
  if (!el) return;
  if (!u) { el.textContent = `Установлена ${state.sys?.version || '—'}`; return; }
  el.textContent = u.hasUpdate ? `Доступна версия ${u.remote}` : `Установлена ${u.local || '—'}`;
}

async function refreshSettings() {
  const cfg = await window.api.getConfig();
  state.cfg = cfg;
  state.favorites = new Set(cfg.favorites || []);

  $('#cfgFolder').value = cfg.batsDir || '';
  $('#cfgRepo').value = cfg.repo || '';
  $('#togCloseOnExit').checked = cfg.closeScriptsOnExit !== false;
  $('#togStartup').checked = !!cfg.launchAtStartup;
  $('#togAutoCheck').checked = cfg.autoCheckUpdates !== false;
  $('#togAppAutoCheck').checked = cfg.appAutoCheckUpdates !== false;
  $('#togTgAutoCheck').checked = cfg.tgAutoCheckUpdates !== false;
  $('#togTgAutoStart').checked = !!cfg.tgAutoStart;
  $('#cfgTgRepo').value = cfg.tgRepo || '';
  $('#cfgTgDir').value = cfg.tgDir || '';
  applyTheme(cfg.accentColor, cfg.backgroundColor);
  $('#accentColor').value = cfg.accentColor || '#ff2e4c';
  $('#accentHex').value = cfg.accentColor || '#ff2e4c';
  $('#backgroundColor').value = cfg.backgroundColor || '#14161b';
  $('#backgroundHex').value = cfg.backgroundColor || '#14161b';

  $('#verLocal').textContent = cfg.localVersion || '—';
  const u = state.update;
  $('#verRemote').textContent = u && u.remote ? u.remote : '—';

  // сервис
  try {
    const st = await window.api.serviceStatus();
    setKv('#svcStrategy', st.strategy || 'не установлена');
    setKv('#svcZapret', st.zapret);
    setKv('#svcWd', st.windivert);
    setKv('#svcWinws', st.winws ? 'запущен' : 'не запущен');
    setKv('#svcSys', st.sysDriver ? 'найден' : 'не найден');
  } catch { /* нет бэкенда (демо) */ }

  const bats = await window.api.listBats();
  state.svcBats = bats;
  const sel = $('#svcBat');
  const cur = sel.value;
  sel.innerHTML = bats.map((b) => `<option value="${esc(b.name)}">${esc(b.name)}</option>`).join('') || '<option>— нет батников —</option>';
  if (cur) sel.value = cur;

  // фильтры
  try {
    const gf = await window.api.gameFilterGet();
    $('#gfStatus').textContent = gf.status || gf.mode;
    $('#gfMode').value = gf.mode;
    $('#gfTcp').value = gf.tcp || '';
    $('#gfUdp').value = gf.udp || '';
    const ip = await window.api.ipsetGet();
    const ipLabels = { loaded: 'загружен', none: 'none (заглушка)', any: 'any (пусто)' };
    $('#ipsetStatus').textContent = ipLabels[ip.status] || ip.status;
    $('#ipsetStatus').className = ip.status === 'loaded' ? 'ok' : 'warn';
    const hs = await window.api.hostsCheck();
    $('#hostsStatus').textContent = hs.ok ? (hs.needsUpdate ? 'требуется обновление' : 'актуален') : `ошибка: ${hs.error ?? 'сеть'}`;
    $('#hostsStatus').className = hs.ok ? (hs.needsUpdate ? 'bad' : 'ok') : 'bad';
  } catch { /* демо */ }

  // фэйки
  try {
    const fk = await window.api.fakesGet();
    $('#fkCurD').textContent = fk.currentDiscord || '—';
    $('#fkCurG').textContent = fk.currentGame || '—';
    const files = fk.files || [];
    $('#fkFile').innerHTML = files.map((f) => `<option value="${esc(f.file)}">${esc(f.name)}</option>`).join('') || '<option>— нет .bin —</option>';
  } catch { /* демо */ }

  try { renderProxyState(await window.api.proxyStatus()); } catch {}
}

function setKv(sel, val) {
  const el = $(sel);
  if (!el) return;
  const v = val && typeof val === 'object' ? (val.label || val.status) : val;
  el.textContent = v || '—';
  el.className = '';
  if (val && typeof val === 'object') {
    if (val.ok) el.className = 'ok';
    else if (val.warn) el.className = 'warn';
    else if (val.bad) el.className = 'bad';
  } else if (typeof val === 'string') {
    if (/NOT INSTALLED|NOT RUNNING|STOPPED|не найден|отсутствует|требуется|конфликт/i.test(val)) el.className = 'bad';
    else if (/RUNNING|установлен|запущен|найден|не требует|актуален/i.test(val)) el.className = 'ok';
    else if (/остановлен|вручную|частичн|PENDING/i.test(val)) el.className = 'warn';
  }
}

function setKvClass(sel, obj) {
  const el = $(sel);
  if (!el || !obj) return;
  el.className = '';
  if (obj.ok) el.className = 'ok';
  else if (obj.warn) el.className = 'warn';
  else if (obj.bad) el.className = 'bad';
}

/* ==================== Диагностический список ==================== */

function renderDiag(results) {
  const box = $('#diagList');
  if (!results || !results.length) {
    box.innerHTML = '';
    return;
  }
  state.conflicts = [];
  box.innerHTML = results.map((r) => {
    if (/конфликт/i.test(r.title) && r.level === 'fail') {
      (r.names || []).forEach((n) => state.conflicts.push(n));
    }
    const detail = (r.lines || []).join(' ');
    return `<div class="d-item ${r.level}"><div><b>${esc(r.title)}</b><span>${esc(detail)}</span></div></div>`;
  }).join('');
  $('#btnFixConflicts').disabled = state.conflicts.length === 0;
}

/* ==================== Выбор папки ==================== */

async function chooseFolder() {
  const path = await window.api.chooseFolder();
  if (!path) return false;
  state.cfg = await window.api.setConfig({ batsDir: path, onboardSeen: true });
  state.bats = await window.api.listBats();
  renderBats();
  refreshSettings();
  toast(`Папка выбрана: ${path}. Найдено батников: ${state.bats.length}.`, 'ok');
  return true;
}

function fillTgConfig(cfg) {
  const c = cfg || {};
  const set = (id, fn) => { const el = $(id); if (el) fn(el); };
  set('#tgHost', el => el.value = c.host || '127.0.0.1');
  set('#tgPort', el => el.value = c.port || 1443);
  set('#tgSecret', el => el.value = c.secret || '');
  set('#tgDcIp', el => el.value = c.dc_ip || '');
  set('#tgBuffer', el => el.value = c.buffer_size || 128);
  set('#tgPool', el => el.value = c.pool_size || 5);
  set('#tgCfproxy', el => el.checked = !!c.cfproxy);
  set('#tgForceDc', el => el.checked = !!c.force_test_dc);
  set('#tgKeepalive', el => el.value = c.ws_keepalive_interval ?? 30);
}

function renderTgProgress(p) {
  const bar = $('#tgProgressBar'); const wrap = $('#tgProgressWrap');
  if (!bar || !wrap) return;
  if (!p || p.percent < 0) { wrap.classList.add('hidden'); bar.style.width='0'; return; }
  wrap.classList.remove('hidden'); bar.style.width = `${Math.min(100, p.percent)}%`;
}


/* ==================== Proxy Center ==================== */

const COUNTRY_ALIASES = {
  ru:['ru','россия','russia','россий'], ua:['ua','украина','ukraine','украин'], de:['de','германия','germany','german','немец'], nl:['nl','нидерланды','netherlands','holland','голланд'], fi:['fi','финляндия','finland'], se:['se','швеция','sweden'], no:['no','норвегия','norway'], dk:['dk','дания','denmark'], pl:['pl','польша','poland'], cz:['cz','чехия','czech','czechia'], fr:['fr','франция','france'], gb:['gb','uk','англия','великобритания','united kingdom','britain'], us:['us','сша','usa','united states','america'], ca:['ca','канада','canada'], tr:['tr','турция','turkey'], ge:['ge','грузия','georgia'], kz:['kz','казахстан','kazakhstan'], am:['am','армения','armenia'], by:['by','беларусь','belarus'], lt:['lt','литва','lithuania'], lv:['lv','латвия','latvia'], ee:['ee','эстония','estonia','estonia'], ch:['ch','швейцария','switzerland'], at:['at','австрия','austria'], es:['es','испания','spain'], it:['it','италия','italy'], jp:['jp','япония','japan'], sg:['sg','сингапур','singapore'], hk:['hk','гонконг','hong kong'], ae:['ae','оаэ','uae','emirates'], il:['il','израиль','israel'], in:['in','индия','india'], kr:['kr','корея','south korea','korea'], au:['au','австралия','australia'], br:['br','бразилия','brazil']
};
function countryCodeToFlag(code){
  const c=String(code||'').toLowerCase().replace(/^uk$/,'gb');
  if(!/^[a-z]{2}$/.test(c))return '';
  return [...c.toUpperCase()].map(ch=>String.fromCodePoint(0x1F1E6+ch.charCodeAt(0)-65)).join('');
}
function escapeRegex(s){return String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function normalizeFlagValue(value){
  const v=String(value||'').trim();
  if(!v) return '';
  if(/^[a-z]{2}$/i.test(v)) return countryCodeToFlag(v);
  const pair=[...v].filter(ch => { const cp=ch.codePointAt(0); return cp>=0x1F1E6 && cp<=0x1F1FF; });
  return pair.length>=2 ? pair.slice(0,2).join('') : v;
}
const COUNTRY_NAMES={ru:'Россия',ua:'Украина',de:'Германия',nl:'Нидерланды',fi:'Финляндия',se:'Швеция',no:'Норвегия',dk:'Дания',pl:'Польша',cz:'Чехия',fr:'Франция',gb:'Великобритания',us:'США',ca:'Канада',tr:'Турция',ge:'Грузия',kz:'Казахстан',am:'Армения',by:'Беларусь',lt:'Литва',lv:'Латвия',ee:'Эстония',ch:'Швейцария',at:'Австрия',es:'Испания',it:'Италия',jp:'Япония',sg:'Сингапур',hk:'Гонконг',ae:'ОАЭ',il:'Израиль',in:'Индия',kr:'Южная Корея',au:'Австралия',br:'Бразилия'};
function countryCodeFromServer(s){
  const explicit=String(s?.countryCode||s?.country||'').trim();
  if(/^[a-z]{2}$/i.test(explicit)) return explicit.toLowerCase().replace(/^uk$/,'gb');
  const text=`${s?.name||''} ${s?.remarks||''} ${s?.tag||''} ${s?.country||''} ${s?.countryCode||''}`.toLowerCase();
  for(const [code,aliases] of Object.entries(COUNTRY_ALIASES)) for(const alias of aliases){
    if(new RegExp(`(?:^|[\\s\\[\\]()._-])${escapeRegex(alias)}(?:$|[\\s\\[\\]()._-])`,'i').test(text)) return code;
  }
  const host=String(s?.address||'').toLowerCase();
  const labels=host.split('.');
  for(const label of labels.slice(0,2)){
    const m=label.match(/^(ru|ua|de|nl|fi|se|no|dk|pl|cz|fr|gb|uk|us|ca|tr|ge|kz|am|by|lt|lv|ee|ch|at|es|it|jp|sg|hk|ae|il|in|kr|au|br)(?:\d+)?$/i);
    if(m) return m[1].toLowerCase().replace(/^uk$/,'gb');
  }
  const suffix=host.match(/\.([a-z]{2})(?::\d+)?$/i);
  return suffix ? suffix[1].toLowerCase().replace(/^uk$/,'gb') : '';
}
const COUNTRY_FLAG_CODES = new Set([
  'ru','ua','de','nl','fi','se','no','dk','pl','cz','fr','gb','us','ca','tr','ge','kz','am','by','lt','lv','ee','ch','at','es','it','jp','sg','hk','ae','il','in','kr','au','br','be','hu','ie','ro','nz'
]);
function vpnServerFlagCode(s){
  const code=countryCodeFromServer(s);
  if(code && COUNTRY_FLAG_CODES.has(code)) return code;
  const raw=String(s?.flag||s?.countryFlag||'').trim().toLowerCase();
  if(/^[a-z]{2}$/.test(raw) && COUNTRY_FLAG_CODES.has(raw)) return raw;
  return '';
}
function vpnServerFlag(s){
  const code=vpnServerFlagCode(s);
  if(!code) return '';
  const label=COUNTRY_NAMES[code]||code.toUpperCase();
  // Local SVG assets are used instead of Unicode regional-indicator glyphs,
  // because Electron/Windows may render those glyphs as plain NL/US letters.
  return `<img class="vpn-flag-img" src="assets/flags/${code}.svg" alt="${esc(label)}" title="${esc(label)}" loading="eager" draggable="false">`;
}
const GENERIC_RENDER_NAMES=new Set(['proxy','vpn','server','vless','vmess','trojan','shadowsocks','ss','socks','socks5','http','hysteria2','hy2','wireguard','wg','direct','block','ru','ua','de','nl','fi','se','no','dk','pl','cz','fr','gb','uk','us','ca','tr','ge','kz','am','by','lt','lv','ee','ch','at','es','it','jp','sg','hk','ae','il','in','kr','au','br']);
function vpnServerDisplayName(s){
  const n=String(s?.name||s?.remarks||s?.tag||'').trim();
  const address=String(s?.address||'').trim();
  const code=countryCodeFromServer(s);
  const country=COUNTRY_NAMES[code]||'';
  if(n && /^[a-z]{2}$/i.test(n)) return country || n.toUpperCase();
  if(n && !GENERIC_RENDER_NAMES.has(n.toLowerCase()) && n.toLowerCase()!==address.toLowerCase() && !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(n)) return n;
  // Не показываем технический домен как название. Для sg.dertux.com получаем «Сингапур».
  if(country) return country;
  if(n && !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(n) && !GENERIC_RENDER_NAMES.has(n.toLowerCase())) return n;
  return 'VPN сервер';
}
function proxyServerLabel(s) {
  return `${String(s.protocol || '').toUpperCase().replace('SHADOWSOCKS','SS')} · ${s.address || '—'}:${s.port || '—'}`;
}
function vpnProtocolTags(s){
  const tags=[];
  const p=String(s.protocol||'').toUpperCase().replace('SHADOWSOCKS','SS');
  if(p) tags.push(p);
  if(s.security && String(s.security).toLowerCase()==='reality') tags.push('Reality');
  else if(s.security && String(s.security).toLowerCase()==='tls') tags.push('TLS');
  const n=String(s.network||'').toLowerCase();
  if(n && n!=='tcp' && !tags.includes(n.toUpperCase())) tags.push(n.toUpperCase());
  return tags;
}
function vpnServerTileHtml(s) {
  const active=!!state.proxy.running && state.proxy.selected?.id===s.id;
  const running=active;
  const ping=s.latency==null?'Пинг —':`${s.latency} ms`;
  const tags=vpnProtocolTags(s);
  const flag=vpnServerFlag(s);
  const displayName=vpnServerDisplayName(s);
  return `<article class="vpn-server-tile ${active?'active':''} ${running?'running':''}" data-proxy-id="${esc(s.id)}">
    <div class="vpn-tile-top">
      <div class="vpn-tile-icon"><svg viewBox="0 0 24 24"><path d="M12 2 4.5 5.5V11c0 5.1 3.1 9.4 7.5 11 4.4-1.6 7.5-5.9 7.5-11V5.5L12 2z"/><path d="m9 12 2 2 4-4"/></svg></div>
      ${flag?`<span class="vpn-flag" aria-label="${esc(COUNTRY_NAMES[vpnServerFlagCode(s)]||'Страна сервера')}">${flag}</span>`:''}
    </div>
    <button class="vpn-star" data-proxy-fav="${esc(s.id)}" title="Избранное">${s.favorite?'★':'☆'}</button>
    <div class="vpn-server-name" title="${esc(displayName)}">${esc(displayName)}</div>
    <div class="vpn-server-host">${esc(s.address || '—')}${s.port?`:${esc(s.port)}`:''}</div>
    <div class="vpn-protocols">${tags.map(x=>`<span>${esc(x)}</span>`).join('')}</div>
    <div class="vpn-tile-footer"><span class="vpn-ping ${s.latency!=null&&s.latency<180?'good':s.latency!=null?'bad':''}">${esc(ping)}</span><span class="vpn-state">${running?'Подключено':'Готов'}</span><button class="vpn-delete" data-proxy-del="${esc(s.id)}" title="Удалить сервер">×</button></div>
  </article>`;
}
function renderVpnServers(){
  const grid=$('#vpnServerGrid'); if(!grid)return;
  const subs=state.proxy.subscriptions||[];
  const servers=state.proxy.servers||[];
  const key=JSON.stringify({
    subs:subs.map(s=>[s.id,s.name,s.count]),
    servers:servers.map(s=>[s.id,s.subscriptionId,s.name,s.address,s.port,s.protocol,s.network,s.security,s.sni])
  });
  if(grid.dataset.structureKey===key){ updateVpnTiles(); return; }
  const groups=[];
  for(const sub of subs){
    const list=servers.filter(s=>s.subscriptionId===sub.id);
    if(!list.length) continue;
    const collapsed=localStorage.getItem(`zl:vpn:sub:${sub.id}`)==='1';
    groups.push(`<section class="vpn-sub-group ${collapsed?'collapsed':''}" data-subscription-id="${esc(sub.id)}"><header class="vpn-sub-head collapsible-head" data-collapse-target="sub:${esc(sub.id)}"><div class="vpn-sub-heading"><span class="vpn-sub-icon">⌁</span><div><div class="vpn-sub-title">${esc(sub.name||sub.profileTitle||'Подписка')}</div><div class="vpn-sub-meta">${list.length} сервер${list.length===1?'':'а'}</div></div></div><div class="vpn-sub-actions"><button class="icon-btn compact-action vpn-sub-ping" data-proxy-sub-ping="${esc(sub.id)}" title="Проверить пинг этой подписки" aria-label="Проверить пинг подписки">${ICON_BOLT}</button><button class="icon-btn compact-action vpn-sub-refresh" data-proxy-sub-refresh="${esc(sub.id)}" title="Обновить подписку" aria-label="Обновить подписку"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0 2 5"/><path d="M20 4v7h-7"/></svg></button><button class="icon-btn compact-action danger vpn-sub-del" data-proxy-sub-del="${esc(sub.id)}" title="Удалить подписку" aria-label="Удалить подписку">×</button><button class="icon-btn compact-action vpn-sub-collapse" type="button" title="Свернуть/развернуть" aria-label="Свернуть/развернуть"><svg viewBox="0 0 24 24"><path d="m7 9 5 5 5-5"/></svg></button></div></header><div class="vpn-sub-content" data-collapse-content="sub:${esc(sub.id)}"><div class="vpn-grid">${list.map(vpnServerTileHtml).join('')}</div></div></section>`);
  }
  const manual=servers.filter(s=>!s.subscriptionId);
  if(manual.length) groups.push(`<section class="vpn-sub-group"><header class="vpn-sub-head"><div><div class="vpn-sub-title">Добавленные серверы</div><div class="vpn-sub-meta">${manual.length} сервер${manual.length===1?'':'а'}</div></div></header><div class="vpn-grid">${manual.map(vpnServerTileHtml).join('')}</div></section>`);
  grid.innerHTML=groups.join('');
  grid.dataset.structureKey=key;
  updateVpnTiles();
}

function renderProxyServers(){ renderVpnServers(); }
function renderProxySubscriptions(){
  const list=state.proxy.subscriptions||[]; const cnt=$('#proxySubCount'); if(cnt)cnt.textContent=`${list.length}`; const el=$('#proxySubList'); if(!el)return;
  el.innerHTML=list.length?list.map(s=>`<div class="proxy-sub-row" data-proxy-sub="${esc(s.id)}"><div class="proxy-server-info"><div class="proxy-server-name">${esc(s.name)}</div><div class="proxy-server-meta">${s.count||0} серверов · ${s.updatedAt?'обновлено '+new Date(s.updatedAt).toLocaleString():'ещё не обновлялась'}${s.error?' · '+esc(s.error):''}</div></div><div class="proxy-row-actions"><button class="proxy-mini proxy-sub-refresh" data-proxy-sub-refresh="${esc(s.id)}" title="Обновить">↻</button><button class="proxy-mini proxy-sub-del" data-proxy-sub-del="${esc(s.id)}" title="Удалить">×</button></div></div>`).join(''):'<div class="hint">Подписок пока нет.</div>';
}

function renderProxyState(p = state.proxy) {
  const px=p||state.proxy||{}; state.proxy={...state.proxy,...px}; const selected=px.selected||(px.servers||[]).find(s=>s.id===px.settings?.activeServerId); const running=!!px.running; const lat=selected?.latency!=null?`${selected.latency} ms`:'—';
  const connecting=!!state.proxyConnectingId && !running;
  const statusText=connecting?'Подключение…':(running?(px.mode==='tun'?'TUN подключён':px.mode==='mixed'?'Смешанный режим подключён':'Прокси подключён'):'Остановлен');
  ['#vpnSectionStatus','#proxyQuickStatus','#proxySettingsStatus'].forEach(sel=>{const el=$(sel);if(el){el.textContent=statusText;el.classList.toggle('on',running);el.classList.toggle('connecting',connecting);}});
  $('#vpnSection')?.classList.toggle('connecting',connecting);
  // Показываем IP, полученный через туннель, — доказательство, что VPN реально работает.
  const ipEl=$('#proxyHeroIp'); if(ipEl) ipEl.textContent = running && px.publicIp ? `IP через VPN: ${px.publicIp}` : '';
  ['#proxyQuickSelected','#proxyHeroServer'].forEach(sel=>{const el=$(sel);if(el)el.textContent=selected?.name||'Сервер не выбран';});
  ['#proxyQuickLatency','#proxyHeroLatency'].forEach(sel=>{const el=$(sel);if(el)el.textContent=lat;});
  const meta=$('#proxyHeroMeta'); if(meta)meta.textContent=selected?`${proxyServerLabel(selected)} · ${px.mode==='tun'?'TUN':px.mode==='mixed'?'TUN + системный прокси':'системный прокси'}`:'Добавьте подписку или сервер в категории VPN.';
  const mode=$('#proxyQuickMode'); if(mode)mode.textContent=px.mode==='tun'?'TUN — весь трафик':px.mode==='mixed'?'Смешанный — TUN + системный прокси':'Системный прокси';
  renderProxyServers(); renderProxySubscriptions(); renderProxyRoutes(); renderProxyCores(); renderFavorites();
}

function renderProxyRoutes(){
  const routes=state.proxy.routes||[]; const sel=$('#proxyRouteSelect'); if(!sel)return;
  sel.innerHTML=routes.map(r=>`<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  if(state.proxy.settings?.routeProfile)sel.value=state.proxy.settings.routeProfile;
}
function renderProxyCores(){
  const c=state.proxy.cores||[]; const x=c.find(v=>v.name==='xray'); const s=c.find(v=>v.name==='sing-box');
  if($('#proxyXrayCore'))$('#proxyXrayCore').textContent=x?.installed?'установлен':'будет скачан при первом подключении';
  if($('#proxySingCore'))$('#proxySingCore').textContent=s?.installed?'установлен':'будет скачан при первом подключении';
}
async function loadProxy(){
  try{
    const p=await window.api.proxyStatus(); state.proxy=p;
    state.proxy.cores=await window.api.proxyCores();
    renderProxyState(p);
    const ps=p.settings||{};
    const map={proxyMode:ps.mode,proxySocksPort:ps.socksPort,proxyHttpPort:ps.httpPort,proxySystemProxy:ps.systemProxy,proxyMtu:ps.mtu,proxyTunCore:ps.tunCore,proxyTunName:ps.tunName,proxySocksAuthMode:ps.socksAuthMode,proxyHttpAuthMode:ps.httpAuthMode,proxyResolveEnable:ps.serverResolveEnable,proxyResolveDnsIp:ps.serverResolveDnsIp,proxyPingType:ps.pingType,proxyPingUrl:ps.pingUrl,proxySubAutoUpdate:ps.subscriptionAutoUpdate,proxySubInterval:ps.subscriptionUpdateIntervalHours,proxySubUserAgent:ps.subscriptionUserAgent,proxySubPingOnOpen:ps.subscriptionPingOnOpen,proxySubAutoconnect:ps.subscriptionAutoconnect};
    for(const [id,v] of Object.entries(map)){const el=$('#'+id);if(!el)continue;if(el.type==='checkbox')el.checked=!!v;else if(v!=null)el.value=v;}
    const modeEl=$('#proxyMode'), sysEl=$('#proxySystemProxy'); if(modeEl&&sysEl){ const mixed=modeEl.value==='mixed'; sysEl.checked=mixed || sysEl.checked; sysEl.disabled=mixed; }
    const dns=$('#proxyDns'); if(dns && Array.isArray(ps.dns)){const val=ps.dns.join(','); if([...dns.options].some(o=>o.value===val))dns.value=val;}
  }catch(e){console.warn('[proxy-ui]',e)}
}
function syncProxySettings(){
  return window.api.proxySetSettings({
    mode:$('#proxyMode')?.value || state.proxy.settings?.mode || 'proxy',
    socksPort:Number($('#proxySocksPort')?.value||10808),
    httpPort:Number($('#proxyHttpPort')?.value||10809),
    systemProxy:($('#proxyMode')?.value==='mixed') || !!$('#proxySystemProxy')?.checked,
    mtu:Number($('#proxyMtu')?.value||1500),
    tunCore:$('#proxyTunCore')?.value || 'sing-box',
    tunName:($('#proxyTunName')?.value||'EpicTunnel').trim() || 'EpicTunnel',
    socksAuthMode:$('#proxySocksAuthMode')?.value || 'disable',
    httpAuthMode:$('#proxyHttpAuthMode')?.value || 'disable',
    serverResolveEnable:!!$('#proxyResolveEnable')?.checked,
    serverResolveDnsIp:($('#proxyResolveDnsIp')?.value||'1.1.1.1').trim(),
    pingType:$('#proxyPingType')?.value || 'tcp',
    pingUrl:($('#proxyPingUrl')?.value||'https://cp.cloudflare.com/generate_204').trim(),
    subscriptionAutoUpdate:!!$('#proxySubAutoUpdate')?.checked,
    subscriptionUpdateIntervalHours:Number($('#proxySubInterval')?.value||6),
    subscriptionUserAgent:($('#proxySubUserAgent')?.value||'').trim(),
    subscriptionPingOnOpen:!!$('#proxySubPingOnOpen')?.checked,
    subscriptionAutoconnect:$('#proxySubAutoconnect')?.value || 'off',
    dns:($('#proxyDns')?.value||'1.1.1.1,8.8.8.8').split(',').map(x=>x.trim()).filter(Boolean)
  }).then(p=>{state.proxy.settings=p;state.proxy.mode=p.mode;renderProxyState(state.proxy);return p});
}

let confirmState = null;
function appConfirm(title, message, confirmText='Удалить') {
  return new Promise(resolve => {
    confirmState = resolve;
    const modal=$('#appConfirm');
    if(!modal){resolve(false);return;}
    $('#appConfirmTitle').textContent=title;
    $('#appConfirmText').textContent=message;
    $('#appConfirmOk').textContent=confirmText;
    modal.classList.remove('hidden');
    requestAnimationFrame(()=>modal.classList.add('show'));
  });
}
function closeAppConfirm(result) {
  const modal=$('#appConfirm');
  const resolve=confirmState; confirmState=null;
  if(modal){modal.classList.remove('show');setTimeout(()=>modal.classList.add('hidden'),140);}
  resolve?.(!!result);
}

/* ==================== Инициализация ==================== */

async function init() {
  // окно
  $('#btnMin').onclick = () => window.api && window.api.minimize ? window.api.minimize() : window.close();
  $('#btnClose').onclick = () => window.api && window.api.close ? window.api.close() : window.close();
  $('#btnSettings').onclick = () => openSettings(true);
  $('#btnSettingsClose').onclick = () => openSettings(false);
  $('#appConfirmOk')?.addEventListener('click',()=>closeAppConfirm(true));
  $('#appConfirmCancel')?.addEventListener('click',()=>closeAppConfirm(false));
  $('#appConfirm')?.addEventListener('click',(e)=>{if(e.target.id==='appConfirm')closeAppConfirm(false);});
  const focusVpn = () => { $('#vpnSection')?.scrollIntoView({behavior:'smooth',block:'start'}); $('#vpnSubInput')?.focus(); };
  $('#btnProxy').onclick = focusVpn;
  $('#btnProxyOpen')?.addEventListener('click', focusVpn);

  // плитки / избранное (делегирование)
  document.addEventListener('click', async (e) => {
    const star = e.target.closest('.star');
    if (star) {
      e.stopPropagation();
      onStarClick(star);
      return;
    }
    const tile = e.target.closest('.tile');
    if (tile) {
      if (tile.id === 'tgTile') {
        if (state.busy) return;
        state.busy = true;
        try {
          const res = await window.api.tgToggle();
          state.tg = await window.api.tgStatus();
          renderTg();
          if (res?.error) toast(`TG Proxy: ${res.error}`, 'warn');
        } catch (err) { toast(`TG Proxy: ${err.message || err}`, 'warn'); }
        finally { state.busy = false; }
      } else {
        await onTileClick(tile);
      }
    }
  });

  document.addEventListener('click', async (e) => {
    const serverRow=e.target.closest('.proxy-server-row, .vpn-server-tile');
    const fav=e.target.closest('[data-proxy-fav]');
    const del=e.target.closest('[data-proxy-del]');
    const subRefresh=e.target.closest('[data-proxy-sub-refresh]');
    const subPing=e.target.closest('[data-proxy-sub-ping]');
    const subDel=e.target.closest('[data-proxy-sub-del]');
    if(fav){e.stopPropagation();try{await window.api.proxyFavoriteServer(fav.dataset.proxyFav);await loadProxy();}catch(err){toast(`Избранное: ${err.message||err}`,'warn');}return;}
    if(del){e.stopPropagation();const ok=await appConfirm('Удалить сервер?','Сервер будет удалён из VPN. Подписка не удаляется и при следующем обновлении может вернуть этот сервер.','Удалить');if(!ok)return;try{await window.api.proxyDeleteServer(del.dataset.proxyDel);await loadProxy();}catch(err){toast(err.message||err,'warn');}return;}
    if(subPing){e.stopPropagation();if(subPing.classList.contains('busy'))return;const group=subPing.closest('.vpn-sub-group');subPing.classList.add('busy');group?.classList.add('pinging');group?.querySelectorAll('.vpn-server-tile').forEach(t=>t.classList.add('pinging'));try{await window.api.proxyPingSubscription(subPing.dataset.proxySubPing);await loadProxy();toast('Пинг подписки проверен.','ok')}catch(err){toast(`Пинг: ${err.message||err}`,'warn')}finally{subPing.classList.remove('busy');group?.classList.remove('pinging');group?.querySelectorAll('.vpn-server-tile').forEach(t=>t.classList.remove('pinging'))}return;}
    if(subRefresh){e.stopPropagation();if(subRefresh.classList.contains('busy'))return;const group=subRefresh.closest('.vpn-sub-group');subRefresh.classList.add('busy');group?.classList.add('refreshing');try{await window.api.proxyRefreshSubscription(subRefresh.dataset.proxySubRefresh);await loadProxy();toast('Подписка обновлена.','ok')}catch(err){toast(`Подписка: ${err.message||err}`,'warn')}finally{subRefresh.classList.remove('busy');group?.classList.remove('refreshing')}return;}
    if(subDel){e.stopPropagation();const ok=await appConfirm('Удалить подписку?','Все серверы этой подписки будут удалены из VPN.','Удалить подписку');if(!ok)return;try{await window.api.proxyDeleteSubscription(subDel.dataset.proxySubDel);await loadProxy();toast('Подписка удалена.','ok')}catch(err){toast(err.message||err,'warn')}return;}
    if(serverRow){const id=serverRow.dataset.proxyId;const already=state.proxy.running && state.proxy.selected?.id===id;if(state.proxyConnectingId || (!already && state.proxy.running))return;if(!already){state.proxyConnectingId=id;serverRow.classList.add('connecting');renderProxyState(state.proxy);}try{await window.api.proxyToggleServer(id);await loadProxy();}catch(err){toast(`VPN: ${err.message||err}`,'warn')}finally{state.proxyConnectingId=null;renderProxyState(state.proxy)}return;}
  });
  const addSubscriptionFromInput=async()=>{const input=$('#vpnSubInput');const url=(input?.value||'').trim();if(!url)return;try{if(!/^https?:\/\//i.test(url))throw new Error('Нужна ссылка подписки http:// или https://');await window.api.proxyAddSubscription(url,'');input.value='';await loadProxy();toast('Подписка добавлена и обновлена.','ok')}catch(e){toast(`Подписка: ${e.message||e}`,'warn',9000)}};
  $('#btnVpnImportFile')?.addEventListener('click',async()=>{try{const raw=await window.api.proxyPickFile();if(!raw)return;const t=raw.trim();if(/^\s*(?:\{|\[)/.test(t)){const list=await window.api.proxyImportJson(t);toast(`Импортировано серверов: ${list.length}.`,'ok')}else{const item=await window.api.proxyImportWireguard(t);toast(`Импортирован ${item.name}.`,'ok')}await loadProxy()}catch(e){toast(`Импорт: ${e.message||e}`,'warn')}});
  const refreshVpn=async()=>{const btn=$('#btnVpnRefreshAll');const section=$('#vpnSection');if(btn?.classList.contains('busy'))return;btn?.classList.add('busy');section?.classList.add('refreshing');document.querySelectorAll('.vpn-sub-group').forEach(g=>g.classList.add('refreshing'));try{toast('Обновляю подписки…');await window.api.proxyRefreshAll();await loadProxy();toast('Подписки обновлены.','ok')}catch(e){toast(`Обновление: ${e.message||e}`,'warn')}finally{btn?.classList.remove('busy');section?.classList.remove('refreshing');document.querySelectorAll('.vpn-sub-group').forEach(g=>g.classList.remove('refreshing'))}};
  const pingVpn=async()=>{if(state.proxyPingBusy)return;state.proxyPingBusy=true;$('#btnVpnPingAll')?.classList.add('busy');$('#vpnSection')?.classList.add('pinging');document.querySelectorAll('.vpn-server-tile').forEach(t=>t.classList.add('pinging'));try{toast('Проверяю пинг серверов…');await window.api.proxyPingAll();await loadProxy();toast('Проверка пинга завершена.','ok')}catch(e){toast(`Пинг: ${e.message||e}`,'warn')}finally{state.proxyPingBusy=false;$('#btnVpnPingAll')?.classList.remove('busy');$('#vpnSection')?.classList.remove('pinging');document.querySelectorAll('.vpn-server-tile').forEach(t=>t.classList.remove('pinging'))}};
  $('#btnVpnRefreshAll').onclick=refreshVpn; $('#btnVpnPingAll').onclick=pingVpn;
  $('#btnProxyRouteApply')?.addEventListener('click',async()=>{try{const id=$('#proxyRouteSelect').value;await window.api.proxySetRoute(id);await syncProxySettings();toast('Профиль маршрутизации применён.','ok')}catch(e){toast(`Маршрутизация: ${e.message||e}`,'warn')}});
  ['#proxyMode','#proxySocksPort','#proxyHttpPort','#proxySystemProxy','#proxyMtu','#proxyDns','#proxyTunCore','#proxyTunName','#proxySocksAuthMode','#proxyHttpAuthMode','#proxyResolveEnable','#proxyResolveDnsIp','#proxyPingType','#proxyPingUrl','#proxySubAutoUpdate','#proxySubInterval','#proxySubUserAgent','#proxySubPingOnOpen','#proxySubAutoconnect'].forEach(sel=>{const el=$(sel);if(el)el.onchange=()=>{ const mixed=$('#proxyMode')?.value==='mixed'; const sys=$('#proxySystemProxy'); if(sys) sys.disabled=mixed; syncProxySettings().catch(e=>toast(`Настройки Proxy: ${e.message||e}`,'warn')); };});

  // Сворачивание разделов приложения и отдельных VPN-подписок.
  document.addEventListener('click', (e) => {
    const collapseControl=e.target.closest('.section-collapse-btn,.vpn-sub-collapse');
    const head=e.target.closest('.collapsible-head');
    if(!head) return;
    if(e.target.closest('button') && !collapseControl) return;
    const key=String(head.dataset.collapseTarget||'').trim();
    if(!key) return;
    const group=head.closest('.vpn-sub-group');
    const section=head.closest('.collapsible-section');
    const target=group || section;
    if(!target) return;
    const collapsed=target.classList.toggle('collapsed');
    target.classList.add('collapse-just-changed');
    setTimeout(()=>target.classList.remove('collapse-just-changed'),220);
    const storageKey=key.startsWith('sub:') ? `zl:vpn:sub:${key.slice(4)}` : `zl:collapse:${key}`;
    localStorage.setItem(storageKey, collapsed?'1':'0');
  });

  // Восстанавливаем состояние разделов после загрузки DOM.
  $$('.collapsible-section').forEach(section=>{
    const head=section.querySelector('.collapsible-head[data-collapse-target]');
    if(!head) return;
    const key=head.dataset.collapseTarget;
    const stored=localStorage.getItem(`zl:collapse:${key}`);
    if(stored==='1') section.classList.add('collapsed');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.closest?.('#vpnSubInput')) { e.preventDefault(); addSubscriptionFromInput(); return; }
    if (e.key === 'Enter') {
      const tile = e.target.closest && e.target.closest('.tile');
      if (tile) {
        if (tile.id === 'tgTile') tile.click();
        else onTileClick(tile);
      }
    }
  });

  // вкладки настроек
  $$('.tab').forEach((tab) => {
    tab.onclick = () => {
      $$('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      $$('.page').forEach((p) => p.classList.remove('active'));
      $(`#page-${tab.dataset.tab}`).classList.add('active');
    };
  });

  // основные
  $('#btnChooseFolder').onclick = chooseFolder;
  $('#btnEmptyFolder').onclick = chooseFolder;
  $('#btnOpenFolder').onclick = () => window.api.openFolder();
  $('#togCloseOnExit').onchange = async (e) => { state.cfg = await window.api.setConfig({ closeScriptsOnExit: e.target.checked }); };
  $('#togStartup').onchange = async (e) => { state.cfg = await window.api.setConfig({ launchAtStartup: e.target.checked }); };
  $('#togAutoCheck').onchange = async (e) => {
    state.cfg = await window.api.setConfig({ autoCheckUpdates: e.target.checked });
    toast(e.target.checked ? 'Проверка обновлений включена (utils/check_updates.enabled).' : 'Проверка обновлений выключена.', 'ok');
  };
  $('#togAppAutoCheck').onchange = async (e) => {
    state.cfg = await window.api.setConfig({ appAutoCheckUpdates: e.target.checked });
  };
  $('#cfgTgRepo').onchange = async (e) => {
    state.cfg = await window.api.setConfig({ tgRepo: e.target.value.trim() });
    toast(`Источник tg-ws-proxy: ${state.cfg.tgRepo}`, 'ok');
  };
  $('#togTgAutoCheck').onchange = async (e) => { state.cfg = await window.api.setConfig({ tgAutoCheckUpdates: e.target.checked }); };
  $('#togTgAutoStart').onchange = async (e) => {
    state.cfg = await window.api.setConfig({ tgAutoStart: e.target.checked });
    if (e.target.checked) await window.api.tgStart(); else await window.api.tgStop();
    state.tg = await window.api.tgStatus(); renderTg();
  };
  $('#btnTgChooseDir').onclick = async () => {
    const dir = await window.api.chooseTgFolder();
    if (!dir) return;
    state.cfg = await window.api.setConfig({ tgDir: dir });
    $('#cfgTgDir').value = dir;
    state.tg = await window.api.tgStatus(); renderTg();
  };
  $('#btnTgOpenFolder').onclick = () => window.api.tgOpenFolder();
  $('#btnTgCheck').onclick = async () => {
    try { state.tgUpdate = await window.api.tgCheck(); renderTgUpdate(); toast(state.tgUpdate.hasUpdate ? `Доступна версия ${state.tgUpdate.remote}` : 'tg-ws-proxy уже актуален.', state.tgUpdate.hasUpdate ? 'warn' : 'ok'); }
    catch (err) { toast(`Ошибка tg-ws-proxy: ${err.message || err}`, 'warn'); }
  };
  $('#btnTgInstall').onclick = async () => {
    $('#btnTgInstall').disabled = true;
    try { state.tg = await window.api.tgInstall(); renderTg(); toast(`tg-ws-proxy ${state.tg.version || ''} загружен.`, 'ok'); }
    catch (err) { toast(`Не удалось загрузить tg-ws-proxy: ${err.message || err}`, 'warn'); }
    finally { $('#btnTgInstall').disabled = false; renderTgProgress({ percent: -1 }); }
  };
  $('#btnTgToggle').onclick = async () => {
    const res = await window.api.tgToggle();
    state.tg = await window.api.tgStatus();
    renderTg();
    if (res && res.error) toast(`tg-ws-proxy: ${res.error}`, 'warn');
  };
  $('#btnTgSave').onclick = async () => {
    try {
      const cfg = await window.api.tgSetConfig({
        host: $('#tgHost').value.trim(),
        port: Number($('#tgPort').value),
        secret: $('#tgSecret').value.trim(),
        dc_ip: $('#tgDcIp').value.trim(),
        buffer_size: Number($('#tgBuffer').value),
        pool_size: Number($('#tgPool').value),
        cfproxy: $('#tgCfproxy').checked,
        force_test_dc: $('#tgForceDc').checked,
        ws_keepalive_interval: Number($('#tgKeepalive').value)
      });
      fillTgConfig(cfg);
      toast('Настройки tg-ws-proxy сохранены.', 'ok');
    } catch (err) { toast(`Ошибка настроек tg-ws-proxy: ${err.message || err}`, 'warn'); }
  };
  $('#btnAppCheck').onclick = async () => {
    state.appUpdate = await window.api.checkAppUpdate();
    renderAppUpdate();
  renderProxyState(state.proxy);
    toast(state.appUpdate.hasUpdate ? `Доступна версия ${state.appUpdate.remote}` : `Обновлений приложения нет.`, state.appUpdate.hasUpdate ? 'warn' : 'ok');
  };
  $('#btnAppUpdate').onclick = async () => {
    const res = await window.api.runAppUpdate();
    if (res?.ok && res?.alreadyLatest) {
      state.appUpdate = { ...(state.appUpdate || {}), hasUpdate: false, local: res.version || state.appUpdate?.local, remote: res.version || state.appUpdate?.remote };
      renderAppUpdate();
  renderProxyState(state.proxy);
      toast(`Установлена последняя версия ${res.version || state.appUpdate?.local || ''}.`, 'ok');
    } else if (!res?.ok) {
      toast(`Не удалось обновить приложение: ${res?.error || 'ошибка'}`, 'warn');
    }
  };
  setColorRow('#accentColor', '#accentHex', 'accentColor');
  setColorRow('#backgroundColor', '#backgroundHex', 'backgroundColor');
  $('#btnResetColors').onclick = async () => {
    const a = '#ff2e4c', bg = '#14161b';
    await window.api.setConfig({ accentColor: a, backgroundColor: bg });
    applyTheme(a,bg); $('#accentColor').value = a; $('#accentHex').value = a; $('#backgroundColor').value = bg; $('#backgroundHex').value = bg;
  };

  $('#cfgRepo').onchange = async (e) => {
    const repo = e.target.value.trim();
    if (!repo) return;
    state.cfg = await window.api.setConfig({ repo });
    toast(`Источник обновлений: ${repo}`, 'ok');
  };

  // обновления
  $('#btnCheckUpdate').onclick = async () => {
    toast('Проверяю обновления…');
    const info = await window.api.checkUpdate();
    state.update = info;
    renderUpdateBanner();
    refreshSettings();
    toast(info.hasUpdate ? `Доступна версия ${info.remote}.` : `Обновлений нет (установлена ${info.local || '—'}).`, info.hasUpdate ? 'warn' : 'ok');
  };
  $('#btnDoUpdate').onclick = async () => {
    $('#btnDoUpdate').disabled = true;
    try {
      const res = await window.api.runUpdate();
      if (res && res.ok) {
        state.bats = await window.api.listBats();
        state.cfg = await window.api.getConfig();
        renderBats();
        state.update = null;
        renderUpdateBanner();
        refreshSettings();
        toast(`Обновлено до версии ${res.version}. Плитки обновлены.`, 'ok');
      } else {
        toast(`Не удалось обновить: ${res && res.error ? res.error : 'неизвестная ошибка'}`, 'warn');
      }
    } finally {
      $('#btnDoUpdate').disabled = false;
      renderProgress({ percent: -1 });
    }
  };

  // hosts
  $('#btnHostsCheck').onclick = async () => {
    try {
      const hs = await window.api.hostsCheck();
      setKv('#hostsStatus', hs.ok ? (hs.statusLabel || hs.status) : `ошибка: ${hs.error || 'сеть'}`);
      setKvClass('#hostsStatus', hs);
      toast(hs.ok ? `Hosts: ${hs.statusLabel || hs.status}` : `Hosts: ${hs.error || 'ошибка сети'}`, hs.ok ? (hs.needsUpdate ? 'warn' : 'ok') : 'warn');
    } catch (err) {
      setKv('#hostsStatus', `ошибка: ${err.message || err}`);
      setKvClass('#hostsStatus', { bad: true });
      toast(`Hosts: ${err.message || err}`, 'warn');
    }
  };
  $('#btnHostsUpdate').onclick = async () => {
    const res = await window.api.hostsUpdate();
    toast(res && res.ok !== false ? 'Hosts-файл обновлён с резервной копией.' : `Ошибка: ${res && res.error}`, res && res.ok !== false ? 'ok' : 'warn');
    $('#btnHostsCheck').onclick();
  };

  // сервис
  $('#btnRefreshSvc').onclick = () => refreshSettings();
  $('#btnInstallSvc').onclick = async () => {
    const name = $('#svcBat').value;
    if (!name) return;
    if (!confirm(`Установить сервис «zapret» со стратегией ${name}?`)) return;
    const res = await window.api.installService(name);
    toast(res && res.ok ? 'Сервис установлен и запущен.' : `Ошибка: ${res && res.error}`, res && res.ok ? 'ok' : 'warn');
    refreshSettings();
  };
  $('#btnRemoveSvc').onclick = async () => {
    if (!confirm('Удалить сервисы zapret / WinDivert и завершить winws.exe?')) return;
    const res = await window.api.removeServices();
    toast('Сервисы удалены.', 'ok');
    refreshSettings();
  };

  // фильтры
  $('#btnGfSave').onclick = async () => {
    const res = await window.api.gameFilterSet({
      mode: $('#gfMode').value,
      tcp: $('#gfTcp').value.trim(),
      udp: $('#gfUdp').value.trim()
    });
    toast(res && res.ok !== false ? 'Game Filter сохранён. Перезапустите zapret.' : `Ошибка: ${res && res.error}`, 'ok');
    refreshSettings();
  };
  const ipset = (mode) => async () => {
    const res = await window.api.ipsetSet(mode);
    toast(`IPSet режим: ${mode}`, 'ok');
    refreshSettings();
  };
  $('#btnIpsetNone').onclick = ipset('none');
  $('#btnIpsetLoaded').onclick = ipset('loaded');
  $('#btnIpsetAny').onclick = ipset('any');
  $('#btnIpsetUpdate').onclick = async () => {
    const res = await window.api.ipsetUpdate();
    toast(res && res.ok !== false ? 'IPSet список обновлён из репозитория.' : `Ошибка: ${res && res.error}`, res && res.ok !== false ? 'ok' : 'warn');
  };

  // фэйки
  $('#btnFkRefresh').onclick = () => refreshSettings();
  $('#btnFkReplace').onclick = async () => {
    const type = $('#fkType').value;
    const file = $('#fkFile').value;
    if (!file) return;
    const res = await window.api.fakesReplace(type, file);
    toast(res && res.ok !== false ? `Активный фэйк подменён: ${file}` : `Ошибка: ${res && res.error}`, res && res.ok !== false ? 'ok' : 'warn');
    refreshSettings();
  };

  // диагностика
  $('#btnRunDiag').onclick = async () => {
    toast('Запускаю диагностику…');
    const results = await window.api.runDiagnostics();
    renderDiag(results);
    const bad = results.filter((r) => r.level === 'fail').length;
    toast(bad ? `Диагностика завершена. Проблем: ${bad}.` : 'Диагностика завершена. Проблем не найдено.', bad ? 'warn' : 'ok');
  };
  $('#btnRunTests').onclick = async () => {
    const res = await window.api.runTests();
    toast(res && res.ok !== false ? 'Тесты запущены в отдельном окне PowerShell.' : `Ошибка: ${res && res.error}`, res && res.ok !== false ? 'ok' : 'warn');
  };
  $('#btnRunnerLog').onclick = async () => {
    const lines = await window.api.runnerLog();
    if (!lines || !lines.length) {
      toast('Лог запусков пуст.', 'warn');
      return;
    }
    renderDiag(lines.slice(-12).map((l) => ({ title: 'runner.log', level: 'info', lines: [l] })));
    toast('Лог запусков показан внизу вкладки «Диагностика».', 'ok');
  };
  $('#btnFixWindivert').onclick = async () => {
    const res = await window.api.fixWindivert();
    toast('WinDivert починен (драйвер перерегистрирован).', 'ok');
    refreshSettings();
  };
  $('#btnFixConflicts').onclick = async () => {
    if (!state.conflicts.length) return;
    if (!confirm(`Удалить конфликтующие сервисы: ${state.conflicts.join(', ')}?`)) return;
    await window.api.fixConflicts(state.conflicts);
    toast('Конфликтующие сервисы удалены.', 'ok');
  };
  $('#btnClearDiscord').onclick = async () => {
    if (!confirm('Очистить кэш Discord (Local Storage)?')) return;
    await window.api.clearDiscordCache();
    toast('Кэш Discord очищен.', 'ok');
  };

  // первый запуск
  $('#btnOnboardFolder').onclick = async () => {
    state.setupPromptDismissed = true;
    await chooseFolder();
    state.setupPromptDismissed = false;
    state.tg = await window.api.tgStatus();
    renderTg();
    renderBats();
  };
  $('#btnOnboardDownload').onclick = async () => {
    const btn = $('#btnOnboardDownload');
    if (btn) btn.disabled = true;
    try {
      state.setupPromptDismissed = true;
      toast('Скачиваю Zapret в Documents\\Zapret Launcher\\zapret…');
      const res = await window.api.installZapret();
      if (!res?.ok) throw new Error(res?.error || 'ошибка установки');
      state.cfg = await window.api.getConfig();
      state.bats = await window.api.listBats();
      toast(`Zapret установлен в ${res.dir}. Найдено батников: ${state.bats.length}.`, 'ok');
    } catch (err) { toast(`Не удалось установить Zapret: ${err.message || err}`, 'warn'); }
    finally { if (btn) btn.disabled = false; state.setupPromptDismissed = false; renderBats(); }
  };
  $('#btnOnboardTgInstall').onclick = async () => {
    const btn = $('#btnOnboardTgInstall');
    if (btn) btn.disabled = true;
    try {
      state.setupPromptDismissed = true;
      toast('Скачиваю TG Proxy в Documents\\Zapret Launcher\\tg-ws-proxy…');
      state.tg = await window.api.tgInstall();
      toast(`TG Proxy ${state.tg.version || ''} установлен.`, 'ok');
    } catch (err) {
      toast(`Не удалось установить TG Proxy: ${err.message || err}`, 'warn');
    } finally {
      if (btn) btn.disabled = false;
      state.setupPromptDismissed = false;
      renderTg();
      renderBats();
    }
  };
  $('#btnOnboardSettings').onclick = () => {
    state.setupPromptDismissed = true;
    renderBats();
    openSettings(true, state.tg?.installed ? 'general' : 'tg');
  };
  $('#btnOnboardLater').onclick = () => { state.setupPromptDismissed = true; renderBats(); };

  // события из основного процесса
  if (window.api && window.api.onState) {
    window.api.onState((p) => {
      state.running = new Set(Array.isArray(p) ? p : (p && p.running) || []);
      applyRunningState();
    });
    // страховка: опрос истины у main каждые 1.2 сек — плитка не может «залипнуть»
    setInterval(async () => {
      try {
        const list = await window.api.runningList();
        const a = [...state.running].sort().join('|');
        const b = [...list].sort().join('|');
        if (a !== b) {
          state.running = new Set(list);
          applyRunningState();
        }
      } catch {}
    }, 1200);
    window.api.onBats((p) => {
      state.bats = p.bats || [];
      renderBats();
      if (!$('#settings').classList.contains('hidden')) refreshSettings();
    });
    window.api.onUpdate((info) => {
      state.update = info;
      renderUpdateBanner();
    });
    window.api.onUpdateProgress((p) => renderProgress(p));
    window.api.onToast((t) => toast(t && t.text ? t.text : String(t), (t && t.type) || ''));
    window.api.onTgState?.((p) => { state.tg = p; renderTg(); });
    window.api.onTgUpdate?.((p) => { state.tgUpdate = p; renderTgUpdate(); });
    window.api.onTgProgress?.((p) => renderTgProgress(p));
    window.api.onAppUpdate?.((p) => { state.appUpdate = p; renderAppUpdate(); });
    window.api.onProxyState?.((p) => { state.proxy = p; renderProxyState(p); });
  }

  // загрузка данных
  try {
    state.cfg = await window.api.getConfig();
    state.sys = await window.api.sysInfo();
    state.bats = await window.api.listBats();
    state.tg = await window.api.tgStatus();
    fillTgConfig(await window.api.tgGetConfig());
    state.proxy = await window.api.proxyStatus();
  } catch {
    state.bats = [];
  }
  state.favorites = new Set(state.cfg.favorites || []);
// самодиагностика частичной замены файлов: маркеры всех четырёх слоёв
  const markers = {
    m: (state.sys && state.sys.build) || 'OLD',
    r: RENDERER_BUILD,
    p: (window.api && window.api.build) || 'OLD',
    h: (document.querySelector('meta[name="zl-build"]') || {}).content || 'OLD'
  };
const stale = Object.keys(EXPECT_BUILD).filter((k) => markers[k] !== EXPECT_BUILD[k]);
  if (stale.length) {
    toast(`Заменены не все файлы! Устарели: ${stale.map((k) => BUILD_LABEL[k]).join(', ')}. Удалите папку src ЦЕЛИКОМ и распакуйте архив заново.`, 'warn', 14000);
  }
  if (state.sys && state.sys.elevated === false) $('#bannerAdmin').classList.remove('hidden');

  applyTheme(state.cfg.accentColor, state.cfg.backgroundColor);
  renderBats();
  renderUpdateBanner();
  renderTg();
  renderTgUpdate();
  renderAppUpdate();
  renderProxyState(state.proxy);

  // автопроверка обновлений
  if (state.cfg.autoCheckUpdates !== false && window.api && window.api.checkUpdate) {
    window.api.checkUpdate().then((info) => {
      state.update = info; renderUpdateBanner(); $('#verRemote').textContent = info && info.remote ? info.remote : '—';
    }).catch(() => {});
  }
  if (state.cfg.tgAutoCheckUpdates !== false) { window.api.tgCheck().then((i) => { state.tgUpdate = i; renderTgUpdate(); }).catch(() => {}); }
  if (state.cfg.appAutoCheckUpdates !== false) { window.api.checkAppUpdate().then((i) => { state.appUpdate = i; renderAppUpdate(); if (i?.hasUpdate) toast(`Доступно обновление приложения ${i.remote}.`, 'warn', 7000); }).catch(() => {}); }
}

init();
