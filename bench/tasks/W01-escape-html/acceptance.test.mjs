import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderNotes } from '../src/render.mjs';

const note = title => ({ id: 1, title, createdAt: 1, pinned: false });

test('script tags are neutralized', () => {
  const html = renderNotes([note('<script>alert(1)</script>')]);
  assert.ok(!html.includes('<script'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('all five special characters are escaped', () => {
  const html = renderNotes([note(`a & b < c > d " e ' f`)]);
  assert.ok(html.includes('a &amp; b &lt; c &gt; d &quot; e &#39; f'));
});

test('plain titles are unchanged', () => {
  assert.ok(renderNotes([note('hello')]).includes('>hello</li>'));
});

test('ampersand is not double escaped', () => {
  assert.ok(renderNotes([note('<')]).includes('&lt;'));
  assert.ok(!renderNotes([note('<')]).includes('&amp;lt;'));
});
