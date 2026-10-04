import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBatchCommandLine } from '../src/main/runner.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

test('Windows BAT command quotes paths with spaces/parentheses exactly once', () => {
  const p = String.raw`C:\Users\zendr\Documents\zapret\general (ALT11).bat`;
  assert.equal(buildBatchCommandLine(p), String.raw`call "C:\Users\zendr\Documents\zapret\general (ALT11).bat"`);
});

test('runner uses Windows verbatim arguments for cmd quoting', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(root, '../src/main/runner.js'), 'utf8');
  assert.match(src, /windowsVerbatimArguments:\s*true/);
  assert.doesNotMatch(src, /'\/s',\s*'\/c'/);
});

test('updater no longer calls Chromium/Electron fetch()', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(root, '../src/main/updater.js'), 'utf8');
  assert.doesNotMatch(src, /\bfetch\s*\(/);
  assert.match(src, /node:https/);
  assert.match(src, /curl\.exe/);
});


test('app self-update treats same version as a normal no-op', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const ipc = readFileSync(path.join(root, '../src/main/ipc.js'), 'utf8');
  assert.match(ipc, /alreadyLatest:\s*true/);
  assert.match(ipc, /updated:\s*false/);
});

test('release workflow syncs package version with tag before building EXE', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const wf = readFileSync(path.join(root, '../.github/workflows/release.yml'), 'utf8');
  assert.match(wf, /TrimStart\('v'\)/);
  assert.match(wf, /npm version \$version --no-git-tag-version/);
  assert.match(wf, /npm run dist/);
});


test('self-update accepts variant EXE asset names and single-EXE releases', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(root, '../src/main/updater.js'), 'utf8');
  assert.match(src, /exeAssets = assets\.filter/);
  assert.match(src, /portable/i);
  assert.match(src, /exeAssets\.length === 1/);
  assert.match(src, /isInstaller/);
});

test('self-update error includes release asset names for diagnosis', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const ipc = readFileSync(path.join(root, '../src/main/ipc.js'), 'utf8');
  assert.match(ipc, /Найдены:/);
  assert.match(ipc, /GitHub не вернул ассеты/);
});


test('self-update has setup fallback for nonstandard launcher EXE names', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(root, '../src/main/updater.js'), 'utf8');
  assert.match(src, /setupLike/);
  assert.match(src, /isOtherComponent/);
  assert.match(src, /wantedVersion/);
});
