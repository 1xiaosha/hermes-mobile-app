# Hermes Mobile 1.0.3 Build 4 媒体交接

日期：2026-10-10（Asia/Shanghai）。
唯一修改仓库 `/Users/tong/Projects/hermes-mobile-app`，分支
`feat/file-attachments`，起始 HEAD
`99b1dd188919272b8ee813f1be02d88590c07afc`。
未提交、推送、合并、部署、调用生产网关、读取真实凭据或调用模型。

## 用户可见行为

- 智能体完成态消息显示图片缩略图，点击打开大图，iOS 可双指缩放、
  使用放大/缩小按钮并关闭。
- MP3/M4A/WAV 显示播放/暂停、当前位置、总时长和可操作进度条，
  VoiceOver 支持前进/后退五秒。不会自动播放。
- 同时只允许一个音频播放；离开会话、进入后台或卸载消息行时停止并释放播放器。
- 下载、缓存写入、图片解码、音频加载/播放失败显示中文错误及重试；
  原正文保留，不显示假的播放或下载成功。
- 上传、全中文界面、发送 FIFO/ACK/steer 逻辑沿用原实现。
  仅为新增媒体 owner 补了聊天测试 mock 接口。

## 解析与原文

`src/lib/message-media.ts` 使用现有 Markdown 库的解析器处理完成态正文，
识别 `MEDIA:/Users/...`（中文、空格、单双引号、多标签、句尾标点）、
Markdown 图片/音频链接及独占一行的明确路径。
Markdown 的明确图片语法可识别 HTTPS 无扩展名 image endpoint；
明确网关媒体 route 的 path 参数转换为实际文件路径，保留冻结 scope。
支持绝对 POSIX 路径和 `~/`；Markdown `file:///Users/...` 在客户端转换成
网关路径，绝不交给手机原生文件读取器。
不承诺 relative/Windows/任意 file host；SVG、data URI 和未知媒体类型不预览。
视频及普通文件继续显示原正文/链接，未新增播放器或下载卡片。

流式半路径不解析；interim 封口、complete、history 使用同一完成态解析。
同一条消息的相同资源去重。消息之间不按正文去重；
沿用既有 `already_streamed` 语义及明确传输事件身份处理。
历史行与 replay 无可靠身份关联时保守保留，不保证无 ID replay 不重卡。
历史中的已验证 `image_url.url` parts 会保留，媒体独占的 assistant 行不丢弃。
围栏代码、缩进代码、行内代码、引用示例及明确教学示例不触发读取。
解析不改写 `ChatItem.text`；长按分享、文本导出、JSONL 导出保持原文。
Markdown 默认图片渲染被禁用，避免绕过认证/字节校验直接发起媒体请求。

## 实际网关协议与边界

独立只读 handler 探针报告：
`/Users/tong/.hermes/cache/scratch/mobile-media-contract-probe/REPORT.md`。
current 与 app pinned files router 共 61 条 HTTP 状态断言通过。
这份独立报告的 ID3 音频只证明协议/Range，不证明播放。

本客户端固定使用：

```text
GET <configured-base-prefix>/api/fs/download
    ?path=<encoded gateway path>
    &session_id=<stored session id>
    &profile=<captured profile, if explicit>
```

真实 handler 返回 binary；服务端无此 route 的大小上限，客户端强制
16 MiB、20 秒（含 headers/body）、逐块读取、实际 MIME/文件签名校验。
同 origin URL 只接受明确白名单路由，再转换为固定的 scoped fs/download；
未知同源地址拒绝，不向它们发送 Cookie。
反代 base prefix 保留。Cookie 只在请求头，URL 不含 token/ticket/password。
外部 HTTPS 直接读取，无网关 Cookie/Authorization，不接收其 Set-Cookie；
外部 HTTP 拒绝。全部媒体下载拒绝重定向。
不使用 media/proxy，不把 native player 直接接到认证远程 stream。

`/api/media` 是 images-only，返回 `data_url`，白名单 roots 且 25 MiB；
音频不能使用它。`/api/fs/read-data-url` 返回 `dataUrl`、16 MiB；
本实现不依赖 JSON data URL。没有修改或扩展任何网关权限。

**fs profile/session 不是文件归属 ACL，也不是 sandbox。**
本地 handler 只验证 session/profile 存在性、选择 relative cwd，
再应用 OS 权限和 sensitive denylist，绝对路径不限制在会话目录。
此版本针对用户 Mac host-local gateway；SSH 分支的 scope/sensitive 缺口、
managed-root stream 和 proxy 的跳转问题均不纳入本实现。

## 认证、owner 与缓存

- owner 冻结精确 `RestClient` 实例、profile、stored session 和设备身份；
  同地址的新连接仍创建新 owner，不在响应后改用当前连接读取资源。
- 延续 CookieJar 的过期感知串行刷新、Set-Cookie ingest、持久化 flush，
  通过 `withAuthRetry` 最多静默重登一次。旧 owner 的 401 不能重登新连接。
  媒体请求仍为 20 秒，未提高超时或改变 60 秒 AT freshness margin。
- `connection.ts` 只为 binary 注入 SDK 57 `expo/fetch`，其 native streaming
  支持 redirect error。安装版 `expo/ios/Fetch/NativeResponse.swift:190-201`
  对非 follow 返回 `completionHandler(nil)`，error 模式抛
  `FetchRedirectException`；已检查实际源码，未执行 iPhone native redirect 测试。
- 缓存 key 包含 message/source/kind，manager 独占其 owner。
  最多 8 项、32 MiB；最多两项下载并行，其余等待。每项最多 16 MiB。
  退出/后台取消 pending reads，过期响应不写入新缓存；
  LRU、会话清理和下一次启动清理仅操作 `hermes-message-media` cache tree。
  OS 已清除文件时清理为 best effort，不影响发送队列。
- 图片和音频最终只接收本机 app cache URI，无认证头、无 Mac file URL。
  文件头校验不保证所有编码都可解码，原生失败继续显示中文重试。
- 音频在 layout cleanup 暂停/解除绑定，早于 Expo hook 的 passive cleanup
  自动释放；测试 mock 对 release 后 pause 抛错，防止卸载顺序回归。

## TDD 与验收

已记录 RED 后修正：缺失 parser/owner/transcript 实现、反代前缀丢失、
Markdown encoded path 去重失败、多个小媒体下载预留空间误报缓存满、
native cache 初始化错误未中文化、持久化等待绕过 deadline、
以及 native player 已释放后才 pause 的卸载顺序错误。
新增测试覆盖 parser、render、immutable owner、401 重登/持久化、
403/404、HTML、声明/分块超限、全请求超时、取消、重定向、内外 origin、
会话切换、缓存清理、单音频和原文分享/导出。

HTTP fixture 使用本机隔离 HTTP server、host WHATWG fetch：
真实 decoded 1x1 PNG 和 100 ms、8 kHz、mono 16-bit PCM 非静音 WAV。
断言实际收到的 bytes、PNG IDAT 解压像素、WAV header/sample，
并写入/重读仓库 work 下的临时文件。TLS 外部地址隔离案例使用明确注入的
TLS termination bridge，实际 body 仍来自本机 fixture；未联系外部 origin。
超时 stall 使用可控 reader double。
播放器/图片原生部分使用 Jest mock，不代表真机听到或看到。

最终本地检查命令：

```sh
npx tsc --noEmit --incremental false
npx jest --runInBand --silent --json --outputFile=work/media-jest-results.json
npm run lint
node scripts/ui-copy-audit.cjs
npx expo export --platform ios --output-dir work/media-ios-export
git diff --check
```

最终结果：以上命令全部 exit 0。Jest 为 **99 suites / 1485 tests 全通过**；
文案审计为 617 项、0 违规；lint 为 0 errors / 0 warnings。
iOS export 成功生成 1908 modules 的 Hermes HBC：

```text
work/media-ios-export/_expo/static/js/ios/entry-4dd3e2c1a90c20a8bd10ef263b030eab.hbc
SHA-256 c636f8ddf8ee2c634e51447a340c0481155a35526b7a8f49b8fef209b12ade3d
```

Jest JSON 和 iOS export 保留在仓库 work；这两项生成物只加入本机
`.git/info/exclude`，不进入源码 diff 或 IPA workflow 提交。
HEAD 仍为起始 `99b1dd188919272b8ee813f1be02d88590c07afc`。
实现与验收已冻结，停止修改，等待父任务独立验收。

## 版本与下一步

app/package/root lock 为 1.0.3，iOS build 为 4；
中文 identity 与 `com.dintinoconte.hermesmobile` 保留。
唯一新增依赖是 `npx expo install expo-audio` 选择的 `~57.0.5`。
音频 plugin 使用中文权限文案，关闭 background playback/recording。
未引入 expo-av。新增原生模块必须构建/安装新 IPA，旧 Build 3 不能热更新获得。
unsigned IPA workflow 验证/产物名已经调整为 1.0.3 build4。

本机没有 full Xcode，未生成或签名 IPA，也未完成真机 UI/声音验收。
父任务独立验收冻结 diff 后，再由父任务处理已授权的 fork/PR#2/CI unsigned IPA。
本 assistant 不远写，完成检查后冻结并停止。

真机验收应覆盖：中文空格路径的真实图片/MP3/M4A/WAV、缩略图/大图缩放关闭、
拖动 seek/总时长、第二音频切换、进入后台/换会话立即停止、
401/403/404 和失效媒体重试，以及网络重定向拒绝。

## 2026-10-26 三项独立阻断最终修复

本节取代上文的旧测试数字、旧 HBC 哈希和仅凭相邻同正文去重的描述。
旧 writer 已停止，本轮未另启 writer。App 重启与 loopback CDP 的旧阻断
已由父任务解除，本轮没有再次重启 App。先读取 AGENTS 与 Expo v57 文档。
HEAD 仍为 `99b1dd188919272b8ee813f1be02d88590c07afc`，
分支仍为 `feat/file-attachments`。

### 三项修复及维护测试

1. `parseMessageMedia` 沿 Markdown 标题层级和前导教学段落保留教学范围。
   `示例：\n\nMEDIA:/Users/tong/example.wav` 经真实 MessageRow →
   MediaSession 的 download 为 **0 次**。同级/上级的新标题结束教学标题范围，
   新正文段落结束前导段落范围；后续正式交付仍识别并下载一次。
   文件名、图片 alt 和链接标签不作为教学前导，避免文件名含“示例”被误吞。
2. `historyMedia` 对明确 `image_url` part 传入 `image` hint。
   `https://cdn.example/rendered?id=1` 无扩展图片被保留，
   `historyToItems` 的纯媒体 assistant 行不再消失。
   SVG、危险协议、URL 凭据及 credential query 的拒绝规则继续通过。
3. ChatScreen 的实时 append/complete/interim 不再按相邻同正文删除。
   两个无可靠 ID、`already_streamed=false` 的独立实时 interim
   即使正文同为 `MEDIA:/Users/tong/a.wav`，仍显示 **2 行**；
   不同 seq、实时 interim 后的同文 complete、历史加载后的同文实时消息也保留。
   已完全删除 ChatScreen 的 `isHistoryMediaReplay`、
   `historyMediaTailRef`、replay window 及所有 `mediaAlreadyAtTail` 调用/导入。
   不用正文、尾行 key、时间或猜测窗口关联历史行和 replay 事件；
   沿用既有 `already_streamed` 及明确传输事件身份处理，
   无可靠身份就保留，不保证无 ID replay 不重卡。
   普通消息、既有 transport 去重、FIFO、ACK、steer 均未改。

相对父任务重启前备份
`/Users/tong/Projects/hermes-mobile-backups/before-codex-restart-20261026-131823/source-manifest.json`，
只修改 2 个实现文件、3 个维护测试文件，以及本交接文档：
`src/lib/message-media.ts`、`src/app/chat/[id].tsx`、
`__tests__/media-parser.test.ts`、`__tests__/message-media-view.test.tsx`、
`__tests__/chat-workflows.test.ts`。其余 22 个候选文件哈希不变。
未重新设计媒体服务、修改队列、认证、owner 或缓存边界。

### RED → GREEN 与独立探针

- 写维护测试后、修改实现前运行三套目标测试：
  **12 failed / 27 passed**，证据 `work/precise-red.json`。
- 将独立探针三个原件逐字复制到隔离 runner，通过 src symlink 测试当前源码；
  SHA-256 核对三个副本与原件完全相同，未改独立断言。
  修复前精确 `-t independent` 为 **5 failed / 2 passed**，
  RED JSON 保留在
  `/Users/tong/Documents/Codex/2026-10-26/hermes-mobile-1-0-3-build/work/precise-probes/red-results.json`。
- 修复后分别重跑原件副本：`independent-review.test.ts` **5/5**，
  `message-media-view.test.tsx` 独立用例 **1/1**，
  `chat-workflows.test.ts` 独立用例 **1/1**；共 **7/7**，三个进程均 exit 0。
  新 GREEN 证据为仓库 `work/probe-results.json`、
  `work/render-probe-results.json`、`work/dedupe-probe-results.json`。
  外部 scratch 原 RED 证据没有覆盖。
  原探针中 helper 同文比较为 true 的断言仍保留；
  该 helper 未用于 ChatScreen，不能用这个断言证明消息身份或删除消息。
  最终真实聊天页探针同时验证实时两行、无历史行身份的 replay 两行和跨新轮 replay 两行。

父任务最终 P2 复核发现窗口仍会漏消息后，本轮仅再修改聊天页、维护测试
和本文档；教学解析与历史图片实现保持通过时的内容不变。
维护测试先记录 **2 failed**（`work/precise-replay-red.json`），
随后删除整个聊天页媒体同文历史折叠机制。
父任务最后两份探针来自
`/Users/tong/.hermes/cache/scratch/mobile-media-final-three/snapshot/__tests__/`，
分别为 `independent-three-chat.test.ts`、`independent-three-row.test.tsx`；
隔离副本逐字相同并核对 SHA-256，原件及 `verified-results.json` 未修改。
精确 RED 为 **27 tests / 25 passed / 2 failed**，
`work/precise-final-three-red.json`；
最终 GREEN 为 **27/27**，`work/precise-final-three-green.json`。
两条曾失败的边界均经真实 ChatScreen / fake gateway 复现并通过：

- 历史尾为 `MEDIA:/Users/tong/a.wav`，replay
  `complete(seq20) → start(seq21) → 同文 interim(seq22, already_streamed=false)`：
  **2 行**。
- 同样历史尾，单独 replay 同文 interim、无法关联可靠历史行身份：
  **2 行**。

维护测试已经用这两条保留消息的断言替换“窗口消费一次”的错误预期。
既有 `already_streamed=true` 单行控制也通过。未更改队列、认证或缓存。

隔离 runner 配置：
`/Users/tong/Documents/Codex/2026-10-26/hermes-mobile-1-0-3-build/work/precise-probes/jest.config.cjs`。
精确重跑方式（`<file>` 依次为三个探针文件，`<result>` 对应上述 GREEN JSON）：

```sh
npx jest --config /Users/tong/Documents/Codex/2026-10-26/hermes-mobile-1-0-3-build/work/precise-probes/jest.config.cjs \
  --runInBand --silent --runTestsByPath \
  /Users/tong/Documents/Codex/2026-10-26/hermes-mobile-1-0-3-build/work/precise-probes/tests/<file> \
  -t independent --json --outputFile=work/<result>
```

### 最终检查及冻结

本轮以下命令均 exit 0：

```sh
npx tsc --noEmit --incremental false
npx jest --runInBand --silent --json --outputFile=work/media-jest-results.json
npm run lint
node scripts/ui-copy-audit.cjs
npx expo export --platform ios --output-dir work/media-ios-export
git diff --check
```

全 Jest 为 **99 suites / 1509 tests**，比修复前新增 24 项维护用例。
lint 为 0 errors / 0 warnings；中文文案审计仍为 **617 项 / 0 违规**。
iOS export 成功生成 **1908 modules** 的 HBC：

```text
work/media-ios-export/_expo/static/js/ios/entry-b2b94efdc437406311ed7e3280b1680d.hbc
SHA-256 ad0f827da24924c63a41051cb20652c9cb37c029c87498ed3c5d143d94c0bb2c
```

依据父任务提供的该版尚未发布状态，维持 **1.0.3 / Build 4**，
未再次升号；中文 identity、bundle `com.dintinoconte.hermesmobile`、
安装版 `expo-audio 57.0.5` 均不变。
native player / image 使用 mock，**不是 iPhone 真机验证**；
iOS export 也不是 native IPA 构建或签名验证。本轮未生成该版 IPA。

28 个候选文件的逐文件 SHA-256 及整体候选哈希记录在：
`/Users/tong/Documents/Codex/2026-10-26/hermes-mobile-1-0-3-build/outputs/source-freeze.json`。
其中排除本文档的 27 个源码/配置/维护测试文件，按相对路径排序，
以 UTF-8 `${sha256}  ${path}\n` 拼接后计算 SHA-256：
`1097e4b3671e72bef9aa4f7b9087fba0f3ef8c7a8d10230f0fa09e58fca63e28`。
本文档最终哈希另计入 28 文件清单，避免文档自引用哈希。
本地验证证据已通过 `.git/info/exclude` 排除，不进入提交。

源码冻结并停止修改；未 commit/push/merge、触发 Actions、修改生产网关或远写。
父任务先独立验收，再处理已授权的 fork1xiaosha 分支、PR #2、
Actions unsigned IPA；若发现该版本实际已发布，应先递增 build。
下载产物后由父任务核对 Info.plist、arm64、中文权限、unsigned、
ZIP 完整性及 SHA-256，并用实际 IPA 的 MEDIA 文件卡交付。
