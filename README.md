# @zixiao-labs/editor

独立实现的可嵌入 TypeScript 编辑器项目，采用
`HistoryStore → EditingHead → EditorSession` 分层。

**当前不是可用的编辑器。** 已有 API 契约、CRDT 算法规格、独立规格检查器、
核心/协作类型契约，以及身份构造器和错误类型。生产历史内核、会话、MultiBuffer、
同步、Diff、语言服务、字体塑形、GPU 视图和 playground 尚未实现。
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
```

`test:consumer` 需要先 build，它从包公开名称读取实际 ESM/declarations；
其中独立类型 fixture 仅使用 ES2022、没有 DOM 或 Node ambient types。
Lightning 是测试框架；Nasti 不用于生产打包。tsdown 以
`isolatedDeclarations`/Oxc 路径生成声明，兼容所选 TypeScript 7，不降级工具。

CRDT 检查器在 `tests/crdt`，不在生产包中。包括三副本离线/重连、完整依赖、
快照、Unicode、位置、undo effects、独立枚举 oracle 和负对照。
这些通过不代表真实生产内核已经通过，也不代表形式证明。

## 设计与进度

- [公共 API 决策](docs/editor-api.md)
- [行为合同](docs/editor-contract.md)
- [API 备选和确认记录](docs/editor-api-options.md)
- [CRDT 算法规格与验证边界](docs/editor-crdt-design.md)
- [分阶段计划](docs/editor-implementation-plan.md)
- [当前进度与实际检查](docs/editor-progress.md)
- [工具与依赖台账](docs/editor-dependencies.md)

本库不实现产品线程/项目/worktree、存储/同步服务器、认证权限、Git 或 Agent
执行器；不使用 Yjs/其包装，也不包装 Monaco/CodeMirror 作为实现。
