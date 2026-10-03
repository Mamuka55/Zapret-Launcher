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
