# 可替换的 CRDT / 历史后端

状态：公开的产品后端接入层、命名空间/opaque SDK、生命周期与能力检查已经实现。
默认 FugueMax 内核仍是内部实现，尚未满足完整 `HistoryStore`，没有注册或公开默认工厂。
本轮是用户明确确认的后端替换能力扩展，不是“只允许配置同一个算法的产品模式”。

## 1. 为什么替换整个历史边界

接入点是现有 `HistoryStore → EditingHead` 行为契约，不是 FugueMax 的排序回调或节点布局。
不同后端可以有不同的操作图、位置表示、revision identity、undo 实现和传输编码，
但上层仍只消费快照、坐标、精确版本、原子批次、历史查询、receipt 和明确的错误。

必须实现完整的 `HistoryStoreImplementation`，包括 pin、位置传递、history 传递和 Diff。
固定成员、CAS/ABA、group closure、Unicode/稳定位置、provenance、失败无前缀等基础语义
不是可选开关。不能用缺方法或一排 `not implemented` 充当已支持的后端。
以后可复用独立的通用 Diff/保留适配器，但本轮不假造这些尚未完成的 native 功能。

`defineHistoryBackend` 验证必需方法的 shape，包装并路由产品实现。**它不是后端语义认证**：
算法收敛、独立副本一致性、原子发布、root 验证、预算与恶意输入处理仍须由后端验证。
错误的 provider 可能已经更改自己的内部状态；接入层不能替它回滚一个错误算法。

## 2. 产品如何接入

下面的 `implementProductHistory` 是产品必须提供的完整实现，不是库中的隐藏默认后端：

```ts
import {
  defineHistoryBackend, historyBackendId, documentId, externalBaseId, actorId, replicaId,
  type HistoryBackendContext, type HistoryStoreOptions, type HistoryStoreImplementation,
} from "@zixiao-labs/editor";

declare function implementProductHistory(
  context: HistoryBackendContext,
  options: HistoryStoreOptions,
): HistoryStoreImplementation;

const backend = defineHistoryBackend({
  descriptor: {
    id: historyBackendId("product:history"),
    contractVersion: 1,
    algorithm: "product-sequence-and-revision/v1",
    formats: { history: "product-history/v1", position: "product-position/v1" },
    capabilities: { selectiveUndo: false, deferredImport: false },
  },
  createStore: implementProductHistory,
});

const store = backend.createStore();
const initial = store.createDocument({
  id: documentId("document"), base: { id: externalBaseId("base"), text: "hello" },
});
const writer = store.openWriter({ actor: actorId("author"), replica: replicaId("client") });
const head = store.fork({ at: store.revisions([initial]), writer });
// Future session/view factories consume head.document(initial.document), not a native head class.
```

工厂每次必须返回新的、未包装的完整 implementation。不能复用另一个已打开 store/facade；
创建过程抛错或返回不符合契约的 provider 时，provider 负责清理其自建资源。
通过接入检查后的公开资源由返回的 store/handle 释放，不销毁产品注入的其他服务。
上层用 `historyStoreFor(head)` 找到所属公开 store；未知或释放后的 head 明确报错。
没有全局 backend 选择状态，也没有对活跃 store 原地换引擎的操作。

## 3. 描述、命名空间与协议

`HistoryBackendDescriptor` 是冻结的值：

- `id` 是语义协议 family，不是软件包名、认证身份或一次 store 的随机 ID；
- `contractVersion: 1` 指公共行为契约；
- `algorithm` 必须包含会影响顺序、revision/ID 意义的语义版本；
- `formats.history` / `formats.position` 是独立且版本明确的编码协议 ID；
- `capabilities` 只声明本地 selective-undo 端口与 defer 可用性，不替代 wire 格式支持。

同 family/algorithm 的兼容实现应对相同 history/root/ID 有相同解释。格式版本变化
不自动改变逻辑身份，算法/身份语义变化则必须使用不同 family 或 algorithm 版本。
相同 format 意味着能理解该格式的完整操作语义，包括可能由其他 peer 生成的控制记录；
不能用本地 `selectiveUndo: false` 作为忽略已接收 undo 记录的理由。

identity SDK 在不归一化文本的前提下使用：

`hb1:<encodeURIComponent(family)>:<encodeURIComponent(algorithm)>:<kind>:<local>`

用于 revision、transaction、operation、group、head、stamp、commit、cursor；
document/external-base/actor/replica 保持产品身份，不在这里猜路径或重新分配。
`identities.create(kind, local)` 发行，`identities.local(kind, id)` 验证并解包。
namespace 按 escaped components 区分，不用哈希碰撞假设；protocol 字段上限 128 UTF-8 bytes，
最终 ID 仍受全局 1024 UTF-8 bytes 限额，后端应使用紧凑的 local IDs。

字符串仍是 opaque：消费者不能依赖此布局做版本比较。constructor 只验证身份，
`local` 只验证 namespace/kind；具体 root 存在、闭包和头成员关系仍由后端核验。
不同 backend/kind 在委派前报 `DIFFERENT_ATOMIC_DOMAIN`。

同步 offer 复用 `HistoryBackendProtocol`：backend family、contractVersion、algorithm、format。
`assertHistoryBackendCompatibility(local, remote, "history" | "position")` 可接收完整 descriptor
或这类协议头；检查选中的格式，不将同算法标签当作可互传证明。
格式不符报 `UNSUPPORTED_FORMAT`，无静默降级、迁移或自动跨后端转换。

## 4. 不暴露内部布局的 opaque SDK

工厂得到的 `HistoryBackendContext` 提供：

- `positions<Payload>()`：本地 store/issuer 的 opaque 稳定位置；
- `undoTokens<Payload>()`：本地 issuer 的控制 token；
- `positionTokens<Payload>()`、`bundles<Payload>()`：按 namespace/所选 format 识别的可传递值；
- `issueReceipt(data)`：复制 arrays/checkpoints 并发行本 store 的有效 receipt。

issueReceipt 可保留后端拥有的扩展字段（例如已验证的 selection effects），同时保留基础
receipt 的只读字段类型和有效 provenance；不能先 spread 出新对象再假定它继承了身份。

每个 issuer 有 create/read/has。消费者拿不到 payload，spread/cast 不会取得有效 token。
position/undo 值不能直接跨 store；position 必须 export/import，接收方发行自己的 position。
portable token/bundle 可以跨相同协议的 provider 实例读取，输入 payload 仍需验证。
`Payload` 是后端私有类型，SDK 不定义 fragment、原点、删除标签或 undo count 布局；
发行后 payload 的不可变性/字节缓冲区 alias 隔离由 provider 负责。

这些是同一 JS realm 中的 WeakMap provenance，不是安全沙箱、数字签名或字节 codec。
一个被信任、能注册后端的实现能声明协议；不能据此认证网络 peer。跨进程序列化、
版本解码和输入限额由匹配的 codec/产品端处理，本轮没有提供这些实现。

## 5. 所有权和生命周期

接入层不依赖 native 类，统一维护公开 wrapper 的归属：

- writer 只能交给所属 store；head 借用 writer；
- 快照、pin、exported position、head、writer、undo scope 和异步 Diff 阻止 store 被过早释放；
- undo scope 借用 head；释放 view/session/一个 scope 不级联销毁其他所有者；
- 成功 dispose 幂等，已释放 handle 的操作报 `DISPOSED`，不可变元数据/复制值仍可读；
- caller revision sets、checkpoint/range 与 query 参数在校验/委派前捕获，
  不在第二次读取 getter 时把另一个值交给 provider；
- head 通知按 microtask 排队，取消订阅/释放 head 可取消未投递回调；通知期间同步写入拒绝，
  listener 失败交给 onError，不回滚已发布结果或阻断其他回调。

后端必须保证自己的写入原子性和资源正确性；wrapper 不转换其内部 history，也不允许
跨后端的 handles/positions/receipts 借同名 local ID 混入。相同协议的根/文档级验证
不能被 namespace 检查替代。

## 6. Undo 不绑定某种 CRDT

`store.undo` 是可选 `HistoryUndoProvider`；capability 必须与端口一致。
open 绑定一个公开 head，接入层传给 provider 对应的原始 head：

- capture 一笔本 head 的有效 receipt，得到 opaque `HistoryUndoToken`；
- apply 精确 head checkpoint、同 scope 的 tokens 和 undo/redo 方向；
- 后端原子执行并返回 `applied | partial | no-effect` 与有效 CommitReceipt；
- head/receipt/token 归属和生命周期由接入层检查；原效果可控域、因果前提、
  远端意图保留和 partial/no-effect 的判定由后端负责，不按字符串相等猜测。

不指定 generation/ID winner、奇偶 count 或某个操作图扩展。默认 FugueMax 的内部
活性寄存器现已实现，公开 adapter 仍待完整 provider 接通；另一后端可使用不同的合规机制。
session 的 undo 栈、命令分组、redo 清理和 selection restoration 仍是上层职责。
尚未实现的默认 session 工厂必须先检查能力；不能把不支持伪装成 empty undo 栈。
defer 能力同样在调用 provider 前检查，不支持报 `UNSUPPORTED_CAPABILITY`。

## 7. 当前证据与非声明

新增接入测试使用明确标注的 **scripted port doubles**，不是两个生产 CRDT：
验证工厂路由、不同 family 的相同 local ID、opaque 归属、可传递格式、能力检查、
完整 store 要求、head 归属、原始 head 解包、资源借用、单次输入捕获、事件和异步 Diff。
类型 fixture 检查 category/opaque 隔离、完整 implementation、无 DOM 和真实包名导入。

这不证明产品提供的 CRDT 收敛、持久化、跨进程协议或完整 undo 正确；
后端作者还须执行符合 D1–D10 的独立模型/并发/资源/安全验收。
默认 NativeHistory/NativeStore 的原有独立差分仍保留，它们没有为了“可注入”而换算法、
丢弃墓碑或公开不完整 factory。内部 group 控制另有独立差分，但未接默认公开 undo port。
没有实现 DeltaDB、Git 集成、session/view。仅需外部 buffer 的只读模式不用实现完整后端，
直接使用 [TextSource](./editor-text-sources.md)，不强制引入 CRDT/rope/SumTree。

## 8. 本轮新增公开设计输入

用户明确指定并已阅读全文：

- [DeltaDB: The Future of Version Control](https://delta.dev/blog/future-of-version-control)：
  因果版本、fragment index、结构共享、Git 互操作的产品方向；
- [How CRDTs make multiplayer text editing part of Zed's DNA](https://zed.dev/blog/crdts)：
  anchors、观察删除、独立删除标识与 undo map。

文章描述了不同实现，不能把其中的 Lamport/vector/count 规则直接拼接到 FugueMax。
本轮只用公开文章内容；未跟进其源码、测试、视频或实现仓库。来源记录不是法律认证。
