import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export function prepareImages(images = []) {
  if (!Array.isArray(images) || images.length > MAX_IMAGES) throw new Error(`이미지는 최대 ${MAX_IMAGES}장까지 첨부할 수 있습니다.`);
  return images.map(dataUrl => {
    if (typeof dataUrl !== 'string') throw new Error('이미지 형식이 올바르지 않습니다.');
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
    if (!match || match[2].length % 4 !== 0) throw new Error('PNG, JPEG, WebP 이미지만 첨부할 수 있습니다.');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('이미지 한 장은 5MB 이하여야 합니다.');
    const mimeType = match[1];
    const valid = mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mimeType === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!valid) throw new Error('이미지 내용과 파일 형식이 일치하지 않습니다.');
    return { mimeType, bytes };
  });
}

export function imagePath(directory, image) {
  if (!/^[0-9a-f-]{36}$/.test(image?.id || '') || !extensions[image?.mimeType]) throw new Error('첨부 이미지 정보가 올바르지 않습니다.');
  return path.join(directory, 'attachments', `${image.id}.${extensions[image.mimeType]}`);
}

export function saveImages(directory, prepared) {
  if (!prepared.length) return [];
  const attachments = path.join(directory, 'attachments');
  fs.mkdirSync(attachments, { recursive: true });
  const saved = [];
  try {
    for (const image of prepared) {
      const metadata = { id: randomUUID(), mimeType: image.mimeType, size: image.bytes.length };
      fs.writeFileSync(imagePath(directory, metadata), image.bytes, { flag: 'wx' });
      saved.push(metadata);
    }
    return saved;
  } catch (error) {
    for (const image of saved) fs.rmSync(imagePath(directory, image), { force: true });
    throw error;
  }
}
