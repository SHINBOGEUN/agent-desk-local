import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectLanguage, durationText, remainingText, translate } from '../src/i18n.ts';

test('language detection prefers the saved choice, then the browser', () => {
  assert.equal(detectLanguage('en', 'ko-KR'), 'en');
  assert.equal(detectLanguage(null, 'ko-KR'), 'ko');
  assert.equal(detectLanguage('fr', 'en-US'), 'en');
});

test('translations fill placeholders in both languages', () => {
  assert.equal(translate('en', 'runTitle', { id: 7 }), 'Run 7');
  assert.equal(translate('ko', 'runTitle', { id: 7 }), '실행 7');
  assert.equal(durationText('ko', 125000), '2 분 5 초');
  assert.equal(durationText('en', 4000), '4 s');
});

test('remaining time reads as days, hours and minutes', () => {
  assert.equal(remainingText('ko', 5076), '3일 12시간 36분');
  assert.equal(remainingText('ko', 293), '4시간 53분');
  assert.equal(remainingText('en', 1440), '1d');
  assert.equal(remainingText('en', 125), '2h 5m');
  assert.equal(remainingText('en', 0), '1m');
});
