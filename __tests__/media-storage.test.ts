import { createMediaStorage } from '../src/lib/media-storage';

jest.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///phone-cache' },
  Directory: class {
    constructor(..._parts: unknown[]) {}
    create() { throw new Error('Native directory failure with a private path'); }
  },
  File: class {},
}));

test('native cache initialization failures become Chinese errors without exposing native details', async () => {
  const storage = createMediaStorage();
  await expect(storage.save({ bytes: new Uint8Array([1]), mime: 'image/png', kind: 'image', extension: 'png' }))
    .rejects.toThrow('媒体缓存写入失败，请重试。');
});
