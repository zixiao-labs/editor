# Editor 公开 API 组织方案

状态：**方案评审记录。用户确认主方案、单次提交 Diff 并要求继续后，公共契约已收敛到 [锁定 API](./editor-api.md)，实施顺序见 [分阶段计划](./editor-implementation-plan.md)。本文件保留备选与设计理由，不是当前可运行 API。**

本文根据 [独立行为契约](./editor-contract.md) 独立设计。示例中的 editor 导出、类型和方法都是待实现的 API，不能当作当前可运行代码；与锁定契约不一致的历史讨论以锁定契约为准。依赖提供的真实 API 与本库 API 不混用。示例里的 `showHover`、`reportError`、字体字节和 transport 由宿主提供。

工作流为本项目的 `maintainer-original`，目标默认分支为 `main`。已进入 agent-flow 的锁定/计划阶段，运行时仍受独立算法与工具门禁约束。不执行上游专属 Subharness、canary、发布或合入流程。不读取参考源码、测试、研究记录或其他会话；独立上下文不是法律认证。

## 1. 推荐结论与三个选择

**已确认 B：HistoryStore → EditingHead → EditorSession，渲染与语言服务作为订阅者，并提供产品协作/服务器同步端口。**

理由不是对象更少，而是所有权更明确：历史可以比任何会话活得久；一个编辑头可以覆盖多个源文档，成为本地原子提交边界；会话只拥有选区和自己的撤销状态；销毁视图不销毁编辑头。`HistoryStore` 是库内历史容器，不是产品的项目、仓库、线程或服务端。

| 维度 | A：文档优先 | B：历史容器与编辑头分层，推荐 | C：不可变状态与命令归约 |
| --- | --- | --- | --- |
| 历史所有者 | 每个 `TextDocument` | `HistoryStore` | 宿主持有的 `EditorState` 值 |
| 可变编辑位置 | 每文档一个 `DocumentHead` | 多文档 `EditingHead` | 每次归约返回一个新 state |
| 多文档提交 | 需要额外协调器 | 同一 store/head 内天然有边界 | 一次归约可计算，发布由宿主串行化 |
| 选区所有者 | 独立 session | 独立 session | state 中的 session 分区 |
| 隔离编辑 | 逐文档派生，宿主拼装版本集 | 从不可变 `RevisionSet` 派生一个 head | 保留旧 state，再独立归约 |
| 嵌入成本 | 单文档最低，多文档较高 | 显式创建三层对象 | 必须处理归约、effects、取消和资源生命周期 |
| 主要风险 | 最后重新发明一个跨文档 store | 被误用为产品 worktree 管理器 | 巨型 state、资源所有权和异步 effect 去重 |

三者均要求自有 CRDT、历史查询和公开选区；不是“完整版”和“当前文本同步版”的比较。下面的 A/C 示例只是比较组织方式；后文的完整语义以 B 为推荐草案。

### A. 文档优先

```ts
// 方案 A 的拟议命名，不与 B 混用。
const document = TextDocument.create({
  id: documentId("demo:main.ts"),
  base: { id: externalBaseId("host:base-1"), text: "let n = 1;\n" },
});
const main = document.openHead({ writer: writerA });
const base = main.revision;
const isolated = document.fork({ at: base, writer: writerB });
const old = document.history.snapshot(base);

isolated.replace({
  expect: base,
  range: old.rangeUtf16(8, 9),
  text: "2",
});
const pinned = isolated.revision;
main.merge({ expect: base, source: pinned }); // 不传 live head

const projection = DocumentProjection.create({
  sources: [main, secondDocumentHead],
  excerpts: excerptSpecs,
  coordinator: localTransactionCoordinator,
});
const session = EditorSession.create({ target: projection });
session.selections.set({ expect: session.selections.read().version, ...selectionSet });
session.replaceSelections({
  expect: session.checkpoint(),
  replacement: { kind: "uniform", text: "value" },
});

const lsp = await LanguageClient.connect({ transport: hostTransport });
const binding = lsp.bind({ head: main, uri: "file:///demo/main.ts", language: "typescript" });
const view = await mountVgpuView({ session, element: canvas, layout });
view.dispose(); // 文档、历史、session 不受影响
```

优点：一个源文档的心智模型直接；容易让已有文档管理产品逐个接入。

代价：跨文档原子提交、group undo、重复源映射都依赖额外协调器；不同协调器下的文档必须拒绝同一事务。协调器最终承担 B 中 store/head 的部分职责，但所有权更加分散。适合多文档编辑不是核心能力的库，不是本需求的最佳取舍。

### B. 历史容器、编辑头、会话分层

```ts
// 方案 B 的拟议 API；完整语义见后文。
const store = createHistoryStore();
const initial = store.createDocument({
  id: documentId("demo:main.ts"),
  base: { id: externalBaseId("host:base-1"), text: "let n = 1;\n" },
});
const main = store.fork({ at: store.revisions([initial]), writer: writerA });
const base = main.checkpoint();
const isolated = store.fork({ at: base.revisions, writer: writerB });
const snapshot = isolated.snapshot(initial.document);

isolated.commit({
  expect: isolated.checkpoint(),
  edits: [{ document: initial.document, range: snapshot.rangeUtf16(8, 9), text: "2" }],
  origin: { kind: "product", label: "change-number" },
});
snapshot.dispose();
const pinned = isolated.checkpoint().revisions;
main.merge({ expect: base, source: pinned });

const session = createEditorSession({ target: main.document(initial.document) });
// MultiBuffer 可以替换 target；不替换 store、CRDT 或源文档。
const view = await mountVgpuView({ session, element: canvas, layout });
view.dispose();
// session 和 main 仍可在无 DOM/GPU 环境继续编辑。
```

代价：多了显式的 store 与 head；宿主需要决定哪些文档进入同一个本地原子域。好处是不用把“产品的项目”作为任何 editor 参数。

### C. 不可变状态与命令归约

```ts
// 方案 C 的拟议 API；effects executor 也必须是库的公开组成部分。
const base = EditorState.create({ documents: initialDocuments, sessions: initialSessions });
const isolated = reduceEditor(base, {
  type: "replace-selections",
  session: sessionId("local"),
  expect: base.checkpoint,
  replacement: { kind: "uniform", text: "value" },
  writer: writerB,
});
const pinned = isolated.state.history.revisions();
const merged = reduceEditor(base, {
  type: "merge",
  expect: base.checkpoint,
  source: pinned,
  history: isolated.state.history,
});
const historical = merged.state.history.snapshot(document, historicalRevision);

// effects 包括语言请求/解析调度，不把 GPU、socket、WASM 实例塞进 state。
const runtime = createEffectRuntime({ transport: hostTransport, languages, layout });
runtime.publish(merged); // 幂等执行 effects，并提供不可变状态订阅
const view = await mountVgpuView({
  session: runtime.session(sessionId("local")),
  element: canvas,
  layout,
});
view.dispose();
```

优点：回放、纯状态检查、宿主统一发布容易理解；并发命令和属性测试可以对状态值直接运行。

代价：宿主必须正确发布 state，避免旧 state 覆盖新 state；effects 仍需带 revision/generation、去重和取消。撤销 CRDT 文本事务不能用“恢复旧 state”代替。历史结构共享与 parser/GPU 等有生命周期的资源必须完全分离，否则“不可变”只是表面承诺。此需求下会把过多编辑器执行器责任交给嵌入方。

## 2. B 的所有权与入口边界

| 对象 | 拥有 | 不拥有 |
| --- | --- | --- |
| `HistoryStore` | 已接受的历史图、文档/base 登记、pin、导入待处理区 | 持久化服务、网络、产品项目、Git |
| `EditingHead` | 当前不可变版本集的可变指针、writer 引用 | 历史的唯一副本、所有 session 的选区 |
| `EditorSession` | 选区、primary、本地 undo/redo、会话设置 | 源文本副本、远端 presence |
| `MultiBuffer` | excerpt 顺序/身份、边界和源映射 | 第二份可写文本、文件发现 |
| history sync / presence port | 精确版本供给句柄、导入结果通知 / 短期远端选区状态 | socket、服务器、认证、持久化 ACK、自动发布隔离 head |
| syntax/LSP attachment | 各自的任务、缓存、协议状态 | 修改文本的独立通道 |
| layout / vgpu view / browser input | 各自拥有的字体塑形、绘制、输入资源 | 模型生命周期 |

拟议包入口（还未创建）：

- `@zixiao-labs/editor`：历史、head、session、MultiBuffer、坐标、Diff 和错误类型；不顶层导入 DOM、GPU、WASM parser 或 socket。
- `@zixiao-labs/editor/collaboration`：headless 历史同步与 presence 端口、供宿主接入的 codec；不内置网络连接或服务器。
- `@zixiao-labs/editor/languages`：语言注册和增量语法服务；具体语法包按需加载。
- `@zixiao-labs/editor/lsp`：JSON-RPC/LSP、transport 接口、源文档绑定。
- `@zixiao-labs/editor/shaping`：塑形/布局接口及按需适配器，不要求创建 view。
- `@zixiao-labs/editor/vgpu`：本库的 vgpu 适配层；不是 vgpu 现有导出的声明。
- `@zixiao-labs/editor/browser`：DOM 输入/可访问性桥接；playground 不成为库入口。

所有跨层注入默认借用资源，不因 session/view 的销毁连带关闭宿主传入的 transport、layout 或 GPU context。工厂内部创建的资源由工厂返回对象释放。重复 `dispose()` 幂等；释放后读写句柄报 `DISPOSED`，已取出的不可变文本值不失效。store 有活动 head、快照 pin 时普通 `dispose()` 报 `RESOURCE_IN_USE`，不用隐含级联销毁。

## 3. 身份、版本、坐标：先消除隐式转换

建议导出不同的 opaque/branded 类型及验证构造器，而不是所有参数都接受裸 `string | number`：

```ts
type RevisionEntry = Readonly<{ document: DocumentId; revision: RevisionId }>;
type TextPoint = Readonly<{
  document: DocumentId;
  revision: RevisionId;
  unit: "utf16";
  offset: number;
}>;
type SourceEndpoint = Readonly<{
  document: DocumentId;
  position: StablePosition;
  excerpt?: ExcerptId;
}>;
type Selection = Readonly<{
  id: SelectionId;
  anchor: SourceEndpoint;
  head: SourceEndpoint;
  metadata?: JsonValue;
}>;
```

- `DocumentId` 是逻辑文档身份；URI、文件名、head ID、excerpt ID 都不能代替它。
- `ExternalBaseId` 是产品交付的 opaque 身份，不拆成 Git commit/path。不做网络解析。
- `RevisionId` 标识一个文档的不可变、因果闭合历史集合，内容相同不代表版本相同。表示法由算法/codec 决定，不承诺是 hash、整数或每字符 ID 数组。
- `RevisionSet` 是不可变的 `DocumentId → RevisionId` 映射；没有可修改的 Map 后门。它不是分布式全局时钟，也不是整个产品的版本。
- `HeadCheckpoint` 带 `headId`、本地单调 `stamp`、`revisions`。`stamp` 只用于该 head 的 compare-and-swap，包括回到相同 revision 的 ABA 检查；不能序列化成历史身份。
- `SessionCheckpoint` 再包含 selection version 和 projection membership version。`expect` 不匹配即拒绝，不以“最新位置”重试。
- `StablePosition` 是带文档/base 身份、创建因果上下文和插入 affinity 的不透明位置；不是公开的 CRDT 原子布局。`ExcerptId` 指某一次呈现，和源位置分开。
- `VisualPoint`/glyph cluster 只在指定 layout generation 内有效，不进入 CRDT/history wire。

快照提供 `pointUtf16`、`rangeUtf16`、`pointUtf8`、`pointScalar`、`convertPoint`、`anchorUtf16`。每个点/范围绑定源 revision；`rangeUtf16(start, end)` 为半开区间。读取旧快照再向新 revision 提交其裸 offset 不被接受。

建议默认：保持源字符串原样，不做 NFC/NFD 或换行归一化；初始内容与插入文本中的孤立 surrogate 报 `INVALID_UNICODE`。编辑不得切开 surrogate pair。低层范围可以切开 combining sequence，但交互导航/删除按 grapheme；两种能力不混为一谈。CRLF 占两个 UTF-16 单元、一个逻辑换行，CR 和 LF 也独立识别。低层显式修改 CR/LF 不被悄悄改写；CRLF 内部点若不能表示为行列则转换报 `INVALID_BOUNDARY`。键入换行默认 LF，可由 session 的 `insertLineEnding` 改为 CRLF；粘贴保留原文本。grapheme 与双向布局的 Unicode 版本在实现依赖选择时记录。

## 4. 原生历史：有历史再有 head，不把它藏在同步接口后面

### 4.1 创建 base、派生隔离编辑头、精确 merge

```ts
import {
  createHistoryStore, documentId, externalBaseId, actorId, replicaId,
} from "@zixiao-labs/editor";

const store = createHistoryStore();
const document = documentId("product-document:42");
const initial = store.createDocument({
  id: document,
  base: { id: externalBaseId("host-opaque-base:8"), text: "let n = 1;\n" },
});
const localWriter = store.openWriter({
  actor: actorId("product-user:7"),
  replica: replicaId("product-installation:a"),
});
const isolatedWriter = store.openWriter({
  actor: actorId("product-user:7"),
  replica: replicaId("product-installation:a"),
});
const main = store.fork({ at: store.revisions([initial]), writer: localWriter });
const base = main.checkpoint();
const historical = store.snapshot({ document, revision: initial.revision });
const isolated = store.fork({ at: base.revisions, writer: isolatedWriter });

const changed = isolated.commit({
  expect: isolated.checkpoint(),
  edits: [{ document, range: historical.rangeUtf16(8, 9), text: "9" }],
  origin: { kind: "agent", label: "adjust-example" },
  attribution: { request: "host-request:55" },
});
const pinnedSource = changed.after.revisions;
const pin = store.pin({ revisions: pinnedSource });
const merged = main.merge({ expect: base, source: pinnedSource });

// isolated 后续编辑不会扩展本次 source；historical.text() 始终是旧内容。
console.log(historical.text(), merged.after.revisions.get(document));
pin.dispose();
historical.dispose();
```

同一 actor 可以有多个 writer。`openWriter` 必须创建不会复用的写入流身份，不能只用 `actor + 本地计数`；headless 随机性提供者可注入。恢复 writer 不允许复制旧计数器到两个活跃实例；未来持久化恢复须有显式 API。操作身份的持久规则在 CRDT 规格中定义。

`createDocument` 登记 `(DocumentId, ExternalBaseId, exact content digest)`。同一身份同一内容重送幂等；同 ID 不同 base/content 报 `BASE_MISMATCH`。独立 store 用相同登记数据应能互认初始历史。首版不悄悄切换外部 base；导入另一份 Git 基线不是把旧文档 reset 成新字符串。

`fork` 只共享不可变历史，不追随别的 head。`merge({ source })` 求目标与指定 source 的因果并集，不能接收一个将来会变的 live head，不能按墙钟取“最新”。没有文本冲突标记或 Git rebase 策略。每文档 CRDT 的冲突次序须由单独算法规格定义。

首版 head 的文档成员在 `fork` 时固定；需要不同成员时显式派生另一个 head。merge 的 source 可以是当前成员的子集，其他文档不变；source 含未纳入 head 的文档报 `DOCUMENT_NOT_IN_HEAD`，不能隐含扩展。fork、checkout、merge 都检查多文档 group 闭合，规则见第 6 节。`head.commit` 的每个 range 必须对应 expect 中该源文档的 revision，且整个批次在同一 expect 下校验。

`head.checkout({ expect, at })` 是移动本地 head 指针，不生成撤销事务，也不删除历史。已有 session 的位置被重解算；目标版本中尚不存在的位置标记 suspended，不擅自迁移到文首。undo 栈不伪装成该历史的新撤销栈：checkout 后清空该 head 上会话的 undo/redo，并在同一事件中明确通知。

### 4.2 可查询的因果历史与归因

```ts
const revision = main.checkpoint().revisions.get(document);
const relation = store.history.compare({
  document, left: initial.revision, right: revision,
}); // "equal" | "ancestor" | "descendant" | "concurrent"

const page = store.history.transactions({
  document, includedIn: revision, limit: 100,
}); // entries + opaque nextCursor；不是 wall-clock 排序
for (const transaction of page.entries) {
  const detail = store.history.transaction(transaction.id);
  // detail：事务/操作 opaque ID、显式 dependencies、actor、origin、attribution、
  // 参与文档/group、各文档 before/after revision 和可查询的编辑摘要。
}

const current = store.snapshot({ document, revision });
const provenance = store.history.provenance({
  document, revision, range: current.rangeUtf16(0, 3),
}); // 存活文本区间 → 原始插入事务/actor/归因，撤销效果另记
const diff = await store.diff({
  from: store.revisions([initial]),
  to: store.revisions([{ document, revision }]),
});
current.dispose();
```

公开查询返回因果依赖与文本变化，不要求公开逐字符节点。分页按拓扑次序，互相并发项用确定性 opaque ID 次序打破平局；这不宣称是人类创作时间。跨文档 group 有可查询身份，但不发明跨整个产品的总序。

attribution 为大小受限的 JSON 值，入库时复制并验证；不接受函数、循环引用、NaN 或可变对象别名。actor/origin/metadata 都是声明，不是签名或权限证明。merge 导入原有归因，不把整段文字记为“合并者新写”。本地 merge receipt 可供产品记录操作，但不重写源事务。

### 4.3 位置转换与删除不是同一错误

```ts
const atInitial = store.snapshot({ document, revision: initial.revision });
const position = atInitial.anchorUtf16(8, { affinity: "after" });
const resolved = store.history.resolve({
  position,
  at: { document, revision },
});
switch (resolved.status) {
  case "present":
    console.log(resolved.point); // 带 revision/unit 的点，可能已移动
    break;
  case "deleted":
    console.log(resolved.before, resolved.after); // 两个明确修复候选，不静默夹紧
    break;
  case "not-yet-created":
    break; // 回看创建位置之前的历史，不等于 history 丢失
}

const translated = store.history.translate({
  point: atInitial.pointUtf16(8),
  to: revision,
  affinity: "after",
}); // 同样的判别联合
const exported = store.exportPosition({ position });
const positionBytes = positionCodec.encode(exported.token);
// exported.retention 是显式保留句柄，不能因快照释放就隐式撤销。
atInitial.dispose();
```

`before` affinity 保持在同边界新插入组之前，`after` 保持在其之后；不靠导入顺序决定。位置在删除区间内部（端点归属按 affinity）时返回 `deleted`；位置依赖的源内容/边界在目标因果集合中尚未产生时返回 `not-yet-created`。仅缺少锚点创建 revision 中的无关编辑不能判为 not-yet-created，位置仍应能向更早版本转换。边界与并发删除的精确定义是 CRDT 规格的必要部分，不能由 UI 猜测。

未知 revision 报 `UNKNOWN_REVISION`，已知但不再可物化的历史报 `HISTORY_UNAVAILABLE`。这两者都不是 `deleted`。导出位置经过 store 登记与保留，再由 `positionCodec.encode/decode` 编解码；接收方以 `store.importPosition(token)` 验证文档/base 和历史依赖后登记。位置格式与 history codec 一起版本化，不让宿主拼装内部原子 ID，也不让纯编码函数暗中修改 store。

### 4.4 导入、导出、保留与 wire 演进

```ts
const bundle = store.exportHistory({
  target: pinnedSource,
  known: base.revisions,
}); // target closure 减 known closure，保持完整事务 group
const bytes = historyCodec.encode(bundle);
// 宿主负责存储、分片、传输、认证；bytes 不等于网络协议。

const report = receivingStore.importHistory(historyCodec.decode(bytes), {
  missing: "reject", // 或显式 "defer"
});
// report: accepted / duplicate / pending 及精确 revision/dependency 摘要。
// import 只进入历史仓库，不推进任何 head。
if (report.status !== "pending") {
  receivingHead.merge({
    expect: receivingHead.checkpoint(),
    source: report.availableRevisions, // 包括已存在的 duplicate target
  });
}
```

接收方须已由产品登记相同 document/base。未知文档/base 默认拒绝，不因网络数据出现就授权新建文档。`known` 必须是发送方可验证的历史身份；其含义是产品声明对端已拥有的因果集合，不是编辑器替对端做认证。

codec 先承诺 envelope 的格式版本、算法族/版本标识、文档/base 身份、依赖摘要、事务/group 边界和限额校验，**不在 API 提案中固定 per-character 数据结构或 wire 字段**。不兼容算法/codec 报 `UNSUPPORTED_FORMAT`，不当作空文本。相同 op ID 的相同 payload 重送幂等；不同 payload（含不可变归因）报 `IDENTITY_CONFLICT`，包括 pending 中的冲突。

默认一个 bundle 先完整验证，再原子接受；缺依赖则整个 bundle 报 `MISSING_DEPENDENCIES`。`defer` 把完整 bundle 放入有界 pending，不将其中一部分解释为当前 offset；补齐后重新完整校验并发出 history 事件。无环性、引用、group 完整性不通过则拒绝，不留下部分接受的历史。

建议首版：不自动 GC/压缩，历史保留至 store 释放；快照、`pin` 和导出位置都有明确保留语义。`exportPosition` 的 retention 登记不随快照释放；产品需持久保存、重建时恢复该登记与依赖历史。显式释放 retention 表示产品撤销该导出位置的保留保证，不能在仍有外部使用者时误释放。首版 `compact` 报 `UNSUPPORTED_COMPACTION`。以后支持压缩必须保持受支持的已 pin revision/position 可解算，或者显式拒绝；不能悄悄变成最近快照。持久化介质、保留策略与跨进程 pin 存储仍归产品。

### 4.5 产品协作与服务器同步端口

本节落实用户新增要求。采用**由宿主驱动的 headless port**，不在核心里启动 WebSocket、订阅产品的所有 head，或实现一个服务器。客户端与产品服务器可以使用同一套历史端口；服务器只需 store 和产品明确选出的版本，无需 session、DOM、字体或 GPU。LSP transport 与历史同步端口完全不同。

#### 历史同步：公开精确版本，不公开整个 store

```ts
interface HistorySyncPort extends Disposable {
  offer(input: { target: RevisionSet }): HistorySyncOffer;
  receive(input: {
    bundle: HistoryBundle;
    missing?: "reject" | "defer";
  }): HistoryImportReport;
  onReceive(listener: (event: HistoryReceiveEvent) => void): Disposable;
}

interface HistorySyncOffer extends Disposable {
  readonly descriptor: HistoryOfferDescriptor;
  exportMissing(input: { known: PeerKnowledge }): HistoryBundle;
}
```

```ts
import { createHistorySyncPort } from "@zixiao-labs/editor/collaboration";

const sync = createHistorySyncPort({
  store,
  documents: [document, otherDocument],
});

// 产品客户端或服务器：先完成认证/授权，再提供自己明确选定的版本。
// publishedRevisions 可以由产品存储恢复，不要求服务器创建 EditingHead。
const offer = sync.offer({ target: publishedRevisions });
try {
  const response = offer.exportMissing({ known: peerKnowledge });
  await hostTransport.send(historyCodec.encode(response));
} finally {
  offer.dispose();
}

// 接收端由产品的 transport handler 调用；decoder/receive 会复制并验证数据。
const incomingBundle = historyCodec.decode(incomingBytes);
await hostPolicy.authorizeImport(incomingBundle); // 在修改 store 之前完成产品授权
const report = sync.receive({
  bundle: incomingBundle,
  missing: "reject",
});
if (report.status !== "pending" && hostPolicy.shouldAdvanceHead(report.availableRevisions)) {
  main.merge({
    expect: main.checkpoint(),
    source: report.availableRevisions,
  });
}
```

`documents` 是本端口的资源限制域，不是认证凭据。`offer.target` 还必须是其中的精确版本子集。**没有不带 target 的“发出全部历史”默认行为**：同 store 内 Agent 的未发布隔离 head 不因为有新操作就被同步。需要实时协作时，产品监听选定 head 的已提交事件，显式生成新的 offer；导入 store 的孤立历史不会自动变成供给目标。

`descriptor` 是可编码的不可变描述：包含精确 target、document/base 身份与内容摘要、格式/算法兼容信息，不包含产品线程或权限模型。host 可用它做握手；`historyCodec` 提供对应 offer/knowledge 的编码校验边界，但本轮不固定内部 CRDT payload。offer ID 是短期句柄，不是历史 revision 身份；释放后不能再供给数据。offer 创建时持有 pin，后续 head 移动不改变它。

`PeerKnowledge` 是对方声明已拥有的因果版本，不是“最后同步时间”或 LSP 的整数 version。若版本在发送方可验证，就导出所缺历史；若对方持有发送方不认识的并发版本，端口不能假设对方包含 target，默认为受影响文档发送完整 target closure，并按完整 group 补齐。它不放宽端口的文档范围，也不绕过 bundle 大小限制。不同 base 或不支持格式显式失败；超限要求产品做有完整 group 边界的交换，不截断历史。

接收语义沿用第 4.4 节，不另建一套冲突算法。`accepted`/`duplicate` 返回可用的精确版本；`pending` 只表明数据有界暂存。`onReceive` 还会通知 pending 后续接受或拒绝，异常带结构化错误，不静默丢失。所有事件仍遵守第 5.3 节不可重入写入规则；从事件推进 head 时，产品须在后续 microtask 明确 merge，不能在通知中隐含修改。

成功 receive **仅表示本实例接受并可查询历史**，不表示已写入磁盘、已广播、获多数副本确认或通过产品授权。服务器的 durable ACK、会话路由、压缩/分片 framing、重试、断线检测、认证和权限均由宿主提供。断线重连重新交换精确 offer/knowledge；重复 delivery 安全，缺依赖会报告，不需要以当前文本覆盖历史来“修复”。

#### 远端光标：与持久历史独立的 presence 端口

```ts
interface PresencePort extends Disposable {
  publish(input: {
    at: RevisionSet;
    selections: SelectionSnapshot;
    metadata?: JsonValue;
  }): PresencePacket;
  receive(input: {
    packet: PresencePacket;
    sender: PresenceSender;
  }): PresenceReceiveResult;
  snapshot(): RemotePresenceSnapshot;
  onChange(listener: (event: RemotePresenceEvent) => void): Disposable;
  expire(): void;
  remove(input: { sender: PresenceSender }): void;
}
```

```ts
const presence = createPresencePort({
  store,
  documents: [document, otherDocument],
  scope: presenceScopeId("host-opaque-room:42"),
  local: hostPresenceIdentity, // participant + session + 新连接 epoch
  clock: hostMonotonicClock,
  ttlMs: 30_000,
});
const packet = presence.publish({
  at: main.checkpoint().revisions,
  selections: session.selections.read(),
});
await hostPresenceTransport.send(presenceCodec.encode(packet));

presence.receive({
  packet: presenceCodec.decode(remoteBytes),
  sender: authenticatedSender, // 由产品 transport 提供，不相信 packet 自称的身份
});
// 产品从远端集合渲染装饰；不会写入 session.selections。
const remote = presence.snapshot();
```

`SelectionSnapshot` 即第 5 节公开的 `{ version, items, primary }`。packet 使用 `participant/session/epoch + session-local selection ID` 区分远端选区，保留 anchor/head 方向、primary 和源文档稳定位置，不传 glyph/屏幕 offset。excerpt ID 只在本地投影有意义，不当作可移植的源身份；接收端通过 source→projection 的一对多映射选择呈现位置。

presence scope 是 opaque 路由标签，不引入产品项目/线程类型。同 scope 也不代表已授权；`sender` 必须来自宿主已经鉴别的连接。端口检查 packet 身份与 sender 匹配，不能把字段存在当成认证。每 epoch 内有递增 sequence，旧/重复 packet 返回 ignored，不覆盖新状态，也不刷新 TTL；epoch 更新由产品连接生命周期声明，不能用墙钟排序。

默认 TTL 30 秒，按本地单调 clock 计算，`expire()` 由宿主调度，不要求 headless 模型创建定时器；断开时宿主可 `remove`。缺少锚点依赖历史时状态为 unresolved，不夹紧到文首，也不自动向网络索要数据。位置只在当前 presence 的短期 lease 内保留；presence 不创建每次光标移动的永久位置导出登记。

presence 默认限额 64 KiB/packet、256 个选区；超限拒绝，不偷偷截断。产品可以明确选择要广播的选区子集，但这不改变本地公开集合。presence 不进入文档 CRDT、undo 或 Diff；销毁 view 不关闭它，销毁 presence 不关闭 store 或宿主 transport。

同步端口的独立验收必须覆盖：同 store 的未发布分支不泄露、group 越过端口文档域时整批拒绝、未知 peer frontier 的安全补发、断线重连/重复/乱序/缺依赖、accepted 与 durable ACK 的区分，以及 presence 的身份、过期、乱序和 unresolved 位置。仅有两个当前文本字符串相等不是这些端口的验收。

### 4.6 Agent 编辑后的 Diff 输出

本节落实用户新增要求。Diff 是**headless 的只读输出能力**，不依赖 syntax、LSP、DOM、vgpu 或 Git。Agent 是产品声明的事务 origin/attribution，不要求库连接任何 Agent 服务。

#### 两种输入，同一个版本化结构化结果

```ts
type DiffInput =
  | { from: RevisionSet; to: RevisionSet; change?: never }
  | { change: CommitReceipt; from?: never; to?: never };

interface DiffOptions {
  contextLines?: number; // 默认 3，允许 0..1000 的整数
  intraline?: "grapheme" | "none"; // 默认 grapheme
  maxOutputBytes?: number; // 默认 16 MiB
  signal?: CancellationSignal; // 核心结构类型，不要求 headless consumer 引入 DOM 声明
}

interface UnifiedDiffOptions {
  labels?: ReadonlyMap<DocumentId, Readonly<{ before: string; after: string }>>;
}

// HistoryStore.diff(input: DiffInput & DiffOptions): Promise<DiffReport>
// formatUnifiedDiff(report: DiffReport, options?: UnifiedDiffOptions): string
// diffCodec.encode/decode：版本化结构化报告，不是历史同步 codec。
```

```ts
const agentHead = store.fork({
  at: main.checkpoint().revisions,
  writer: agentWriter,
});
const change = agentHead.commit({
  expect: agentHead.checkpoint(),
  edits: agentEdits,
  origin: { kind: "agent", label: "host-agent-edit:17" },
  attribution: { request: "host-request:17" },
});
const report = await store.diff({ change, contextLines: 3 });
const structured = diffCodec.encode(report);
const unified = formatUnifiedDiff(report, {
  labels: new Map([[document, { before: "a/src/main.ts", after: "b/src/main.ts" }]]),
});
// 产品保存、展示或把 unified 返回给 Agent；本库不自动写文件或打印到终端。
// 输出 Diff 不会合并 Agent head；接受修改仍是另一次显式 pinned merge。
```

`CommitReceipt` 指一次完整本地发布的 before/after 和受影响文档；`head.commit`、session 批量编辑、undo/redo、merge 的 receipt 均可用于 Diff。先前正文中的提交返回值统一采用这个类型；`store.diff({change})` 限定该 receipt 的确切边界，而不是以调用时 head 的“最新文本”比较。无源变化的 receipt 返回空报告。

receipt 的 source before/after 统一为 `HeadCheckpoint`，session 的 selection effects 作为附加字段，不用 session checkpoint 冒充源版本。receipt 是本地提交证明对象，不是新的分布式历史身份；跨进程可以保存精确 from/to，并在恢复对应历史后使用 versions 输入。传入不属于本 store 或无法验证的 receipt 报 `INVALID_REFERENCE`，不能相信任意对象自称的 commit/origin。

`DiffReport` 为不可变值，包含：

- `schemaVersion`、basis（versions 或 commit）、精确 from/to 和可用的事务/group/origin 摘要；这些 metadata 不被视为认证。
- 按 DocumentId 规范次序排列的 source-document diff；重复 excerpt 只产生一份源差异。
- 每文档的 before/after revision（某边在输入集合中缺席则为 null）、`modified | added | removed`、完整文本替换段与删/插行统计。
- 每个替换段的旧/新版本 UTF-16 半开范围、删除/插入文本；可选 grapheme intraline 标记也绑定对应源 revision，不暴露为当前 live offset。
- 带上下文的行级 hunks 和 unified 输出所需原始文本。报告完成后不依赖继续存活的快照句柄。

报告中的 added/removed 只表示文档在两份版本集合中的成员差异，不执行或推断文件系统的创建/删除。未知 revision 不是缺席，不可用历史也不是空文档。首版不识别 rename/move；移动文本显示为删除/插入。源初始内容不变但历史/归因变化时，文本 Diff 为空，历史查询仍可看出差别。

#### 多步 Agent 编辑与并发边界

```ts
const before = agentHead.checkpoint();
// 产品让 Agent 在此隔离 head 上执行多步编辑。
const after = agentHead.checkpoint();
const report = await store.diff({
  from: before.revisions,
  to: after.revisions,
  signal: controller.signal,
});
```

只比较捕获版本，不自动跟随 agentHead。计算开始时验证并 pin 两端；异步期间新的编辑不改变报告，完成/失败/取消后释放计算持有的 pin，不长时间阻塞源写入。

一个本地 commit 原子发布，因此 receipt diff 能说明该次发布的净文本变化。若该 receipt 是 merge，其变化可能包含多个 actor，不能称为单个 Agent 的创作。多步区间若包含远端/人工编辑，则 versions diff 包含它们；没有按 actor 过滤后仍假称可应用的 patch 模式。需要纯 Agent 提案时，产品应给 Agent 未合并他人变更的隔离 head；需要看“接受 Agent 后对当前主 head 的影响”，则比较那次 pinned merge 的 receipt，两种 Diff 不能互换。

#### Unified diff 的确定性与错误语义

默认 context 为 3 行，不忽略空白、大小写或 EOL；不加时间戳或额外的终端颜色/ANSI。相同端点与 options 产生相同排序和输出。unified 行号按 **LF 分隔的 patch 行**计算，与编辑器识别 CR/CRLF 的逻辑行坐标区分；CRLF 的 CR 保留为行内容，CR-only 内容不被偷偷转成 LF。缺结尾 LF 使用固定英文的标准 `\ No newline at end of file` 标记；结构化源范围仍是准确 UTF-16。

labels 由产品提供，不从 DocumentId 猜真实路径；默认使用安全编码的文档身份标签，缺席的一侧 header 使用 `/dev/null`。换行、NUL、控制字符等不合法 label 报 `INVALID_DIFF_LABEL`，不把不可信字符串变成 patch header。已有的文件名/path 标签只是输出描述；不宣称默认输出已经对应可运行 `git apply` 的工作区，也不实现 patch 应用。若产品需要接受修改，应使用保存的源 edits 与 checkpoint 或精确 merge，不把 Diff 文本当作 CRDT 操作。源文本自身仍是不可信内容，宿主展示或写终端时需安全处理，不把 formatter 未添加 ANSI 误解为源内容已被清洗。

`maxOutputBytes` 按结构化报告和完整 unified 输出的 UTF-8 编码预算检查，任一超限整次报 `LIMIT_EXCEEDED`；formatter 对标签变化后的输出也校验预算。不返回“成功但截断”的 patch。取消报 `CANCELLED`，历史缺失用已有错误；异步失败不改变源、选区或撤销栈。收到外部 Diff 的 decoder 校验格式/范围/hunk 一致性，但不把它变成认证过的历史。

独立验收增加：单次/多步 Agent 编辑、合并 receipt 与源提案差异、并发区间不能冒称 Agent-only、重复 excerpt、多文档/空差异、重复行的确定性、非 ASCII/grapheme、LF/CRLF/CR-only/缺结尾换行、标签注入、输出上限与取消、历史释放/丢失错误。统一 Diff 的测试需在精确 base 上重建得到精确 target，而不只是检查输出“长得像 patch”；该重建 oracle 不成为首版公共 patch/Git API。

#### 已确认的局部呈现

用户进一步确认 receipt 入口，并提供局部编辑片段截图。按文件标签 + 上下文 + 行级增删高亮组织，不复制截图源码或读取其文件。单次 receipt 是 Agent 结果卡片默认边界，不把对话“思考/工具调用/说明”模型塞入库。

`/vgpu` 提供只读 `mountVgpuDiffView({report,document,element,layout,syntax?,options?})`；产品可只用结构化报告自行渲染，不被此 view 绑住。删除行分类绑定 before，插入/context 行绑定 after；不能用拼接 hunks 假装完整源解析。视图不创建可写假文档或替产品接受修改。具体生命周期和默认值以锁定契约 D7 为准。

## 5. 多光标：产品掌握会话，不读取 view 私有状态

### 5.1 完整集合、稳定 ID、方向与 primary

```ts
const session = createEditorSession({ target: main.document(document) });
const source = main.snapshot(document);
const first = selectionId("rename:left");
const second = selectionId("rename:right");

session.selections.set({
  expect: session.selections.read().version,
  items: [
    {
      id: first,
      anchor: { document, position: source.anchorUtf16(0, { affinity: "before" }) },
      head: { document, position: source.anchorUtf16(3, { affinity: "after" }) },
    },
    {
      id: second,
      // anchor > head，是反向选区；不另设可能矛盾的 reversed 标志。
      anchor: { document, position: source.anchorUtf16(9, { affinity: "after" }) },
      head: { document, position: source.anchorUtf16(8, { affinity: "before" }) },
    },
  ],
  primary: first,
  origin: { kind: "product", label: "rename-preview" },
});
const selectionState = session.selections.read();
// { version, items, primary }：运行时不可变，不只是 TypeScript readonly。
const subscription = session.selections.onChange(event => {
  // event: before/after、origin、reason、commitId、repairs、checkpoint
  renderProductOwnedCursorDecorations(event.after);
});
```

`selectionId(string)` 由产品命名或 `session.allocateSelectionId()` 分配；只要求会话内唯一，不使用数组索引，不因方向改变、合并或绘制排序而换 ID。同一 ID 不表示远端用户 presence。

折叠 caret 的 anchor/head 使用同一个 stable position。仅当前 offset 相同而 affinity 不同的两个端点，不保证在后续插入后仍折叠。`metadata` 为会话局部、验证后复制的 JSON 值；保留它不代表将其广播或写进源历史。

还拟提供 `add`、`update`、`remove`、`setPrimary`；均要求 selection `expect` 和 origin。`set` 中 ID 重复、primary 不在集合中或混入其他目标的端点，整次拒绝。允许空集合，primary 必须为 null；默认 session 从空集合开始，不偷偷创建 renderer 私有光标。添加到空集合时该 selection 成为 primary；移除非最后一个 primary 时必须显式指定新的 primary，不以数组首项补位。单个 selection 两端必须属于同一个源文档与同一个 excerpt occurrence。

源文档 session 不带 excerpt；MultiBuffer session 的端点必须带 excerpt。保存使用 `session.selections.save()`，恢复使用 `restore({ expect, saved, missing: "reject" })`；默认不丢失无法解算的选区。显式 `missing: "repair"` 才按 affinity 选择删除位置的 before/after 候选，并在返回值和事件报告修复。保存值不是认证后的 presence，也不进入源文档历史。

### 5.2 一个批量 API：统一替换或按 ID 替换

```ts
const receipt = session.replaceSelections({
  expect: session.checkpoint(),
  replacement: { kind: "uniform", text: "value" },
  origin: { kind: "product", label: "rename" },
}); // 一个事务/group，所有 ranges 基于同一个 checkpoint

const nextReceipt = session.replaceSelections({
  expect: session.checkpoint(),
  replacement: {
    kind: "per-selection",
    values: new Map([[first, "leftValue"], [second, "rightValue"]]),
  },
  origin: { kind: "product", label: "two-values" },
});
// receipt 提供 source transaction/group、before/after、
// 每个 selection ID 的结果、去重后的 appliedSourceEdits。
```

`per-selection` 必须恰好覆盖本次 selection ID 集合，缺项/多项均拒绝，不用数组位置对齐。默认替换后每个 ID 折叠到它插入内容的末尾，primary 不变；原有方向在撤销记录中保留。空集合编辑报 `NO_SELECTION`。文本相同、删除空范围等无源变化时返回 `no-change`，不制造空 CRDT op 或污染 undo。

`no-change` 只表示源文本没变；如果命令需要折叠原选区，仍发布 selection-only 变更，并在 receipt 中区分 text/selection 是否改变。

**建议固定的默认冲突规则：**

| 在同一 base revision 上归一到源范围后 | 处理 |
| --- | --- |
| 相同范围、相同文本、相同边界 affinity | 合成一次源编辑，保留所有 selection ID 与 occurrence |
| 重复 caret，插入不同文本 | `ALIAS_EDIT_CONFLICT`，不按 ID/数组顺序拼接 |
| 相同范围，但替换内容/边界语义不同 | `ALIAS_EDIT_CONFLICT` |
| 严格重叠、但不完全相同的非空范围 | `OVERLAPPING_EDITS`，即便文本相同也不猜 union |
| 相邻非空半开范围 | 允许，同时应用 |
| caret 位于另一替换范围内部或恰在端点 | `OVERLAPPING_EDITS`，避免隐式“先插入还是先替换” |
| 不同源文档，或者同文档不相交范围 | 允许 |

选区集合本身可重叠/重复；这些规则约束执行编辑，不自动删选区。归一、alias 去重和全部校验先于任何写入。以文档 ID 的规范字节序、源范围起点/终点、selection ID 形成稳定报告顺序；实际语义是同一 base 的同时编辑，不是按该顺序连续解释旧 offset。primary 不因 alias 合成消失。

### 5.3 事件、远端更新与撤销

源事务、head 版本、projection 映射、关联选区全部提交后才通知。每次提交有一个带 before/after checkpoint 的不可变 envelope；head/session 等细分订阅引用同一个 commit ID。事件按提交序列在 microtask 派发；消费者不能改 payload 的 Map/数组背后的共享状态。读取 live head 可能已比某个排队事件新，需用该事件 checkpoint 获取对应快照，不能假定始终等于 event.after。

监听期间同步重入写入报 `REENTRANT_WRITE`，宿主可在后续 microtask 发起下一事务。监听器异常经可配置 error sink 报告，不回滚已发布文本、不阻断其他监听器，也不静默吞掉。

远端 history 接受后，只有产品显式将精确 revisions merge 到 head，session 才随该 head 更新位置。selection ID、primary 和产品 metadata 不被远端集合覆盖。删除落点按其 affinity 修复并发出 `reason: "history"` 和 repair 详情；目标版本尚未创建/移除 occurrence 时保留 ID、标记 suspended，编辑报 `UNRESOLVED_SELECTION`。

```ts
const group = session.undo.beginGroup();
session.replaceSelections({
  expect: session.checkpoint(),
  replacement: { kind: "uniform", text: "replacement" },
  undoGroup: group.id,
  origin: { kind: "product", label: "one-user-command" },
});
group.close();

session.undo.undo({ expect: session.checkpoint() });
session.undo.redo({ expect: session.checkpoint() });
// 默认每个未显式归组的用户命令就是一个 group，无 headless 定时器猜测。
```

undo 栈属于 session，记录该 session 发起的本地 group 以及前后 selection 集合/primary/方向。直接 `head.commit` 不自动成为任一 session 的用户撤销项。首版只撤销最近的可撤销本地 group，忽略中间远端事务；不承诺任意挑选旧 group。跨文档 group 作为一个撤销单位。

undo/redo 生成新的因果补偿事务，不删除历史、不 checkout，不删除无关远端插入，也不复活仍被其他删除效果覆盖的内容。具体可撤销删除标记/补偿规则要在 CRDT 规格中证明。结果为 `applied | partial | no-effect`，包含受并发影响的明细，不能承诺任何时候都逐字返回旧字符串。只恢复发起 session 的选区，按当前历史转换保存的锚点并报告修复；其他 session 仅跟踪位置。远端合并不清空 redo；新的本地 session 编辑才清空 redo。

## 6. MultiBuffer：可编辑的源投影，不是特殊源文档

```ts
const snapshot = main.snapshot(document);
const whole = snapshot.stableRangeUtf16(0, snapshot.lengthUtf16, {
  startAffinity: "before",
  endAffinity: "after",
});
const projection = createMultiBuffer({
  head: main,
  excerpts: [
    { id: excerptId("occurrence:one"), document, range: whole },
    { id: excerptId("occurrence:two"), document, range: whole },
    { id: excerptId("occurrence:other"), document: otherDocument, range: otherRange },
  ],
  decorations: [{ id: "heading:one", before: excerptId("occurrence:one"), text: "Example" }],
});
const projected = projection.snapshot();
const endpoint = projected.toSource({
  kind: "text",
  excerpt: excerptId("occurrence:two"),
  offsetUtf16: 4,
  affinity: "after",
});
// endpoint 含 document、stable position、excerpt；没有丢掉 occurrence。
const occurrences = projected.fromSource({
  document: endpoint.document,
  position: endpoint.position,
});
// fromSource 只接收源身份，不接收限制 occurrence 的 excerpt：
// occurrence:one 和 occurrence:two 都可能命中，按投影顺序返回。
const session = createEditorSession({ target: projection });
```

`otherDocument` 必须在同一个 main head 内；`otherRange` 必须由对应源快照创建。`ProjectionSnapshot` 保存 source revisions 与 membership generation。`offsetUtf16` 仅相对指定 excerpt，不制造可误用为源 offset 的“拼接全文数字”。

`toSource` 接收判别联合：text、boundary、decoration。text 返回源端点；boundary/decoration 返回同类不可编辑结果，不伪装源字符。若在两个 excerpt 间插入，必须用 `resolveBoundary({ boundary, side: "left" | "right" })` 明确选定目标 occurrence；不存在的一侧报错。affinity 决定源位置跟随同边界插入的方向，不替代左右 excerpt 的选择。

excerpt 的稳定范围两端必须给出 affinity；不默认吞入/排除边界插入。上例 before/after 表示两端新插入包含在范围内。范围内部被删空时保留零长 excerpt 与身份；身份只由产品通过 `setExcerpts({ expect, excerpts })` 改变。删除了 occurrence 后，相关选区 suspended 并带 reason，不自动绑定到另一个相同源的 excerpt。

**重复映射与跨 excerpt 策略：**

- 同一 source 的变更同时反映到所有 occurrence；解析、高亮和 LSP 仍按源文档处理一次。
- 一个 selection 的替换跨越不同 excerpt，默认 `CROSS_EXCERPT_EDIT`，即使两段来自同一文档且在源中相邻。标题/分隔符不进入编辑范围。
- 多个各自位于单个 excerpt 的 selection 可以作为同一 `replaceSelections` 批量编辑。
- 重复 excerpt 的相同源编辑按第 5 节去重；不能因为有两个“光标”就插入两次。冲突的 alias 编辑整批拒绝。
- 不同文档必须同属一个 store/head；`DIFFERENT_ATOMIC_DOMAIN` 不能降级为依次成功。

### 本地原子性不等于分布式原子性

一个多源命令先收集所有文档的 base revision，再验证所有范围、映射和 group 元数据，最后一次发布；任一失败，不修改任何源文档或选区。产品若需远程权限验证，应先自行完成，提交时仍做 checkpoint 校验；editor 不因校验过某份文本就提供授权保证，也不实现授权服务。

每个源文档仍有自己的 revision，多文档写入用 `TransactionGroupId` 关联。head 的版本集合提供本地一致视图。导出/导入以完整 group 为最小发布边界；缺成员或依赖先 reject/defer，不在接收 store 暴露半组。

**精确 merge 也遵守 group 闭合**：如果 pin 的版本只包含某跨文档 group 的一部分，且目标也未包含其余成员，报 `INCOMPLETE_TRANSACTION_GROUP`。错误提供必须补齐的精确成员 revisions；不偷偷拉取 source head 的较新版本。document-filtered export 同理，不悄悄扩大权限范围。

这些规则只能保证一个库实例内的接受/发布不露出半组。不提供分布式锁、共识、两阶段提交、全节点同时可见或服务端持久化原子性；网络可以断开、某副本可以一直缺文档。产品若要求跨设备的持久/同步原子性，须另建协议。group 的库内一致性与因果闭合不代表所有副本已收到。

## 7. 语言层：先源坐标，再协议，最后呈现

### 7.1 语言插件与增量语法

```ts
const languages = createLanguageRegistry();
const registration = languages.register({
  id: "typescript",
  syntax: independentlyPackagedTypeScriptSyntax,
});
const syntax = attachSyntax({ head: main, languages });
const tokens = await syntax.classify({
  document,
  revision: main.checkpoint().revisions.get(document),
});
// { document, revision, grammarGeneration, classifications }，不是颜色数组
```

插件声明 language ID、parser/runtime 兼容信息、grammar/query 资产及许可。文件名/URI → language 的选择可由产品指定；不硬编码进 renderer。推荐首版语法覆盖 TS/JS/JSON，具体 parser/runtime 和 grammar 版本尚未选择，也未安装。

语法服务持有自己的树/worker；只在有可信 source edit 链时复用旧树。转换单位用对应旧/新 revision 的坐标；无法重放的跳转可以全量解析，但不能把全量每次解析称为增量。公开树快照不得因 Tree-sitter 的树编辑而变化；并发 worker 使用独立树副本。异步结果核对 document、revision、grammar generation，晚到结果不能覆盖当前输出。

分类到主题的映射独立于语法；默认优先级是“当前 revision 的 semantic 属性覆盖 syntax 的相应属性，其余保留 syntax，最后才是 plain text”。过期 semantic 不覆盖新 syntax。诊断下划线、选区、光标是独立装饰层。仅颜色不同不切碎塑形 run；必须改变字体/特性时才触发布局失效。一个合成 glyph 跨多种颜色时默认采用其首个逻辑 grapheme 的颜色，避免靠切断连字实现着色。

### 7.2 Transport 注入与源文档绑定

```ts
interface RpcTransport {
  send(message: JsonRpcMessage): Promise<void>;
  onMessage(callback: (message: unknown) => void): Disposable;
  onClose(callback: (cause?: Error) => void): Disposable;
  dispose(): void;
}

const client = await connectLanguageServer({
  transport: hostTransport,
  initialization: { rootUri: "file:///demo", workspaceFolders: hostFolders },
  requestTimeoutMs: 10_000,
  unversionedDiagnostics: "report-only",
}); // 初始化协商成功后才返回；transport 默认借用

const binding = client.bindDocument({
  head: main,
  document,
  uri: "file:///demo/main.ts",
  language: "typescript",
});
const requestSnapshot = main.snapshot(document);
try {
  const at = requestSnapshot.revision;
  await binding.sync({ at });
  const result = await binding.hover({
    at,
    position: requestSnapshot.pointUtf16(4),
    signal: abortController.signal,
  });
  if (result.status === "ready") showHover(result.value);
  // status === "stale" 不会拿旧 offset 画在新文档上。
} finally {
  requestSnapshot.dispose();
}

binding.dispose(); // didClose（若连接尚在），移除订阅
await client.shutdown(); // shutdown/exit，有截止时间；不关闭借用的宿主 transport
```

transport 只负责有序 message 交付、背压和断开通知。WebSocket frame、stdio Content-Length 等 framing 属于适配器；库负责 JSON-RPC envelope 验证、ID/响应匹配、初始化、LSP 能力检查、取消、超时、状态和错误传播。浏览器不会因为调用 `connectLanguageServer` 就获得 spawn 原生进程的能力。

同一连接同一 URI 同时只能绑定一个源 head/document；不同隔离 head 用相同 URI 报 `URI_IN_USE`，产品选择不同连接或服务器支持的虚拟 URI。逻辑 DocumentId 与 URI 解耦；URI 改变走显式 close/open，不改历史身份。外部 definition location 保留 URI/协商 encoding，由产品加载并绑定后再转换，不擅自访问文件系统。

同步规则：

1. 每个连接 generation、URI binding 维护 `RevisionId ↔ LSP document version` 表。LSP version 是有界递增整数，不是 CRDT revision；head 回看历史也不能让 version 倒退。
2. 协商 full/incremental/none 与位置编码，默认支持 UTF-16，并仅宣告已实现的 UTF-8/UTF-32 转换。未指定编码按 LSP 3.17 的 UTF-16 默认处理，不把 UTF-16 code units 当字节。
3. 同一 library batch 的范围都相对于旧 base；LSP `contentChanges` 却是逐项顺序应用。适配器必须重算为连续有效的变化序列，不能把并行 ranges 原封不动塞进数组。full 模式发完整源文本；none 模式不能假装后续编辑已同步。
4. `sync({at})` 先验证 binding/head 的源 revision，排队发送对应 didOpen/didChange；同 generation/URI 的请求排在这些消息之后。`send`/sync 完成表示已按序交给 transport，**没有 didChange 分析完成 ACK 的承诺**。
5. hover、completion、definition、semantic tokens 均捕获 `{document, uri, revision, lspVersion, generation}`。响应只有在 stamp 仍匹配时为 ready，否则为 stale；默认不自动重放或重映射语义结果。取消/超时/断开 reject 对应错误，不返回伪造空成功。
6. diagnostics 有 version 时按已知表精确关联；无 version 时只能报告 `unversioned`，默认不直接上屏，也不能虚构为最近一次发送的 revision。产品可观察此事件；首个真实服务器若不带 version，必须诚实展示这一限制或采用有版本证据的受支持协议路径。
7. completion 的 text edits、LSP WorkspaceEdit 经保存的源 revision/编码转换后，再走同一个 head/session 原子提交 API；已过期编辑拒绝。首版不执行创建/重命名/删除文件等 resource operations，不宣告此能力。

注册的首批 feature 为 diagnostics、completion、hover、definition、semantic highlighting，逐项检查服务器 capability。只有实际实现的 client capability 才参与初始化。markup 作为不可信纯文本/安全 Markdown 数据交付，禁止 server HTML 直接注入 DOM。服务 disconnect 后所有 pending 请求被拒绝、旧结果 generation 失效；重连是新 generation，重新初始化并 didOpen。

开发原生桥若以后提供，只绑定 localhost、命令和 workspace 白名单；不作为生产远程执行服务。真实 TypeScript server 的包/版本、许可和启动方式在实现计划前另行选定，协议 fixture 不能取代这个工作流。

## 8. 塑形、GPU 与输入：三个独立责任

```ts
import { createLayoutEngine, loadFont } from "@zixiao-labs/editor/shaping";
import { mountVgpuView } from "@zixiao-labs/editor/vgpu";
import { bindBrowserInput } from "@zixiao-labs/editor/browser";

const plex = await loadFont({
  bytes: genuineIbmPlexMonoBytes,
  expectedFamily: "IBM Plex Mono",
});
const layout = createLayoutEngine({
  shaper: verifiedShaper,
  fonts: { primary: plex, fallback: explicitFallbackFaces },
  features: { liga: true, calt: true },
});
const view = await mountVgpuView({ session, element: canvas, layout });
const input = bindBrowserInput({ session, element: hostInputElement, geometry: view });
const states = view.onStateChange(state => {
  // loading-font / ready / webgpu-unavailable / device-lost / disposed
  if (state.kind === "device-lost") reportError(state.cause);
});
layout.setOpenTypeFeatures({ liga: false, calt: false });

input.dispose();
states.dispose();
view.dispose();
// session、main、store、借用的 layout 仍活着，可挂载另一个 view。
layout.dispose(); // 释放布局自有资源，不释放借用的 shaper/font
plex.dispose(); // layout 借用的字体由创建它的宿主释放
```

此处没有调用或捏造任何 vgpu 当前包 API。`mountVgpuView` 是本库拟议入口，内部才绑定选定版本的 vgpu。失败的 WebGPU 初始化 reject `WEBGPU_UNAVAILABLE`，运行中设备丢失有状态事件并停止绘制。默认不静默切到 Canvas renderer；宿主仍能使用 headless model。恢复尝试必须显式 `view.recover()`，若失败仍报告 device-lost，不销毁源历史。

责任边界：

- **shaper** 接收真实字体、源文本、方向/script/language、OpenType 特性，产生 glyph ID、font-unit advance/offset、cluster → 源范围关联。推荐评估 HarfBuzz/WASM；尚未选择包装包或版本。单纯 CSS 开关不算塑形实现。
- **layout** 将 glyph/cluster、grapheme caret stops、换行/折行、tab、bidi 视觉次序转为 CSS pixel 几何；hit-test/选区几何都带 source revision 和 layout generation。连字内部的合法 caret 先用字体提供的 ligature caret 数据，缺失时在 grapheme 边界给出有说明的插值策略，不把 glyph 当成一个源字符。
- **rasterizer + vgpu view** 将真实 glyph 栅格化/缓存并用 vgpu 绘制，使用 layout 的几何，负责可见区虚拟化、DPR、裁剪、atlas/GPU 生命周期。vgpu 绘制不能代替字体塑形，glyph rasterizer 也不能拿源字符逐个浏览器 measure 后宣称连字正确。

默认字体明确为真正 IBM Plex Mono；候选官方资产 `@ibm/plex-mono@2.5.0`，尚未安装。不隐式联网获取字体，缺少默认字体是 `FONT_UNAVAILABLE`，不能静默用另一个等宽字体冒名。中文缺字可走明确配置的 fallback face，并在 glyph run 暴露实际 font ID，不能把整段默认字体偷换。字体资产来源、版本、digest、许可随选择记录。

IBM Plex Mono 不含 `->`、`=>`、`===` 编程连字。要证明引擎真支持这些连字，需用户批准一个**另选的 opt-in 连字字体/测试资产**，例如待审许可的 Fira Code；不能通过更改源字符证明。批准前只能测试默认 Plex 的真实塑形，不能宣告编程连字验收已通过。批准后对真实 glyph/cluster 与浏览器 GPU 输出做 on/off 检验，并验证源文本、复制内容和 caret mapping 不变。

输入桥处理 beforeinput、composition、paste 和焦点，不靠 keydown 推导中文文本。composition 预览暂存于 session 的瞬态 overlay，不成为每次 compositionupdate 的 CRDT 事务；确认提交为一个 undo group。组合期间源变更需按稳定位置跟踪；若组合目标被删除或 occurrence 消失，取消并发出 `COMPOSITION_CONFLICT` 及可恢复预览文本，不提交过期 offset。多个 selection 的 IME 默认仅 primary 参与，提交后其他 selection 保留并正常重定位；统一多选区替换仍由公开 API 显式发起。

input 与 view 可独立拆卸；产品可管理自己的 textarea/焦点 UI。可访问性需以真实工作流验证读屏、导航和 composition，不因存在隐藏 textarea 就宣称支持。单纯 headless session 不需要字体、DOM 或 GPU。

## 9. 失败语义与建议默认值汇总

同步模型操作抛出 `EditorError`，有稳定 `code`、不可变结构化 `details`、可选 `cause`；失败无部分文本/选区变更。异步 parser/font/LSP/GPU 方法 reject 同一错误体系，连接/view 状态另有可订阅事件。预期的查询状态（位置 deleted、结果 stale、undo partial）用判别联合，不以异常或空数组掩盖。TypeScript 类型品牌不能代替运行时导入校验。

| 类别 | 拟议 code / 行为 |
| --- | --- |
| 身份/历史 | `UNKNOWN_DOCUMENT`、`DOCUMENT_NOT_IN_HEAD`、`BASE_MISMATCH`、`UNKNOWN_REVISION`、`HISTORY_UNAVAILABLE`、`IDENTITY_CONFLICT`、`INVALID_CAUSAL_GRAPH` |
| 同步导入 | `MISSING_DEPENDENCIES`（含缺项）、`INVALID_REFERENCE`、`UNSUPPORTED_FORMAT`、`LIMIT_EXCEEDED` |
| 协作/输出 | `SYNC_SCOPE_MISMATCH`、`SENDER_MISMATCH`、`INVALID_PRESENCE`、`INVALID_DIFF_LABEL`；旧 presence 返回 ignored 而非覆盖新状态 |
| 事务/坐标 | `STALE_CHECKPOINT`、`WRONG_REVISION`、`INVALID_RANGE`、`INVALID_BOUNDARY`、`INVALID_UNICODE`、`DIFFERENT_ATOMIC_DOMAIN`、`INCOMPLETE_TRANSACTION_GROUP` |
| 选区/投影 | `INVALID_SELECTION_SET`、`NO_SELECTION`、`UNRESOLVED_SELECTION`、`OVERLAPPING_EDITS`、`ALIAS_EDIT_CONFLICT`、`CROSS_EXCERPT_EDIT` |
| 生命周期 | `DISPOSED`、`RESOURCE_IN_USE`、`REENTRANT_WRITE`、`UNSUPPORTED_COMPACTION` |
| 语言服务 | `URI_IN_USE`、`UNSUPPORTED_CAPABILITY`、`UNSYNCHRONIZABLE_REVISION`、`PROTOCOL_ERROR`、`CANCELLED`、`TIMEOUT`、`DISCONNECTED` |
| 呈现/输入 | `FONT_UNAVAILABLE`、`SHAPING_FAILED`、`WEBGPU_UNAVAILABLE`、`DEVICE_LOST`、`COMPOSITION_CONFLICT` |

建议数值默认，待签名锁定时确认，不是现有实现事实：

| 项目 | 默认 |
| --- | --- |
| import 缺依赖 | reject；defer 必须显式启用 |
| bundle 上限 | 8 MiB 编码字节、100,000 operations；两者任一超限即拒绝 |
| attribution/origin metadata | 每事务总计 16 KiB 的规范 JSON 字节，不自动截断 |
| pending 上限 | 显式 defer 时 32 MiB；按依赖顺序尝试，不静默驱逐 |
| history retention | 首版无自动回收/压缩；生产持久存储不由库包办 |
| 同步端口 | 必须显式指定文档域和精确 target；不自动发布所有历史、不自动推进 head |
| presence | TTL 30 秒、64 KiB/packet、256 选区；宿主驱动 expire，旧/重复 packet 不延长 TTL |
| Diff | 结构化 + unified，context 3、grapheme intraline、16 MiB 完整输出预算；不隐式归一化或截断 |
| 选区 | 初始空集、primary null；重叠可表示但编辑按第 5 节处理 |
| 编辑后选区 | 原 ID/primary 保留、折叠到插入末尾 |
| undo | 每命令一组、会话本地、补偿历史而非 reset；跨文档同组 |
| 跨 excerpt 单范围替换 | 拒绝；不同 excerpt 的独立选区可批量提交 |
| LSP | 10 秒请求超时；stale 不上屏；无 version diagnostics 只报告 |
| GPU fallback | 无静默 fallback；失败显式报告，headless 继续 |
| 字体与文本 | IBM Plex Mono；不伪造编程连字；源文本无 Unicode/EOL 归一化 |

这些上限是资源防护，不是文件大小/历史总量的性能承诺。一次本地有效但无法在上限内编码的事务不能等到同步时才发现；提交阶段也要验证其可导出大小。超过上限需宿主显式分组或调整一致的限额，不能自动拆开破坏用户事务语义。

## 10. CRDT 的独立算法关口，不由 API 方案代替

本轮没有选择/实现 CRDT，也不从合同推导一个“已正确”的排序规则。下一份算法规格需采用公开来源并说明哪些性质沿用、哪些是本库自行扩展；不能复制参考项目的代码/伪代码/测试。公开阅读候选：

- Shapiro 等，*Conflict-Free Replicated Data Types*（2011），DOI `10.1007/978-3-642-24550-3_29`：收敛、因果交付等基础定义；尚未在本轮通读证明。
- Weidner、Kleppmann，[*The Art of the Fugue: Minimizing Interleaving in Collaborative Text Editing*](https://arxiv.org/abs/2305.00583)，明确引用版本 `2305.00583v3`：比较非交织性质；本轮只核查摘要，不宣称已验证其算法或证明。不读取其实现仓库作为捷径。

算法选型时比较至少两种公开可说明的序列 CRDT，重点不是 benchmark 排名，而是：

1. 并发相同/相邻 gap 插入的确定性顺序与 run 非交织性质；反向连续输入、并发替换到底保留什么意图。
2. 删除作用于哪个因果上下文、是否只删除已观察内容；为何不能误删并发插入；重复/乱序/缺依赖与恶意 ID 冲突。
3. actor、replica、writer/stream、操作 ID、依赖图与 revision 等价性；跨重启身份、循环/溢出/碰撞处理。
4. 位置的创建、affinity、删除、旧版本回看、并发删除时 before/after 的形式定义。
5. 多文档 group、选择性本地 undo/redo、新补偿事务的可见性；不能仅有一个插入/删除算法就声称这些已解决。
6. codec 校验、base digest、历史 materialization、pin/压缩兼容的模型；内部可以用 run/chunk 索引，不暴露为固定逐字符公共 wire。

独立验证设计也单独审阅：小规模因果图的全部合法 delivery 排列、至少三副本 seeded 随机序列、重连/重复/缺父节点/非法历史、fork 与精确 pinned merge；用简单慢模型验证历史集合和顺序性质，避免 oracle 与生产实现共用排序代码。顺序参考字符串只证明单副本编辑，不能冒充并发 oracle。另测连续插入不交织和远端意图保留，不能只断言所有副本“同样错”。

以上是后续规格的进入条件，不是本轮已经完成的算法证明或分阶段实施计划。如果公开算法不能支撑已推荐的补偿/位置语义，应在实现前回来重审 API，而不是偷偷削弱合同。

## 11. 用户确认记录与契约收敛

用户已在本会话确认下面四项。它们不再作为开放问题；后续不能因实现方便而默默切回 A/C、放宽冲突规则或换掉默认字体。无需再次决定已明确的“禁止 Yjs、使用 vgpu、保留工具版本、产品拥有线程/Git”等要求。

| 决策 | 已确认内容 | 约束 |
| --- | --- | --- |
| D1：公开对象组织 | **B：store/head/session 分层**，并给产品协作/服务器同步端口 | 同 store/head 为本地多源原子域；产品服务不进入 editor |
| D2：多选区和跨 excerpt | **严格规则**：相同源编辑去重但保留选区 ID；冲突重叠整批拒绝；单范围跨 excerpt 拒绝 | union/跨段分割若以后增加，必须是单独的显式命令 |
| D3：连字证明用字体 | **允许许可审查后的 opt-in 连字字体用于测试与 playground 切换；Plex 仍默认** | 具体资产/版本/许可尚未选择，不假称已批准某一个字体包 |
| D4：首版语言与示例 | **TS/JS/JSON 增量语法 + 一个真实 TypeScript LSP；框架无关库、vanilla TS playground** | grammar/runtime/server 的具体依赖仍须版本、许可与真实工作流验证 |

同次反馈还新增 **Agent 编辑后的 Diff 输出**。本轮补齐第 4.5、4.6 节的具体 API，范围明确包含服务端可调用的历史端口、独立远端 presence、结构化 Diff 与 unified 文本；不是仅把已有文本变化通知重命名为“协作能力”。

接口边界收敛为：**宿主驱动网络和权限；库保证精确版本供给、验证与因果整合；不自动发布隔离 head；Diff 使用版本/receipt 而不是 actor 过滤。** 用户随后明确确认“一次 Agent 提交的确切变化”，提供局部片段呈现参考并要求继续，因此进入锁定/计划阶段；不虚构用户逐条审阅过每个辅助类型字段。

错误码、默认值、生命周期、只读 Diff view 与非目标已归入 [规范 API](./editor-api.md)，是实施约束而非已完成事实。保留首版不压缩历史、无静默 GPU fallback、无版本 diagnostics 不自动上屏、IME 仅 primary 组合；需要更改时明确重开对应决策，不能由实现偷偷偏离。

[实施计划](./editor-implementation-plan.md)已给出：下一任务先完成 CRDT 公开来源、并发语义与独立验证规格，之后工具/类型门禁和测试优先实施。无需再重复确认原有选择；技术关口发现真实语义冲突时再具体报告。没有先写临时文本同步内核，也没有跳过算法关口直接做静态 playground。

## 12. 本轮证据、依赖状态与非目标

已做：只检查 editor 自身目录、manifest/锁文件和适用规则；保存允许交付的合同；独立撰写本 API 提案。没有读取受禁目录、其他线程历史或参考实现。

文档校验使用 Python 3 检查两个文件的结尾换行、尾随空白、代码围栏配对和本地相对链接；使用 `git diff --no-index --check /dev/null <各文档路径>` 检查新增文档的空白错误。两类检查不编译示例、不执行行为测试，不能作为 API 或运行时正确性的证据。

公开文档核查：

- LSP 3.17 的 [官方规范](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)：经 Context7 定向核查位置编码默认 UTF-16、请求/响应顺序、didChange 内逐项状态变更。直接抓取整页因工具 512 KiB 限额失败，未假称成功读完全部规范。
- [Tree-sitter advanced parsing](https://tree-sitter.github.io/tree-sitter/using-parsers/3-advanced-parsing.html)：先编辑旧树再复用解析、树/节点的独立更新与并发副本约束。只作为增量边界依据，不是已选定版本的依赖 API。
- [HarfBuzz shaping](https://harfbuzz.github.io/shaping-and-shape-plans.html)：输出 glyph ID、cluster 与 advance/offset，实际绘制是另一层职责。未据此捏造任何 TypeScript 包签名。
- GNU Diffutils 的 [unified 格式](https://www.gnu.org/software/diffutils/manual/html_node/Detailed-Unified.html)与[不完整行](https://www.gnu.org/software/diffutils/manual/html_node/Incomplete-Lines.html)文档：本轮新增核查 header、hunk 和缺结尾换行标记；不是读取任何 editor 参考实现或依赖某个本机 diff CLI 的输出。

文档查询命令：

```sh
# 初次尝试：失败，项目 devEngines 不接受 npm；未改 manifest。
npx --yes ctx7@latest library "Language Server Protocol" \
  "Official LSP 3.17 textDocument synchronization document version position encoding and stale request results"

# 按用户建议使用 pnpm：成功解析并查询 3.17 官方文档索引。
pnpm dlx ctx7@latest library "Language Server Protocol" \
  "Official LSP 3.17 document synchronization versions position encoding and stale responses"
pnpm dlx ctx7@latest docs \
  /websites/microsoft_github_io_language-server-protocol_specifications_lsp_3_17 \
  "textDocument didOpen didChange didClose synchronization version number positionEncodings default UTF-16 request ordering stale responses diagnostics without version cancellation"
```

上述查询使用临时 `ctx7@0.8.2`，未加入依赖。命令实际输出宿主 pnpm **12.3.4**，与项目锁定的 **12.15.0** 不同；这里只作为文档查询结果，不是合格的项目构建/测试证据。后续项目验收必须使用锁定的 12.15.0，不能拿这次命令替代。

现有 Lightning 3.1.2、Nasti 2.7.0、tsdown 0.23.2、TypeScript 7.0.2 与 pnpm 锁定不变。没有新增生产依赖。vgpu 尚未选择/安装版本，不把研究侧查过的 0.6.0 当成本项目版本；若安装进入授权范围，先按 vgpu skill 检查 manifest/lock。届时若仍无用户或项目选择，使用明确的稳定 `vgpu@latest`，记录解析出的精确版本；有既定版本则保留它，不换 prerelease。随后确认本地 CLI，并读其随包文档。Tree-sitter、shaper/WASM、字体、真实 LSP server 同样需记录准确版本、许可和官方文档后再实现。

**未做且不得据此宣称完成**：API 类型检查、Lightning 测试、生产构建、CRDT 收敛/意图证明、真实 LSP、真实 GPU/连字/IME/读屏、playground、性能或兼容性验证。所有代码块是方案说明，不是通过编译的发布示例。

不实现产品的线程/项目/worktree 编排、存储同步服务、认证权限服务、Git、对话回滚、文件系统 CRDT 或完整 IDE；不发布包、不 push、不开 PR、不合入共享分支。本会话后续实施继续在 editor 中进行，不会自动回传或合并到研究会话。
