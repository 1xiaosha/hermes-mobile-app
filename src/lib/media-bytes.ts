import type { MediaKind } from './message-media';

export const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
export interface MediaBytes { bytes: Uint8Array; mime: string; kind: MediaKind; extension: string }

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}
function starts(bytes: Uint8Array, expected: number[]): boolean {
  return expected.every((byte, index) => bytes[index] === byte);
}

/** MIME alone is not proof: reject HTML/login pages and active SVG. Decoders in
 * expo-image/expo-audio still decide whether a structurally valid file can play. */
export function validateMediaBytes(bytes: Uint8Array, mimeHeader: string, expected: MediaKind): MediaBytes {
  if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) throw new Error('媒体为空或超过 16 MB，请重新生成较小的文件。');
  const mime = mimeHeader.split(';')[0].trim().toLowerCase();
  let found: { kind: MediaKind; extension: string; mimes: string[] } | null = null;
  if (bytes.length >= 33 && starts(bytes, [137, 80, 78, 71, 13, 10, 26, 10]) && ascii(bytes, 12, 4) === 'IHDR')
    found = { kind: 'image', extension: 'png', mimes: ['image/png'] };
  else if (bytes.length > 4 && starts(bytes, [255, 216, 255]) && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217)
    found = { kind: 'image', extension: 'jpg', mimes: ['image/jpeg', 'image/jpg'] };
  else if (bytes.length >= 13 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6)))
    found = { kind: 'image', extension: 'gif', mimes: ['image/gif'] };
  else if (bytes.length >= 20 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP')
    found = { kind: 'image', extension: 'webp', mimes: ['image/webp'] };
  else if (bytes.length >= 54 && ascii(bytes, 0, 2) === 'BM')
    found = { kind: 'image', extension: 'bmp', mimes: ['image/bmp', 'image/x-ms-bmp'] };
  else if (bytes.length >= 44 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE')
    found = { kind: 'audio', extension: 'wav', mimes: ['audio/wav', 'audio/x-wav', 'audio/wave'] };
  else if (bytes.length >= 16 && ascii(bytes, 4, 4) === 'ftyp' && /^(M4A |M4B |isom|mp42|mp41)$/.test(ascii(bytes, 8, 4)))
    found = { kind: 'audio', extension: 'm4a', mimes: ['audio/mp4', 'audio/x-m4a'] };
  else if (bytes.length > 10 && (ascii(bytes, 0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1] & 224) === 224)))
    found = { kind: 'audio', extension: 'mp3', mimes: ['audio/mpeg', 'audio/mp3'] };
  if (!found || found.kind !== expected || !found.mimes.includes(mime)) {
    throw new Error('媒体类型或内容无效，请重试或重新生成文件。');
  }
  return { bytes, mime, kind: found.kind, extension: found.extension };
}
