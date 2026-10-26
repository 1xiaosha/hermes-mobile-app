import { MarkdownIt } from 'react-native-markdown-display';

export type MediaKind = 'image' | 'audio';
export interface MessageMedia { source: string; kind: MediaKind; name: string }
const EXTENSIONS = 'png|jpe?g|gif|webp|bmp|mp3|m4a|wav';
const imageExt = /^(png|jpe?g|gif|webp|bmp)$/i;
const audioExt = /^(mp3|m4a|wav)$/i;
const teaching = /(?:示例|例如|举例|教学|语法|用法|(?:^|\s)example(?:\s|:)|(?:^|\s)e\.g\.)/i;
const parser = MarkdownIt({ html: false, linkify: false });
const gatewayRoute = /\/api\/(?:media|fs\/download|files\/(?:download|stream))$/;
const credentialKey = /^(?:token|ticket|password|authorization|access_token|refresh_token)$/i;
// Parse local media destinations without ever opening them on the phone.
parser.validateLink = (url: string) => /^(?:https?:|file:|\/|~\/|#media:)/i.test(url);

export function mediaReference(raw: string, hint?: MediaKind): MessageMedia | null {
  let source = raw.trim();
  if (!source || source.length > 4096 || /[\u0000-\u001f]/.test(source)) return null;
  if (source.startsWith('#media:')) {
    try { source = decodeURIComponent(source.slice(7)); } catch { return null; }
  }
  if (source.startsWith('//')) return null;
  if (source.startsWith('/') && gatewayRoute.test(source.split('?')[0]) && source.includes('?')) {
    try {
      const route = new URL(source, 'https://gateway.invalid');
      if ([...route.searchParams.keys()].some((key) => credentialKey.test(key))) return null;
      const path = route.searchParams.get('path') ?? '';
      return /^(?:\/(?!\/)|~\/|file:)/i.test(path) ? mediaReference(path) : null;
    } catch { return null; }
  }
  if (/^file:/i.test(source)) {
    try {
      const url = new URL(source);
      if (url.hostname || url.search || url.hash) return null;
      source = decodeURIComponent(url.pathname);
    } catch { return null; }
  }
  let namePath = source;
  if (/^https?:/i.test(source)) {
    try {
      const url = new URL(source);
      if (url.username || url.password || [...url.searchParams.keys()].some((key) => credentialKey.test(key))) return null;
      if (gatewayRoute.test(url.pathname)) {
        const path = url.searchParams.get('path') ?? '';
        if (!/^(?:\/(?!\/)|~\/|file:)/i.test(path)) return null;
        const local = mediaReference(path);
        if (local) url.searchParams.set('path', local.source);
        return local ? { ...local, source: url.toString() } : null;
      }
      source = url.toString();
      namePath = decodeURIComponent(url.pathname);
    } catch { return null; }
  } else if (!/^(?:\/|~\/)/.test(source)) return null;
  // Template placeholders are instructions, not delivered files.
  if (/[<>]/.test(namePath)) return null;
  const name = namePath.split('/').pop() ?? '';
  const ext = name.split('.').pop() ?? '';
  const kind = imageExt.test(ext) ? 'image' : audioExt.test(ext) ? 'audio'
    : hint === 'image' && /^https:/i.test(source) && !/\.[a-z0-9]+$/i.test(name) ? 'image' : null;
  return kind ? { source, kind, name } : null;
}

/** Complete messages only. Markdown's parser excludes code fences/indented code;
 * inline code and quoted examples never become request candidates. */
export function parseMessageMedia(text: string, complete: boolean): MessageMedia[] {
  if (!complete || !text) return [];
  const media: MessageMedia[] = [];
  const seen = new Set<string>();
  function add(raw: string, encoded = false, hint?: MediaKind) {
    if (encoded && raw.startsWith('/') && !gatewayRoute.test(raw.split('?')[0])) {
      try { raw = decodeURIComponent(raw); } catch { return; }
    }
    const ref = mediaReference(raw, hint);
    if (ref && !seen.has(ref.source)) { seen.add(ref.source); media.push(ref); }
  }
  let quoteDepth = 0;
  let headingLevel = 0;
  let teachingHeading: number | null = null;
  let teachingLead = false;
  for (const block of parser.parse(text, {})) {
    if (block.type === 'blockquote_open') quoteDepth++;
    if (block.type === 'blockquote_close') quoteDepth--;
    if (quoteDepth) continue;
    if (block.type === 'heading_open') {
      headingLevel = Number(block.tag.slice(1));
      if (teachingHeading !== null && headingLevel <= teachingHeading) teachingHeading = null;
      teachingLead = false;
    }
    if (block.type !== 'inline') continue;
    // Read scope from prose, never from filenames, image alt text or link labels.
    let linkDepth = 0;
    const prose = (block.children ?? []).map((token: { type: string; content: string }) => {
      if (token.type === 'link_open') linkDepth++;
      if (token.type === 'link_close') linkDepth--;
      if (token.type === 'softbreak' || token.type === 'hardbreak') return '\n';
      return token.type === 'text' && !linkDepth ? token.content : '';
    }).join('').replace(/^\s*(?:MEDIA:|\/|~\/|file:).*$/gmi, '').trim();
    if (headingLevel) {
      if (teaching.test(prose) && teachingHeading === null) teachingHeading = headingLevel;
      headingLevel = 0;
    } else if (prose) {
      // A lead covers following media blocks until the next prose paragraph.
      teachingLead = teaching.test(prose);
    }
    if (teachingHeading !== null || teachingLead) continue;
    for (const token of block.children ?? []) {
      if (token.type === 'image') add(token.attrGet('src') ?? '', true, 'image');
      if (token.type === 'link_open') add(token.attrGet('href') ?? '', true);
      if (token.type !== 'text') continue;
      const tags = new RegExp(
        `\\bMEDIA:\\s*(?:"([^"\\n]+)"|'([^'\\n]+)'|((?:https?:\\/\\/|\\/|~\\/)[^\\n]*?\\.(?:${EXTENSIONS})(?:\\?[^\\s，。；！）"']*)?(?=[\\s，。；！!?,;:.)\\]}*]|MEDIA:|$)))`, 'gi',
      );
      for (const match of token.content.matchAll(tags)) add(match[1] ?? match[2] ?? match[3] ?? '');
    }
    // A bare path must occupy a whole non-code line.
    if (!(block.children ?? []).some((t: { type: string }) => t.type === 'code_inline')) {
      for (const line of block.content.split('\n')) {
        const bare = line.trim().replace(/^["'](.*)["']$/, '$1');
        if (/^(?:\/|~\/|file:)/i.test(bare)) add(bare);
      }
    }
  }
  return media;
}

/** Verified OpenAI image_url parts are independent of text; unknown blobs stay ignored. */
export function historyMedia(content: unknown): MessageMedia[] {
  if (!Array.isArray(content)) return [];
  const media = new Map<string, MessageMedia>();
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const url = part.type === 'image_url' ? part.image_url?.url : undefined;
    if (typeof url !== 'string') continue;
    const ref = mediaReference(url, 'image');
    if (ref) media.set(ref.source, ref);
  }
  return [...media.values()];
}

export function messageMedia(text: string, complete: boolean, parts?: MessageMedia[]): MessageMedia[] {
  if (!complete) return [];
  return [...new Map([...parseMessageMedia(text, true), ...(parts ?? [])].map((m) => [m.source, m])).values()];
}

/** Content comparison only: callers must establish a history replay window
 * before folding a candidate. Equal text alone never identifies a live event. */
export function mediaAlreadyAtTail(items: readonly { role: string; text: string; complete?: boolean }[], text: string): boolean {
  const last = items[items.length - 1];
  return last?.role === 'assistant' && Boolean(last.complete) && last.text === text && parseMessageMedia(text, true).length > 0;
}
