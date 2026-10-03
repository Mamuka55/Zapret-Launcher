import fs from 'node:fs';
import path from 'node:path';
import { naturalCompare, cleanLabel, isServiceBat } from './lib/pure.js';

/**
 * Сканирует папку и возвращает список батников для плиток.
 * Исключает service*.bat (его функции перенесены в настройки приложения).
 * Сортировка «естественная» — как в оригинальном service.bat.
 */
export function listBats(dir) {
  if (!dir) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const bats = entries
    .filter((e) => e.isFile() && /\.(bat|cmd)$/i.test(e.name) && !isServiceBat(e.name))
    .map((e) => e.name)
    .sort(naturalCompare)
    .map((name) => ({
      name,
      label: cleanLabel(name),
      path: path.join(dir, name)
    }));
  return bats;
}

/** Имя service.bat в папке (может быть service.bat / service_gui.bat и т.п.) */
export function findServiceBat(dir) {
  if (!dir) return null;
  try {
    const f = fs
      .readdirSync(dir)
      .filter((n) => /^service.*\.(bat|cmd)$/i.test(n))
      .sort(naturalCompare)[0];
    return f ? path.join(dir, f) : null;
  } catch {
    return null;
  }
}

/**
 * Наблюдение за папкой: если батник добавили/удалили — вызываем onChange.
 * (Требование 7: плитки добавляются и убираются автоматически)
 */
export function watchBatsDir(dir, onChange) {
  if (!dir || !fs.existsSync(dir)) return null;
  let timer = null;
  let watcher = null;
  try {
    watcher = fs.watch(dir, { persistent: false }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try { onChange(listBats(dir)); } catch {}
      }, 500);
    });
  } catch (err) {
    console.error('watchBatsDir:', err);
  }
  return watcher;
}
