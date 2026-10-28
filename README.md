# @zixiao-labs/editor

独立实现的可嵌入 TypeScript 编辑器项目，采用
`HistoryStore → EditingHead → EditorSession` 分层。

**当前不是可用的编辑器。** 已有 API 契约、CRDT 算法规格、独立规格检查器、
核心/协作/集成类型契约，以及身份构造器和错误类型。P2 已开始，内部源快照、
三种单位的坐标索引和稳定位置解算已实现；尚未接入生产 CRDT/历史 store。
生产事务、隔离 heads、codec、会话、MultiBuffer、同步、Diff、语言服务、
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
这些通过不代表真实生产内核已经通过，也不代表形式证明。

P2 的内部源视图在 `src/model`、坐标索引在 `src/coordinates`。它们消费已验证的
全序/可见性，不建立因果历史、不校验 root/revision digest；未知历史必须由后续
history 层拒绝。位置差分用独立 oracle 提供全序、规格模型提供可见性与期望解算，
只验证生产位置/坐标层。内部模块尚未接入包入口，不能通过包名调用，
也不能把公开产物体积未变当作完整 P2 的包体结果。

## 设计与进度

- [公共 API 决策](docs/editor-api.md)
- [行为合同](docs/editor-contract.md)
- [API 备选和确认记录](docs/editor-api-options.md)
- [CRDT 算法规格与验证边界](docs/editor-crdt-design.md)
- [集成契约与入口边界](docs/editor-integration-contracts.md)
- [分阶段计划](docs/editor-implementation-plan.md)
- [当前进度与实际检查](docs/editor-progress.md)
- [工具与依赖台账](docs/editor-dependencies.md)

本库不实现产品线程/项目/worktree、存储/同步服务器、认证权限、Git 或 Agent
执行器；不使用 Yjs/其包装，也不包装 Monaco/CodeMirror 作为实现。
