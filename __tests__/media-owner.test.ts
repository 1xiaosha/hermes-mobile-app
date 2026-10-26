import { captureMediaOwner, createOwnedMediaSession } from '../src/lib/media-owner';
import { RestClient } from '../src/api/restClient';
import { CookieJar } from '../src/api/cookieJar';

const media = { source: '/Users/tong/a.wav', kind: 'audio' as const, name: '音频' };
const bytes = { bytes: new Uint8Array(46), kind: 'audio' as const, mime: 'audio/wav', extension: 'wav' };
const storage = () => ({ save: jest.fn(async () => ({ uri: 'file:///phone-cache/audio.wav', remove: jest.fn() })), clear: jest.fn() });

test('owner is immutable and REST receives stored id, profile and the captured instance', async () => {
  const rest = new RestClient('http://gateway/prefix', new CookieJar());
  const read = jest.spyOn(rest, 'mediaBytes').mockResolvedValue(bytes);
  const owner = captureMediaOwner(rest, '中文', 'stored-id', 'device');
  const retry = async <T>(fn: (client: RestClient) => Promise<T>) => fn(rest);
  const manager = createOwnedMediaSession(owner, retry, storage());
  await manager.acquire('message', media).promise;
  expect(Object.isFrozen(owner)).toBe(true);
  expect(read).toHaveBeenCalledWith(media, { profile: '中文', sessionId: 'stored-id' }, expect.anything());
  manager.clear();
});

test('same-address replacement has a different scope and cannot receive an old owner retry', async () => {
  const old = new RestClient('http://gateway', new CookieJar());
  const next = new RestClient('http://gateway', new CookieJar());
  const read = jest.spyOn(next, 'mediaBytes').mockResolvedValue(bytes);
  const owner = captureMediaOwner(old, null, 'stored', 'device');
  const other = captureMediaOwner(next, null, 'stored', 'device');
  expect(owner.key).not.toBe(other.key);
  const retry = async <T>(fn: (client: RestClient) => Promise<T>) => fn(next);
  const disk = storage();
  const manager = createOwnedMediaSession(owner, retry, disk);
  await expect(manager.acquire('message', media).promise).rejects.toThrow('连接已切换');
  expect(read).not.toHaveBeenCalled();
  expect(disk.save).not.toHaveBeenCalled();
  manager.clear();
});
