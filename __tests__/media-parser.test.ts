import { parseMessageMedia, historyMedia } from '../src/lib/message-media';
import { historyToItems } from '../src/lib/history';

const sources = (text: string, complete = true) => parseMessageMedia(text, complete).map((m) => m.source);

test('MEDIA accepts Chinese, spaces, quotes, multiple tags and prose punctuation', () => {
  const raw = '图片：MEDIA:/Users/tong/生成 目录/你好 世界.png，语音 MEDIA:"/Users/tong/生成 目录/声音.m4a"。MEDIA:/Users/tong/a.wav!';
  expect(sources(raw)).toEqual([
    '/Users/tong/生成 目录/你好 世界.png', '/Users/tong/生成 目录/声音.m4a', '/Users/tong/a.wav',
  ]);
  expect(raw).toContain('，语音'); // parsing never rewrites the original message
});

test('markdown images, media links, file URLs and explicit bare lines share identities', () => {
  expect(sources([
    '![图](</Users/tong/你好 世界.png>)',
    '[听](file:///Users/tong/%E5%A3%B0%E9%9F%B3.wav)',
    '/Users/tong/你好 世界.png',
    'MEDIA:/Users/tong/你好 世界.png',
    '[外部](https://example.com/a.mp3)',
  ].join('\n'))).toEqual([
    '/Users/tong/你好 世界.png', '/Users/tong/声音.wav', 'https://example.com/a.mp3',
  ]);
});

test('streaming, code blocks, inline code, quoted teaching and prose bare paths do not fetch', () => {
  expect(sources('MEDIA:/Users/tong/half.png', false)).toEqual([]);
  expect(sources([
    '```text', 'MEDIA:/Users/tong/a.png', '```',
    '    MEDIA:/Users/tong/b.wav',
    '`MEDIA:/Users/tong/c.png`',
    '> 示例 MEDIA:/Users/tong/d.png',
    '例如 MEDIA:/Users/tong/example.png',
    '这是语法示例：![图](/Users/tong/f.png)',
    '请运行 /Users/tong/e.wav',
  ].join('\n'))).toEqual([]);
});

test('unsafe protocols, SVG, ambiguous extensionless and credential URLs are not admitted', () => {
  expect(sources([
    'MEDIA:/Users/tong/private',
    'MEDIA:/Users/tong/a.svg',
    '![恶意](javascript:alert)',
    'MEDIA:https://user:password@example.com/a.png',
    'MEDIA:data:image/svg+xml;base64,PHN2Zz4=',
  ].join('\n'))).toEqual([]);
});

test('Markdown image endpoints and scoped gateway URLs remain readable without guessing arbitrary local files', () => {
  expect(sources([
    '![生成图片](https://cdn.example/rendered?id=1)',
    '![网关图](/api/media?path=%2FUsers%2Ftong%2F%E5%9B%BE.png)',
    '[网关语音](https://gateway.example/prefix/api/fs/download?path=%2FUsers%2Ftong%2Fa.wav)',
    '![不能读](/Users/tong/arbitrary.txt)',
    '![SVG](https://cdn.example/a.svg)',
  ].join('\n'))).toEqual([
    'https://cdn.example/rendered?id=1', '/Users/tong/图.png',
    'https://gateway.example/prefix/api/fs/download?path=%2FUsers%2Ftong%2Fa.wav',
  ]);
});

test('quoted filesystem punctuation stays inside the filename and prose punctuation stays outside', () => {
  expect(sources('MEDIA:"/Users/tong/100% # ? 文件.png"，MEDIA:\'/Users/tong/stop!.wav\'；MEDIA:/Users/tong/a.mp3!')).toEqual([
    '/Users/tong/100% # ? 文件.png', '/Users/tong/stop!.wav', '/Users/tong/a.mp3',
  ]);
});

test('history keeps media-only assistant rows and preserves source text', () => {
  const content = [{ type: 'image_url', image_url: { url: '/Users/tong/图.png' } }];
  expect(historyMedia(content)).toEqual([expect.objectContaining({ kind: 'image', source: '/Users/tong/图.png' })]);
  const items = historyToItems([{ role: 'assistant', timestamp: 1, content }], () => 'row');
  expect(items).toEqual([expect.objectContaining({ key: 'row', text: '', complete: true, media: historyMedia(content) })]);
  const text = '原文\nMEDIA:/Users/tong/a.wav';
  expect(historyToItems([{ role: 'assistant', timestamp: 1, content: text }], () => 'row')[0].text).toBe(text);
});

test.each([
  '示例：\n\nMEDIA:/Users/tong/example.wav',
  '# 教学示例\n\nMEDIA:/Users/tong/example.wav',
  '例如下面的路径：\n\n![图](/Users/tong/example.png)',
  '# 教学示例\n\n下面演示音频语法。\n\nMEDIA:/Users/tong/example.wav',
  '示例：\n\nMEDIA:/Users/tong/example.wav\n\nMEDIA:/Users/tong/second.wav',
])('teaching scope crosses Markdown blocks without reading files: %s', (text) => {
  expect(sources(text)).toEqual([]);
});

test.each([
  '示例：\n\nMEDIA:/Users/tong/example.wav\n\n正式交付：\n\nMEDIA:/Users/tong/a.wav',
  '# 教学示例\n\nMEDIA:/Users/tong/example.wav\n\n# 正式交付\n\nMEDIA:/Users/tong/a.wav',
  '# 交付\n\n## 教学示例\n\nMEDIA:/Users/tong/example.wav\n\n## 音频\n\nMEDIA:/Users/tong/a.wav',
  '> 示例：\n>\n> MEDIA:/Users/tong/example.wav\n\nMEDIA:/Users/tong/a.wav',
  '上文提到了示例。\n\n这是生成的音频。\n\nMEDIA:/Users/tong/a.wav',
])('teaching scope does not swallow later delivery: %s', (text) => {
  expect(sources(text)).toEqual(['/Users/tong/a.wav']);
});

test('explicit extensionless history image survives as a media-only row', () => {
  const content = [{ type: 'image_url', image_url: { url: 'https://cdn.example/rendered?id=1' } }];
  expect(historyMedia(content)).toEqual([{
    source: 'https://cdn.example/rendered?id=1', kind: 'image', name: 'rendered',
  }]);
  expect(historyToItems([{ role: 'assistant', timestamp: 1, content }], () => 'row')).toEqual([
    expect.objectContaining({ text: '', media: historyMedia(content) }),
  ]);
});

test.each([
  'https://cdn.example/a.svg', 'javascript:alert(1)', 'data:image/png;base64,YQ==',
  'https://user:password@cdn.example/rendered', 'https://cdn.example/rendered?token=secret',
])('history image hint still rejects unsafe sources: %s', (url) => {
  expect(historyMedia([{ type: 'image_url', image_url: { url } }])).toEqual([]);
});

test('teaching words in delivered filenames and image labels do not open a teaching scope', () => {
  expect(sources('MEDIA:/Users/tong/示例.wav\n\n![示例图片](/Users/tong/示例.png)')).toEqual([
    '/Users/tong/示例.wav', '/Users/tong/示例.png',
  ]);
});
