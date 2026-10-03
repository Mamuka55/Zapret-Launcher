// Smoke-тест UI: запускаем приложение в smoke-режиме и проверяем,
// что окно открылось, есть плитки, избранное и кнопки управления.
// Требует установленного electron (npm install) и дисплея (в CI — xvfb-run).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let bin = null;
try {
  const p = require('electron'); // вне рантайма electron модуль возвращает путь к бинарнику
  if (typeof p === 'string' && fs.existsSync(p)) bin = p;
} catch { /* electron не установлен */ }

test('smoke: окно открывается, плитки и элементы управления на месте', {
  skip: bin ? false : 'electron не установлен (выполните npm install)',
  timeout: 90000
}, () => {
  const res = spawnSync(bin, [root, '--smoke', '--no-sandbox'], {
    encoding: 'utf8',
    timeout: 80000,
    env: { ...process.env, ELECTRON_DISABLE_GPU: '1' }
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  console.log(out);
  assert.equal(res.status, 0, `smoke-проверка завершилась с кодом ${res.status}`);
  assert.match(out, /\[smoke\]/);
  assert.match(out, /"window":true/);
  assert.match(out, /"tiles":([3-9]|\d\d)/);
});
