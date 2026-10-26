import { createContext, use, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { useFocusEffect } from 'expo-router';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Icon } from './icon';
import { useTheme } from '@/theme';
import { withAuthRetry } from '@/connection';
import { messageMedia, type MessageMedia } from '@/lib/message-media';
import { MediaSession, activeMediaAudio, type CachedMedia } from '@/lib/media-session';
import { createMediaStorage } from '@/lib/media-storage';
import { createOwnedMediaSession, type MediaOwner } from '@/lib/media-owner';

export type { MediaOwner } from '@/lib/media-owner';
export const MediaContext = createContext<{ manager: MediaSession | null; enabled: boolean }>({ manager: null, enabled: false });

function OwnedMediaProvider({ owner, children }: { owner: MediaOwner; children: React.ReactNode }) {
  const [manager] = useState(() => createOwnedMediaSession(owner, withAuthRetry, createMediaStorage()));
  const [enabled, setEnabled] = useState(false);
  useFocusEffect(useCallback(() => {
    setEnabled(AppState.currentState === 'active');
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') { activeMediaAudio.stop(); manager.clear(); }
      setEnabled(state === 'active');
    });
    return () => {
      setEnabled(false);
      activeMediaAudio.stop();
      manager.clear();
      subscription.remove();
    };
  }, [manager]));
  return <MediaContext value={{ manager, enabled }}>{children}</MediaContext>;
}

export function MessageMediaProvider({ owner, children }: { owner: MediaOwner | null; children: React.ReactNode }) {
  return owner ? (
    <OwnedMediaProvider key={owner.key} owner={owner}>
      {children}
    </OwnedMediaProvider>
  ) : <MediaContext value={{ manager: null, enabled: false }}>{children}</MediaContext>;
}

function clock(seconds: number): string {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

function AudioPreview({ uri, onFailure }: { uri: string; onFailure: () => void }) {
  const { colors } = useTheme();
  const player = useAudioPlayer(uri, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const liveRef = useRef(false);
  const [width, setWidth] = useState(1);
  const [preparing, setPreparing] = useState(false);
  // The URI is a credential-free phone cache file. The native hook releases
  // its player on every unmount, including background/session changes.
  const key = uri;
  useEffect(() => { if (status.error) onFailure(); }, [status.error, onFailure]);
  useEffect(() => {
    if (status.isLoaded || status.error) return;
    const timeout = setTimeout(onFailure, 15_000);
    return () => clearTimeout(timeout);
  }, [status.isLoaded, status.error, onFailure]);
  const duration = Number.isFinite(status.duration) ? Math.max(0, status.duration) : 0;
  const position = Number.isFinite(status.currentTime) ? Math.max(0, Math.min(status.currentTime, duration)) : 0;
  async function seek(time: number) {
    try { await player.seekTo(Math.max(0, Math.min(duration, time))); } catch { onFailure(); }
  }
  async function toggle() {
    if (preparing || !status.isLoaded) return;
    if (status.playing) { activeMediaAudio.release(key); return; }
    setPreparing(true);
    try {
      await setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false, interruptionMode: 'doNotMix' });
      // Async audio-session setup may finish after the row was removed. This
      // object is invalidated by the cleanup below before any play can occur.
      if (!liveRef.current) return;
      if (status.didJustFinish || (duration > 0 && position >= duration)) await player.seekTo(0);
      if (!liveRef.current) return;
      activeMediaAudio.claim(key, () => player.pause());
      player.play();
    } catch { activeMediaAudio.release(key); onFailure(); }
    finally { if (liveRef.current) setPreparing(false); }
  }
  useLayoutEffect(() => {
    liveRef.current = true;
    // Expo releases the shared native player in a passive-effect cleanup.
    // Pause/invalidate first, while its native object still exists.
    return () => { liveRef.current = false; activeMediaAudio.release(key); };
  }, [key]);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={status.playing ? '暂停音频' : '播放音频'}
        accessibilityState={{ disabled: !status.isLoaded || preparing }} disabled={!status.isLoaded || preparing}
        onPress={() => void toggle()} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
        {status.isBuffering || preparing ? <ActivityIndicator color={colors.accent} /> : <Icon sf={status.playing ? 'pause.fill' : 'play.fill'} size={22} color={colors.accent} />}
      </Pressable>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View accessible accessibilityRole="adjustable" accessibilityLabel="音频进度"
          accessibilityState={{ disabled: !status.isLoaded || duration === 0 }}
          accessibilityValue={{ min: 0, max: Math.round(duration), now: Math.round(position), text: `${clock(position)}，总时长 ${clock(duration)}` }}
          accessibilityActions={[{ name: 'increment', label: '前进五秒' }, { name: 'decrement', label: '后退五秒' }]}
          onAccessibilityAction={(event) => void seek(position + (event.nativeEvent.actionName === 'increment' ? 5 : -5))}
          onLayout={(event) => setWidth(Math.max(1, event.nativeEvent.layout.width))}
          onStartShouldSetResponder={() => status.isLoaded && duration > 0}
          onResponderGrant={(event) => void seek((event.nativeEvent.locationX / width) * duration)}
          onResponderRelease={(event) => void seek((event.nativeEvent.locationX / width) * duration)}
          style={{ height: 44, justifyContent: 'center' }}>
          <View style={{ height: 4, backgroundColor: colors.border, borderRadius: 2 }}>
            <View style={{ height: 4, width: `${duration ? position / duration * 100 : 0}%`, backgroundColor: colors.accent, borderRadius: 2 }} />
            <View style={{ position: 'absolute', top: -4, left: `${duration ? position / duration * 100 : 0}%`,
              width: 12, height: 12, borderRadius: 6, backgroundColor: colors.accent, transform: [{ translateX: -6 }] }} />
          </View>
        </View>
        <Text style={{ color: colors.textDim, fontSize: 12, fontVariant: ['tabular-nums'] }}>{clock(position)} / {clock(duration)}</Text>
      </View>
    </View>
  );
}

function ImagePreview({ uri, name, onFailure }: { uri: string; name: string; onFailure: () => void }) {
  const { colors } = useTheme();
  const { width, height } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={`查看大图：${name}`} onPress={() => { setZoom(1); setOpen(true); }}>
        <Image source={{ uri }} onError={onFailure} contentFit="contain" cachePolicy="none"
          accessibilityLabel={`图片：${name}`} style={{ width: '100%', height: 220, borderRadius: 8, backgroundColor: colors.raised }} />
      </Pressable>
      <Modal visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: 56 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8, paddingHorizontal: 12 }}>
            <Pressable accessibilityRole="button" accessibilityLabel="缩小图片" onPress={() => setZoom((z) => Math.max(1, z - 1))}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
              <Icon sf="minus.magnifyingglass" color={colors.text} />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="放大图片" onPress={() => setZoom((z) => Math.min(4, z + 1))}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
              <Icon sf="plus.magnifyingglass" color={colors.text} />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭大图" onPress={() => setOpen(false)}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
              <Icon sf="xmark" color={colors.text} />
            </Pressable>
          </View>
          {open ? <ScrollView accessibilityLabel="大图，可缩放" minimumZoomScale={1} maximumZoomScale={4} zoomScale={zoom}
            centerContent bouncesZoom contentContainerStyle={{ alignItems: 'center', justifyContent: 'center' }}>
            <Image source={{ uri }} onError={() => { setOpen(false); onFailure(); }} cachePolicy="none" contentFit="contain"
              style={{ width, height: Math.max(100, height - 144) }} />
          </ScrollView> : null}
        </View>
      </Modal>
    </>
  );
}

function MediaDownload({ media, messageKey, manager, onRetry }: {
  media: MessageMedia; messageKey: string; manager: MediaSession; onRetry: () => void;
}) {
  const { colors } = useTheme();
  const [file, setFile] = useState<CachedMedia | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const lease = manager.acquire(messageKey, media);
    lease.promise.then((result) => { if (active) setFile(result); }, (e) => {
      if (active) setError(e instanceof Error ? e.message : '媒体下载失败，请重试。');
    });
    return () => { active = false; lease.release(); };
  }, [manager, messageKey, media]);
  const failure = () => setError('媒体无法打开，请重试或重新生成文件。');
  return (
    <>
      {error ? (
        <View style={{ gap: 4 }}>
          <Text style={{ color: colors.danger, fontSize: 13 }}>{error}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="重试媒体下载" onPress={onRetry}
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Icon sf="arrow.clockwise" color={colors.accent} />
          </Pressable>
        </View>
      ) : file ? (
        media.kind === 'image' ? <ImagePreview uri={file.uri} name={media.name} onFailure={failure} /> : <AudioPreview uri={file.uri} onFailure={failure} />
      ) : <ActivityIndicator accessibilityLabel="正在下载媒体" color={colors.accent} />}
    </>
  );
}

function MediaTile({ media, messageKey }: { media: MessageMedia; messageKey: string }) {
  const { colors } = useTheme();
  const { manager, enabled } = use(MediaContext);
  const [retry, setRetry] = useState(0);
  return (
    <View style={{ marginTop: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 10, gap: 6 }}>
      <Text numberOfLines={2} style={{ color: colors.textDim, fontSize: 13 }}>{media.name}</Text>
      {enabled && manager ? <MediaDownload key={retry} media={media} messageKey={messageKey} manager={manager}
        onRetry={() => { manager.invalidate(messageKey, media); setRetry((r) => r + 1); }} />
        : <Text style={{ color: colors.textFaint, fontSize: 12 }}>打开此会话后加载媒体</Text>}
    </View>
  );
}

export function MessageMediaAttachments({ text, complete, parts, messageKey }: {
  text: string; complete: boolean; parts?: MessageMedia[]; messageKey: string;
}) {
  const media = messageMedia(text, complete, parts);
  return <>{media.map((item) => <MediaTile key={`${messageKey}:${item.source}`} media={item} messageKey={messageKey} />)}</>;
}
