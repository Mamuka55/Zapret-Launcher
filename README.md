# Zapret Launcher

## 1.4.3

Исправлен VPN: добавлен Windows curl/HTTP2 fallback для подписок с HTTP 502/503/504, расширен разбор нативного Xray JSON, включая `outbounds → settings → vnext/servers`, VPN переведён в TG-style категорию. Добавление подписки выполняется только по Enter; отдельной кнопки «Добавить подписку» и глобальной кнопки подключения больше нет. Подключение и отключение выполняется повторным нажатием на плитку сервера. Плитки используют общий стиль Zapret и показывают название, ping и протоколы. Глобальное автоподключение отключено.

## 1.4.2

Исправлен Proxy / VPN Center: подписки с HTTPS теперь автоматически получают несколько вариантов User-Agent, поддерживаются JSON/обёртки/вложенные конфигурации, base64 и gzip/deflate/brotli, служебные VLESS-записи `0.0.0.0:1` отбрасываются. На главном экране VPN оставлена только строка добавления подписки; обновление и ping — компактные иконки, серверы отображаются в стеклянных плитках в стиле Zapret. Все остальные параметры VPN, импорт и управление подписками находятся в отдельной вкладке **VPN** настроек.


Стеклянный (red/gray glassmorphism) лаунчер батников проекта **zapret-discord-youtube**:
плитки стратегий с включением/выключением в один клик, избранное, единые настройки,
встроенный Proxy/VPN Center для Xray/sing-box, подписок, TUN и маршрутизации,
`service.bat` в едином окне и автообновление с GitHub. Electron + Vanilla JS,
без тяжёлых зависимостей.

![Стеклянные плитки](build/icon.png)

---

## Возможности

| Требование | Реализация |
|---|---|
| Плитки с названием стратегии | Автопоиск `*.bat` в папке zapret, номер в имени не показывается, сортировка «как человек» (`1, 2, 10`) |
| Вкл/выкл в один клик | Клик по плитке запускает батник скрыто (`windowsHide`) или завершает его дерево процессов (`taskkill /T /F`) |
| Статус запущен/остановлен | Зелёная подсветка плитки и пульсирующий индикатор, событие из main-процесса |
| Избранное | Звёздочка на плитке, отдельная секция, хранится в конфиге |
| Единое окно настроек | Шестерёнка в заголовке: папка, обновления, сервис, Game/IPSet-фильтры, фэйки, hosts, диагностика, тесты |
| Автообновление | Сравнение `LOCAL_VERSION` из `service.bat` с релизом GitHub, скачивание zip с прогрессом, замена файлов; новые/удалённые батники сами появляются/исчезают с плиток |
| Права администратора | UAC запрашивается **один раз** при старте собранного exe (`requestedExecutionLevel: requireAdministrator`) |
| Тесты | `npm test` = юнит-тесты логики (`node --test`) + smoke-тест UI (запуск окна, проверка плиток и элементов) |
| Proxy/VPN | Встроенный центр подключений: VLESS, VLESS Reality, VMess, Trojan, Shadowsocks, SOCKS5; Hysteria2 и WireGuard через sing-box |
| Подписки | Добавление по URL, автоматическое обновление, удаление серверов подписки вместе с подпиской |
| Импорт | URI ключей, Xray JSON, sing-box JSON, WireGuard `.conf`, `incy://routing/...` и `happ://routing/...` для открытых routing-профилей |
| Режимы | Системный HTTP/SOCKS-прокси и TUN через Xray/Wintun либо sing-box |
| Маршрутизация | Профили proxy/direct/block, DNS-параметры и MTU |
| Диагностика proxy | Проверка TCP latency для всех серверов и выбор активного сервера |
| Трей | Фоновый запуск с быстрыми командами подключения/отключения прокси |
| Сборка | `npm run dist` → portable + setup exe через electron-builder |

Дополнительно: демо-режим с тестовыми плитками, тосты, онбординг при первом запуске,
баннер «нет прав администратора», баннер обновления с прогресс-баром.

---

## Запуск в режиме разработки

```bash
npm install        # поставит electron и electron-builder
npm start          # открыть окно лаунчера
npm test           # юнит-тесты логики + smoke-тест UI
npm run dist       # собрать portable/setup .exe (Windows)
```

Smoke-тест открывает реальное окно Electron в headless-режиме (`--smoke`),
проверяет структуру окна, плитки и звёздочки избранного; в CI работает под `xvfb-run`.

При первом запуске появится онбординг: выбрать папку zapret, скачать релиз с GitHub
или включить демо-режим (тестовые плитки из `demo-bats/`).

---

## Структура

```
src/
  main/            # основной процесс Electron
    main.js        # окно без рамки (frame:false, transparent), smoke-режим
    ipc.js         # каналы preload <-> main
    config.js      # конфиг (папка, избранное, флаги) в userData
    scanner.js     # поиск *.bat, fs.watch за папкой
    runner.js      # скрытый запуск/остановка батников, дерево процессов
    updater.js     # GitHub releases: проверка, скачивание zip/EXE, установка
    service.js     # сервис, фильтры, фэйки, hosts, install/uninstall
    tgProxy.js     # загрузка/обновление и управление tg-ws-proxy
    diagnostics.js # 20+ проверок системы из service.bat
    lib/pure.js    # чистая логика (версии, порты, парсинг) — покрыта юнит-тестами
  preload/         # contextBridge (contextIsolation: true)
  renderer/        # интерфейс: index.html, styles.css (glassmorphism), app.js
tests/             # unit + renderer/settings checks, smoke.test.mjs
demo-bats/         # тестовые плитки для демо-режима и smoke-теста
.github/workflows/ci.yml  # CI: юниты, smoke под xvfb, сборка exe
```

## Конфиг

Хранится в `userData/settings.json` ( `%AppData%/zapret-launcher` ):
папка zapret, репозиторий GitHub, избранное, флаги `closeScriptsOnExit`,
`autoCheckUpdates` (синхронизируется с `utils/check_updates.enabled`), автозапуск.

## Примечания

- Сборка exe требует Windows (electron-builder); в CI артефакты собираются на `windows-latest`.
- Без прав администратора лаунчер работает, но показывает предупреждение: установка
  сервиса/WinDivert и правка hosts будут недоступны.
- Диапазоны портов Game Filter валидируются как в `service.bat`
  (`1024-65535`, списки через запятую, иначе — откат к значениям по умолчанию).


## Версия 1.3.4
- отдельная категория `tg-ws-proxy` с загрузкой, запуском/остановкой, настройками и обновлением;
- избранные батники больше не дублируются в общем списке;
- отдельная проверка и установка обновления самого Zapret Launcher из GitHub Releases;
- гибкая палитра акцентного и фонового цвета через системный color picker;
- GitHub Actions workflow публикует EXE в Releases при push тега `v*`.

Для обновления самого приложения репозиторий должен иметь GitHub Release с ассетами `ZapretLauncher-<version>-setup.exe` и/или `ZapretLauncher-<version>-portable.exe`.


### Первый релиз для автообновления
После добавления этого проекта в GitHub достаточно создать тег вида `v1.3.4` и отправить его:

```bash
git tag v1.3.4
git push origin v1.3.4
```

Workflow `.github/workflows/release.yml` на Windows сначала синхронизирует версию `package.json` с тегом, затем соберёт `setup.exe` и `portable.exe` и опубликует их в Releases. Лаунчер затем сможет видеть новый релиз через GitHub API.


### Каталоги компонентов

Автоматическая установка размещает Zapret в `Documents\Zapret Launcher\zapret`, а TG Proxy — в `Documents\Zapret Launcher\tg-ws-proxy`. Плитка TG Proxy показывается только после успешной установки.


## Proxy Center 1.4.0

Proxy Center хранит данные в `%AppData%/zapret-launcher/proxy`: серверы, подписки, routing-профили и настройки не смешиваются с файлами zapret.

### Поддерживаемые открытые форматы

- `vless://`, в том числе Reality
- `vmess://`
- `trojan://`
- `ss://`
- `socks5://` / `socks://`
- `hysteria2://` / `hy2://`
- WireGuard `.conf`
- Xray/sing-box JSON
- открытые `incy://routing/...` и `happ://routing/...` профили маршрутизации

Зашифрованные фирменные ссылки HAPP/INCY с закрытой схемой шифрования намеренно не реализованы.

### Ядра

Xray-core и sing-box не вшиваются в репозиторий и скачиваются по требованию из их официальных GitHub Releases. Для Xray Windows-архив содержит Wintun, необходимый для TUN на Windows.

### Ограничения 1.4.0

Полноценный per-app proxy и безопасный системный kill switch требуют отдельной реализации на уровне Windows Filtering Platform; в этой версии они не включены, чтобы не менять глобальную политику брандмауэра или сетевые интерфейсы пользователя неожиданным образом.
