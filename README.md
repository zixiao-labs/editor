# @zixiao-labs/editor

独立实现的可嵌入 TypeScript 编辑器项目，采用
`HistoryStore → EditingHead → EditorSession` 分层。

**当前不是可用的编辑器。** 已有 API 契约、CRDT 算法规格、独立规格检查器、
核心/协作/集成类型契约，以及身份构造器和错误类型。P2 已有内部源快照、
三种单位的坐标索引、稳定位置，以及接通源视图的单文档 FugueMax 事务内核。
文本已采用持久化 B+ SumTree + chunked rope，接入真实替换和快照坐标查询。
CRDT 全序/可见性已接入持久 chunk 索引、身份定位与 revision delta 物化，
连续插入/删除按批更新，源快照直接共享索引而不编译整篇 guard 表。
内部 store/head 编排已支持登记/查询、writer 所有权、隔离 heads、CAS/ABA 和精确
merge/checkout，以及多文档原子 group、manifest、闭包检查和 typed bundle 传递。
公开的后端接入层已支持产品提供完整历史实现；默认历史 store、wire codec、会话、
MultiBuffer、同步端口、Diff、语言服务、
字体塑形、GPU 视图和 playground 尚未实现。
不会用抛 `not implemented` 的假工厂冒充运行时。

## 当前可运行的导出

```ts
import { documentId, actorId, EditorError } from "@zixiao-labs/editor";

const document = documentId("host-document:1");
const actor = actorId("host-agent:1");
```

身份构造器不认证身份，也不证明对应历史存在。不归一化 Unicode；非空、
不含控制字符、无孤立 surrogate，最多 1024 UTF-8 字节。
`CoreFactories` / `CollaborationFactories` 等导出目前只是 TypeScript 契约，
不是 `createHistoryStore` 等可调用的包导出。后续实现将按这些契约逐阶段加入。

根入口另提供可调用的 `defineHistoryBackend`、`historyBackendId`、
`assertHistoryBackendCompatibility` 和 `historyStoreFor`。
产品可提供完整 `HistoryStoreImplementation`，通过 `backend.createStore()` 打开；
上层不依赖 FugueMax，ID/opaque 值、格式、资源归属和可选 undo/defer 能力有明确边界。
这不等于默认 native backend 已完成，也不认证产品后端的算法正确性。
[接入方式与必需契约](docs/editor-history-backends.md)。

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
undo 控制仍只覆盖规格模型。
测试通过不代表完整 P2 已验收，也不代表形式证明。

P2 内部实现位于 `src/history`、`src/model`、`src/coordinates`、`src/text` 和 `src/collections`。
单文档历史层建立规范 root/revision 身份、writer stream、因果闭包和包含墓碑的
FugueMax 全序；同 base 批量替换与 typed 事务接受先验证后发布，未知 revision 拒绝。
原有源视图仍只消费已验证的全序/可见性。该内部 typed 接缝不是安全 wire codec，
没有 pending 或 undo 控制。多文档 commit 统一验证/预算后发布一个 manifest/checkpoint；
fork/merge/checkout/typed 传递须 group-closed，缺成员报告精确补齐需求，不追 latest、
不自动扩 head membership/文档域。[group 边界与验证](docs/editor-transaction-groups.md)。
事件在 microtask 按提交序
通知，禁止监听器同步重入写入；store/head/writer/snapshot 的借用与释放分别校验。
默认内核模块尚未接入包入口，不能通过包名调用。root 现在包含的是通用后端接入层，
不是完整 native CRDT 的包体结果。默认工厂仍须等 codec/retention 和 `diff` 等
完整契约齐全后才导出；接入层拒绝把缺方法的内部 store 伪装成产品后端。

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
- [集成契约与入口边界](docs/editor-integration-contracts.md)
- [分阶段计划](docs/editor-implementation-plan.md)
- [当前进度与实际检查](docs/editor-progress.md)
- [工具与依赖台账](docs/editor-dependencies.md)

本库不实现产品线程/项目/worktree、存储/同步服务器、认证权限、Git 或 Agent
执行器；不使用 Yjs/其包装，也不包装 Monaco/CodeMirror 作为实现。
