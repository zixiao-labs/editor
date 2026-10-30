# P2：多文档原子 group

状态：内部 `NativeStore` 已支持本地跨源提交、manifest、group-closed 版本边界、
typed bundle 传递及原子 group 活性控制。不是公开 `HistoryStore`/`HistoryBundle`、
安全 wire codec、session undo 栈或同步端口。
只承诺当前 JS 进程内完整接受/发布，不承诺 durable ACK、远端同时可见或分布式提交。

## 1. 身份与不可变 manifest

`src/history/transaction-group.ts`：

- 每个 group 的非空 `members` 按 document ID 排序；每文档只有一个成员事务，
  transaction IDs 全局唯一。净 no-op 文档不成为成员，全 no-op 不生成 group/事务。
- 每成员包含 `document`、外部 `base`、精确 root identity、`transaction`、
  `before`（该事务的规范 depends frontier）与 `after`（恰好 `[transaction]`）。
- 先确定成员事务 IDs/frontiers，再计算
  `group:<SHA-256(framed("editor/group/v1", canonicalJson(members)))>`。
  framing/规范 JSON 与 root/revision 使用同一已验证 helper，不做 Unicode/EOL 归一化。
- 每个事务的不可变 payload 含该 `group` 引用。manifest 不包含事务 payload hash、
  自身 ID 或 revision digest，故没有自引用 hash 环；revision 仍由 root + canonical
  transaction frontier 确定。原先临时的 `group:${transactionId}` singleton 占位规则已替换。
- 接受时核对 group digest、成员顺序、唯一性、root/base、事务的 group 引用、
  before 与 depends 相等、after 恰好包含该事务。一个事务不能被多个 manifests 认领。
  同事务 ID 异 payload 继续报 `IDENTITY_CONFLICT`。

group digest 绑定成员关系，不认证 actor、网络发送者或内容签名。不声称能在首次遇到
某个事务时识别所有恶意身份冒用；同 ID 的 equivocation 仍由不可变 payload 冲突检查处理。
这些内部 typed 字段不是稳定 wire 协议，没有对旧私有无 group payload 提供迁移承诺。

## 2. 同一条闭包规则

`src/history/group-closure.ts` 的 `assertGroupClosed` 用于：

- `revisions` 版本集构造、fork、merge 的精确 source、checkout 的精确 target；
- 本地提交的候选结果；
- typed export 的 target、可完整验证的 known，以及 typed acceptance 的 target。

一个成员进入某文档的因果集合，就必须在相应文档集合中包含整组其他成员及其祖先。
可以包含成员的后代，不要求某个文档停在最初 after revision。source 自身必须闭合，
不能用接收 head 恰好持有的另一半来给不完整 source 兜底。

检查器沿已接受事务和已知 manifests 的 before 关系继续查祖先；即使所需 member payload
未送达，已提供的 manifests 仍能给出已知的传递要求。缺少 opaque group 的 manifest 时，
不能从 digest 反推成员列表。

`INCOMPLETE_TRANSACTION_GROUP` 的 frozen `details` 包含：

- `missing`：按 group/document 排序的 `{ group, document, base, root, transaction,
  before, after }` 要求；
- `missingManifests`：尚缺的精确 group IDs。

它不替用户做 join，不追踪任何 live head 的 latest，不自动创建文档，也不扩大 head
membership 或传输域。尚未登记的必需文档可以从 missing 中看到 exact base/root 需求；
显式传入 payload 的文档仍要求先登记正确 root。

merge 仍允许 group-closed 文档子集，checkout 仍要求完整且相同的固定成员集。
逐文档 snapshot/history 查询不是发布一个新的 revision set，仍可单独读取已知文档版本；
不能把这类查询结果绕过闭包校验拿去 fork/merge/checkout/传输。

## 3. 因果图不止逐文档无环

`validateGroups` 在 staged 状态检查两个额外不变量：

1. 将每成员 before 事务所属 group 作为边，整个 group dependency graph 必须无环。
   例如 A 源中 G1 → G2、B 源中 G2 → G1，虽然两个源图单独无环，仍整体拒绝。
2. 当 group 同时写 A/B，若 A 的 before 已观察到某祖先组的 A 成员，B 的 before
   也必须包含该祖先组的 B 成员。最终 target 再 merge 缺少的旧事务，不能倒补一笔
   原本不是从同一个一致 checkpoint 创作的 group。

未写入或净 no-op 的文档不被强迫成为新 group 成员；祖先组要求的只读成员由版本闭包
规则要求携带，不产生空事务。不把同 writer 较小 counter 推断为祖先。

## 4. 本地多源提交的实际路径

`NativeStore.#commit`：

1. CAS/ownership 检查，复制所有 caller edits/metadata。每个文档仍执行相同的范围、
   scalar、别名冲突、overlap 与净 no-op 规则。
2. 按 document 排序，为各文档 clone 持久 history/index roots，调用 owner-bound
   `NativeHistory.draft`；验证失败尚未分配/消耗 counters。
3. `NativeWriter.plan(count)` 得到暂定连续 IDs；形成 group manifest，再由对应
   staging history `finalize` 各 draft。只有其所属 history 可以 finalize 该 draft。
4. 各源 typed effects 独立验证；检查整个 envelope（含 manifests、root/target refs）
   的 **8 MiB / 100,000 scalar insert/delete effects 或控制记录** 预算。metadata 仍逐成员验证
   16 KiB；不把多文档预算误当作每文档各享一份 8 MiB。
5. 检查 manifest、group DAG、before 一致性与候选 revision set 的 group closure。
6. 所有检查完成后 commit writer allocation，连续发布全部源 owner、manifest、transaction
   owner 和一个 checkpoint/receipt。这个同步区间没有 caller callback。
   最后只排一个 head-change microtask；receipt 的 groups 去重，保留精确 before/after。

失败丢弃整个 staging 图和 caches，没有先发布合法文档前缀，也不 rewind 已公开 stream。
未 commit 的 allocation 可放弃；重复、外来或已 stale 的 allocation 不能消费 counters。
既有快照/隔离 branches 保留原索引根。净 no-op 文本提交返回原 checkpoint，不发源事件；
活性控制不同，即使 no-effect 也记录新历史（见第 7 节）。
显式同 revision checkout 的 stamp/lifecycle 规则保持不变。

## 5. 内部 typed 传递，不冒充 codec

`exportTyped({ target, known?, documents? })`：

- 一次捕获精确 target，输出各目标文档 exact root/frontier、需要传递的 transactions
  及其 manifests。不会导出另一个 head 的隔离历史。
- 可验证且 group-closed 的 known 做精确因果集合差，包括并发 known；
  任一 known revision 在本实例未知时放弃整份知识推断，安全补发 target closure。
  不能把 max writer counter 当作知识前缀。
- 重发已有 manifests 是允许的。显式 `documents` 是本地 whitelist，不是权限认证；
  payload/target/manifest 涉及域外文档时报 `SYNC_SCOPE_MISMATCH`，绝不自动扩域。

`acceptBundle(bundle, { documents? })`：

- 复制 typed 数据和 scope，然后克隆所有 payload/target 文档，统一暂存 effects、
  targets、group/transaction registry 和 caches；
- 检查 root、全局身份、writer stream 所有权、预算、缺依赖、manifest、DAG 与闭包；
  拒绝 target 外的额外 payload/manifests，不借传递混入其他隔离历史；
- 通过后统一接受，返回精确 `availableRevisions`；不移动任何现存 head，
  同内容重复幂等。target frontier 可按既有 revision 规则去冗余，不扩展 causal closure。

单文档 `accept` 只是兼容便利入口：仅当引用确为由该单成员派生的 digest，才重建 singleton
manifest；不能把 multi-member group 拆开后重新解释。若祖先跨文档，即使最新事务是
singleton，其目标仍需通过带齐版本集合的 bundle 表达。

这些内部方法自身不做网络协议或持久 ACK；默认 backend 已把它们接到公开字节 codec
与 defer 队列（API D13：坏字节、内存与 pending 限额验收在那里执行）。接收方先登记
root；不会从不受信输入自动创建文档。

## 6. 验证与剩余边界

- 原子事件/receipt/manifest、后源非法/整组超预算回滚、counter 不消耗、净 no-op、
  输入排列规范性、freeze/alias、固定成员与精确 pinned merge；
- fork/merge/checkout/版本构造/export 对同一半组给出一致要求，含传递祖先与
  missing payload/未登记 required root；membership 改写/缺 manifest 不能逃逸；
- typed 完整/delta/重复传递、未知/并发 known、scope、接收不动 head、损坏后源无前缀；
- 逐源无环但跨组有环，以及闭合 target 掩盖不一致 before 的反例均被拒绝；
- 四组、八成员事务的小图枚举每个逐源 causal cut，用独立扁平 all-or-none oracle
  判组闭包（144 个逐源合法 cuts 中 10 个完整、134 个半组），各源用独立规格模型
  检查文本/provenance；保留一个“逐源合法但半组”的负对照；
- 每 seed 8 个 32 步的三文档/三 head 状态机，混合离线多源编辑、captured merge、
  checkout、typed target 传递和旧 snapshots。失败保存 seed/run/完整命令及逻辑成员集合，
  不把单事务 shrinker 冒充能安全缩减 saved-checkpoint 索引的状态机 reducer。

当前 group/因果校验仍会扫描保留历史与闭包，不宣称整笔 commit O(log n)，也没有完整
大历史墙钟/内存基准。wire codec/defer、pin/位置导出、Diff 与公开工厂已在后续轮完成；
session undo 栈/公开 native undo port 和真实 browser/IME/多进程网络仍待后续独立验收。

## 7. 默认 native group 活性寄存器

本节只约束默认后端内核，不要求产品后端采用 generation、delete tags 或 FugueMax。
公开的 `HistoryUndoProvider` 仍是 opaque capture/apply 端口；默认 native provider
已发布（D13）但 `selectiveUndo` 声明为 false，未把缺该能力的 store 冒充 undo provider；
session 分组、redo 栈与选区恢复仍未实现。

### revision-local 规则

每个原始 effect group 默认 `{ generation: 0, active: true }`。控制事务无文本 effects，
记录 `{ target, member, generation, active, order }`：

- target 是原始 group，member 是该文档的原始成员事务，必须在 depends 闭包已观察到；
  不允许以控制组为被控目标，不能通过控制控制操作绕开这条规则。
- generation 严格等于**这份精确 base revision** 已观察 winner 的 generation + 1；
  不是 store-global 最新值、writer counter 或墙钟。超过 safe integer 拒绝。
- register 在该 revision 的控制集合选最大 `(generation, order)`。order 是控制组按 document
  排序的**首成员 transaction ID**，所有文档共用同一个 tie key。
  不能使用各文档自己的控制事务 ID：并发控制的成员 ID 排列可能不同，会产生 A 已 undo、
  B 却 redo 的 split winner。当前每事务只有一个控制，ordinal 固定为 0。
- undo domain 为原始 writer stream nonce + actor/replica。当前 stream 不支持恢复，
  新 stream 不能因 actor 标签相同就控制旧组；这不是认证或持久会话恢复机制。
  共享同一合法 writer 的隔离 heads 可从旧 cuts 发出并发控制。

控制在同一 atomic publication 路径为原始组的**全部且仅这些文档**生成成员；
manifest 仍含各源完整 before/after/root/base，目标 revision 集仍须 group-closed。
组内成员必须一致指向同一 target、generation、active、order，并绑定相应原始成员。
拒绝 text/control 混组、半控制组、伪造代表 ID 及不一致 before；校验失败不消耗 counter、
不发布任意文档前缀。每个 controller 计一项 operations 预算，而不是因 effects 空就免费。

### 增量 visibility，不删除历史

每个 slot 保留 creator group、独立 delete tags 和 active delete count；每 group 保留
created/deleted IDs 的持久列表。切换只访问该 group 的 effects 和相关 chunks：

`(根元素或 creator active) && activeDeletes === 0`

隐藏 creator 不递归隐藏其子树，远端 descendants 仍在原全序。撤销删除只关闭自己的
tag，其他 active 删除仍阻止复活；redo 重新使用原 IDs、文本和创建归因。
完整 order、tombstones、稳定位置 guards 保留，visibility 变化不会重排其他元素。
受影响区间合并后从右向左更新 rope，并批量更新 chunks；旧 revision/snapshot 共享旧根。

`NativeStore.setGroupActive` 是内部内核入口：检查 head 归属/CAS/固定成员和 domain，
暂存所有控制，再统一生成 checkpoint、receipt 和一次 undo/redo 事件。
结果按 effect identity 的可见性判断，不比较最终字符串：

- 无目标 visibility 改变：`no-effect`；
- 有改变但部分 effect 仍被其他 creator/delete 活性阻挡：`partial`；
- 有改变且无受阻目标：`applied`。

即使重复要求 inactive 或所有恢复都被其他 tags 阻挡，控制仍推进 generation，产生真实
`committed` receipt/stamp/event。这种 no-effect 历史不能按净 no-op 文本编辑规则丢弃。

### 验证证据

native 单测覆盖远端后代、旧 snapshot/guard、redo identity、独立删除标签、旧 base
generation、交付顺序、错误 domain、控制目标、partial/no-effect、原子事件/receipt、
typed 完整/重复 roundtrip、不一致成员与半控制组拒绝、控制预算。
32,768-root 的单元素控制禁止枚举整篇 graph/order，order nodes 共享 >90%；
这不是完整历史墙钟/内存或整笔 commit 的复杂度保证。

另有独立规格模型差分：三份隔离 causal cuts 每 seed 8 × 32 步 edits/controls/joins，
逐步比较文本、可见身份、provenance 与旧 cuts，并作冷 typed 导入。
两文档并发控制 fixture 特意令两源的成员 ID 顺序相反；共享代表 winner 一致，
改用每源自身 ID 的 mutant 则失败。adapter 只展开依赖与重命名共享 control ID，
不调用生产寄存器排序或 visibility 规则来生成期望值。
