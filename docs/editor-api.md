# Editor API 决策与接口契约

Status: locked (2026-10-27)

后续明确变更：用户已确认开放 **CRDT/历史后端替换能力**，而不只是产品模式编排；
又要求支持外部文本存储的仅渲染模式。D11/D12 记录这两项边界扩展；
默认 FugueMax 的内部格式不再被解释成所有后端或只读文本源的约束。

此状态锁定的是**待实现的公共契约**，不是“已有可用库”。用户已确认 B、编辑策略、可选连字资产、首版语言范围、单次提交 Diff，并要求继续；本文件据此收敛签名、默认值、失败语义与非目标。不声称用户逐字审阅过每个类型声明。后续不能因实现方便悄悄修改这些决定；发现算法或依赖无法支持时，先列出冲突，请用户重开对应决策。

规范优先级：用户后续明确决定 → 本文件 → [行为合同](./editor-contract.md) → [备选方案与讨论记录](./editor-api-options.md)。本文补充而不削弱合同。代码块是声明/使用规范，不是已存在的导出；辅助类型的实现声明由类型契约测试验证。实施顺序见 [实施计划](./editor-implementation-plan.md)，集成辅助接口与入口/所有权边界见 [G1 集成契约](./editor-integration-contracts.md)。

## D1. 所有权、入口与生命周期

选择 B：`HistoryStore → EditingHead → EditorSession`。store 保存原生历史，head 选择版本，会话拥有选区与本地撤销状态；MultiBuffer 是源映射投影，不存第二份可写文本。

| 入口 | 公共责任 |
| --- | --- |
| `@zixiao-labs/editor` | 历史、head、session、MultiBuffer、坐标、Diff、错误类型 |
| `/collaboration` | 历史同步、presence 端口与编码边界 |
| `/languages` | 语言注册、增量语法服务 |
| `/lsp` | JSON-RPC/LSP 与源文档绑定 |
| `/shaping` | 字体、塑形和布局；具体适配器按需加载 |
| `/vgpu` | 可编辑 view、只读局部 Diff view |
| `/browser` | 输入与可访问性桥 |

根入口及其声明不得迫使 headless 消费者导入 DOM、GPU、socket、字体或 parser。核心异步 API 的 `signal` 类型是结构化 `CancellationSignal`，不直接依赖 DOM 的 `AbortSignal` 声明；浏览器原生 signal 可经结构兼容或 browser 适配器接入。必须用不含 DOM lib 的 consumer 类型测试核实，不凭声明名称保证兼容。

所有资源有幂等 `dispose()`。工厂自建资源由返回句柄释放，注入资源默认借用。活动借用阻止所有者释放时，报 `RESOURCE_IN_USE`，不隐含级联销毁；view/input 释放不销毁 session/head/store。已复制出的不可变文本、Diff 报告不随句柄释放而变化。

拒绝 A：多文档协调责任分散。拒绝 C：宿主需要承担过多状态发布与 effects 调度。

## D2. 身份、坐标、不可变值

分别导出验证构造器及 opaque 类型：`DocumentId`、`ExternalBaseId`、`RevisionId`、`ActorId`、`ReplicaId`、`TransactionId`、`OperationId`、`TransactionGroupId`、`SelectionId`、`ExcerptId`。head/session/commit 的本地身份与历史身份不同。

```ts
interface RevisionEntry {
  readonly document: DocumentId;
  readonly revision: RevisionId;
}
interface RevisionSet {
  get(document: DocumentId): RevisionId;
  has(document: DocumentId): boolean;
  entries(): Iterable<RevisionEntry>;
}
interface HeadCheckpoint {
  readonly headId: HeadId;
  readonly stamp: HeadStamp;
  readonly revisions: RevisionSet;
}
interface TextPoint {
  readonly document: DocumentId;
  readonly revision: RevisionId;
  readonly unit: "utf16" | "utf8" | "scalar";
  readonly offset: number;
}
interface SourceEndpoint {
  readonly document: DocumentId;
  readonly position: StablePosition;
  readonly excerpt?: ExcerptId;
}
```

`RevisionSet.get` 对缺失成员抛 `UNKNOWN_DOCUMENT`，不是可修改 Map。`RevisionId` 指因果闭合历史集合，不能用文本 hash 相等代替历史相等。`HeadStamp` 只用于同一 head 的 CAS/ABA 检查，不作为可同步版本。`SessionCheckpoint` 包含源 head checkpoint、selection version、projection membership version。

快照签名：

```ts
interface TextSnapshot extends Disposable {
  readonly document: DocumentId;
  readonly revision: RevisionId;
  readonly lengthUtf16: number;
  text(): string;
  readUtf16(start: number, end: number): string;
  pointUtf16(offset: number): TextPoint;
  pointUtf8(offset: number): TextPoint;
  pointScalar(offset: number): TextPoint;
  convertPoint(point: TextPoint, unit: TextPoint["unit"]): TextPoint;
  rangeUtf16(start: number, end: number): TextRange;
  anchorUtf16(offset: number, options: { affinity: "before" | "after" }): StablePosition;
  stableRangeUtf16(start: number, end: number, options: {
    startAffinity: "before" | "after";
    endAffinity: "before" | "after";
  }): StableRange;
}
```

范围半开且绑定文档/revision/unit。拒绝错误 revision、越界、反向非方向性范围、surrogate 中点和孤立 surrogate；不做 Unicode/EOL 归一化。低层操作可以切开 grapheme，交互导航/删除不能以 UTF-16 单元代替 grapheme。

CRLF 占两个 UTF-16 单元、一个逻辑换行；单独 CR/LF 也识别。CRLF 中间点若无法表示为行列，转换报 `INVALID_BOUNDARY`，低层显式编辑不偷偷改写。session 键入换行默认 LF，可设 CRLF；粘贴保留原串。

快照、事件、版本集、选区与 Diff 报告在运行时不可变。只写 `readonly` 或冻结可修改 Map 外壳不够；输入数组/JSON/字节缓冲区不得成为内部可变别名。

拒绝一个裸 `number` 同时表示源 offset、投影 offset 和 glyph cluster。

## D3. 原生历史、隔离 head、事务与保留

```ts
declare function createHistoryStore(options?: HistoryStoreOptions): HistoryStore;

interface HistoryStore extends Disposable {
  readonly backend: HistoryBackendDescriptor;
  readonly undo?: HistoryUndoProvider;
  createDocument(input: {
    id: DocumentId;
    base: { id: ExternalBaseId; text: string };
  }): RevisionEntry;
  openWriter(input: { actor: ActorId; replica: ReplicaId }): Writer;
  revisions(entries: readonly RevisionEntry[]): RevisionSet;
  fork(input: { at: RevisionSet; writer: Writer }): EditingHead;
  snapshot(input: RevisionEntry): TextSnapshot;
  pin(input: { revisions: RevisionSet }): RetentionHandle;
  exportPosition(input: { position: StablePosition }): ExportedPosition;
  importPosition(token: PositionToken): ExportedPosition;
  exportHistory(input: { target: RevisionSet; known: RevisionSet }): HistoryBundle;
  importHistory(bundle: HistoryBundle, options?: {
    missing?: "reject" | "defer";
  }): HistoryImportReport;
  readonly history: HistoryQueries;
  diff(input: DiffInput & DiffOptions): Promise<DiffReport>;
}

interface EditingHead extends Disposable {
  checkpoint(): HeadCheckpoint;
  snapshot(document: DocumentId): TextSnapshot;
  document(document: DocumentId): DocumentTarget;
  commit(input: {
    expect: HeadCheckpoint;
    edits: readonly SourceEdit[];
    origin: EditOrigin;
    attribution?: JsonValue;
  }): CommitReceipt;
  merge(input: { expect: HeadCheckpoint; source: RevisionSet }): CommitReceipt;
  checkout(input: { expect: HeadCheckpoint; at: RevisionSet }): CommitReceipt;
  onChange(listener: (event: HeadChangeEvent) => void): Disposable;
}
```

`SourceEdit` 为 `{ document, range: TextRange, text }`；全部 ranges 必须属于 expect 内各文档的源 revision。commit 先完整验证，后一次发布；批次内坐标同时解释，不按数组顺序滚动解释。`origin` 为声明的来源，actor 由 writer 关联，metadata 不代表认证。

`createDocument` 校验 document/base/content digest；相同登记幂等，不同内容/base 报错。同一兼容后端的不同 store 相同登记应互认根历史。默认实现的 writer 创建新写入流；actor/replica 可以相同，但不能复用活跃 stream/counter。若采用随机身份，无安全随机源时必须报错或要求注入，不能用弱随机冒充持久身份。其他后端可以采用不同身份方案，但必须满足并发唯一性、显式因果关系与隔离 head 的同等约束，不能把全局计数前缀当作未声明的祖先。

head 成员在 fork 时固定，改变成员需显式派生另一个 head。merge 可选成员子集，不自动增加文档；它只整合传入的精确 source，不接受 live head。checkout 移动指针，不生成文本补偿；清空该 head 上 session 的 undo/redo，并明确通知。

`CommitReceipt` 至少包含本地 commit ID、`before/after: HeadCheckpoint`、受影响文档、源事务/group 引用及 `committed | no-change` 状态。session 返回兼容的 receipt，另附 selection effects，不把 session checkpoint 冒充源 checkpoint。receipt 不作为新的分布式历史 ID；外部对象不能伪造有效 receipt。

历史查询签名：

```ts
interface HistoryQueries {
  revision(input: RevisionEntry): RevisionInfo;
  transaction(id: TransactionId): TransactionInfo;
  transactions(input: {
    document: DocumentId;
    includedIn: RevisionId;
    limit: number;
    cursor?: HistoryCursor;
  }): HistoryPage;
  compare(input: {
    document: DocumentId; left: RevisionId; right: RevisionId;
  }): "equal" | "ancestor" | "descendant" | "concurrent";
  provenance(input: {
    document: DocumentId; revision: RevisionId; range: TextRange;
  }): readonly ProvenanceSpan[];
  resolve(input: { position: StablePosition; at: RevisionEntry }): PositionResolution;
  translate(input: {
    point: TextPoint; to: RevisionId; affinity: "before" | "after";
  }): PositionResolution;
}
```

查询可见持久操作 ID、显式依赖、事务前后版本、actor/origin/归因及编辑摘要，但不承诺逐字符节点布局。分页按因果拓扑与确定性 ID 平局序，默认调用方显式给 limit。文本 Diff 统一为 `store.diff`，不另保留一套 `history.diff` 规则。

位置解算为 `present | deleted | not-yet-created`，deleted 给出 before/after 修复候选；未知/丢失历史是错误，不是 deleted。仅缺少创建 revision 的无关编辑不算尚未创建。affinity 为 before/after；并发边界的形式定义必须在算法关口完成。

导入验证完整 envelope 与因果图：默认缺依赖整包 reject；显式 defer 时有界暂存，后续完整接受/拒绝有事件。重复相同 op 幂等，不同 payload 同 ID 报错。导入不推进 head。codec 版本化并限额，但不在公共契约固定逐字符 payload。

首版保留全部已接受历史，无自动压缩。pin、快照与导出位置的 retention 明确；位置 export/import 登记其依赖，纯 codec 无隐含 store 写入。释放导出 retention 是显式撤销其保留保证，跨进程清单与历史持久保存由产品负责。首版压缩请求报 `UNSUPPORTED_COMPACTION`。

拒绝当前文本同步代替历史；拒绝以移动 head 代替 undo；拒绝未定义兼容性就固化内部 wire。

## D4. 产品控制的多选区、事件与 undo

```ts
interface Selection {
  readonly id: SelectionId;
  readonly anchor: SourceEndpoint;
  readonly head: SourceEndpoint;
  readonly metadata?: JsonValue;
}
interface SelectionSnapshot {
  readonly version: SelectionVersion;
  readonly items: readonly Selection[];
  readonly primary: SelectionId | null;
}
interface SelectionController {
  read(): SelectionSnapshot;
  set(input: {
    expect: SelectionVersion; items: readonly Selection[];
    primary: SelectionId | null; origin: EditOrigin;
  }): SelectionSnapshot;
  add(input: {
    expect: SelectionVersion; selection: Selection;
    makePrimary?: boolean; origin: EditOrigin;
  }): SelectionSnapshot;
  update(input: {
    expect: SelectionVersion; selection: Selection; origin: EditOrigin;
  }): SelectionSnapshot;
  remove(input: {
    expect: SelectionVersion; id: SelectionId;
    primary?: SelectionId | null; origin: EditOrigin;
  }): SelectionSnapshot;
  setPrimary(input: {
    expect: SelectionVersion; id: SelectionId; origin: EditOrigin;
  }): SelectionSnapshot;
  save(): SavedSelections;
  restore(input: {
    expect: SelectionVersion; saved: SavedSelections;
    missing?: "reject" | "repair"; origin: EditOrigin;
  }): SelectionRestoreResult;
  onChange(listener: (event: SelectionChangeEvent) => void): Disposable;
}

declare function createEditorSession(input: {
  target: DocumentTarget | MultiBuffer;
  insertLineEnding?: "\n" | "\r\n";
}): EditorSession;
```

session 公开 `selections`、`checkpoint()`、`allocateSelectionId()`、`replaceSelections`、`undo` 与 `dispose`。初始空集、primary null；ID 会话内稳定，不取数组索引。anchor/head 保留方向，caret 两端用同一 stable position。source session 无 excerpt，投影 session 必须携带 occurrence；单选区不能跨文档或 excerpt。

添加到空集时新 selection 成为 primary，其他 add 默认不更换 primary。删除非最后一个 primary 必须指定替代；删除最后一个可归空集。set 重复 ID/无效 primary/错误目标整次拒绝。save/restore 默认缺失 reject，repair 才按 affinity 修复，并报告详情。

```ts
type Replacement =
  | { kind: "uniform"; text: string }
  | { kind: "per-selection"; values: ReadonlyMap<SelectionId, string> };
// session.replaceSelections({
//   expect: SessionCheckpoint, replacement: Replacement,
//   origin: EditOrigin, attribution?: JsonValue, undoGroup?: UndoGroupId
// }): SessionCommitReceipt
```

per-selection 恰好覆盖 ID 集合。编辑后保留 ID/primary，折叠到插入末尾；no-change 不造空 CRDT op，必要时仍有 selection-only 变更。

冲突规则：完全同源范围/文本/affinity 去重，所有 ID 保留；相同源范围不同内容报 alias 冲突；严格重叠非等同范围拒绝；相邻非空半开范围允许；caret 在另一个替换范围内部或端点拒绝。排序只用于稳定报告，不能改变同时编辑语义。

源/head/投影/选区全部一致后，按 commit 序在 microtask 通知；事件不可变并带 before/after checkpoint、origin、reason、repairs。事件内同步重入写入报 `REENTRANT_WRITE`；监听异常经 error sink 报告，不回滚、不阻断其他监听器。

远端 merge 只重定位本地选区，不覆盖集合/primary/metadata。删除位置按 affinity 修复并报告；尚未存在的位置或被移除 occurrence 标记 suspended，后续编辑拒绝，不能偷偷选另一个 occurrence。

undo 接口为 `beginGroup(): UndoGroupHandle`、`undo({expect})`、`redo({expect})`；group handle 有 id 与 `close()`。默认每命令一组，无 headless 延时猜组；首版撤销最近本地组，不任意挑旧组。直接 head.commit 不自动进入某会话 undo。撤销为新因果补偿，不撤掉远端插入，结果可为 applied/partial/no-effect；只恢复发起会话的选区。远端 merge 不清 redo，新的本地会话编辑清 redo。

拒绝 renderer 私有多光标作为公共 API；拒绝重叠规则取决于数组顺序。

## D5. MultiBuffer 与本地原子性

```ts
declare function createMultiBuffer(input: {
  head: EditingHead;
  excerpts: readonly ExcerptSpec[];
  decorations?: readonly ProjectionDecoration[];
}): MultiBuffer;
// ExcerptSpec: { id: ExcerptId, document: DocumentId, range: StableRange }
// MultiBuffer.snapshot(): ProjectionSnapshot
// MultiBuffer.setExcerpts({ expect: ProjectionVersion, excerpts }): ProjectionSnapshot
// ProjectionSnapshot.toSource(point): SourceEndpoint | NonSourceProjectionPoint
// ProjectionSnapshot.fromSource({ document, position }): readonly ProjectionOccurrence[]
// ProjectionSnapshot.resolveBoundary({ boundary, side: "left" | "right" }): SourceEndpoint
```

投影点绑定 membership generation；text offset 明确是指定 excerpt 的 UTF-16 相对 offset。header/boundary 是呈现对象，不是源字符。边界插入必须明确左右 occurrence；源 affinity 不能代替 occurrence 选择。

稳定范围起/止 affinity 显式必填，删空保留 excerpt 身份。删除 occurrence 导致相关选区 suspended，不自动绑同源另一个片段。同源更新反映所有 occurrence；反向映射返回多个结果。重复映射先归一源再去重/校验，不写两遍。

单范围跨 excerpt 替换拒绝；多个各自合法 selection 可跨文档批量提交，必须同 store/head。一个源事务组在本实例完整验证/发布/撤销。fork/checkout/merge/export/import 都要求 group 闭合；缺成员报 `INCOMPLETE_TRANSACTION_GROUP`，给出确切补齐需求，不拉取 live 最新版本、不扩大同步文档域。

仅承诺本地接受/可见性原子性，不承诺跨设备同时可见、网络原子交付或持久化共识。拒绝可写拼接字符串和隐式跨段分割。

## D6. 产品协作/服务器同步端口

采用由宿主驱动的 headless ports，具体签名与消息行为沿用 [同步端口设计](./editor-api-options.md#历史同步公开精确版本不公开整个-store)：

```ts
declare function createHistorySyncPort(input: {
  store: HistoryStore; documents: readonly DocumentId[];
}): HistorySyncPort;
interface HistorySyncPort extends Disposable {
  offer(input: { target: RevisionSet }): HistorySyncOffer;
  receive(input: {
    bundle: HistoryBundle; missing?: "reject" | "defer";
  }): HistoryImportReport;
  onReceive(listener: (event: HistoryReceiveEvent) => void): Disposable;
}
interface HistorySyncOffer extends Disposable {
  readonly descriptor: HistoryOfferDescriptor;
  exportMissing(input: { known: PeerKnowledge }): HistoryBundle;
}
```

offer 持有精确 target 的 pin；不能无 target 发布整个 store，不能把 Agent 隔离历史自动发布。文档域是本地校验限制，不是授权。peer 知识未知时安全补发受影响 target closure，仍检查 group/域/限额；不能把不认识的并发版本当成对方已有 target。

产品先完成授权，再 receive；它只接受历史、不自动 merge。accepted 不是 durable ACK。网络 framing、socket、重试/连接、认证、权限、存储和服务端确认归产品；服务器可仅使用 store，不要求创建编辑器。

presence 使用 `createPresencePort({store, documents, scope, local, clock, ttlMs?})`；方法为 `publish({at,selections,metadata?})`、`receive({packet,sender})`、`snapshot()`、`onChange(listener)`、`expire()`、`remove({sender})`、`dispose()`。

source anchors、方向、primary 可传输，excerpt/glyph/屏幕坐标不可当共享源身份。产品鉴别的 participant/session/epoch 与 packet 必须相符，epoch 内 sequence 去乱序；旧包不刷新 TTL。未具备源历史时 unresolved，不猜位置。presence 不进历史/undo/Diff，不修改本地集合；期限清理由宿主单调 clock 驱动。

拒绝核心内建同步服务器、全 store 广播、把 actor 元数据当认证。

## D7. 单次 Agent 提交 Diff 与局部预览

**Agent 默认入口是单次 `CommitReceipt`**；版本区间比较保留为通用历史原语，不是 Agent 默认“整轮对话变化”。不按 actor 标签过滤出一个冒称可应用的 patch。

```ts
type DiffInput =
  | { change: CommitReceipt; from?: never; to?: never }
  | { from: RevisionSet; to: RevisionSet; change?: never };
interface DiffOptions {
  contextLines?: number;
  intraline?: "grapheme" | "none";
  maxOutputBytes?: number;
  signal?: CancellationSignal;
}
interface UnifiedDiffOptions {
  labels?: ReadonlyMap<DocumentId, Readonly<{ before: string; after: string }>>;
}
declare function formatUnifiedDiff(report: DiffReport, options?: UnifiedDiffOptions): string;
```

`store.diff` 验证并 pin 精确两端，异步期间源编辑不改变报告。返回不可变、自包含的 `DiffReport`：schema/basis、源文档/revision、事务摘要、旧/新 UTF-16 范围、删/插文本、grapheme 标记、行级 hunks 与上下文。source 去重，不重复 excerpt。完成/取消/失败释放计算 pin，报告本身不依赖 store 继续存活。

文本相同但历史不同可为空 Diff；added/removed 只是版本集成员差异，不执行文件操作。merge receipt 包含该次整合的净变化，不能冒称仅一个 Agent 创作。默认 context 3、保留空白/大小写/EOL；unified 按 LF patch 行计算，保留 CR，用固定英文缺换行标记。labels 由产品指定或安全编码身份，缺侧 `/dev/null`；非法 label 拒绝。结构化 codec 与 history codec 分开，Diff 不作为 CRDT 导入。

### 局部 Diff 视图

用户截图只用于确定呈现结构：文件标签后展示局部上下文，新增/删除行有底色及非颜色标识，保留语法样式。没有复制图中源码、定位图中文件或检索其实现。

```ts
declare function mountVgpuDiffView(input: {
  report: DiffReport;
  document: DocumentId;
  element: HTMLCanvasElement;
  layout: LayoutEngine;
  syntax?: DiffSyntaxProvider;
  options?: {
    lineNumbers?: boolean;
    maxVisibleRows?: number;
  };
}): Promise<VgpuDiffView>;
```

此签名只存在于 `/vgpu`，DOM 类型不进入根入口。view 只借用 report/layout/syntax，无需可编辑 session，也不制造一个拼接的可写文档。一个实例显示报告中的一个源文档，内联显示删行与插行，多个 hunk 明确分隔。默认 maxVisibleRows 12、lineNumbers false；超出在片段内滚动，长行水平滚动，不偷偷丢弃报告内容。view 有状态订阅、显式 recover、resize 与幂等 dispose；不支持编辑、不自带 accept/reject。

颜色只表达差异，不替代增删标记；低对比度绿底、删行底色、focus、surface、border、syntax colors 使用主题 token，暗/亮主题均验证。代码保持 IBM Plex Mono；无卡片悬浮位移、键入/加载脉冲或装饰动画。使用紧凑边框和间距，不把片段变成营销卡片。

语法 provider 按完整源文档的旧/新 revision 分类，删除行用 before、插入/上下文行用 after；不能把孤立 hunk 或拼接的加减行假装完整源去解析。异步结果核对对应 revision/generation。无 provider 时诚实显示 plain 样式，不声称增量高亮。报告仍可独立供产品 DOM/其他 renderer 使用，不强制产品采用本 view。

view 的 hit-test/激活结果包含 document、before/after side、该侧 revision 和源点，不直接跳到当前 head 裸行号。文本/复制等产品操作可用结构化报告和纯文本输出，不自动写 clipboard。无 GPU 时输出明确失败，宿主仍可显示文本 Diff。

“Edit + 文件名”、折叠/展开、打开文件、复制按钮、思考记录、工具计数、自然语言说明与接受/拒绝动作由产品拥有。首版不增加对话模型、side-by-side review 工作台或整文件编辑器来代替局部片段。

拒绝仅给 unified 字符串而丢失源映射；拒绝将整个聊天轮次或最新 head 当作单次编辑 Diff。

## D8. 语言注册、增量语法与 LSP

首版 TS/JS/JSON 语法与一个真实 TypeScript LSP。`createLanguageRegistry().register({id,syntax})` 返回可释放注册；`attachSyntax({head,languages})` 管理 parser/worker/cache，`classify({document,revision})` 返回带 grammar generation 的源分类，不返回主题色。

旧树复用必须有对应 edit 链及单位转换，无有效链才全量解析；不能每次全量却声称增量。旧树快照不随 worker 编辑。分类独立 theme，当前 semantic 属性覆盖同属性 syntax，过期 semantic 不盖新 syntax。颜色变化不任意拆塑形 run。

```ts
interface RpcTransport {
  send(message: JsonRpcMessage): Promise<void>;
  onMessage(listener: (message: unknown) => void): Disposable;
  onClose(listener: (cause?: Error) => void): Disposable;
  dispose(): void;
}
declare function connectLanguageServer(input: {
  transport: RpcTransport;
  initialization: LspInitializationOptions;
  requestTimeoutMs?: number;
  unversionedDiagnostics?: "report-only";
}): Promise<LanguageClient>;
// client.bindDocument({head,document,uri,language}): LanguageBinding
// binding.sync({at:RevisionId}): Promise<void>
// binding.hover/completion/definition/semanticTokens({at,position?,signal?})
// binding.onDiagnostics(listener): Disposable
// binding.dispose(); client.shutdown(): Promise<void>
```

transport 默认借用；客户端负责 JSON-RPC/LSP、协商、取消/超时、断开传播，不在浏览器 spawn 原生进程。同连接同 URI 不可绑定两个 head；源 URI 与文档 ID 分开。LSP version 映射 revision，不用作 CRDT 身份；回看仍递增版本。

sync 只保证有序交付给 transport，没有 didChange 分析完成 ACK。full/incremental/none 和 UTF 编码按协商处理；批次旧 base ranges 必须转成 LSP 连续变化序列。请求/响应 stamp 绑定源 revision、URI、LSP version、generation；不匹配 stale 不上屏。无版本 diagnostics 只报告，不猜当前版本。

completion/workspace edits 走统一源提交，不执行文件 resource operations。不支持的能力不宣告；markup 不可信，不直接注入 HTML。开发桥若增加则 localhost/命令与 workspace 白名单，不成为生产执行服务。

拒绝 projected 拼接内容/位置进 LSP，拒绝 mock 代替真实服务器验收。

## D9. 塑形、vgpu、输入与字体

`loadFont({bytes,expectedFamily})`、`createLayoutEngine({shaper,fonts,features})`、`layout.setOpenTypeFeatures(features)` 与资源释放保持显式。布局拥有 glyph/cluster、grapheme caret、bidi、tab、折行和 hit-test，view 负责栅格缓存与 vgpu 绘制；不假定 vgpu 自带完整塑形器。

```ts
declare function mountVgpuView(input: {
  session: EditorSession; element: HTMLCanvasElement; layout: LayoutEngine;
}): Promise<VgpuEditorView>;
// bindBrowserInput({session,element,geometry:view}): BrowserInputBinding
```

view 提供 loading-font/ready/webgpu-unavailable/device-lost/disposed 状态；初始化失败 reject，运行中丢失显式通知，recover 必须显式调用，无静默 Canvas fallback。adapter 的实际 vgpu 调用须以获选版本本地随包文档为准，本文件不是依赖 API 声明。

IBM Plex Mono 为默认，官方 2.5.0 资产候选仍须许可/来源记录；不伪造编程连字。用户已允许另选 opt-in 连字字体用于测试/playground，具体包/版本待许可审查。缺字体显式失败；中文 fallback 显式配置并暴露实际 face，不替换整体默认字体。

glyph clusters 与源位置不等价；连字内部 caret 使用字体数据或有说明的 grapheme 插值。运行时特性切换必须真的改变塑形证据而不改变源字符。输入处理 beforeinput/composition/paste；IME 默认 primary 组合，预览瞬态、确认一个 undo group，目标消失时取消并报告可恢复文本，不提交旧 offset。

输入桥、可访问性验证与产品 UI 分离。隐藏 textarea 不是读屏完成证据。拒绝 keydown-only 输入、Unicode 箭头替换、CSS 开关冒充缺失连字。

## D10. 错误、限额、非目标与执行边界

同步失败抛 `EditorError`，异步失败 reject，有稳定 code/结构化 details/cause。失败不留下部分文本/选区；deleted/stale/undo partial 等预期状态用判别联合。

核心 code：`UNKNOWN_DOCUMENT`、`DOCUMENT_NOT_IN_HEAD`、`BASE_MISMATCH`、`UNKNOWN_REVISION`、`HISTORY_UNAVAILABLE`、`IDENTITY_CONFLICT`、`INVALID_CAUSAL_GRAPH`、`MISSING_DEPENDENCIES`、`INVALID_REFERENCE`、`UNSUPPORTED_FORMAT`、`LIMIT_EXCEEDED`、`STALE_CHECKPOINT`、`WRONG_REVISION`、`INVALID_RANGE`、`INVALID_BOUNDARY`、`INVALID_UNICODE`、`DIFFERENT_ATOMIC_DOMAIN`、`INCOMPLETE_TRANSACTION_GROUP`。

交互/lifecycle code：`INVALID_SELECTION_SET`、`NO_SELECTION`、`UNRESOLVED_SELECTION`、`OVERLAPPING_EDITS`、`ALIAS_EDIT_CONFLICT`、`CROSS_EXCERPT_EDIT`、`DISPOSED`、`RESOURCE_IN_USE`、`REENTRANT_WRITE`、`UNSUPPORTED_COMPACTION`、`RANDOM_UNAVAILABLE`。

集成 code：`SYNC_SCOPE_MISMATCH`、`SENDER_MISMATCH`、`INVALID_PRESENCE`、`INVALID_DIFF_LABEL`、`URI_IN_USE`、`UNSUPPORTED_CAPABILITY`、`UNSYNCHRONIZABLE_REVISION`、`PROTOCOL_ERROR`、`CANCELLED`、`TIMEOUT`、`DISCONNECTED`、`FONT_UNAVAILABLE`、`SHAPING_FAILED`、`WEBGPU_UNAVAILABLE`、`DEVICE_LOST`、`COMPOSITION_CONFLICT`。

| 默认 | 值 |
| --- | --- |
| bundle | 8 MiB、100,000 operations，任一超限拒绝 |
| metadata | 每事务合计 16 KiB 规范 JSON，无截断 |
| missing dependencies / pending | 默认 reject；显式 defer 的 pending 上限 32 MiB |
| presence | TTL 30 秒、64 KiB/packet、256 选区；旧包不续期 |
| Diff | context 3、grapheme intraline、16 MiB 完整输出预算，不截断 |
| Diff view | 单文档 inline，12 可见行，行号默认关闭，增删标记保留 |
| LSP | 请求超时 10 秒；stale 不绘制；unversioned diagnostics report-only |
| 核心撤销 | 每命令一组，不按定时器猜组 |

一次本地事务还要检查可导出限额，不能提交后才发现永远不能同步；多组交换可由宿主安排，不自动切开用户事务。

非目标：产品线程/项目/worktree 编排、存储/同步服务、认证权限服务、Git、文件系统 CRDT、对话回滚、Agent 执行器、整套 review/聊天 UI、自动修复冲突的 Git 策略、生产远程执行、隐含 fallback、未经证明的任意历史压缩。

工具版本保持 Lightning 3.1.2、Nasti 2.7.0（仅 playground dev）、tsdown 0.23.2、TypeScript 7.0.2、pnpm 12.15.0。自有 CRDT，禁 Yjs/其包装及 Monaco/CodeMirror 替代实现。

本次授权是继续设计/实施工作流，不是发布、push、PR 或合入共享分支。本会话只用 editor；不读取其他 worktree、参考源码/测试、研究目录或其他会话历史。若算法证明/依赖能力与本契约冲突，实施计划的 G0/G1 门禁要求停下报告，不静默降级。

## D11. 可替换历史后端

用户已明确要求替换 CRDT/历史后端，而非仅在固定算法之上配置产品模式。
公开 `HistoryBackend` / `HistoryBackendDefinition` 与 `defineHistoryBackend` 接入完整产品
`HistoryStoreImplementation`；工厂接收 `HistoryBackendContext` 和已有 options，
返回的 store 带不可变 `backend` 描述。上层通过 `historyStoreFor(head)` 找到所属 store，
不得依赖 `NativeStore`、FugueMax 节点布局或某个公共 ID 的内部计数格式。

`HistoryBackendDescriptor` 明确 backend family ID、contractVersion、algorithm/身份语义版本、
history/position 格式 ID 和 selectiveUndo/deferredImport 能力。跨后端不自动转换；
同步 offer 的 `HistoryBackendProtocol` 头与 descriptor 使用同一命名，兼容性检查必须包含
family、contract、algorithm 与所选 format，不能仅比较算法标签。

默认 FugueMax 仍须完成全部必需契约后才能作为公开后端提供。产品接入入口不替代未实现的
无参 `createHistoryStore`；不能把内部半成品通过 cast 或一组 not-implemented 方法充当后端。
原子批次、精确因果版本、固定 head 成员、稳定位置/修复、历史查询、保留与完整 Diff 是
基础要求；runtime shape 检查不是这些语义的正确性证明，产品后端须另做自己的 conformance 验证。

后端通过 context 生成带 family/algorithm/kind 命名空间的 revision/transaction/group 等
IDs，并发行本地 opaque positions/receipts/undo tokens；position tokens/history bundles
额外带格式归属。跨后端在入口拒绝，同协议仍要由后端验证 root、闭包与 payload。
格式标识不是安全认证，不声明不受信字节已解码或校验。

可选 `HistoryUndoProvider` 提供 head-bound scope 的 capture/apply/dispose；
apply 接受 opaque tokens 与 undo/redo 方向，返回 applied/partial/no-effect 和真实
CommitReceipt。不公开 generation、奇偶计数、节点 ID 或删除标签布局。
会话栈、命令分组、选区恢复仍在 D4；未来默认 session 在后端不支持 selective undo 时
应在创建阶段报 `UNSUPPORTED_CAPABILITY`，不能等按撤销键时再暴露假实现。
defer 不支持时，同样在调用后端前明确拒绝；未声明能力不得伪装成功。

具体协议、后端作者用法、验证证据和保留的边界见
[可替换历史后端](./editor-history-backends.md)。原有 D1–D10 的行为要求仍有效；
本扩展不是算法迁移、Git 策略、UI/session 或网络实现已经完成的声明。

## D12. 外部文本存储与仅渲染模式

产品可以独立选择文本存储与历史后端。仅渲染不需要创建 `HistoryStore`、writer、稳定位置
或 CRDT，也不要求使用内置 rope/SumTree。内置完整后端的目标是开箱即用，不是入口前提。
完整外部历史按 D11 接入；仅渲染的 gap buffer/piece table/持久快照按本节接入。

根入口公开 `createTextSource(provider, { onError? })` 与
`textSourceFromHead(head, document)`。`TextSourceProvider` 只提供可释放 read lease 和
变更订阅；返回 `TextSource` 只读、借用产品数据，不写入、不销毁产品 buffer/head/store。
`TextSnapshot.readUtf16(start, end)` 增补有界读取，遵循 D2 的 scalar-safe 半开范围；
不得为局部布局被迫调用 `text()` 展平整篇。

lease 分两类：`snapshot` 的旧内容持久不变；`versioned` 借用可变存储，必须提供检测每次
mutation（含 ABA）的 `isCurrent()`。后者在每次读取前后检查；失效报 `STALE_TEXT_VIEW`，
不返回撕裂文本。产品保证并发读取安全；版本检查本身不是锁或跨线程内存屏障。
内部 raw lease 必须支持边界探测，即允许单独 UTF-16 单元；公开 read snapshot 只返回
完整 Unicode scalars，不归一化文本/EOL，验证仅限所请求的范围及边界，不全量扫描存储。

每份 `TextReadSnapshot` 有独立 `TextReadVersion`；point/range 绑定这份 read，而非 revision。
异 read 的 range 报 `WRONG_TEXT_VIEW`；这些值不能进入 edit/StablePosition/历史同步。
`assertValid()` 检查能否继续读取；`source.isCurrent(read)` 另检查是否仍可作为最新布局发布。
持久旧读可能仍有效但已非最新；异步布局必须同时检查 source/read/layout generation。
活动 read 阻止 source dispose；通知是可合并的失效提示，不是逐事务事件或历史记录。

`/shaping` 增加 `shapeText/layoutText` 和只读布局结果；`/vgpu` 增加
`VgpuTextView`、`mountVgpuTextView` 与 `setSource` 契约，不要求 `EditorSession`。
只读 view 不满足可编辑 `EditorGeometry`，不能接到编辑输入桥。
快速/完整模式由产品显式替换 source、保留或迁移数据；不自动转换旧坐标或恢复 gap buffer
没有记录的历史。具体用法见 [只读文本源](./editor-text-sources.md)。
当前只读适配运行时已实现，shaping/GPU view 仍只有类型契约，不能据此声称已经绘制文字。
