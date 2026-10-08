import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { requestAttach } from '../src/attach-bus';
import ChatScreen from '../src/app/chat/[id]';
import type { ChatItem } from '../src/components/message-row';
import type { RpcMethods } from '../src/vendor/hermes-gateway';
import { createFakeGateway, HOLD, rpcErr, type FakeGateway } from '../src/api/__tests__/fixtures/fake-gateway';
import { installFakeWebSocketGlobal, restoreWebSocketGlobal } from '../src/api/__tests__/fixtures/fake-socket';
import { event as frame } from '../src/api/__tests__/fixtures/frames';

let mockGateway: FakeGateway;
let mockRouteId = 'new';
const mockSnapshot: Partial<RpcMethods['session.resume']['result']> = {};
const mockPicker = jest.fn();
const mockRead = jest.fn(async () => 'YWJj');
const mockFiles = new Map<string, string>();
jest.mock('../src/api/gatewayClient', () => ({
  ...jest.requireActual('../src/api/gatewayClient'),
  makeNativeSocket: (url: string) => mockGateway.factory(url),
}));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: (...args: unknown[]) => mockPicker(...args) }));
jest.mock('expo-file-system', () => {
  class MockFile {
    uri: string;
    constructor(...parts: (string | MockFile)[]) { this.uri = parts.map((p) => typeof p === 'string' ? p : p.uri).join('/'); }
    get exists() { return mockFiles.has(this.uri); }
    get size() { return 3; }
    base64() { return mockRead(); }
    async text() { return mockFiles.get(this.uri)!; }
    write(value: string) { mockFiles.set(this.uri, value); }
    delete() { mockFiles.delete(this.uri); }
    async move(target: MockFile) { mockFiles.set(target.uri, mockFiles.get(this.uri)!); mockFiles.delete(this.uri); }
    async copy(target: MockFile) { mockFiles.set(target.uri, mockFiles.get(this.uri) ?? 'abc'); }
  }
  return { File: MockFile, Directory: class extends MockFile { create() {} }, Paths: { document: 'file:///private' } };
});
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: mockRouteId }), router: { push: jest.fn(), replace: jest.fn() } }));
jest.mock('expo-glass-effect', () => ({ isLiquidGlassAvailable: () => false }));
jest.mock('expo-haptics', () => ({
  impactAsync: async () => {}, notificationAsync: async () => {},
  ImpactFeedbackStyle: { Light: 'Light', Medium: 'Medium' }, NotificationFeedbackType: { Success: 'Success' },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 30, bottom: 24 }) }));
jest.mock('../src/connection', () => ({
  mintGatewayUrl: async () => 'ws://gateway/api/ws?ticket=test',
  connectionInfo: async () => ({ baseUrl: 'http://gateway', deviceId: 'device', username: '' }),
  withAuthRetry: async (fn: (rest: object) => unknown) => fn({ getMessages: async () => ({ messages: [] }), claimSession: async () => {} }),
}));
jest.mock('../src/api/models', () => ({ getModelInfo: async () => ({ model: 'test' }), modelDisplayName: (name: string) => name }));
jest.mock('../src/profile-store', () => ({ getProfileState: () => ({ selected: null }), hydrateProfileStore: async () => {} }));
jest.mock('../src/sidebar-store', () => ({ openSidebar: () => {} }));
jest.mock('../src/components/icon', () => ({ Icon: () => null }));
jest.mock('../src/components/message-row', () => ({
  MessageRow: (props: { item: ChatItem }) => require('react').createElement(require('react-native').View, { testID: 'message', item: props.item }),
}));

beforeAll(installFakeWebSocketGlobal);
afterAll(restoreWebSocketGlobal);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() { await act(async () => { for (let i = 0; i < 12; i++) await tick(); }); }
async function mount() {
  await render(React.createElement(ChatScreen));
  await settle();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add attachment' })).toBeEnabled());
  await settle();
}
const input = () => screen.getByPlaceholderText(/Chat with Hermes|Steer Hermes/);
async function type(text: string) { await fireEvent.changeText(input(), text); }
async function press(label: string) {
  const button = screen.getByRole('button', { name: label });
  expect(button).toBeEnabled();
  await act(async () => {
    await fireEvent.press(button);
    for (let i = 0; i < 12; i++) await tick();
  });
}
function messages(): ChatItem[] { return screen.queryAllByTestId('message').map((row) => row.props.item); }
function calls(method: string) { return mockGateway.sockets.flatMap((sock) => sock.sentFor(method)); }
async function event(type: string, payload: unknown = {}) {
  await act(async () => mockGateway.current().serverSend(frame(type, payload, { session_id: 'live' })));
  await settle();
}
const file = (name = '中文 报告.pdf') => ({ uri: `file:///phone/${name}`, name, mimeType: 'application/pdf', size: 3 });
async function pickFiles(assets = [file()]) {
  mockPicker.mockResolvedValue({ canceled: false, assets });
  await act(async () => requestAttach('files'));
  await settle();
}
beforeEach(() => {
  mockFiles.clear();
  mockRouteId = 'new';
  mockRead.mockClear();
  mockPicker.mockReset();
  for (const key of Object.keys(mockSnapshot)) Reflect.deleteProperty(mockSnapshot, key);
  Object.assign(mockSnapshot, { session_id: 'live', message_count: 0, messages: [], info: {}, running: false });
  mockGateway = createFakeGateway();
  mockGateway.responders['session.create'] = () => ({ session_id: 'live', stored_session_id: 'stored', info: {} });
  mockGateway.responders['session.resume'] = () => ({ ...mockSnapshot });
  mockGateway.responders['session.events.since'] = () => ({ events: [], latest_seq: 0, count: 0, truncated: false, epoch: 'e1' });
  mockGateway.responders['file.attach'] = (params) => ({ attached: true, ref_text: `@file:"${params.name}"`, path: '/host/a', name: params.name });
  mockGateway.responders['session.steer'] = (params) => ({ status: 'queued', text: params.text });
  mockGateway.responders['session.interrupt'] = () => ({ status: 'interrupted' });
  mockGateway.responders['prompt.submit'] = () => { mockSnapshot.running = true; return { status: 'streaming' }; };
});
afterEach(async () => { await cleanup(); });

test('file-only multi-attachment send: failed upload preserves selections, retry creates only one user bubble', async () => {
  await mount(); await pickFiles([file(), file('预算 表.xlsx')]);
  expect(mockPicker).toHaveBeenCalledWith({ type: '*/*', multiple: true, copyToCacheDirectory: true });
  let fail = true;
  mockGateway.responders['file.attach'] = (params) => {
    if (fail) { fail = false; return rpcErr(5028, 'upload failed'); }
    return { attached: true, ref_text: `@file:"${params.name}"`, path: '/host/a', name: params.name };
  };
  await press('Send message');
  expect(screen.getByRole('button', { name: 'Remove file 中文 报告.pdf' })).toBeOnTheScreen();
  expect(messages().filter((m) => m.role === 'user')).toHaveLength(0);
  await press('Send message');
  expect(messages().filter((m) => m.role === 'user')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Remove file 中文 报告.pdf' })).toBeNull();
  expect(calls('prompt.submit')[0].params).toMatchObject({ text: '@file:"中文 报告.pdf"\n@file:"预算 表.xlsx"', queued: true });
});

test('cancel and oversize picker results preserve existing text and attachments', async () => {
  await mount(); await type('draft'); await pickFiles();
  mockPicker.mockResolvedValue({ canceled: true, assets: null });
  await act(async () => requestAttach('files')); await settle();
  await pickFiles([{ ...file('big.pdf'), size: 11 * 1024 * 1024 }]);
  expect(input().props.value).toBe('draft');
  expect(screen.getByRole('button', { name: 'Remove file 中文 报告.pdf' })).toBeOnTheScreen();
  await press('Remove file 中文 报告.pdf');
  expect(screen.queryByRole('button', { name: 'Remove file 中文 报告.pdf' })).toBeNull();
});

test('busy FIFO has one server handoff; local tail can be restored and cancelled', async () => {
  await mount(); await type('initial'); await press('Send message');
  expect(input().props.editable).toBe(true);
  mockGateway.responders['prompt.submit'] = (params) => { mockSnapshot.queued = { user: params.text }; return { status: 'queued' }; };
  await type('first'); await press('加入队列 / Queue');
  await type('second'); await press('加入队列 / Queue');
  expect(screen.getByRole('button', { name: 'Cancel queued 1' })).toBeDisabled();
  await press('Restore queued 2 to draft');
  expect(input().props.value).toBe('second');
  await press('加入队列 / Queue'); await press('Cancel queued 2');
  await type('third'); await press('加入队列 / Queue');
  mockSnapshot.queued = null;
  mockSnapshot.inflight = { user: 'first', streaming: true };
  await event('message.start');
  expect(screen.getByText('1. third')).toBeOnTheScreen();
  expect(calls('prompt.submit').map((call) => call.params.text)).toEqual(['initial', 'first']);
  mockSnapshot.running = false; mockSnapshot.inflight = null;
  await event('message.complete');
  expect(calls('prompt.submit').map((call) => call.params.text)).toEqual(['initial', 'first', 'third']);
  expect(calls('prompt.submit').every((call) => call.params.queued === true)).toBe(true);
});

test('Stop persists pause before interrupt and never auto-dispatches tail; Continue resumes it', async () => {
  await mount(); await type('initial'); await press('Send message');
  mockGateway.responders['prompt.submit'] = (params) => { mockSnapshot.queued = { user: params.text }; return { status: 'queued' }; };
  await type('first'); await press('加入队列 / Queue');
  await type('tail'); await press('加入队列 / Queue');
  mockGateway.responders['session.interrupt'] = () => {
    const records = [...mockFiles.values()].filter((raw) => raw.startsWith('{"version"')).map((raw) => JSON.parse(raw));
    expect(records.some((record) => record.state.paused === true)).toBe(true);
    return { status: 'interrupted' };
  };
  await press('Stop response');
  mockSnapshot.running = false; mockSnapshot.queued = null;
  await event('message.complete', { status: 'interrupted' });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1600)); });
  expect(calls('prompt.submit').map((call) => call.params.text)).toEqual(['initial', 'first']);
  await press('继续队列 / Continue queue');
  expect(calls('prompt.submit').map((call) => call.params.text)).toEqual(['initial', 'first', 'tail']);
});

test('interim/tool/final transcript has no duplicate assistant segment', async () => {
  await mount(); await type('initial'); await press('Send message');
  await event('message.delta', { text: 'comment' });
  await event('message.interim', { text: 'comment', already_streamed: true });
  await event('tool.start', { tool_id: 't', name: 'terminal' });
  await event('tool.complete', { tool_id: 't', name: 'terminal', result: 'ok' });
  mockSnapshot.running = false;
  await event('message.complete', { text: 'final' });
  expect(messages().map((m) => [m.role, m.text])).toEqual([
    ['assistant', 'final'], ['tool', 'terminal'], ['assistant', 'comment'], ['user', 'initial'],
  ]);
});

test('steer ACK means accepted not consumed; rejection retains text without redirect or submit', async () => {
  await mount(); await type('initial'); await press('Send message');
  await type('correction'); await press('引导当前任务 / Steer');
  expect(input().props.value).toBe('');
  expect(messages().some((m) => m.text === 'correction' && m.steered)).toBe(true);
  expect(screen.getByText('引导已接受，未确认消费；压缩时可能转入下一轮。')).toBeOnTheScreen();
  mockGateway.responders['session.steer'] = (params) => ({ status: 'rejected', text: params.text });
  await type('rejected'); await press('引导当前任务 / Steer');
  expect(input().props.value).toBe('rejected');
  expect(calls('session.redirect')).toHaveLength(0);
  expect(calls('prompt.submit')).toHaveLength(1);
});

test('unknown steer stays visible and blocked after reconnect, without redirect or auto-submit', async () => {
  await mount(); await type('initial'); await press('Send message');
  mockGateway.responders['session.steer'] = (_params, sock) => { setTimeout(() => sock.drop(), 0); return HOLD; };
  await type('unknown correction'); await press('引导当前任务 / Steer');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
  expect(input().props.value).toBe('unknown correction');
  expect(screen.getByText('引导结果未确认，无法凭同文快照确认；文字保留，不自动重发。')).toBeOnTheScreen();
  expect(input().props.editable).toBe(false);
  expect(calls('session.steer')).toHaveLength(1);
  expect(calls('session.redirect')).toHaveLength(0);
  expect(calls('prompt.submit')).toHaveLength(1);
});

test('session switch restores unknown ACK and its local tail without repeated delivery', async () => {
  await mount(); await type('initial'); await press('Send message');
  mockGateway.responders['prompt.submit'] = (params, sock) => {
    mockSnapshot.queued = { user: params.text };
    setTimeout(() => sock.drop(), 0);
    return HOLD;
  };
  await type('first'); await press('加入队列 / Queue');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add attachment' })).toBeEnabled());
  await type('tail'); await press('加入队列 / Queue');
  await cleanup();
  mockRouteId = 'other'; await mount();
  expect(screen.queryByText('1. first')).toBeNull();
  await cleanup();
  mockRouteId = 'stored'; await mount();
  expect(screen.getByText('1. first')).toBeOnTheScreen();
  expect(screen.getByText('2. tail')).toBeOnTheScreen();
  expect(screen.getByText(/提交结果未确认，已暂停重发/)).toBeOnTheScreen();
  expect(calls('prompt.submit').map((call) => call.params.text)).toEqual(['initial', 'first']);
});
