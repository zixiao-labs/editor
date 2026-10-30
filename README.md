# @zixiao-labs/editor

独立实现的可嵌入 TypeScript 编辑器项目，采用
`HistoryStore → EditingHead → EditorSession` 分层。

**当前不是可用的编辑器。** 默认 native FugueMax 历史后端已作为可调用的
`createHistoryStore` 发布：编辑、历史查询、隔离 heads/CAS、原子 group、活性控制、
pin/位置导出、版本化字节 codec、显式 defer 导入（含事件）与完整 Diff
（结构化报告与 `formatUnifiedDiff`）均可按包名使用；产品替换整套历史引擎仍走
`defineHistoryBackend`，无需 patch。CRDT 算法、独立规格检查器与全部差分门禁
保持不变。会话 undo 栈、选区、MultiBuffer、同步端口、Diff 视图、语言服务、
字体塑形、GPU 视图和 playground 尚未实现，公开 native undo adapter 待补。
不会用抛 `not implemented` 的假工厂冒充运行时。

## 当前可运行的导出

```ts
import { createHistoryStore, documentId, externalBaseId, actorId, replicaId } from "@zixiao-labs/editor";

const document = documentId("host-document:1");
const store = createHistoryStore();
const initial = store.createDocument({ id: document, base: { id: externalBaseId("host-base:1"), text: "hello" } });
const writer = store.openWriter({ actor: actorId("host-agent:1"), replica: replicaId("client:1") });
const head = store.fork({ at: store.revisions([initial]), writer });
```

历史可按精确版本导出为字节（`encodeHistoryBundle`/`decodeHistoryBundle`），
位置经 `exportPosition` + `encodePositionToken` 跨 store `importPosition`；
`store.diff({ change })` 返回结构化报告，`formatUnifiedDiff(report)` 输出
确定性 unified patch。

`CoreFactories` / `CollaborationFactories` 等仍是 TypeScript 契约；其中
`createHistoryStore` 与 `formatUnifiedDiff` 已是可调用的包导出，其余工厂按契约
逐阶段加入。身份构造器不认证身份，也不证明对应历史存在。不归一化 Unicode；非空、
不含控制字符、无孤立 surrogate，最多 1024 UTF-8 字节。

根入口另提供可调用的 `defineHistoryBackend`、`historyBackendId`、
`assertHistoryBackendCompatibility` 和 `historyStoreFor`。
产品可提供完整 `HistoryStoreImplementation`，通过 `backend.createStore()` 打开；
上层不依赖 FugueMax，ID/opaque 值、格式、资源归属和可选 undo/defer 能力有明确边界。
这不等于默认 native backend 已完成，也不认证产品后端的算法正确性。
[接入方式与必需契约](docs/editor-history-backends.md)。

`createTextSource` 可借用产品 gap buffer、piece table 或持久快照，提供有界只读 UTF-16
读取与失效通知，不需要 CRDT/rope/SumTree/history。`textSourceFromHead` 将完整历史
head 接到同一读端口，不展平整篇文本。快速/完整模式由产品显式替换 source；
不自动迁移旧坐标或恢复未记录的历史。[只读接入与生命周期](docs/editor-text-sources.md)。
这两个适配器可运行；相应只读 shaping/GPU view 仍只有类型。

六个子入口 `/collaboration`、`/languages`、`/lsp`、`/shaping`、`/vgpu`、`/browser`
当前仅导出类型，ESM 为空模块；对应 `LanguageFactories`、`LspFactories`、
`ShapingFactories`、`VgpuFactories`、`BrowserFactories` 不是可调用的工厂值。
前四个子入口保持 ES-only；只有 `/vgpu`、`/browser` 的声明需要 DOM。
完整边界与资源借用关系见[集成契约](docs/editor-integration-contracts.md)。

## 开发与验证

要求 Node >=22.12.0，pnpm **12.15.0**。不要升级锁定工具来绕过兼容问题。

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm test:types
pnpm typecheck
SEED=424242 pnpm test:crdt
pnpm build
pnpm test:consumer
pnpm measure:package
```

`test:consumer` 需要先 build，它从包公开名称读取实际 ESM/declarations；
其中 headless fixture 仅使用 ES2022、没有 DOM 或 Node ambient types；browser fixture
单独使用 DOM。consumer 还直接编译锁定 API 文档的代码块并检查签名一致性。
Lightning 是测试框架；Nasti 不用于生产打包。tsdown 以
`isolatedDeclarations`/Oxc 路径生成声明，兼容所选 TypeScript 7，不降级工具。

CRDT 检查器在 `tests/crdt`，不在生产包中。包括三副本离线/重连、完整依赖、
快照、Unicode、位置、undo effects、独立枚举 oracle 和负对照。
其中 `native-history.test.ts` 对照真实生产单文档事务，`native-heads.test.ts`
逐步对照真实 head 的精确因果集合、文本与 provenance；`transaction-groups.test.ts`
枚举多源 cuts 并对照独立 all-or-none oracle，另做三文档/三 head 状态机。
`group-activity.test.ts` 对照真实活性内核，含跨源共享 tie key 的负对照。
测试通过不代表 P2 之外（undo adapter、会话、同步端口、视图）已验收，也不代表形式证明。

P2 内部实现位于 `src/history`、`src/model`、`src/coordinates`、`src/text` 和 `src/collections`。
单文档历史层建立规范 root/revision 身份、writer stream、因果闭包和包含墓碑的
FugueMax 全序；同 base 批量替换与 typed 事务接受先验证后发布，未知 revision 拒绝。
原有源视图仍只消费已验证的全序/可见性。该内部 typed 接缝不是安全 wire codec，
没有 pending 或安全 byte decoder。多文档 commit/control 统一验证/预算后发布一个 manifest/checkpoint；
fork/merge/checkout/typed 传递须 group-closed，缺成员报告精确补齐需求，不追 latest、
不自动扩 head membership/文档域。[group 边界与验证](docs/editor-transaction-groups.md)。
事件在 microtask 按提交序
通知，禁止监听器同步重入写入；store/head/writer/snapshot 的借用与释放分别校验。
默认内核经接入层进入包入口，root 包含通用后端接入层、默认 native backend、
codec/Diff 与外部文本读适配器；`store.backend` 描述 family/algorithm/格式/能力，
产品后端可整套替换（D11）。接入层仍拒绝把缺方法的内部 store 伪装成产品后端。

rope 的底层是等深、多路、带组合摘要和 dimension cursor 的 B+ SumTree；
单点修改共享未变子树，不用整篇 string/prefix array 做文本写入和坐标查询。
身份通过 chunk/leaf/版本级父定位查前缀秩，right-origin 比较不再重建整篇 rank map；
物化复用已缓存因果子集，只应用缺少的 effects。因果闭包、历史 Map 浅复制、
rope 等值核对及显式全文/provenance 输出仍可能有全量成本，
不能把 rope 的树高界限当成整笔 commit 的复杂度。[实现和验证边界](docs/editor-storage-design.md)。

## 设计与进度

- [公共 API 决策](docs/editor-api.md)
- [行为合同](docs/editor-contract.md)
- [API 备选和确认记录](docs/editor-api-options.md)
- [CRDT 算法规格与验证边界](docs/editor-crdt-design.md)
- [Rope/SumTree 存储与增量化边界](docs/editor-storage-design.md)
- [多文档原子 group 与 typed 传递](docs/editor-transaction-groups.md)
- [可替换历史后端与接入协议](docs/editor-history-backends.md)
- [外部文本存储与只读模式](docs/editor-text-sources.md)
- [集成契约与入口边界](docs/editor-integration-contracts.md)
- [分阶段计划](docs/editor-implementation-plan.md)
- [当前进度与实际检查](docs/editor-progress.md)
- [工具与依赖台账](docs/editor-dependencies.md)

本库不实现产品线程/项目/worktree、存储/同步服务器、认证权限、Git 或 Agent
执行器；不使用 Yjs/其包装，也不包装 Monaco/CodeMirror 作为实现。
