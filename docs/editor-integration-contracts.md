# G1 集成契约与入口边界

这是 `editor-api.md` D1/D7/D8/D9 的辅助类型交付，不是集成运行时。
没有安装 parser、LSP server、shaper、字体或 vgpu，也没有宣称它们的能力已验收。
所有工厂目前只存在于 `*Factories` 类型中；六个子入口的 ESM 为空模块，
不能将 `import type` 改成可调用工厂的 value import。

## 入口图

| 公开入口 | 声明依赖 | lib | 当前运行时 |
| --- | --- | --- | --- |
| root | identity、errors、core、collaboration | ES2022 | 身份构造器、`EditorError` |
| `/collaboration` | core、identity、errors | ES2022 | 无 |
| `/languages` | core、identity | ES2022 | 无 |
| `/lsp` | core、identity、errors | ES2022 | 无 |
| `/shaping` | core、identity | ES2022 | 无 |
| `/vgpu` | core、languages、shaping、identity、errors | ES2022 + DOM | 无 |
| `/browser` | core、shaping、errors | ES2022 + DOM | 无 |

这些是本库接口，不是第三方 vgpu、parser 或 shaper 的 API 声明。root 不反向
导出集成类型；原有 root 协作类型导出保留兼容，同时提供规范的 `/collaboration`。
tsdown 为重复类型生成共享声明 chunk；不能只测入口 `.d.ts` 大小而遗漏闭包。
DOM 不进入前五个入口的声明闭包。parser/WASM/字体/原生 bridge/playground 不在 root。

`tsconfig.json` 保持 ES-only，`tsconfig.browser.json` 单独检查 DOM 契约。
构建声明时允许 DOM，但实际包消费者分别以无 DOM 和有 DOM、`types: []`、
`skipLibCheck: false` 验证。给所有源码开启 DOM 会掩盖泄露，不能替代这两个门禁。

## 语法：完整源与可信 edit 链

- `SyntaxPlugin.metadata` 明确 runtime 名称/版本，以及 grammar/query 的来源、版本、
  许可与 digest。元数据不代替之后的许可/兼容性实测，也不是已下载资产。
- registry 仅登记语言。产品通过 `SyntaxService.setLanguage({document,language})`
  显式选择源文档语言，不从文档 ID 猜文件名。未选择/未登记语言时 classify
  报 `UNSUPPORTED_CAPABILITY`；view 不传 syntax provider 时才走明确的 plain 显示。
  这是补齐原先未展开的辅助接口，不改变 `register`/`attachSyntax`/`classify` 签名。
- parser 接收不可变源快照；`previous` 只有携带从旧树 revision 到目标 revision 的
  完整连续 `SyntaxChange` 链才允许复用。每步 edits 对该步旧快照同时解释。
  适配器负责转为 parser 单位，不把 UTF-16 offset 当 byte offset。
- 新树不得修改旧树；service 拥有新建 parser、树与缓存。解析结果绑定源
  document/revision，分类另带 `GrammarGeneration`。过期结果不可盖住新结果。
- `SyntaxService` 同时满足 `DiffSyntaxProvider`：旧/新侧查完整保留源，不解析拼接 hunk。
  分类只给 range/type/modifiers；主题、semantic 属性覆盖和绘制是后续独立步骤。

## LSP：协议位置与源位置不混用

- JSON-RPC transport 仍只管有序 message 交付/背压/断开。params 为对象或数组；
  成功/失败响应互斥，未知入站 message 由未来 runtime 完整验证。
- `LspInitializationOptions` 是宿主选项，不是原样外传的完整 InitializeParams；
  实现负责补齐 processId、只包含已实现能力的 capabilities 和握手顺序。
  `LanguageCapabilities` 是协商结果，不是当前骨架已经提供这些能力的声明。
- feature 请求只接受 `TextPoint` 和源 `RevisionId`，不接受 projection/visual/glyph。
  回应带 `{document,revision,uri,version,generation}`；`stale` 分支没有 `value`。
  类型不能证明两个动态 revision 相等，runtime 仍须验证。
- `sync` 是有序发送保证，不是服务器分析 ACK。`none` 不得假报编辑已同步。
  同 base 并行 edits 必须转换为协议顺序变化；协商编码与回看版本规则沿用 D8。
- versioned diagnostics 使用精确源范围与 stamp；`unversioned` 只有协议范围、
  encoding 和连接 generation，没有杜撰的 revision。外部 definition 保留 URI/
  encoding，由产品加载，库不读文件。markup 始终是不可信数据。
- completion 的 `SourceEditProposal` 提供完整 head checkpoint 和统一 `SourceEdit[]`，
  由产品显式 `head.commit`，不在响应到达时偷偷应用。
  `prepareWorkspaceEdit` 同样要求捕获的 `LspStamp[]`；缺失/过期映射拒绝，
  不把无版本 wire edit 推断为最新源。任一文档失败整批拒绝。
  文本-only `LspWorkspaceEdit` 不含 create/rename/delete；未知 wire resource operations
  仍须由 decoder 拒绝，不能依靠 TypeScript 过滤不可信数据。

协议依据为 [LSP 3.17 initialize](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#initialize)
与 [publishDiagnostics](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_publishDiagnostics)；
本轮核对了官方 initialize 源文档及 `PublishDiagnosticsParams.version?`。
没有用类型检查冒称真实服务器互操作通过。

## 塑形、几何与输入

- `LoadedFont` 暴露真实 family/font ID/unitsPerEm；输入字节必须复制，不能成为可变别名。
  `Shaper` 接收明确 font、源范围、方向/script/language/features；结果为实际
  glyph/cluster/source mapping 和 **font units** 的 advances/offsets。
- `LayoutEngine` 转成 **CSS pixels**。`VisualPoint/VisualRect` 绑定
  `LayoutGeneration`，与 grammar generation、glyph cluster 和源点互不兼容。
  hit-test/selection geometry 来自同一个 layout snapshot，输出源 revision 与 excerpt。
  `PositionedGlyph.font` 是实际 fallback face，不是伪装成 primary。
- caret stop 声明 font/grapheme-interpolation/boundary 的来源。这里没有实现
  grapheme/bidi/ligature caret 算法，也没有字体 on/off 或栅格化证据。
- `/vgpu` 只绑定 canvas；editor view 实现共享 `EditorGeometry`，
  Diff view 只接受不可变 report，激活携带 document/side/revision/源点。
  resize 单位、DPR、状态订阅、显式 recover/dispose 均有类型契约。
  初始化/设备丢失错误不静默变成 Canvas renderer。
- `/browser` 只借用产品输入元素/session/geometry；composition event
  的 cancelled 分支保留 `recoverableText`。primary-only 预览/一次 undo group、
  稳定目标失效取消的实际状态机留给 P6，不以事件类型冒称 IME 已支持。

## 所有权

| 句柄 | 自建并释放 | 默认借用，不连带释放 |
| --- | --- | --- |
| registry | 注册记录 | 注入 plugin/资产定义 |
| syntax service | parser、树、worker/cache | head、registry |
| language client/binding | 请求队列、订阅、绑定状态 | transport、head |
| font handle | 解码字体/内部字节副本 | 不保留输入字节的可变别名 |
| layout engine | layout/cache | shaper、fonts、当前计算用源快照 |
| editor view | atlas/GPU/渲染订阅 | session、layout |
| Diff view | atlas/GPU/局部视图状态 | report 值、layout、syntax |
| input binding | 输入监听/组合预览状态 | element、session、geometry |

全部遵守 D1 的幂等 dispose/活动借用阻止释放规则；借用者先释放，
不是通过级联销毁来清理外部资源。不可变值不会因句柄释放而被改写。
这张表定义待实现的责任，未声称已有资源管理运行时。

## 门禁与后续

- `pnpm test:types`：核心/集成 ES-only 用例与独立 DOM 用例；正向工作流与
  `@ts-expect-error` 负例覆盖坐标、generation、stale/unversioned、只读结果、
  protocol envelope 与未实现的 value exports。
- `pnpm test:consumer`：包名解析全部七个实际产物入口；前五个 ES-only，
  浏览器 fixture 单独加 DOM，原生 `AbortSignal` 对核心 signal 结构兼容。
  独立 Node 对全部入口设置 DOM/network tripwires，六个子入口必须没有运行时导出。
- 同一命令中的文档检查直接提取 `editor-api.md` 全部 12 个 TS 代码块：
  以正确 lib 编译，声明/工厂与公开类型双向可赋值。改变 offset 参数为 string
  的负对照必须失败。历史备选 A/C 不是规范示例，不承诺它们可运行。
- `pnpm build` / `pnpm measure:package`：七入口 ESM/declarations 与声明闭包大小。
  真实资源/性能/LSP/GPU/字体/IME/读屏检查仍须在对应 P5–P8 阶段执行。

G1 的工具、公共类型与入口门禁已可用于 P2；没有新增生产依赖需要批准。
集成运行时依赖审查按实际安装阶段保持未完成，不能据此发布“可用编辑器”。
