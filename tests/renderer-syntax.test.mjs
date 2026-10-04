// Синтаксический контроль renderer/app.js: любая опечатка уровня парсера
// убивает весь UI молча, поэтому проверяем явно через node --check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('renderer/app.js парсится без синтаксических ошибок', () => {
  const src = path.join(root, 'src/renderer/app.js');
  const tmp = path.join(os.tmpdir(), `zl-app-${Date.now()}.mjs`);
  fs.copyFileSync(src, tmp);
  const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  fs.rmSync(tmp, { force: true });
  assert.equal(r.status, 0, `app.js не парсится:\n${r.stderr}`);
});

test('renderer/app.js не содержит повторных const-объявлений', () => {
  const text = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
  const names = [...text.matchAll(/^const\s+([A-Za-z0-9_$]+)\s*=/gm)].map((m) => m[1]);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(dup, [], `Дубли const: ${dup.join(', ')}`);
});
