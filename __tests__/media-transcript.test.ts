import { mediaAlreadyAtTail, parseMessageMedia } from '../src/lib/message-media';
import { closeStreaming } from '../src/lib/transcript-rows';
import { historyToItems } from '../src/lib/history';
import { exportAsJsonl, exportAsText } from '../src/lib/export';

const text = '正文保留\nMEDIA:/Users/tong/图片.png\nMEDIA:"/Users/tong/声音 文件.wav"';
test('stream completion, interim and reloaded history have identical media and original text', () => {
  const streaming = [{ key: 'live', role: 'assistant', text, complete: false }];
  expect(parseMessageMedia(streaming[0].text, streaming[0].complete)).toEqual([]);
  const interim = closeStreaming(streaming);
  const history = historyToItems([{ role: 'assistant', content: text, timestamp: 1 }], () => 'history');
  expect(parseMessageMedia(interim[0].text, true)).toEqual(parseMessageMedia(history[0].text, true));
  expect(history[0].text).toBe(text);
  expect(JSON.parse(exportAsJsonl(history)).text).toBe(text);
  expect(exportAsText(history)).toBe(`Hermes: ${text}`);
  expect(mediaAlreadyAtTail(interim, text)).toBe(true);
  expect(mediaAlreadyAtTail(history, text)).toBe(true);
});

test('only an exact completed media tail is a duplicate; a new user turn and prose remain independent', () => {
  expect(mediaAlreadyAtTail([{ role: 'assistant', text, complete: false }], text)).toBe(false);
  expect(mediaAlreadyAtTail([{ role: 'assistant', text, complete: true }], text + '\n新的正文')).toBe(false);
  expect(mediaAlreadyAtTail([{ role: 'assistant', text, complete: true }, { role: 'user', text: '再来一张' }], text)).toBe(false);
  expect(mediaAlreadyAtTail([{ role: 'assistant', text: '普通正文', complete: true }], '普通正文')).toBe(false);
  const example = '```text\nMEDIA:/Users/tong/a.png\n```';
  expect(mediaAlreadyAtTail([{ role: 'assistant', text: example, complete: true }], example)).toBe(false);
});
