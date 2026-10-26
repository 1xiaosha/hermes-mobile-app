/** Real encoded 1x1 PNG and PCM WAV; HTTP serves decoded bytes, never a fake data-url reply. */
import * as http from 'node:http';
import { runInThisContext } from 'node:vm';
import { RestClient, AuthError } from '../src/api/restClient';
import { CookieJar } from '../src/api/cookieJar';
import { validateMediaBytes, MAX_MEDIA_BYTES } from '../src/lib/media-bytes';
import { connect, disconnect, withAuthRetry } from '../src/connection';
import * as SecureStore from 'expo-secure-store';
import { inflateSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Use the host's WHATWG fetch, rather than React Native's Jest fetch mock.
const nodeFetch: typeof fetch = runInThisContext('fetch');
const mockSecureStorage = new Map<string, string>();
jest.mock('expo/fetch', () => ({ fetch: (...args: Parameters<typeof fetch>) => require('node:vm').runInThisContext('fetch')(...args) }));
jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(async (key: string, value: string) => { mockSecureStorage.set(key, value); }),
  getItemAsync: jest.fn(async (key: string) => mockSecureStorage.get(key) ?? null),
  deleteItemAsync: jest.fn(async (key: string) => { mockSecureStorage.delete(key); }),
}));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const WAV = Buffer.alloc(1644); // 100 ms, 8 kHz, mono 16-bit PCM tone
WAV.write('RIFF'); WAV.writeUInt32LE(WAV.length - 8, 4); WAV.write('WAVEfmt ', 8);
WAV.writeUInt32LE(16, 16); WAV.writeUInt16LE(1, 20); WAV.writeUInt16LE(1, 22);
WAV.writeUInt32LE(8000, 24); WAV.writeUInt32LE(16000, 28);
WAV.writeUInt16LE(2, 32); WAV.writeUInt16LE(16, 34); WAV.write('data', 36); WAV.writeUInt32LE(1600, 40);
for (let i = 0; i < 800; i++) WAV.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * 440 * i / 8000)), 44 + i * 2);
let server: http.Server;
let base: string;
const requests: { url: string; cookie?: string }[] = [];
let logins = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push({ url: req.url!, cookie: req.headers.cookie });
    const url = new URL(req.url!, 'http://fixture');
    const path = url.searchParams.get('path') || '';
    if (url.pathname.endsWith('/auth/password-login')) {
      logins++;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': logins === 1 ? 'hermes_session_rt=fixture-login; Path=/' : 'hermes_session_at=fixture-fresh; Max-Age=900; Path=/',
      });
      res.end('{"ok":true}'); return;
    }
    if (path.includes('relogin') && !req.headers.cookie?.includes('fixture-fresh')) { res.writeHead(401); res.end(); return; }
    if (path.includes('401')) { res.writeHead(401); res.end(); return; }
    if (path.includes('403')) { res.writeHead(403); res.end(); return; }
    if (path.includes('404')) { res.writeHead(404); res.end(); return; }
    if (path.includes('redirect')) { res.writeHead(302, { Location: `${base}/leaked.png` }); res.end(); return; }
    if (path.includes('html')) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>login</html>'); return; }
    if (path.includes('chunked')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.write(PNG); res.end(Buffer.alloc(MAX_MEDIA_BYTES)); return;
    }
    if (path.includes('large')) { res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': MAX_MEDIA_BYTES + 1 }); res.end(); return; }
    const wav = path.endsWith('.wav') || url.pathname.endsWith('.wav');
    res.writeHead(200, { 'Content-Type': wav ? 'audio/wav' : 'image/png', 'Set-Cookie': 'hermes_session_rt=rotated; Path=/' });
    res.end(wav ? WAV : PNG);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => requests.splice(0));

function client() {
  const jar = CookieJar.fromJSON({ hermes_session_rt: 'fixture' });
  const flush = jest.fn(async () => {});
  const rest = new RestClient(base, jar, nodeFetch as any, flush, nodeFetch as any);
  return { rest, jar, flush };
}

test.each([['图 片.png', 'image', PNG], ['声 音.wav', 'audio', WAV]] as const)(
  'downloads %s through encoded scoped authenticated route and verifies actual bytes', async (file, kind, expected) => {
    const { rest, jar, flush } = client();
    const path = `/Users/tong/中文 空格/${file}`;
    const result = await rest.mediaBytes({ source: path, kind, name: file }, { sessionId: '会话', profile: '中文 配置' });
    expect(Buffer.from(result.bytes)).toEqual(expected);
    const work = join(process.cwd(), 'work');
    mkdirSync(work, { recursive: true });
    const scratch = mkdtempSync(join(work, 'media-http-'));
    try {
      const filePath = join(scratch, file);
      writeFileSync(filePath, result.bytes);
      expect(readFileSync(filePath)).toEqual(expected);
    } finally { rmSync(scratch, { recursive: true }); }
    expect(validateMediaBytes(result.bytes, result.mime, kind).kind).toBe(kind);
    const request = new URL(requests[0].url, base);
    expect(request.pathname).toBe('/api/fs/download');
    expect(request.searchParams.get('path')).toBe(path);
    expect(request.searchParams.get('session_id')).toBe('会话');
    expect(request.searchParams.get('profile')).toBe('中文 配置');
    expect(requests[0].cookie).toBe('hermes_session_rt=fixture');
    expect(requests[0].url).not.toContain('fixture');
    expect(jar.header()).toContain('rotated');
    expect(flush).toHaveBeenCalled();
  },
);

test.each([['401', AuthError], ['403', Error], ['404', Error], ['html', Error], ['large', Error], ['chunked', Error], ['redirect', Error]])(
  '%s fails without trusting error pages or following redirects', async (caseName, error) => {
    const { rest } = client();
    await expect(rest.mediaBytes({ source: `/Users/tong/${caseName}.png`, kind: 'image', name: '图' }, { sessionId: 's' })).rejects.toThrow(error);
    expect(requests).toHaveLength(1);
  },
);

test('real fixture 401 re-login retries the same stored scope and durably saves rotated cookies', async () => {
  const originalFetch = global.fetch;
  global.fetch = nodeFetch;
  logins = 0;
  try {
    await connect(base, 'synthetic-fixture-user', 'synthetic-fixture-password');
    const media = { source: '/Users/tong/relogin.wav', kind: 'audio' as const, name: '声音' };
    const result = await withAuthRetry((rest) => rest.mediaBytes(media, { sessionId: 'stored', profile: '中文' }));
    expect(Buffer.from(result.bytes)).toEqual(WAV);
    expect(logins).toBe(2);
    const mediaRequests = requests.filter((r) => r.url.includes('/api/fs/download'));
    expect(mediaRequests).toHaveLength(2);
    expect(mediaRequests.map((r) => new URL(r.url, base).searchParams.get('session_id'))).toEqual(['stored', 'stored']);
    expect(mediaRequests.map((r) => new URL(r.url, base).searchParams.get('profile'))).toEqual(['中文', '中文']);
    expect(mediaRequests[1].cookie).toContain('fixture-fresh');
    const saved = JSON.parse((await SecureStore.getItemAsync('hermes-connection'))!);
    expect(saved.cookies.hermes_session_rt).toBe('rotated');
  } finally {
    await disconnect();
    global.fetch = originalFetch;
  }
});

test('external origin receives no cookie and cannot rotate the gateway jar', async () => {
  const { jar, flush } = client();
  // Byte stream still comes from the HTTP server; the injected bridge models TLS
  // termination without sending credentials or contacting an external host.
  const source = 'https://external.invalid/a.wav';
  const bridge = async (_url: string, init: RequestInit) => {
    const res = await nodeFetch(base + '/a.wav', init);
    return { body: res.body, headers: res.headers, ok: res.ok, status: res.status, redirected: res.redirected, url: source } as Response;
  };
  const rest = new RestClient(base, jar, nodeFetch as any, flush, bridge as any);
  await rest.mediaBytes({ source, kind: 'audio', name: '音频' }, { sessionId: 's' });
  expect(requests[0].cookie).toBeUndefined();
  expect(jar.header()).toBe('hermes_session_rt=fixture');
  expect(flush).not.toHaveBeenCalled();
});

test('reverse proxy prefix survives and unknown same-origin routes receive no credentials', async () => {
  const { jar, flush } = client();
  const rest = new RestClient(`${base}/hermes`, jar, nodeFetch as any, flush, nodeFetch as any);
  await rest.mediaBytes({ source: '/Users/tong/图.png', kind: 'image', name: '图' }, { sessionId: 'stored' });
  expect(new URL(requests[0].url, base).pathname).toBe('/hermes/api/fs/download');
  await expect(rest.mediaBytes({ source: `${base}/private.png`, kind: 'image', name: '图' }, { sessionId: 'stored' })).rejects.toThrow();
  expect(requests).toHaveLength(1);
});

test('external HTTP and URL credentials are rejected before I/O', async () => {
  const { rest } = client();
  for (const source of ['http://external.invalid/a.png', 'https://external.invalid/a.png?token=secret', `${base}/api/media?path=/Users/tong/a.png&token=secret`]) {
    await expect(rest.mediaBytes({ source, kind: 'image', name: '图' }, { sessionId: 's' })).rejects.toThrow();
  }
  expect(requests).toHaveLength(0);
});

test('cross-origin credential URL and phone-local file URL never reach fetch', async () => {
  const { rest } = client();
  for (const source of ['http://user:pass@example.com/a.png', 'file:///Users/tong/a.png']) {
    await expect(rest.mediaBytes({ source, kind: 'image', name: '图' }, { sessionId: 's' })).rejects.toThrow();
  }
  expect(requests).toHaveLength(0);
});

test('MIME and signatures must agree; SVG and HTML cannot be previewed', () => {
  expect(() => validateMediaBytes(new Uint8Array(Buffer.from('<html/>')), 'image/png', 'image')).toThrow();
  expect(() => validateMediaBytes(new Uint8Array(PNG), 'audio/wav', 'audio')).toThrow();
  expect(() => validateMediaBytes(new Uint8Array(Buffer.from('<svg/>')), 'image/svg+xml', 'image')).toThrow();
});

test('fixtures contain a decodable red PNG pixel and a non-silent PCM tone', () => {
  expect(PNG.readUInt32BE(16)).toBe(1);
  expect(PNG.readUInt32BE(20)).toBe(1);
  expect(inflateSync(PNG.subarray(41, 54))).toEqual(Buffer.from([0, 255, 0, 0, 255]));
  expect(WAV.readUInt16LE(20)).toBe(1);
  expect(WAV.readUInt32LE(24)).toBe(8000);
  expect(WAV.readUInt32LE(40)).toBe(WAV.length - 44);
  expect(WAV.subarray(44).some((b) => b !== 0)).toBe(true);
});

test('an abandoned owner 401 cannot silently re-login the replacement connection', async () => {
  const originalFetch = global.fetch;
  global.fetch = nodeFetch;
  logins = 0;
  try {
    await connect(base, 'synthetic-user', 'synthetic-password');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const old = withAuthRetry(async () => { await gate; throw new AuthError('expired'); });
    old.catch(() => {});
    await connect(base + '/other', 'synthetic-other', 'synthetic-other-password');
    release();
    await expect(old).rejects.toThrow(AuthError);
    expect(logins).toBe(2);
  } finally { await disconnect(); global.fetch = originalFetch; }
});

test('stalled body has a strict whole-request deadline and cancels its reader', async () => {
  jest.useFakeTimers();
  try {
    const jar = new CookieJar();
    jar.ingest(['hermes_session_at=fixture-fresh; Max-Age=900']);
    let signal: AbortSignal | undefined;
    const cancel = jest.fn(async () => {});
    const stalled = jest.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return {
        ok: true, status: 200, headers: { get: (key: string) => key === 'content-type' ? 'image/png' : null },
        body: { getReader: () => ({ read: () => new Promise(() => {}), cancel }) },
      } as unknown as Response;
    });
    const rest = new RestClient(base, jar, nodeFetch as any, undefined, stalled as any);
    const promise = rest.mediaBytes({ source: '/Users/tong/a.png', kind: 'image', name: '图' }, { sessionId: 'stored' });
    promise.catch(() => {});
    for (let i = 0; i < 5; i++) await Promise.resolve();
    jest.advanceTimersByTime(20_000);
    await expect(promise).rejects.toThrow('媒体下载超时');
    expect(signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  } finally { jest.useRealTimers(); }
});

test('pre-cancelled reads never enter HTTP or native fetch', async () => {
  const controller = new AbortController();
  controller.abort();
  const { rest } = client();
  await expect(rest.mediaBytes({ source: '/Users/tong/a.png', kind: 'image', name: '图' }, { sessionId: 'stored' }, controller.signal)).rejects.toThrow('取消');
  expect(requests).toHaveLength(0);
});

test('invalid configured gateway produces a Chinese media error', async () => {
  const rest = new RestClient('invalid', new CookieJar());
  await expect(async () => rest.mediaBytes({ source: '/Users/tong/a.png', kind: 'image', name: '图' }, { sessionId: 'stored' }))
    .rejects.toThrow('网关地址无效');
});

test('cookie persistence wait is covered by the same strict deadline', async () => {
  jest.useFakeTimers();
  let release!: () => void;
  let promise: Promise<unknown> | undefined;
  try {
    const jar = new CookieJar();
    jar.ingest(['hermes_session_at=fixture-fresh; Max-Age=900']);
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const response = async () => ({
      ok: true, status: 200,
      headers: { get: (key: string) => key === 'set-cookie' ? 'hermes_session_rt=rotated; Path=/' : key === 'content-type' ? 'image/png' : null },
      body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) },
    }) as unknown as Response;
    const rest = new RestClient(base, jar, nodeFetch as any, () => gate, response as any);
    promise = rest.mediaBytes({ source: '/Users/tong/a.png', kind: 'image', name: '图' }, { sessionId: 'stored' });
    let settled = false;
    promise.catch(() => { settled = true; });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    jest.advanceTimersByTime(20_000);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(settled).toBe(true);
    await expect(promise).rejects.toThrow('媒体下载超时');
  } finally {
    release?.();
    await promise?.catch(() => {});
    jest.useRealTimers();
  }
});
