import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectLanguage, durationText, translate } from '../src/i18n.ts';

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
