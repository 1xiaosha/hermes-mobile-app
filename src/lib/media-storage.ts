import { Directory, File, Paths } from 'expo-file-system';
import type { MediaStorage } from './media-session';

let cleanedStartupCache = false;
let serial = 0;
/** Only this feature's cache tree is removed; uploads and journals are untouched. */
export function createMediaStorage(): MediaStorage {
  const root = new Directory(Paths.cache, 'hermes-message-media');
  const directory = new Directory(root, `${Date.now()}-${serial++}`);
  function prepare() {
    root.create({ intermediates: true, idempotent: true });
    if (!cleanedStartupCache) {
      for (const entry of root.list()) entry.delete();
      cleanedStartupCache = true;
    }
    directory.create({ intermediates: true, idempotent: true });
  }
  return {
    async save(media) {
      let file: File | undefined;
      try {
        prepare();
        file = new File(directory, `${serial++}.${media.extension}`);
        file.create();
        file.write(media.bytes);
        if (file.size !== media.bytes.byteLength) throw new Error('媒体缓存写入失败，请重试。');
        const saved = file;
        return { uri: saved.uri, remove() { try { if (saved.exists) saved.delete(); } catch { /* OS may evict cache concurrently */ } } };
      } catch {
        try { if (file?.exists) file.delete(); } catch { /* startup cleanup retries orphaned cache */ }
        throw new Error('媒体缓存写入失败，请重试。');
      }
    },
    clear() { try { if (directory.exists) directory.delete(); } catch { /* startup cleanup retries orphaned cache */ } },
  };
}
