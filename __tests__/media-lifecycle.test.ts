import { MediaSession, OneActiveAudio } from '../src/lib/media-session';
import type { MediaBytes } from '../src/lib/media-bytes';
import type { MessageMedia } from '../src/lib/message-media';

const media = { source: '/Users/tong/a.wav', name: 'a.wav', kind: 'audio' as const };
const bytes = { bytes: new Uint8Array(46), mime: 'audio/wav', extension: 'wav', kind: 'audio' } as MediaBytes;
function fixture() {
  const save = jest.fn(async () => ({ uri: 'file:///phone-cache/a.wav', remove: jest.fn() }));
  const download = jest.fn(async (_media: MessageMedia, _signal: AbortSignal) => bytes);
  return { save, download, manager: new MediaSession(download, { save, clear: jest.fn() }) };
}

test('same message shares one request; different messages/sessions never share cached bytes', async () => {
  const a = fixture(), b = fixture();
  const lease1 = a.manager.acquire('m1', media), lease2 = a.manager.acquire('m1', media);
  await Promise.all([lease1.promise, lease2.promise]);
  expect(a.download).toHaveBeenCalledTimes(1);
  await a.manager.acquire('m2', media).promise;
  await b.manager.acquire('m1', media).promise;
  expect(a.download).toHaveBeenCalledTimes(2);
  expect(b.download).toHaveBeenCalledTimes(1);
  lease1.release(); lease1.release(); lease2.release();
  a.manager.clear(); b.manager.clear();
});

test('last consumer leaving aborts old work; a late response cannot populate a new session', async () => {
  let resolve!: (value: MediaBytes) => void;
  let signal!: AbortSignal;
  const save = jest.fn(async () => ({ uri: 'file:///cache/a.wav', remove: jest.fn() }));
  const manager = new MediaSession((_media, captured) => {
    signal = captured;
    return new Promise((r) => { resolve = r; });
  }, { save, clear: jest.fn() });
  const lease = manager.acquire('old', media);
  lease.promise.catch(() => {});
  lease.release();
  expect(signal.aborted).toBe(true);
  resolve(bytes);
  await expect(lease.promise).rejects.toThrow();
  expect(save).not.toHaveBeenCalled();
  manager.clear();
});

test('clear removes cached files, cancels pending reads and keeps retries possible', async () => {
  const f = fixture();
  const lease = f.manager.acquire('m1', media);
  const cached = await lease.promise;
  f.manager.clear();
  expect(cached.remove).toHaveBeenCalledTimes(1);
  lease.release();
  await f.manager.acquire('m1', media).promise;
  expect(f.download).toHaveBeenCalledTimes(2);
  f.manager.clear();
});

test('cache entries are bounded and evictions delete files', async () => {
  const f = fixture();
  const removed: jest.Mock[] = [];
  for (let i = 0; i < 20; i++) {
    const lease = f.manager.acquire(`message-${i}`, media);
    const result = await lease.promise;
    removed.push(result.remove as jest.Mock);
    lease.release();
  }
  expect(f.manager.entryCount()).toBeLessThanOrEqual(8);
  expect(removed.filter((remove) => remove.mock.calls.length)).toHaveLength(12);
  f.manager.clear();
});

test('multiple media wait for download slots rather than failing while two small files load', async () => {
  const gates: (() => void)[] = [];
  let reads = 0;
  const manager = new MediaSession(async () => {
    reads++;
    await new Promise<void>((resolve) => gates.push(resolve));
    return bytes;
  }, { save: async () => ({ uri: 'file:///cache/a.wav', remove() {} }), clear() {} });
  const leases = [1, 2, 3, 4].map((i) => manager.acquire(`m${i}`, media));
  leases.forEach((lease) => lease.promise.catch(() => {}));
  expect(reads).toBe(2);
  gates.shift()!(); gates.shift()!();
  await Promise.all(leases.slice(0, 2).map((l) => l.promise));
  for (let i = 0; i < 4; i++) await Promise.resolve();
  expect(reads).toBe(4);
  gates.shift()!(); gates.shift()!();
  await Promise.all(leases.map((l) => l.promise));
  manager.clear();
});

test('one active audio pauses the previous player and cleanup is idempotent', () => {
  const audio = new OneActiveAudio(), first = jest.fn(), second = jest.fn();
  audio.claim('first', first);
  audio.claim('first', first);
  expect(first).not.toHaveBeenCalled();
  audio.claim('second', second);
  expect(first).toHaveBeenCalledTimes(1);
  audio.release('first');
  expect(second).not.toHaveBeenCalled();
  audio.stop();
  audio.stop();
  expect(second).toHaveBeenCalledTimes(1);
});
