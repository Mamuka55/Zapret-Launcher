/* ================================================================
   Zapret Launcher — логика интерфейса
   Плитки (вкл/выкл), избранное, настройки (шестерёнка),
   обновления GitHub, сервис, фильтры, фэйки, диагностика, тосты
   ================================================================ */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// маркер сборки рендера: виден в бейдже шапки (самодиагностика старых файлов)
const RENDERER_BUILD = 'r1.3.3';
const EXPECT_BUILD = { m: 'm1.3.3', r: 'r1.3.3', p: 'p1.3.3', h: 'h1.3.3' };
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
  svcBats: [],
  tg: { installed: false, running: false, version: null },
  tgUpdate: null,
  appUpdate: null,
  theme: { accent: '#ff2e4c', background: '#14161b' },
  setupPromptDismissed: false
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

function renderBats() {
  const favs = state.bats.filter((b) => state.favorites.has(b.name));
  const regular = state.bats.filter((b) => !state.favorites.has(b.name));
  $('#favGrid').innerHTML = favs.map(tileHtml).join('');
  $('#favSection').classList.toggle('hidden', favs.length === 0);
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

/* ==================== Инициализация ==================== */

async function init() {
  // окно
  $('#btnMin').onclick = () => window.api && window.api.minimize ? window.api.minimize() : window.close();
  $('#btnClose').onclick = () => window.api && window.api.close ? window.api.close() : window.close();
  $('#btnSettings').onclick = () => openSettings(true);
  $('#btnSettingsClose').onclick = () => openSettings(false);

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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const tile = e.target.closest && e.target.closest('.tile');
      if (tile) {
        if (tile.id === 'tgTile') tile.click();
        else onTileClick(tile);
      }
    }
    if (e.key === 'Escape') openSettings(false);
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
    toast(state.appUpdate.hasUpdate ? `Доступна версия ${state.appUpdate.remote}` : `Обновлений приложения нет.`, state.appUpdate.hasUpdate ? 'warn' : 'ok');
  };
  $('#btnAppUpdate').onclick = async () => {
    const res = await window.api.runAppUpdate();
    if (res?.ok && res?.alreadyLatest) {
      state.appUpdate = { ...(state.appUpdate || {}), hasUpdate: false, local: res.version || state.appUpdate?.local, remote: res.version || state.appUpdate?.remote };
      renderAppUpdate();
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
  }

  // загрузка данных
  try {
    state.cfg = await window.api.getConfig();
    state.sys = await window.api.sysInfo();
    state.bats = await window.api.listBats();
    state.tg = await window.api.tgStatus();
    fillTgConfig(await window.api.tgGetConfig());
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
