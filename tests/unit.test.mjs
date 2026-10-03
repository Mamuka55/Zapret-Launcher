// Юнит-тесты чистой логики (node --test)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  naturalCompare, compareVersions, isNewer, cleanLabel, parseLocalVersion,
  validatePortRange, parseGameFilterText, ipsetStatusFromContent,
  hostsNeedsUpdate, isServiceBat, guessAssetUrl
} from '../src/main/lib/pure.js';

test('naturalCompare сортирует номера как человек', () => {
  const arr = ['10. YouTube.bat', '2. Discord.bat', '1. Discord & YouTube.bat'];
  assert.deepEqual([...arr].sort(naturalCompare), [
    '1. Discord & YouTube.bat', '2. Discord.bat', '10. YouTube.bat'
  ]);
});

test('compareVersions / isNewer', () => {
  assert.equal(compareVersions('1.10.3', '1.9.9'), 1);
  assert.equal(compareVersions('1.2.0', '1.2'), 0);
  assert.equal(compareVersions('v1.2.0', '1.3.0'), -1);
  assert.equal(isNewer('1.11.0', '1.10.3'), true);
  assert.equal(isNewer('1.10.3', '1.10.3'), false);
  assert.equal(isNewer('1.10.3', null), true);
});

test('cleanLabel убирает номер и расширение', () => {
  assert.equal(cleanLabel('1. Discord & YouTube.bat'), 'Discord & YouTube');
  assert.equal(cleanLabel('10) YouTube (alt).cmd'), 'YouTube (alt)');
  assert.equal(cleanLabel('run.bat'), 'run');
});

test('parseLocalVersion читает LOCAL_VERSION из service.bat', () => {
  const text = '@echo off\r\nset "LOCAL_VERSION=1.10.3"\r\n';
  assert.equal(parseLocalVersion(text), '1.10.3');
  assert.equal(parseLocalVersion('нет версии'), null);
});

test('validatePortRange как в service.bat', () => {
  assert.equal(validatePortRange('1024-65535'), '1024-65535');
  assert.equal(validatePortRange('1024-1934,1936-65535'), '1024-1934,1936-65535');
  assert.equal(validatePortRange('443'), '443');
  assert.equal(validatePortRange('0-80'), null);
  assert.equal(validatePortRange('70000'), null);
  assert.equal(validatePortRange('2000-1000'), null);
  assert.equal(validatePortRange('abc'), null);
  assert.equal(validatePortRange(''), null);
});

test('parseGameFilterText разбирает utils/game_filter.enabled', () => {
  const t1 = 'mode=all\ntcp=1024-65535\nudp=1024-65535\n';
  assert.equal(parseGameFilterText(t1).mode, 'all');
  const t2 = 'mode=udp\ntcp=12\nudp=1024-2000\n';
  const r2 = parseGameFilterText(t2);
  assert.equal(r2.mode, 'udp');
  assert.equal(r2.udp, '1024-2000');
  const r3 = parseGameFilterText(null);
  assert.equal(r3.mode, 'disabled');
  assert.equal(r3.enabled, false);
});

test('ipsetStatusFromContent: any / none / loaded', () => {
  assert.equal(ipsetStatusFromContent(null), 'any');
  assert.equal(ipsetStatusFromContent(''), 'any');
  assert.equal(ipsetStatusFromContent('203.0.113.113/32\n'), 'none');
  assert.equal(ipsetStatusFromContent('1.2.3.4/32\n5.6.7.8/32\n'), 'loaded');
});

test('hostsNeedsUpdate сравнивает первую и последнюю строки', () => {
  const remote = '# zapret hosts v1\nexample.com\n# end marker';
  assert.equal(hostsNeedsUpdate('# zapret hosts v1\nx\n# end marker', remote), false);
  assert.equal(hostsNeedsUpdate('старый файл', remote), true);
  assert.equal(hostsNeedsUpdate(null, remote), true);
});

test('isServiceBat исключает служебные файлы из плиток', () => {
  assert.equal(isServiceBat('service.bat'), true);
  assert.equal(isServiceBat('Service_gui.cmd'), true);
  assert.equal(isServiceBat('1. Discord.bat'), false);
});

test('guessAssetUrl собирает fallback-ссылку на zip', () => {
  assert.equal(
    guessAssetUrl('Flowseal/zapret-discord-youtube', '1.10.4'),
    'https://github.com/Flowseal/zapret-discord-youtube/releases/download/1.10.4/zapret-discord-youtube-1.10.4.zip'
  );
});
