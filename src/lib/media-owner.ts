import type { RestClient } from '@/api/restClient';
import { MediaSession, type MediaStorage } from './media-session';

export interface MediaOwner {
  readonly key: string;
  readonly rest: RestClient;
  readonly profile: string | null;
  readonly sessionId: string;
  readonly identity: string;
}
let ownerSerial = 0;
export function captureMediaOwner(rest: RestClient, profile: string | null, sessionId: string, identity: string): MediaOwner {
  return Object.freeze({ key: `media-owner-${ownerSerial++}`, rest, profile, sessionId, identity });
}
type AuthRetry = <T>(fn: (rest: RestClient) => Promise<T>) => Promise<T>;

export function createOwnedMediaSession(owner: MediaOwner, retry: AuthRetry, storage: MediaStorage): MediaSession {
  const { rest: captured, profile, sessionId } = owner;
  return new MediaSession(
    (media, signal) => retry((rest) => {
      if (rest !== captured || signal.aborted) throw new Error('连接已切换，请重新打开此会话。');
      return captured.mediaBytes(media, { profile, sessionId }, signal);
    }),
    storage,
  );
}
