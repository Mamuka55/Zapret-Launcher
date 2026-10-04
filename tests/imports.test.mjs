// Тест связности модулей: каждый именованный импорт ./xxx.js
// должен существовать в экспортах целевого файла.
// Ловит рассинхроны вида "import { f } from './util.js'", когда f живёт в другом модуле.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = ['src/main', 'src/main/lib', 'src/preload', 'src/renderer'];

function exportsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/g)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    m[1].split(',').forEach((s) => {
      const v = s.trim().split(/\s+as\s+/).pop().trim();
      if (v) names.add(v);
    });
  }
  if (/export\s+default/.test(src)) names.add('default');
  return names;
}

function importsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const list = [];
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
    m[1].split(',').map((s) => s.trim()).filter(Boolean).forEach((name) => {
      list.push({ name: name.split(/\s+as\s+/)[0].trim(), from: m[2] });
    });
  }
  for (const m of src.matchAll(/import\s+\*\s+as\s+[A-Za-z0-9_$]+\s+from\s*['"](\.[^'"]+)['"]/g)) {
    list.push({ name: '*', from: m[1] });
  }
  return list;
}

test('все именованные импорты существуют в экспортах целевых модулей', () => {
  const problems = [];
  for (const dir of dirs) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (!/\.(js|mjs|cjs)$/.test(f)) continue;
      const file = path.join(abs, f);
      for (const imp of importsOf(file)) {
        if (imp.name === '*') continue;
        const target = path.resolve(path.dirname(file), imp.from);
        if (!fs.existsSync(target)) {
          problems.push(`${dir}/${f}: файл не найден ${imp.from}`);
          continue;
        }
        if (!exportsOf(target).has(imp.name)) {
          problems.push(`${dir}/${f}: нет экспорта '${imp.name}' в ${imp.from}`);
        }
      }
    }
  }
  assert.deepEqual(problems, [], `Найдены битые импорты:\n${problems.join('\n')}`);
});

test('каналы preload совпадают с обработчиками ipcMain', () => {
  const preload = fs.readFileSync(path.join(root, 'src/preload/preload.cjs'), 'utf8');
  const ipc = fs.readFileSync(path.join(root, 'src/main/ipc.js'), 'utf8');
  const invoked = [...preload.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]);
  const handled = new Set([
    ...ipc.matchAll(/ipcMain\.handle\('([^']+)'/g),
    ...ipc.matchAll(/ipcMain\.on\('([^']+)'/g)
  ].map((m) => m[1]));
  const missing = invoked.filter((ch) => !handled.has(ch));
  assert.deepEqual(missing, [], `Нет обработчиков для каналов: ${missing.join(', ')}`);

  const sent = [...preload.matchAll(/ipcRenderer\.on\('([^']+)'/g)].map((m) => m[1]);
  const emitted = new Set([...ipc.matchAll(/send\('([^']+)'/g)].map((m) => m[1]));
  const noSend = sent.filter((ch) => !emitted.has(ch));
  assert.deepEqual(noSend, [], `Main не шлёт события: ${noSend.join(', ')}`);
});
