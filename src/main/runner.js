import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { killTreeSync, isProcessRunning, hideStrayConsoles } from './util.js';

/** Подробный лог событий раннера (для диагностики «залипших» плиток) */
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log('[runner]', ...args);
  const file = process.env.ZL_LOG;
  if (file) {
    try { fs.appendFileSync(file, line + '\n'); } catch {}
  }
}

/** Точная командная строка cmd для BAT. Кавычки добавляются один раз. */
export function buildBatchCommandLine(batPath) {
  const safeBatPath = String(batPath).replaceAll('\"', '');
  return `call \"${safeBatPath}\"`;
}

/**
 * Менеджер процессов батников.
 *  - запуск полностью скрытый (windowsHide) — консольное окно не появляется (требование 4)
 *  - повторный вызов stop() убивает всё дерево процессов (cmd -> winws.exe) (требование 3)
 */
class Runner extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, {proc: import('node:child_process').ChildProcess, pid: number, startedAt: number}>} */
    this.running = new Map();
    /** имена батников, которые останавливают прямо сейчас (не «воскрешать» плитку) */
    this.stopping = new Set();
    // самоуточнение статусов каждые 2 сек: лечит «залипшую» зелёную плитку
    const t = setInterval(() => this.reconcile(), 2000);
    t.unref?.();
  }

  /** Сверка с реальностью: мертвые процессы и исчезнувший winws гасят плитку */
  async reconcile() {
    if (this.running.size === 0) return;
    let changed = false;
    let winwsUp = null;
    for (const [name, entry] of [...this.running]) {
      if (this.stopping.has(name)) continue;
      if (entry.external) {
        if (winwsUp === null) winwsUp = await isProcessRunning('winws.exe');
        if (!winwsUp) {
          log('reconcile: winws мёртв, гасим плитку', name);
          this.running.delete(name);
          changed = true;
        }
      } else if (entry.pid) {
        let alive = true;
        try { process.kill(entry.pid, 0); } catch { alive = false; }
        if (!alive) {
          log('reconcile: процесс мёртв, гасим плитку', name);
          this.running.delete(name);
          changed = true;
        }
      }
    }
    if (changed) this.emit('state');
  }

  isRunning(name) {
    return this.running.has(name);
  }

  list() {
    return [...this.running.keys()];
  }

  /** Запустить батник скрыто. Возвращает {ok} или {error} */
  start(batPath, name) {
    if (this.running.has(name)) return { ok: false, error: 'already-running' };
    let proc;
    try {
      // ВАЖНО для Windows: не даём Node автоматически экранировать кавычки.
      // Иначе cmd получает \"...\" и воспринимает путь как часть команды.
      // Для BAT с пробелами/скобками нужна точная строка:
      // call "C:\\path\\general (ALT11).bat"
      const command = buildBatchCommandLine(batPath);
      proc = spawn(process.env.ComSpec || 'cmd.exe', [
        '/d', '/c', command
      ], {
        cwd: path.dirname(batPath),
        windowsHide: true,
        windowsVerbatimArguments: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env
      });
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
    if (proc.pid == null) {
      return { ok: false, error: 'failed-to-spawn' };
    }
    // захватываем вывод батника, чтобы объяснять быстрые завершения
    const chunks = [];
    let total = 0;
    const cap = (chunk) => {
      if (total < 8192) { chunks.push(chunk); total += chunk.length; }
    };
    proc.stdout?.on('data', cap);
    proc.stderr?.on('data', cap);
    const decodedOutput = () => {
      const buf = Buffer.concat(chunks);
      const utf8 = buf.toString('utf8');
      // батники пишут в OEM-кодировке (cp866) — если utf8 дал кракозябры, декодируем cp866
      return utf8.includes('\uFFFD') ? new TextDecoder('cp866').decode(buf) : utf8;
    };
    // закрываем stdin: если в батнике есть pause, он не повиснет невидимо
    try { proc.stdin?.end(); } catch {}

    const startedAt = Date.now();
    this.running.set(name, { proc, pid: proc.pid, startedAt });
    log('start:', name, 'pid', proc.pid);
    // прячем консольные окна, которые батник/winws могут создать сами (start, AllocConsole)
    for (const ms of [150, 700, 1600, 3000]) {
      setTimeout(() => hideStrayConsoles(), ms).unref?.();
    }
    proc.on('exit', (code) => {
      this.running.delete(name);
      log('exit:', name, 'code', code, 'duration', Date.now() - startedAt);
      // батник остановили мы сами — не восстанавливаем статус и не жалуемся
      if (this.stopping.has(name)) {
        this.stopping.delete(name);
        this.emit('state');
        return;
      }
      const duration = Date.now() - startedAt;
      if (duration < 2500) {
        // Многие BAT запускают winws.exe через `start`/PowerShell и завершаются
        // раньше, чем дочерний процесс реально появляется. Поэтому не проверяем
        // winws только один раз сразу после выхода BAT: даём ему несколько секунд.
        const adoptExternalWinws = async () => {
          const checks = [150, 300, 600, 1000, 1600, 2500, 4000, 5500];
          for (const wait of checks) {
            await new Promise((resolve) => setTimeout(resolve, wait));
            if (this.stopping.has(name)) return false;
            try {
              if (await isProcessRunning('winws.exe')) {
                log('external: winws жив после ожидания', name);
                this.running.set(name, {
                  external: true,
                  pid: null,
                  startedAt: Date.now()
                });
                this.emit('state');
                return true;
              }
            } catch {}
          }
          return false;
        };
        adoptExternalWinws().then((adopted) => {
          if (!adopted) {
            this.emit('state');
            this.emit('quick-exit', { name, code, duration, output: decodedOutput().trim() });
          }
        }).catch(() => {
          this.emit('state');
          this.emit('quick-exit', { name, code, duration, output: decodedOutput().trim() });
        });
        return;
      }
      this.emit('state');
    });
    proc.on('error', () => {
      this.running.delete(name);
      this.emit('state');
    });
    this.emit('state');
    return { ok: true, pid: proc.pid };
  }

  /** Остановить батник (убить дерево процессов и winws.exe гарантированно) */
  stop(name) {
    const entry = this.running.get(name);
    if (!entry) return { ok: false, error: 'not-running' };
    this.stopping.add(name);
    this.running.delete(name);
    log('stop:', name, entry.external ? '(external)' : `(pid ${entry.pid})`);
    if (!entry.external) {
      killTreeSync(entry.pid);
      try { entry.proc.kill('SIGKILL'); } catch {}
    } else {
      // Для external-запуска нет ChildProcess `exit`, который очистил бы
      // stopping. Не оставляем имя в stopping, иначе следующий запуск
      // этого же BAT будет ошибочно заблокирован adoptExternalWinws().
      this.stopping.delete(name);
    }
    // winws мог быть запущен откреплённо (WMI/Start-Process) — убиваем всегда
    killWinws();
    setTimeout(() => {
      // контрольный выстрел: если winws ожил/не убился с первого раза
      isProcessRunning('winws.exe').then((up) => { if (up) killWinws(); }).catch(() => {});
    }, 600).unref?.();
    this.emit('state');
    return { ok: true };
  }

  /** Переключить: запущен -> остановить, иначе -> запустить */
  toggle(batPath, name) {
    return this.isRunning(name) ? this.stop(name) : this.start(batPath, name);
  }

  /** Остановить всё (при выходе из приложения) */
  stopAll() {
    for (const name of [...this.running.keys()]) this.stop(name);
  }

  /** Синхронная остановка всего (для before-quit) */
  stopAllSync() {
    for (const [name, entry] of this.running) {
      this.stopping.add(name);
      if (entry.external) killWinws();
      else killTreeSync(entry.pid);
      this.running.delete(name);
    }
    if (this.stopping.size) killWinws();
  }
}

function killWinws() {
  try { spawnSync('taskkill', ['/IM', 'winws.exe', '/F'], { windowsHide: true, timeout: 8000 }); } catch {}
}

export const runner = new Runner();
