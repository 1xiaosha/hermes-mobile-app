import { MAX_MEDIA_BYTES, type MediaBytes } from './media-bytes';
import type { MessageMedia } from './message-media';

export interface CachedMedia { uri: string; remove(): void }
export interface MediaStorage {
  save(bytes: MediaBytes): Promise<CachedMedia>;
  clear(): void;
}
type Entry = {
  controller: AbortController;
  refs: number;
  size: number;
  file?: CachedMedia;
  promise: Promise<CachedMedia>;
};
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 8;

/** One immutable gateway/profile/stored-session owner. A cache key includes the
 * message, so identical paths from two replies cannot borrow each other's bytes. */
export class MediaSession {
  private entries = new Map<string, Entry>();
  private running = 0;
  private waiting = new Set<() => void>();
  constructor(
    private readonly download: (media: MessageMedia, signal: AbortSignal) => Promise<MediaBytes>,
    private readonly storage: MediaStorage,
  ) {}

  acquire(messageKey: string, media: MessageMedia): { promise: Promise<CachedMedia>; release(): void } {
    const key = JSON.stringify([messageKey, media.source, media.kind]);
    let entry = this.entries.get(key);
    if (!entry) {
      this.makeRoom(0);
      const total = [...this.entries.values()].reduce((size, e) => size + e.size, 0);
      if (this.entries.size >= MAX_CACHE_ENTRIES || total > MAX_CACHE_BYTES) {
        return { promise: Promise.reject(new Error('媒体缓存已满，请关闭其他媒体后重试。')), release() {} };
      }
      const controller = new AbortController();
      entry = { controller, refs: 0, size: 0, promise: Promise.resolve(null as unknown as CachedMedia) };
      const current = entry;
      this.entries.set(key, entry);
      entry.promise = this.withDownloadSlot(controller.signal, () => this.load(key, media, current));
    }
    // Map order is the LRU order, including cache hits.
    this.entries.delete(key);
    this.entries.set(key, entry);
    entry.refs++;
    const owned = entry;
    let released = false;
    return {
      promise: entry.promise,
      release: () => {
        if (released) return;
        released = true;
        owned.refs--;
        if (!owned.refs && !owned.file) {
          owned.controller.abort();
          if (this.entries.get(key) === owned) this.entries.delete(key);
        }
      },
    };
  }

  private async load(key: string, media: MessageMedia, entry: Entry): Promise<CachedMedia> {
    try {
      const bytes = await this.download(media, entry.controller.signal);
      if (entry.controller.signal.aborted || this.entries.get(key) !== entry) throw new Error('媒体下载已取消。');
      this.makeRoom(bytes.bytes.byteLength, false);
      const used = [...this.entries.values()].reduce((size, e) => size + e.size, 0);
      if (bytes.bytes.byteLength > MAX_MEDIA_BYTES || used + bytes.bytes.byteLength > MAX_CACHE_BYTES) throw new Error('媒体缓存已满，请关闭其他媒体后重试。');
      entry.size = bytes.bytes.byteLength;
      const file = await this.storage.save(bytes);
      if (entry.controller.signal.aborted || this.entries.get(key) !== entry) {
        file.remove();
        throw new Error('媒体下载已取消。');
      }
      entry.file = file;
      entry.size = bytes.bytes.byteLength;
      return file;
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    }
  }

  private withDownloadSlot<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const cancelled = () => {
        this.waiting.delete(start);
        reject(new Error('媒体下载已取消。'));
      };
      const start = () => {
        this.waiting.delete(start);
        signal.removeEventListener('abort', cancelled);
        if (signal.aborted) { reject(new Error('媒体下载已取消。')); return; }
        this.running++;
        work().then(resolve, reject).finally(() => {
          this.running--;
          this.waiting.values().next().value?.();
        });
      };
      if (this.running < 2) start();
      else {
        this.waiting.add(start);
        signal.addEventListener('abort', cancelled, { once: true });
        if (signal.aborted) cancelled();
      }
    });
  }

  private makeRoom(reservation: number, addingEntry = true) {
    for (const [key, entry] of this.entries) {
      const total = [...this.entries.values()].reduce((size, e) => size + e.size, 0);
      if ((!addingEntry || this.entries.size < MAX_CACHE_ENTRIES) && total + reservation <= MAX_CACHE_BYTES) break;
      if (entry.refs) continue;
      entry.controller.abort();
      entry.file?.remove();
      this.entries.delete(key);
    }
  }

  entryCount(): number { return this.entries.size; }
  invalidate(messageKey: string, media: MessageMedia): void {
    const key = JSON.stringify([messageKey, media.source, media.kind]);
    const entry = this.entries.get(key);
    entry?.controller.abort();
    entry?.file?.remove();
    this.entries.delete(key);
  }
  clear(): void {
    for (const entry of this.entries.values()) {
      entry.controller.abort();
      entry.file?.remove();
    }
    this.entries.clear();
    this.storage.clear();
  }
}

export class OneActiveAudio {
  private current: { key: string; pause: () => void } | null = null;
  claim(key: string, pause: () => void): void {
    if (this.current?.key !== key) this.stop();
    this.current = { key, pause };
  }
  release(key: string): void { if (this.current?.key === key) this.stop(); }
  stop(): void {
    const active = this.current;
    this.current = null;
    active?.pause();
  }
}
export const activeMediaAudio = new OneActiveAudio();
