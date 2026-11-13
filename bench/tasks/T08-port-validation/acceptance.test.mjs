import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './harness.mjs';

test('PORT is validated', async () => {
  const { loadConfig } = await load('src/config.mjs');
  assert.equal(loadConfig({}).port, 3100);
  assert.equal(loadConfig({ PORT: '4000' }).port, 4000);
  assert.equal(loadConfig({ PORT: '1024' }).port, 1024);
  assert.equal(loadConfig({ PORT: '65535' }).port, 65535);
  for (const PORT of ['80', '1023', '65536', '70000', 'abc', '3000.5', '-1']) {
    assert.throws(() => loadConfig({ PORT }), undefined, `PORT=${PORT}`);
  }
  assert.equal(loadConfig({}).dataFile, 'data/todos.json');
});
