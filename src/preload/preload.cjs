// Мост между интерфейсом и основным процессом (contextIsolation: true)
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('api', {
  // маркер сборки preload-слоя (для самодиагностики «старых файлов»)
  build: 'p1.4.9',

  // окно
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),

  // плитки
  listBats: () => invoke('bats:list'),
  toggleBat: (name, batPath) => invoke('bats:toggle', { name, batPath }),
  runningList: () => invoke('bats:running'),
  stopAll: () => invoke('bats:stopAll'),

  // настройки
  getConfig: () => invoke('config:get'),
  setConfig: (patch) => invoke('config:set', patch),
  toggleFavorite: (name) => invoke('config:toggleFavorite', name),
  chooseFolder: () => invoke('config:chooseFolder'),
  chooseTgFolder: () => invoke('config:chooseTgFolder'),
  openFolder: () => invoke('config:openFolder'),
  defaultBatsDir: () => invoke('paths:defaultBats'),
  defaultTgDir: () => invoke('paths:defaultTg'),

  // обновления
  checkUpdate: () => invoke('updates:check'),
  installZapret: () => invoke('updates:install'),
  runUpdate: () => invoke('updates:run'),
  checkAppUpdate: () => invoke('appUpdates:check'),
  runAppUpdate: () => invoke('appUpdates:run'),

  // tg-ws-proxy
  tgStatus: () => invoke('tg:status'),
  tgToggle: () => invoke('tg:toggle'),
  tgStart: () => invoke('tg:start'),
  tgStop: () => invoke('tg:stop'),
  tgCheck: () => invoke('tg:check'),
  tgInstall: () => invoke('tg:install'),
  tgGetConfig: () => invoke('tg:getConfig'),
  tgSetConfig: (patch) => invoke('tg:setConfig', patch),
  tgOpenFolder: () => invoke('tg:openFolder'),

  // сервис
  serviceStatus: () => invoke('service:status'),
  installService: (batName) => invoke('service:install', batName),
  removeServices: () => invoke('service:remove'),

  // фильтры
  gameFilterGet: () => invoke('filter:gameGet'),
  gameFilterSet: (payload) => invoke('filter:gameSet', payload),
  ipsetGet: () => invoke('filter:ipsetGet'),
  ipsetSet: (mode) => invoke('filter:ipsetSet', mode),
  ipsetUpdate: () => invoke('filter:ipsetUpdate'),

  // фэйки
  fakesGet: () => invoke('fakes:get'),
  fakesReplace: (type, file) => invoke('fakes:replace', { type, file }),

  // hosts
  hostsCheck: () => invoke('hosts:check'),
  hostsUpdate: () => invoke('hosts:update'),

  // диагностика / инструменты
  runDiagnostics: () => invoke('diag:run'),
  runnerLog: () => invoke('diag:runnerLog'),
  fixWindivert: () => invoke('diag:fixWindivert'),
  fixConflicts: (names) => invoke('diag:fixConflicts', names),
  clearDiscordCache: () => invoke('diag:clearDiscord'),
  runTests: () => invoke('tools:runTests'),

  // система
  sysInfo: () => invoke('sys:info'),


  // proxy / VPN center
  proxyStatus: () => invoke('proxy:status'),
  proxySettings: () => invoke('proxy:settings'),
  proxySetSettings: (patch) => invoke('proxy:setSettings', patch),
  proxyServers: () => invoke('proxy:servers'),
  proxyAddServer: (value) => invoke('proxy:addServer', value),
  proxyDeleteServer: (id) => invoke('proxy:deleteServer', id),
  proxySelectServer: (id) => invoke('proxy:selectServer', id),
  proxyToggleServer: (id) => invoke('proxy:toggleServer', id),
  proxyRenameServer: (id, name) => invoke('proxy:updateServer', { id, patch: { name } }),
  proxyFavoriteServer: (id) => invoke('proxy:favoriteServer', id),
  proxyPing: (id) => invoke('proxy:ping', id),
  proxyPingAll: () => invoke('proxy:pingAll'),
  proxyPingSubscription: (id) => invoke('proxy:pingSubscription', id),
  proxyStart: (opts) => invoke('proxy:start', opts),
  proxyStop: () => invoke('proxy:stop'),
  proxySubscriptions: () => invoke('proxy:subscriptions'),
  proxyAddSubscription: (url, name) => invoke('proxy:addSubscription', { url, name }),
  proxyRefreshSubscription: (id) => invoke('proxy:refreshSubscription', id),
  proxyRefreshAll: () => invoke('proxy:refreshAll'),
  proxyDeleteSubscription: (id) => invoke('proxy:deleteSubscription', id),
  proxyRoutes: () => invoke('proxy:routes'),
  proxyAddRoute: (route) => invoke('proxy:addRoute', route),
  proxyDeleteRoute: (id) => invoke('proxy:deleteRoute', id),
  proxySetRoute: (id) => invoke('proxy:setRoute', id),
  proxyImportJson: (raw) => invoke('proxy:importJson', raw),
  proxyImportWireguard: (raw) => invoke('proxy:importWireguard', raw),
  proxyPickFile: () => invoke('proxy:pickFile'),
  proxyCores: () => invoke('proxy:cores'),
  onProxyState: (cb) => ipcRenderer.on('evt:proxy-state', (_e, p) => cb(p)),

  // события из основного процесса
  onState: (cb) => ipcRenderer.on('evt:state', (_e, p) => cb(p)),
  onBats: (cb) => ipcRenderer.on('evt:bats', (_e, p) => cb(p)),
  onUpdate: (cb) => ipcRenderer.on('evt:update', (_e, p) => cb(p)),
  onUpdateProgress: (cb) => ipcRenderer.on('evt:update-progress', (_e, p) => cb(p)),
  onToast: (cb) => ipcRenderer.on('evt:toast', (_e, p) => cb(p)),
  onTgState: (cb) => ipcRenderer.on('evt:tg-state', (_e, p) => cb(p)),
  onTgUpdate: (cb) => ipcRenderer.on('evt:tg-update', (_e, p) => cb(p)),
  onTgProgress: (cb) => ipcRenderer.on('evt:tg-progress', (_e, p) => cb(p)),
  onAppUpdate: (cb) => ipcRenderer.on('evt:app-update', (_e, p) => cb(p))
});
