# P2：多文档原子 group

状态：内部 `NativeStore` 已支持本地跨源提交、manifest、group-closed 版本边界和
typed bundle 传递。不是公开 `HistoryStore`/`HistoryBundle`、安全 wire codec 或同步端口。
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
   的 **8 MiB / 100,000 scalar insert/delete effects** 预算。metadata 仍逐成员验证
   16 KiB；不把多文档预算误当作每文档各享一份 8 MiB。
5. 检查 manifest、group DAG、before 一致性与候选 revision set 的 group closure。
6. 所有检查完成后 commit writer allocation，连续发布全部源 owner、manifest、transaction
   owner 和一个 checkpoint/receipt。这个同步区间没有 caller callback。
   最后只排一个 head-change microtask；receipt 的 groups 去重，保留精确 before/after。

失败丢弃整个 staging 图和 caches，没有先发布合法文档前缀，也不 rewind 已公开 stream。
未 commit 的 allocation 可放弃；重复、外来或已 stale 的 allocation 不能消费 counters。
既有快照/隔离 branches 保留原索引根。所有 no-op 返回原 checkpoint，不发源事件。
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

这些方法不实现公开 opaque bundle、byte decoder、版本协商、defer/pending、异步 pin、
网络协议或持久 ACK。接收方先登记 root；不会从不受信输入自动创建文档。
未来 codec 必须把版本头/编码开销计入预算，并单独做坏字节、内存与 pending 限额验收。

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
大历史墙钟/内存基准。生产 group 活性寄存器/undo、wire codec/defer、pin/位置导出、
Diff/公开工厂和真实 browser/IME/多进程网络仍待后续独立验收。
