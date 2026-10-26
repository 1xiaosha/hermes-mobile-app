import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Share } from 'react-native';
import { MessageRow } from '../src/components/message-row';
import { MediaContext } from '../src/components/message-media';
import { MediaSession, activeMediaAudio } from '../src/lib/media-session';

const mockPlayers: any[] = [];
jest.mock('expo-audio', () => {
  const React = require('react');
  return {
    setAudioModeAsync: jest.fn(async () => {}),
    useAudioPlayer: (source: string) => {
      const [player] = React.useState(() => {
        const p: any = { source, playing: false, currentTime: 0, duration: 10, notify: () => {} };
        p.play = jest.fn(() => { p.playing = true; p.notify(); });
        p.pause = jest.fn(() => {
          if (p.removed) throw new Error('Native player has already been released');
          p.playing = false; p.notify();
        });
        p.seekTo = jest.fn(async (time: number) => { p.currentTime = time; p.notify(); });
        p.remove = jest.fn(() => { p.removed = true; });
        mockPlayers.push(p);
        return p;
      });
      React.useEffect(() => () => player.remove(), [player]);
      return player;
    },
    useAudioPlayerStatus: (player: any) => {
      const status = () => ({ isLoaded: true, isBuffering: false, playing: player.playing, currentTime: player.currentTime, duration: 10, didJustFinish: false, error: null });
      const [value, setValue] = React.useState(status);
      React.useEffect(() => { player.notify = () => setValue(status()); return () => { player.notify = () => {}; }; }, [player]);
      return value;
    },
  };
});
jest.mock('../src/components/icon', () => ({ Icon: () => null }));
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(async () => {}), ImpactFeedbackStyle: { Medium: 'medium' } }));

function fixture(fail = false) {
  let counter = 0;
  const download = jest.fn(async () => {
    if (fail) throw new Error('媒体下载失败，请重试。');
    return { bytes: new Uint8Array(46), mime: 'audio/wav', extension: 'wav', kind: 'audio' as const };
  });
  const manager = new MediaSession(download, {
    save: async () => ({ uri: `file:///phone-cache/${counter++}.wav`, remove: jest.fn() }),
    clear: jest.fn(),
  });
  const view = (text: string, enabled = true, complete = true, key = 'm') => (
    <MediaContext value={{ manager, enabled }}>
      <MessageRow item={{ key, role: 'assistant', text, complete }} />
    </MediaContext>
  );
  return { manager, download, view };
}
afterEach(() => { activeMediaAudio.stop(); mockPlayers.splice(0); });

test('teaching preamble never downloads through MessageRow and MediaSession', async () => {
  const f = fixture();
  const result = await render(f.view('示例：\n\nMEDIA:/Users/tong/example.wav'));
  await act(async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); });
  expect(f.download).not.toHaveBeenCalled();
  await result.rerender(f.view('示例：\n\nMEDIA:/Users/tong/example.wav\n\n正式交付：\n\nMEDIA:/Users/tong/a.wav'));
  await waitFor(() => expect(screen.getByLabelText('播放音频')).toBeOnTheScreen());
  expect(f.download).toHaveBeenCalledTimes(1);
  expect(f.download.mock.calls[0]).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: '/Users/tong/a.wav' }),
  ]));
  f.manager.clear();
});

test('streaming never requests a half path; completion shows a playable card without auto play', async () => {
  const f = fixture();
  const raw = '正文\nMEDIA:/Users/tong/声音.wav';
  const result = await render(f.view(raw, true, false));
  expect(f.download).not.toHaveBeenCalled();
  await result.rerender(f.view(raw));
  await waitFor(() => expect(screen.getByLabelText('播放音频')).toBeOnTheScreen());
  expect(f.download).toHaveBeenCalledTimes(1);
  expect(mockPlayers[0].play).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText('播放音频'));
  expect(mockPlayers[0].play).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByLabelText('暂停音频'));
  expect(mockPlayers[0].pause).toHaveBeenCalledTimes(1);
  await fireEvent(screen.getByLabelText('音频进度'), 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
  expect(mockPlayers[0].seekTo).toHaveBeenCalledWith(5);
  f.manager.clear();
});

test('second audio pauses the first; background and leaving release each native player once', async () => {
  const f = fixture();
  const raw = 'MEDIA:/Users/tong/a.wav\nMEDIA:/Users/tong/b.wav';
  const result = await render(f.view(raw));
  await waitFor(() => expect(screen.getAllByLabelText('播放音频')).toHaveLength(2));
  await fireEvent.press(screen.getAllByLabelText('播放音频')[0]);
  await fireEvent.press(screen.getByLabelText('播放音频'));
  expect(mockPlayers[0].pause).toHaveBeenCalledTimes(1);
  await result.rerender(f.view(raw, false));
  expect(mockPlayers[1].pause).toHaveBeenCalledTimes(1);
  expect(mockPlayers.map((p) => p.remove.mock.calls.length)).toEqual([1, 1]);
  await result.unmount();
  expect(mockPlayers.map((p) => p.remove.mock.calls.length)).toEqual([1, 1]);
  f.manager.clear();
});

test('download errors keep prose and offer a real retry, never successful playback', async () => {
  const f = fixture(true);
  await render(f.view('正文保留\nMEDIA:/Users/tong/a.wav'));
  await waitFor(() => expect(screen.getByText('媒体下载失败，请重试。')).toBeOnTheScreen());
  expect(screen.getByText(/正文保留/)).toBeOnTheScreen();
  expect(screen.queryByLabelText('播放音频')).toBeNull();
  await fireEvent.press(screen.getByLabelText('重试媒体下载'));
  await waitFor(() => expect(f.download).toHaveBeenCalledTimes(2));
});

test('image opens a zoomable modal and closes; share receives unchanged raw source', async () => {
  const f = fixture();
  const raw = '正文\n![图](</Users/tong/你好 世界.png>)';
  const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
  await render(f.view(raw));
  await waitFor(() => expect(screen.getByLabelText('查看大图：你好 世界.png')).toBeOnTheScreen());
  await fireEvent.press(screen.getByLabelText('查看大图：你好 世界.png'));
  expect(screen.getByLabelText('大图，可缩放')).toBeOnTheScreen();
  await fireEvent.press(screen.getByLabelText('放大图片'));
  await fireEvent.press(screen.getByLabelText('关闭大图'));
  expect(screen.queryByLabelText('大图，可缩放')).toBeNull();
  await fireEvent(screen.getByLabelText('智能体消息，长按分享'), 'longPress');
  expect(share).toHaveBeenCalledWith({ message: raw });
  share.mockRestore();
  f.manager.clear();
});
