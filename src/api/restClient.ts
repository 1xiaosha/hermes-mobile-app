// src/api/restClient.ts
import { SESSION_CLAIM_ROUTE } from '@/lib/push';
import { CookieJar } from './cookieJar';
import type { MessagesResponse, SessionListResponse, WsTicketResponse } from './types';
import type { MessageMedia } from '@/lib/message-media';
import { MAX_MEDIA_BYTES, validateMediaBytes, type MediaBytes } from '@/lib/media-bytes';

export class AuthError extends Error {}
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type FetchFn = typeof fetch;

/** Serialize requests once the access token has less than this much life left
 * (or its expiry is unknown). That is the only window in which a request falls
 * back to the rotating refresh token, so it is the only window in which two
 * concurrent requests could replay the same RT. The margin absorbs clock skew
 * and in-flight time; the server-side reuse grace window backstops any residue. */
export const AT_FRESH_MARGIN_MS = 60_000;

/** Default upper bound per request. The audited REST surface is all small JSON
 * on a private network — nothing legitimately approaches this — so it only ever
 * fires on a genuine hang, turning a silent freeze into an explicit failure and
 * freeing the serialization chain. */
export const REQUEST_TIMEOUT_MS = 20_000;

/** Ceiling for a per-request override. Only a call the gateway itself holds
 * open may ask for more than the default: starting MCP OAuth waits up to 30 s
 * for the authorization URL, and installing a catalog connector connects to the
 * server (up to ~40 s). A caller that raises the limit must send a fast
 * request first, because the gateway writes rotated cookies back only when the
 * handler returns — an aborted slow request would lose a rotation it carried
 * (docs/superpowers/specs/2026-10-01-mcp-connectors-design.md §6.1). */
export const MAX_REQUEST_TIMEOUT_MS = 45_000;

export interface RequestOptions {
  /** Per-request limit; clamped to MAX_REQUEST_TIMEOUT_MS. Default REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
}

export function resolveTimeoutMs(opts?: RequestOptions): number {
  const t = opts?.timeoutMs;
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return REQUEST_TIMEOUT_MS;
  return Math.min(t, MAX_REQUEST_TIMEOUT_MS);
}

// Load-bearing invariant. The off-chain "fresh" path lets a request skip the
// serialization chain; that is safe only because a fresh request finishes
// (bounded by MAX_REQUEST_TIMEOUT_MS) before the access token can fall below
// AT_FRESH_MARGIN_MS — so a fresh request and a later chained (post-rotation)
// request can never overlap on the same refresh token. That holds only while
// the margin dominates the largest timeout; fail loudly if a future edit breaks it.
if (AT_FRESH_MARGIN_MS <= MAX_REQUEST_TIMEOUT_MS || MAX_REQUEST_TIMEOUT_MS < REQUEST_TIMEOUT_MS) {
  throw new Error(
    'RestClient: AT_FRESH_MARGIN_MS must exceed MAX_REQUEST_TIMEOUT_MS, which must be at least REQUEST_TIMEOUT_MS (fresh-path race invariant)',
  );
}

export class RestClient {
  constructor(
    public readonly baseUrl: string,           // e.g. http://100.1.2.3:9119 (no trailing slash)
    private readonly jar: CookieJar,
    private readonly fetchFn: FetchFn = fetch,
    // Flush queued cookie persistence to durable storage. Awaited after a
    // response rotates the refresh token, BEFORE the request resolves, so the
    // app can't be suspended/killed between rotating the RT and saving it —
    // which would leave the next launch replaying the rotated-out token and
    // (server-side) getting the device revoked. Best-effort; never rejects.
    private readonly flushCookiePersist?: () => Promise<void>,
    // Runtime supplies expo/fetch: native streaming + redirect:'error'. Tests inject HTTP I/O.
    private readonly mediaFetchFn: FetchFn = fetchFn,
  ) {}

  // Serializes authed requests. Refresh tokens rotate single-use server-side:
  // two concurrent requests would both snapshot the same RT from the jar and
  // send it, and the gateway treats the second (rotated-out) RT as reuse —
  // revoking the device. Chaining each request after the previous one means a
  // request always sends the freshly-rotated cookie the prior response
  // ingested. The cost on a private network is one extra RTT per multi-call
  // screen; streaming rides the WebSocket, not this path.
  private chain: Promise<unknown> = Promise.resolve();

  private request<T>(path: string, init: RequestInit = {}, opts?: RequestOptions): Promise<T> {
    const timeoutMs = resolveTimeoutMs(opts);
    return this.schedule(() => this.send<T>(path, init, timeoutMs));
  }

  private schedule<T>(send: () => Promise<T>): Promise<T> {
    // Access token fresh → the server validates it without rotating the refresh
    // token, so requests are safe to run concurrently and a hung request cannot
    // wedge the rest of the REST layer. (This relies on the gateway contract
    // that a valid, unexpired AT never triggers refresh_session / RT rotation —
    // dashboard_auth middleware: AT present ⇒ no refresh.) Stale/unknown → fall
    // back to the chain so only one request at a time can trigger (and thus
    // race) a refresh-token rotation.
    if (this.jar.accessTokenFresh(AT_FRESH_MARGIN_MS)) {
      return send();
    }
    const run = this.chain.then(send);
    // Keep the chain alive across failures — a rejected request must not wedge
    // later ones — while still propagating the real result to the caller.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Bytes for a message-owned preview. Local paths are gateway paths, never
   * phone file:// URLs. No credential ever enters a media URL or a native player. */
  mediaBytes(
    media: MessageMedia,
    scope: { sessionId: string; profile?: string | null },
    signal?: AbortSignal,
  ): Promise<MediaBytes> {
    let url: URL;
    let base: URL;
    try { base = new URL(this.baseUrl); } catch { return Promise.reject(new Error('网关地址无效。')); }
    if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash) return Promise.reject(new Error('网关地址无效。'));
    const prefix = base.pathname.replace(/\/+$/, '');
    if (/^(?:\/|~\/)/.test(media.source) && !media.source.startsWith('//')) {
      if (!scope.sessionId) return Promise.reject(new Error('会话尚未就绪，请稍后重试。'));
      url = new URL(`${this.baseUrl.replace(/\/+$/, '')}/api/fs/download`);
      url.searchParams.set('path', media.source);
      url.searchParams.set('session_id', scope.sessionId);
      if (scope.profile) url.searchParams.set('profile', scope.profile);
    } else {
      try { url = new URL(media.source); } catch { return Promise.reject(new Error('媒体地址无效。')); }
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return Promise.reject(new Error('媒体地址无效。'));
      if ([...url.searchParams.keys()].some((key) => /^(?:token|ticket|password|authorization|access_token|refresh_token)$/i.test(key))) {
        return Promise.reject(new Error('媒体地址包含凭据，请重新生成安全的地址。'));
      }
      if (url.origin === base.origin) {
        const allowed = ['/api/media', '/api/fs/download', '/api/files/download', '/api/files/stream'].map((route) => prefix + route);
        if (!allowed.includes(url.pathname)) return Promise.reject(new Error('此网关媒体地址不受支持。'));
        const path = url.searchParams.get('path');
        if (!path || !/^(?:\/|~\/)/.test(path)) return Promise.reject(new Error('媒体地址无效。'));
        return this.mediaBytes({ ...media, source: path }, scope, signal);
      }
      if (url.protocol !== 'https:') return Promise.reject(new Error('外部媒体地址必须使用 HTTPS。'));
    }
    const authed = url.origin === base.origin;
    const send = () => this.sendMedia(url, media, authed, signal);
    return authed ? this.schedule(send) : send();
  }

  private async sendMedia(url: URL, media: MessageMedia, authed: boolean, signal?: AbortSignal): Promise<MediaBytes> {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let rejectAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new Error(timedOut ? '媒体下载超时，请重试。' : '媒体下载已取消。'));
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    try {
      if (controller.signal.aborted) throw new Error('媒体下载已取消。');
      const cookie = authed ? this.jar.header() : null;
      const res = await Promise.race([this.mediaFetchFn(url.toString(), {
        method: 'GET', headers: cookie ? { Cookie: cookie } : {},
        credentials: 'omit', redirect: 'error', signal: controller.signal,
      }), cancelled]);
      if (res.redirected || (res.url && new URL(res.url).origin !== url.origin) || (res.status >= 300 && res.status < 400)) {
        throw new Error('媒体地址发生重定向，已停止下载。');
      }
      const setCookie = authed ? res.headers.get('set-cookie') : null;
      if (setCookie) {
        this.jar.ingest([setCookie]);
        try {
          await Promise.race([this.flushCookiePersist?.() ?? Promise.resolve(), cancelled]);
        } catch { /* same durability policy as JSON requests */ }
      }
      if (controller.signal.aborted) throw new Error('媒体下载已取消。');
      if (res.status === 401 && authed) throw new AuthError('会话已过期，请重新连接。');
      if (!res.ok) throw new HttpError(res.status, res.status === 403 ? '无权读取此媒体。' : res.status === 404 ? '媒体文件不存在，请重新生成。' : `媒体下载失败（HTTP ${res.status}），请重试。`);
      const mime = res.headers.get('content-type') ?? '';
      if (!/^(?:image\/(?:png|jpe?g|gif|webp|bmp|x-ms-bmp)|audio\/(?:wav|x-wav|wave|mpeg|mp3|mp4|x-m4a))(?:;|$)/i.test(mime)) {
        throw new Error('服务器返回的媒体类型无效，请重试。');
      }
      const length = Number(res.headers.get('content-length'));
      if (length > MAX_MEDIA_BYTES) throw new Error('媒体超过 16 MB，请重新生成较小的文件。');
      if (!res.body) throw new Error('媒体下载失败，请重试。');
      reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await Promise.race([reader.read(), cancelled]);
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_MEDIA_BYTES) throw new Error('媒体超过 16 MB，请重新生成较小的文件。');
        chunks.push(chunk.value);
      }
      if (controller.signal.aborted) throw new Error('媒体下载已取消。');
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return validateMediaBytes(bytes, mime, media.kind);
    } catch (error) {
      if (error instanceof AuthError || error instanceof HttpError) throw error;
      if (controller.signal.aborted) throw new Error(timedOut ? '媒体下载超时，请重试。' : '媒体下载已取消。');
      throw new Error('媒体下载失败或内容无效，请重试。');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
      // Abort closes a native body even when we rejected before acquiring its reader.
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
    }
  }

  private async send<T>(path: string, init: RequestInit = {}, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };
    const cookie = this.jar.header();
    if (cookie) headers['Cookie'] = cookie;
    // One controller + timer guards the WHOLE request — headers AND body reads.
    // A server that returns headers then stalls the body would otherwise hang in
    // res.json() forever (and, on the chain, re-wedge the REST layer). `init`
    // never carries a caller signal today; we own it.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        credentials: 'omit', // we manage cookies ourselves
        signal: controller.signal,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        this.jar.ingest([setCookie]);
        // Durably persist a rotated refresh token before this request resolves
        // (see flushCookiePersist). Best-effort: a persistence failure must not
        // fail the request — we'd rather proceed than wedge the REST layer.
        if (this.flushCookiePersist) {
          try {
            await this.flushCookiePersist();
          } catch {
            // persistence is best-effort; the in-memory jar already rotated
          }
        }
      }
      if (res.status === 401) throw new AuthError('会话已过期或凭据无效，请重新连接。');
      if (res.status === 429) throw new HttpError(429, '请求过于频繁，请稍后重试。');
      if (!res.ok) {
        // FastAPI errors carry {"detail": "..."} — surface it (e.g. cron
        // schedule-parse 400s) instead of a bare status code.
        let message = `请求 ${path} 失败（HTTP ${res.status}）`;
        try {
          const body = (await res.json()) as { detail?: unknown };
          if (typeof body?.detail === 'string' && body.detail) message = body.detail;
        } catch {
          // non-JSON (or aborted) error body — keep the generic message
        }
        throw new HttpError(res.status, message);
      }
      return (await res.json()) as T;
    } catch (e) {
      // The timeout fires by aborting the controller; map any resulting abort —
      // during the headers phase OR a stalled body read — to a clear timeout.
      // Detect via the controller's own state (robust to RN/polyfill error
      // shapes). Intentional AuthError/HttpError thrown above pass through.
      if (controller.signal.aborted && !(e instanceof AuthError) && !(e instanceof HttpError)) {
        throw new HttpError(0, `请求超时（${timeoutMs / 1000} 秒）`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Generic authed verbs — feature modules (cron, memory, …) build on these
   * instead of growing this class. */
  get<T>(path: string, opts?: RequestOptions): Promise<T> {
    return this.request<T>(path, {}, opts);
  }

  post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }, opts);
  }

  patch<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) }, opts);
  }

  put<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }, opts);
  }

  del<T>(path: string, opts?: RequestOptions): Promise<T> {
    return this.request<T>(path, { method: 'DELETE' }, opts);
  }

  async login(username: string, password: string): Promise<void> {
    await this.request<{ ok: boolean }>('/auth/password-login', {
      method: 'POST',
      body: JSON.stringify({ provider: 'basic', username, password }),
    });
  }

  wsTicket(): Promise<WsTicketResponse> {
    return this.request<WsTicketResponse>('/api/auth/ws-ticket', { method: 'POST', body: '{}' });
  }

  listSessions(offset = 0, archived: 'exclude' | 'only' = 'exclude'): Promise<SessionListResponse> {
    const arch = archived === 'only' ? '&archived=only' : '';
    return this.request<SessionListResponse>(`/api/sessions?limit=40&offset=${offset}&order=recent${arch}`);
  }

  /** Bind this device to a session so session-stop push hooks can target it.
   * Best-effort: callers fire-and-forget after session.create/resume. */
  async claimSession(sessionId: string, sessionKey: string): Promise<void> {
    await this.post(SESSION_CLAIM_ROUTE, {
      session_id: sessionId,
      session_key: sessionKey,
    });
  }

  getMessages(sessionId: string, profile?: string): Promise<MessagesResponse> {
    const q = profile ? `?profile=${encodeURIComponent(profile)}` : '';
    return this.request<MessagesResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/messages${q}`);
  }

  /** ws:// or wss:// URL for the gateway socket. */
  wsUrl(ticket: string): string {
    return `${this.baseUrl.replace(/^http/, 'ws')}/api/ws?ticket=${encodeURIComponent(ticket)}`;
  }
}
