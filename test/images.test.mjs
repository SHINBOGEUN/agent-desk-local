import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareImages, saveImages, imagePath, MAX_IMAGE_BYTES } from '../lib/images.mjs';

const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+b9d0AAAAASUVORK5CYII=';

test('pasted image is validated and saved as a local file without base64 in run metadata', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desk-image-'));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  const [image] = saveImages(directory, prepareImages([pixel]));
  assert.deepEqual(Object.keys(image).sort(), ['id','mimeType','size']);
  assert.equal(image.mimeType, 'image/png');
  assert.equal(fs.readFileSync(imagePath(directory, image)).length, image.size);
  assert.ok(imagePath(directory, image).startsWith(path.join(directory, 'attachments') + path.sep));
});

test('image validation rejects spoofed, oversized, and excessive attachments', () => {
  assert.throws(() => prepareImages([pixel,pixel,pixel,pixel]), /최대 3장/);
  assert.throws(() => prepareImages(['data:image/png;base64,' + Buffer.from('not a png').toString('base64')]), /내용과 파일 형식/);
  assert.throws(() => prepareImages(['data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64')]), /PNG, JPEG, WebP/);
  assert.throws(() => prepareImages(['data:image/png;base64,' + Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64')]), /5MB/);
  assert.throws(() => imagePath('C:\\data', { id:'../escape',mimeType:'image/png' }), /올바르지/);
});
