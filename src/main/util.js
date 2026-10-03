import { spawn, spawnSync } from 'node:child_process';

export const isWindows = process.platform === 'win32';

/**
 * Запуск команды с захватом вывода (окно консоли скрыто).
 * @returns {Promise<{code:number, stdout:string, stderr:string, out:string}>}
 */
export function sh(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, {
        windowsHide: true,
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        shell: false
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err?.message ?? err), out: String(err?.message ?? err) });
      return;
    }
    const timer = opts.timeout ? setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, opts.timeout) : null;
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err?.message ?? err), out: stdout + stderr });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, out: stdout + stderr });
    });
  });
}

/** cmd-обёртка: sh('cmd', ['/d','/s','/c', 'net stop zapret']) */
export function shCmd(commandLine, opts = {}) {
  return sh('cmd.exe', ['/d', '/s', '/c', commandLine], opts);
}

/** Запуск отдельного «видимого» процесса (например, окно PowerShell для тестов) */
export function spawnVisible(cmd, args = [], opts = {}) {
  try {
    const child = spawn(cmd, args, {
      windowsHide: false,
      detached: true,
      stdio: 'ignore',
      cwd: opts.cwd,
      env: opts.env ?? process.env
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Синхронное убийство дерева процессов (используется при выходе из приложения) */
export function killTreeSync(pid) {
  if (!pid || !isWindows) return;
  try {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 });
  } catch {}
}

/** Права администратора у текущего процесса? */
export async function isAdmin() {
  if (!isWindows) return false;
  const r = await sh('net', ['session'], { timeout: 8000 });
  return r.code === 0;
}

/** Вывод `sc query <name>` -> состояние сервиса или null */
export async function serviceState(name) {
  if (!isWindows) return null;
  const r = await sh('sc', ['query', name], { timeout: 8000 });
  if (r.code !== 0) return null;
  const m = /STATE\s*:\s*\d+\s+(\w+)/i.exec(r.out);
  return m ? m[1].toUpperCase() : 'UNKNOWN';
}

/** Процесс запущен? (по имени образа) */
export async function isProcessRunning(imageName) {
  if (!isWindows) return false;
  const r = await sh('tasklist', ['/FI', `IMAGENAME eq ${imageName}`], { timeout: 8000 });
  return r.out.toLowerCase().includes(imageName.toLowerCase());
}

/** Значение реестра HKLM...Services\zapret -> zapret-discord-youtube (имя стратегии) */
export async function readStrategyFromRegistry() {
  if (!isWindows) return null;
  const r = await sh('reg', [
    'query', 'HKLM\\System\\CurrentControlSet\\Services\\zapret', '/v', 'zapret-discord-youtube'
  ], { timeout: 8000 });
  const m = /zapret-discord-youtube\s+REG_SZ\s+(.+)\r?$/im.exec(r.out);
  return m ? m[1].trim() : null;
}

/** Полный список запущенных сервисов (для поиска конфликтов, как `sc query | findstr`) */
export async function listRunningServicesText() {
  if (!isWindows) return '';
  const r = await sh('sc', ['query'], { timeout: 15000 });
  return r.out;
}

/**
 * Спрятать консольные окна, которые батник или winws могли создать сами
 * (команда start, AllocConsole и т.п.): батники не должны быть видны (требование 4/5).
 */
export function hideStrayConsoles() {
  if (!isWindows) return;
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinHide { [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); }
"@
$cutoff = (Get-Date).AddSeconds(-10)
foreach ($p in Get-Process winws,cmd,conhost,powershell -ErrorAction SilentlyContinue) {
  try {
    if ($p.MainWindowHandle -eq 0) { continue }
    if ($p.StartTime -lt $cutoff) { continue }
    $t = $p.MainWindowTitle
    if ($p.Name -eq 'winws' -or $t -match '\.bat|winws|zapret|windivert|cmd\.exe|powershell') {
      [WinHide]::ShowWindowAsync($p.MainWindowHandle, 0) | Out-Null
    }
  } catch {}
}`;
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], {
      windowsHide: true, stdio: 'ignore'
    });
    child.unref();
  } catch {}
}
