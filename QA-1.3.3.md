# QA 1.3.3

## Automated checks

- JavaScript syntax checks: PASS
- Node test suite: 32/32 PASS
- Settings IDs and tabs: PASS
- TG Proxy missing-install onboarding: PASS
- Zapret default path: `Documents\\Zapret Launcher\\zapret`
- TG Proxy default path: `Documents\\Zapret Launcher\\tg-ws-proxy`
- TG Proxy tray suppression code: PASS (Windows implementation statically verified)
- Hosts transport: Node HTTPS + Windows curl fallback; Chromium/Electron `fetch()` is not used for hosts
- All update actions are located in the `Обновления` settings tab, including IPSet

## Runtime note

A full Electron UI smoke test requires the project's `node_modules` and a Windows runtime for tray/API validation; the source archive does not include `node_modules`, so those checks are limited to static and unit coverage in this environment.
