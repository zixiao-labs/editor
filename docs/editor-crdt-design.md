# 原生历史与序列 CRDT 规格

状态：G0 的独立算法设计。不是已有生产 CRDT，不是公共 wire format。
公共行为仍以 [锁定 API](./editor-api.md) 为准；执行进度与实测证据另见
[实施记录](./editor-progress.md)。本文件不修改已经确认的产品决定。

## 1. 来源、比较与选择

只使用公开论文与本项目行为合同独立设计；未读取参考编辑器源码、测试或研究目录。
没有使用论文链接的实现仓库，也不把上下文隔离声称为法律认证。

主要来源：Matthew Weidner、Martin Kleppmann，
*The Art of the Fugue: Minimizing Interleaving in Collaborative Text Editing*，
[arXiv:2305.00583v3](https://arxiv.org/html/2305.00583v3)。
阅读范围为 III-A、IV（Algorithm 1、Theorem 1）、V-A 至 V-E
（Definitions 2/4/6、Lemma 5、Theorems 9/10）和 Appendix A-A8。
以下区别很重要：

| 方案 | 规则与取舍 | 本库选择 |
| --- | --- | --- |
| RGA 类 | predecessor/left-origin 树与确定性 sibling 顺序；墓碑保留结构。论文 III-A、Table I 和 A-A8 给出倒序插入交织的具体反例 | 不选；仅有收敛不足以保护连续输入 |
| Fugue | 左/右子树中序遍历；两侧 sibling 均按 ID 排序。IV 证明 strong list，V-D 证明 forward non-interleaving | 可行且简单，但不同 right origins 的复杂并发仅按 ID 排序有额外交织 |
| FugueMax | 保留 Fugue 的 parent/side 生成；右 siblings 按 right-origin 的**列表逆序**排序，同 origin 才按 ID。V-C Definition 6；V-D/E 给出最大非交织与唯一性 | 采用，额外成本是保留 right origin 和次序比较 |

这里的 RGA 比较以所读 Fugue 论文对原算法的分析为依据，不冒称已经逐章
核验原 RGA 论文。Roh 等原论文 DOI 是
https://doi.org/10.1016/j.jpdc.2010.12.006 ，不是本次代码来源。

采用的只是序列排序规则。身份、批次、历史、坐标、undo、同步域和本地跨文档
原子性是下面独立规定的扩展，**不在上述论文证明的范围内**。
FugueMax 也不承诺任意两个用户的所有修改永不交织：V-B Figure 6/
Lemma 5 说明 forward/backward 非交织有不可同时满足的情况。
不修改算法去“修复”这个不可满足条件。

## 2. 身份、根、revision 与因果图

### 根与 writer

根登记由 `(document ID, external base ID, exact initial text)` 确定。
用带 domain/version 的规范编码及 SHA-256 生成根身份；长度前缀隔开字段，
文本编码 UTF-8，拒绝孤立 surrogate，不做 NFC 或换行归一化。
外部 base ID 是宿主不透明身份，不从路径/Git 推断；相同 base ID 不意味着允许不同内容。
相同 document/base/text 在不同 store 有相同根；同 document 的不同登记报
`BASE_MISMATCH`。接收仍比较登记内容/摘要，不以 hash 代替全部校验。

每个 writer 分配安全随机的 128-bit stream nonce，事务 ID 为
`(stream nonce, uint64 counter)`；actor/replica 是另列的归因身份，不是唯一性来源。
counter 不可回退/溢出，重启新开 stream；跨进程恢复 stream 须由产品保证唯一租用，
首版不提供自动恢复活跃 writer。随机源可注入，无安全随机源报 `RANDOM_UNAVAILABLE`。
操作 ID 为事务 ID 加规范 sub-operation ordinal；元素身份与插入 op/ordinal 关联。
排序使用固定 byte/整数顺序，不使用 locale、时钟或 `Array` 到达顺序。

**同一 stream 较小 counter 不自动成为因果祖先。** 同一 writer 可写多个隔离
head；必须依赖编辑所声明的 revision，不得把另一 head 的未发布历史带进来。
因此不能以“最大 counter 的 version vector”推断拥有连续前缀。

### 版本与闭包

事务有显式 `depends` frontier、document/base、group manifest、actor、
origin、规范 JSON attribution，以及不可变 effects。依赖必须能还原创建时 base。
revision 是根和因果闭合集合；canonical frontier 为其中非祖先冗余的最大事务集合。
`RevisionId` 是根与规范 frontier 的 domain-separated digest；集合相等才历史相等，
不是文本相等。head stamp 是本地 CAS/ABA 状态，不进入同步 revision。

merge 是两个闭包的集合并；传入捕获的精确 revision，不读取源 head 的最新状态。
checkout 只移动 head，不生成 undo；import 只接受历史，不移动任何 head。
历史查询拓扑排序，ready 集合按事务 ID 平局；分页 cursor 绑定查询 revision。
snapshot 只读其闭包，不使用 store 的“当前可见删除”状态。

### 接受边界

先在暂存域验证 envelope/版本/预算、根登记、ID、依赖图、所有源引用和 group
闭包，再一次发布；一个错误不能留下部分节点或部分文档。

- 同 ID、同规范 payload：幂等。不同 payload：`IDENTITY_CONFLICT`，包括 pending。
- 缺依赖：默认整包 `MISSING_DEPENDENCIES`；显式 defer 才有界暂存整个未满足批次。
- 图内自环/环：`INVALID_CAUSAL_GRAPH`，不冒充无限 pending。
- 引用必须在声明依赖闭包或当前事务的较早 sub-operation 中；store 恰好知道
  一个不在依赖里的节点，不足以使引用合法。跨文档/base 引用拒绝。
- 校验生成规则：parent/side/right origin 必须对应声明 base 的合法 insertion gap；
  delete 只能命名已观察到的可见元素。不用接收时最新文本解释 offset。
- pending 后续变得可判定时，整体接受或显式拒绝并发事件；不得静默丢弃。

生产接收还必须执行 D10 的 8 MiB/100,000 operations、metadata 16 KiB、
pending 32 MiB 限额；本地生成先验证事务可导出。测试小模型不是安全 decoder。

## 3. 元素、插入、删除与同时替换

规格以 Unicode scalar 为逻辑元素，UTF-16 surrogate pair 不能切分。
不把每 scalar 一个对象固定为公共格式；生产可以压缩 runs，但解码后的语义必须一致。
根的初始 scalar 用 `(root identity, scalar index)` 定位，按顺序构成右链。
另有不可删除的 START/END；START 是树根，END 是排序哨兵，不是可编辑字符。

### FugueMax 的精确规则

树节点保留 ID、scalar、parent、L/R、left origin、right origin、创建事务。
即使文本不可见，节点和 parent/origin 都不删、不重排。
遍历先左子树、节点自身、右子树；仅输出满足第 5 节 visibility 的 scalar。

在指定生成状态的插入 offset：

1. 找到可见 predecessor `l`，没有则 START。
2. `r` 是**包含墓碑的遍历**中 `l` 的直接后继，没有则 END。
   不是下一个可见字符，不能因缓存只存可见文本而跳过墓碑。
3. 若 `l` 无右 child，新节点是 `l` 的右 child，记录 `r`。
   否则新节点是 `r` 的左 child。
4. 左 siblings 按 ID 升序。右 siblings 按各自 right origin 的现有列表顺序降序，
   origin 相同按 ID 升序；END 大于所有节点。不能按 origin ID 代替列表次序。
5. 这些 origins 因果先于新节点；现有节点相对顺序不会因将来插入而改变。
   实现可在 causally ready 时比较 origin 次序，不得在接收顺序上做任意平局。

删除记录一组**已观察到的元素 ID**和该事务的 delete tag；不是持久 raw offsets，
不是覆盖整个区间的一条持续删除规则。并发新插入无该 tag，因而不被误删。
删除一个节点不递归删除其子树。

替换是同一事务内的 observed delete + 插入 run；并发替换可能留下两个替换 run，
不静默选择 last writer 或报告 Git 式冲突。按 causal state 生成的 run 保持算法的
非交织性质，不保证不同 concurrent replacements 的语言学意义。

### 批次

所有公共 ranges 先在同一 checkpoint 校验，源归一后按 D4 去重/拒绝冲突。
以 document ID、range 规范排序分配 ordinal，不能依调用者数组顺序决定结果。
每文档在私有 staged 状态按起点从右到左执行替换，每段只删除 base 中选中的 ID，
插入文本按 scalar 正序生成；当前段新插入的字符参与后续 scalar 的生成。
同起点的冲突在此前已拒绝。相邻非空 ranges 可接受；右段修改不改变左段 base
offset。发布前核实单副本结果等于对原串同时应用全部替换。

## 4. 稳定位置与坐标的独立规则

不可变 source cut 记录 document/base、guard 元素身份、guard 边、
affinity 和位置格式版本。生成 revision 可用于验证，但不是所有无关操作都成为
位置存在的先决条件。公开 token 不暴露可修改树节点。

在可见 gap 捕获：

- `before` 选择可见左字符（无则 START）的右边缘。
- `after` 选择可见右字符（无则 END）的左边缘。

目标 revision 解算：

1. document/base 不同报错；revision/保留历史不可用报错，不返回 deleted。
2. 非哨兵 guard 的创建不在目标闭包：`not-yet-created`。
3. guard 被删除/创建效果已撤销：`deleted`；给出以其完整树遍历位置最近的
   可见前驱/后继构造的 before/after 修复 anchors。两者数值 offset 可以相同，
   但对未来插入的 affinity 不同。不要自动把 exported anchor 改成 repair。
4. guard 可见：`present`。左边缘是其前面可见 scalar 的 UTF-16 长度之和；
   右边缘还包含 guard 自身。START 为 0，END 为当前长度。

这种身份依附有意使“guard 被删”和“目前还没创建”可区分。session 可按 affinity
修复 deleted 并报告；not-yet-created 暂停编辑。仅缺少捕获 revision 中无关事务，
只要 guard 已存在就不算尚未创建。

| 演算 | 结果 |
| --- | --- |
| `AB` 的 offset 1，两端分别 guard A/right、B/left；并发插入 `xy` | `before` 为 1，`after` 为 3，文本 `AxyB` |
| 删除上例的 A，保留 xy/B | A/right 为 deleted，修复点 0；B/left 仍 present 为 2 |
| `A😀B` | UTF-16 边界 0/1/3/4，UTF-8 边界 0/1/5/6，scalar 边界 0/1/2/3；UTF-16 2 拒绝 |
| `e\u0301` | 两 scalar、一个 grapheme；低层 offset 1 合法且不归一化；交互删除按 grapheme |
| `A\r\nB` | UTF-16 0..4；offset 2 在 CR/LF 间，低层可表示；行列转换报 INVALID_BOUNDARY；粘贴仍保留原串 |
| 位置依附新插入 X，回看 X 之前版本 | not-yet-created；不夹紧到 0 |

UTF-8/UTF-16/scalar 转换必须针对同一 snapshot 校验。affinity 与 MultiBuffer 的
左/右 occurrence 选择是两个概念；头部和 excerpt 边界不参与 CRDT。

## 5. 选择性 undo/redo：效果寄存器，而非删除历史

原论文的不可逆墓碑不足以直接提供本 API 的 undo；这里定义单独扩展。
一个本地 undo group 的所有创建/删除 effects 默认 active。历史只增不减；
undo/redo 生成一个新的 `SetGroupActive(group, generation, active)` 控制事务，
依赖原 group manifest 和已观察的控制版本。新事务不修改旧 payload。

每 group 的 register 选择已纳入 revision 的最大 `(generation, control operation ID)`；
generation 是已观察该 group 最大值 + 1，ID 是固定排序，绝不是墙钟。
本地会话按顺序控制自己拥有的组；并发控制依然有确定性赢家，不按先到拒绝
导致副本各自锁死。controller 绑定原 group 的 undo domain；身份不是认证，
网络授权由产品负责。undo 域只用于授权/栈所属，不强迫发布同域的其他历史。

元素可见当且仅当：

```
创建于根，或创建 group 为 active
并且
没有任何 active group 的 delete tag 命中此元素
```

创建被撤销的节点仍在排序树里，仍遍历子树。证明要点：

- undo 插入只关闭该 group 创建的元素；远端的插入有不同 creator，不会被递归隐藏。
- undo 删除只关闭自己的 delete tags；若另一个 active 删除仍命中，元素仍不可见，
  不会“复活”被别人删除的内容。
- redo 重新激活原 effects，不创建一份相同文本；远端 delete tag 仍生效。
- 活性是 revision 闭包的纯函数、ID 固定排序，控制 delivery/重复不改变同集结果。
  排序始终包含不可见节点，因此切换可见性不改变其他元素的相对次序。

多个删除可能使恢复只有 partial/no-effect；会话不能靠字符串对比决定是否撤销成功。
结果按原 effect 的恢复/受阻情况报告。保存的选区只恢复发起会话；merge 不清 redo，
新本地 session 编辑清 redo，checkout 清该 head 的栈。一个会话的新撤销操作
不自动进入另一个会话栈，不提供任意历史组的公共选择性撤销。

## 6. 多文档 group、同步域与 Diff

一个本地跨源提交包含不可变 manifest：group ID、全部 document/base、
每成员事务 ID、每成员的精确 before/after frontier。为避免自引用 hash，
先确定成员 transaction IDs/frontiers，再用规范 membership body 派生 group ID，
编码 manifest 及事务的 group 引用；不对包含自身引用的 payload 求 hash。
revision digest 在内容确定后计算。当前内部格式和验证见第 13 节。
依赖 group manifest 中其他文档不自动使其出现在 head 中。

revision set 为 group-closed：包含一个 group 成员时必须包含全部成员及其因果祖先。
fork/checkout/merge/import/export 同一校验，缺成员报
`INCOMPLETE_TRANSACTION_GROUP` 并列精确要求。导出不能扩展成另一个 head 的 latest，
不能跨 sync port 的 documents 域；域不足整组拒绝。控制同组 undo/redo 也完整发布。
只承诺本进程接受/可见性原子性，不承诺远端同刻可见或 durable ACK。

发送目标是显式 target closure；`known` 可验证时做集合差，未知并发 frontier
安全补发受影响 target closure。相同 stream counter 不是 knowledge prefix。
presence 不写历史；Agent Diff 只读取单次 receipt 的精确 before/after，
不根据 actor 筛选或自动接受提案。这些能力不需要另一套文本冲突规则。

## 7. 可运行小模型与独立 oracle

`tests/crdt` 是**规格检查器**，不导出为产品运行时；不得从 `src` 导入或在生产
复用其 helper。测试用短字符串 ID、完整依赖集、单文档、无安全 codec/资源限额，
有意低效，以便审查。它不是 G1/P2 的替代品。

两条独立路径：

1. 小模型从 accepted transaction 集合做因果重放，按 FugueMax 的树规则求序；
   不使用未来生产索引/缓存。它检查 missing、duplicate、ID 冲突、依赖外引用、
   非法图、删除 tags、效果控制和稳定位置。
2. 小规模 oracle **不读取 parent/side，也不调用树排序**。枚举元素的所有排列、
   所有因果闭合子集，以 strong-list 的 origin 间隔、Definition 4 的前向/例外
   后向相邻性及同 origins ID 平局约束筛选唯一全序（最多 7 元素）。
   这是故意昂贵的声明式判定；大规模测试不能用它作完整意图证明。

小图枚举所有合法 delivery 顺序并注入重复；缺依赖另测 reject/defer。
至少三副本随机离线编辑、delete/replace、显式重连，seed 从 `SEED` 读取；
异常输出 seed 与完整事务轨迹。缩减器每次移除事务及所有因果后代，保留仍失败的
最小化候选；是 1-minimal，不宣称最短。生产差分测试必须保存缩减后的反例。

negative controls 必须真正检出：右 sibling 只按 ID 排序的错误、
同 origin 反转平局的错误、遗漏依赖仍接受的错误。不能只断言所有副本调用
同一函数的输出相同。固定 goldens、独立 oracle、快照/provenance、观察删除
分别提供不同的证据。

## 8. 门禁与尚未覆盖的风险

G0 的设计退出条件是上述规则可逐条审查，D3/D4/D5 有语义支撑，没有必须重开
产品决定的已知冲突。小模型检查提供反例发现，不是本库扩展的形式化证明；
论文也不证明 undo、跨文档 group、导入安全或位置 API。

进入 P2 前仍必须完成 G1 的准确工具、品牌类型、DOM-free consumer 与构建门禁。
P2 要用独立 oracle 和小模型对照真实生产实现；P3/P4 再验收会话、group 闭包、
端口隔离与 Agent Diff。不能将本次规格测试标记为这些阶段已完成。
特别需要生产验证的成本：深链避免递归栈溢出、恶意图/metadata/待决内存限额、
大闭包物化、规范 hash 跨环境一致性、事件不可重入、跨文档发布与回滚安全。
首版无历史压缩；保留所有已接受历史，pin/导出位置不因静默 GC 失效。

## 9. P2 单文档内核的内部约定

以下记录已实现的接缝，方便复核；不把它发布为公共 wire format。
`src/history` 不导入测试模型，公共入口尚未导出这些内部类。

- root 编码依次为 domain `editor/root/v1`、document ID、external base ID、
  exact initial text；revision 编码依次为 domain `editor/revision/v1`、
  完整 root 身份字符串、规范 frontier 的事务身份字符串。
  **每个字段（包括 domain）**前置 uint64 big-endian UTF-8 字节长度，再对连接字节
  做 SHA-256。显示身份为 `root:<lowercase hex digest>`、`rev:<lowercase hex digest>`。
  不使用平台字符串编码、路径、locale 或文本归一化。
- 同步注册 API 不能等待 WebCrypto promise；使用依据 FIPS 180-4 编写的同步
  SHA-256，不引入 Node/DOM 依赖。测试包含标准空串/短串/多块/百万字节向量，
  Unicode root/revision golden 由独立 Node `crypto` 命令计算；未宣称真实浏览器验收。
- writer 使用安全随机源或受信宿主注入的 `RandomSource`，不降级到 `Math.random`。
  事务身份是 `t:<32 hex stream>:<16 hex counter>`，counter 从 1 开始，uint64 耗尽拒绝。
  不恢复 stream，不把 counter 前缀变成依赖；完整 writer/store 租用生命周期仍由后续层实现。
- 同 base 的 ranges 先转换为 scalar 边界，规范排序、去重并拒绝冲突，然后按范围
  起点降序生成 effects。每个 delete effect 持有 base 中已观察的 ID 集合；每个 insert
  effect 持有 scalar、parent/side、left/right origin。effect ordinal 按此规范执行顺序分配，
  插入元素身份是 `<transaction ID>/<8 hex effect ordinal>`；根元素是
  `<root identity>/<8 hex scalar index>`。ordinal 包含 delete effect 的位置。
  只在内部暂存中使用不同命名空间的 draft 身份，验证全部效果与预算后才消耗 writer ID。
- 内部规范 JSON 按 UTF-16 code-unit 顺序排序 object keys，有限 number 用 JSON
  编码（`-0` 变成 `0`），字符串保持原始 Unicode/EOL；拒绝非 JSON、cycle、accessor、
  sparse array 和超过 64 层的嵌套。这不是 RFC 8785 或已交付的公共 codec。
  metadata 合计 16 KiB，typed 批次表示 8 MiB/100,000 scalar insert/delete effects；
  最终 codec 加入 envelope/group 后必须重测本地可导出预算。
- `accept` 在独立暂存图中拒绝环、缺依赖、非规范 frontier、同 ID 异 payload、
  base 外引用与非法生成 gap；全部通过后才发布。重复同规范 payload 幂等。
  单文档 kernel 不持有跨源 registry；payload 已含 group 引用，但须由第 13 节的
  store 边界验证 group 闭包。不带 defer queue、bytes 或安全 decoder。
  `revision`/`join` 是显式的闭包查询，不存在隐式 latest head；未知 revision 先报错，
  再建立源视图，不能混成 `not-yet-created`。
- 首版使用包含墓碑的双向 threaded order，现已由第 12 节的持久 chunk 索引替代；
  不再每次查询重放身份图或重建整篇 origin 秩表。因果 ready 队列和完整闭包保留
  仍是简单实现，大历史时间/空间仍可能为二次量级，不宣称完整性能验收。

生产差分现在覆盖：三副本随机离线编辑与显式闭包重连、旧源视图/provenance、
每个小图因果 cut 的 factorial oracle、固定 right-origin/连续输入 goldens，
以及错误排序负对照和因果缩减。typed 重连不是历史 codec round trip；
生产 undo、位置导出/retention 仍待后续实现；heads/CAS 见第 10 节，内部 group 见第 13 节。

## 10. P2 内部 store/head 编排

`NativeStore` 已接通单文档内核和锁定的 `EditingHead`/`HistoryQueries` 形状，
但不是已导出的完整 `HistoryStore`。head 的固定成员集可有多个文档，
当前跨源 commit 已由第 13 节的 manifest/闭包和统一 staging 支持。
最初的单源 `group:${txId}` 占位引用已替换为绑定完整成员的 digest。

- 文档按原始 base/text 和摘要核对，重复登记幂等。writer 由 store 持有，
  head 借用 writer；跨 store writer 拒绝，活跃借用阻止释放。随机 stream 在此
  store 生命周期内不能复用，包括已释放 stream 和已接受历史出现的 stream。
  typed 接受不能扩展本实例独占租用的 writer stream，只能重复已有事务；
  这不是认证，跨进程租用恢复仍不提供。
- 版本集复制、排序并验证已知 revision；读取调用方 iterable 时立即复制每个 entry，
  不保留 live head 或可变 Map。显式 typed 历史接受在 clone 上验证后替换 owner，
  不移动 head。已返回快照独立保留源视图，并借用 store；无静默 GC 或级联释放。
- CAS 比较 head ID、单调 stamp 和完整版本集。revision 可以 checkout 回原值，
  stamp 不能回退。merge 允许固定成员子集，求已捕获精确闭包的并集；checkout
  必须包含恰好相同的成员，不生成补偿事务。
- 空/文本相同的替换在别名/冲突校验之后移除，批次净文本不变也不分配空 CRDT op。no-change commit
  和已包含历史的 merge 不推进 stamp、不发源事件；显式 checkout 即使同 revision
  仍推进 stamp 并发 `reason: "checkout"` 生命周期事件。未来 session 可据此清栈，
  不是已实现/验收了 session undo。
- receipt 是私有 WeakSet 登记的冻结值，包含精确前后 checkpoint；spread/cast
  不能取得有效 receipt 身份。本地 head/stamp/commit/cursor ID 使用进程内单调命名，
  不混成分布式历史 ID，不用于重启恢复。
- revision 的 `parents` 由因果集合唯一确定：按 canonical frontier 的 ID 顺序，
  分别去掉一个 maximal transaction 得到其直接因果父版本。它不记录“第一次通过
  哪次 merge 创建这个 revision”。分页 cursor 绑定 store/document/exact revision；
  provenance 输出 UTF-16 源范围并保持原创建事务/actor/attribution。
- 事件按提交序在 microtask 发布；先发布完整源/checkpoint，再通知监听器。
  监听期间所有同步源写入报 `REENTRANT_WRITE`，取消订阅可阻止尚未投递的回调。
  单个 listener 的异常不回滚、不阻断其他 listener；交给 `onError`，没有 sink
  或 sink 自身抛错时异步暴露错误，不静默吞掉。

heads 状态机测试每 seed 12 个 32 步场景，用独立规格模型逐步核对三个隔离 head 的
精确因果集合、文本、provenance 和旧快照，混合编辑、捕获版本 merge 与 checkout。
失败保存 seed/run、完整命令、事务和预期集合；没有将事务级 shrinker 冒充命令级
缩减器，因为移除命令会改变后续 checkout 的保存点索引。仍无安全 codec round trip、
生产 undo、Diff 或公开工厂验收；跨文档 group 的新增差分见第 13 节。
已有的大历史成本限制不变。

## 11. Rope/SumTree 存储基础

用户要求先补正规文本存储，并指定公开文章说明多路 B+ SumTree，而非经典二叉 rope。
现已实现并接入真实写入、不可变 revision 文本与快照坐标层；树的不变量、
摘要/CRLF、dimension cursor、路径共享和外部设计输入边界见
[存储设计](./editor-storage-design.md)。最初拟议的 AVL 方案未落地。

这不改变 FugueMax 的因果图、parent/origin、删除、位置或公共协议规则。
它的结构性界限不能当作整笔事务的复杂度；CRDT 接入进展见下一节。

## 12. CRDT 持久 chunk 索引与 delta 物化

全序、墓碑可见性及 source guard 查询现已共享 `SequenceIndex`：

- B+ items 是最多 64 entries 的不可变 chunks；摘要同时累计 entry/full/visible
  长度和可见 UTF-16/UTF-8 长度。两个零文本 enter/exit markers 为每个元素保存
  子树边界；这是内部索引结构，不是新增 CRDT ops 或 wire 字段。
- 持久 ordered maps 从身份找到 chunk，再找到 leaf 和版本级父定位，聚合前缀秩；
  共享节点没有可变父指针。不使用会无限增长的 fractional labels 或全局重标号。
  子节点列表同样持久化，单 child 特化；right-origin 仍比较当前 full-order rank。
- 新连续 forward chain 一次写入 chunks；删除按受影响 chunks 和连续可见区间更新，
  不每 scalar 重建持久树。旧版本/墓碑仍可定位；不是已完成 scalar ID/run 压缩。
- 每个 validated transaction 缓存其闭包的不可变物化；多 frontier revision 从
  最大的已缓存 frontier 成员闭包出发，只应用差集 effects。不是按文本相似或 writer
  counter 猜祖先，也不是承诺在所有缓存中寻找全局最近的因果子集。
- 本地 prepare 和 typed acceptance 仍分别验证；accept 的 index/text caches 一起
  暂存，非法批次不会发布合法前缀。detached input 不携带可受信的索引缓存。
- native `SourceRevision` 直接共享已验证的 index/rope pair；独立 elements-input
  接缝仍逐 scalar 检查并复制，不将这个内部受信接缝冒充安全 decoder。

新增差分把真实 native index 的稳定位置与独立规格模型在每个因果 cut 两两比较，
覆盖三种状态和删除修复；丢弃 indexed tombstones 的负对照必须失败。
另有 40 个并发兄弟/连续 runs、顺逆交付和 child-tree 重平衡用例。
结构共享、禁 full-order 枚举的真实 head 路径、delta effect 计数及尚未解决的成本见
[存储设计](./editor-storage-design.md)。仍不宣称整笔 commit O(log n)。

## 13. 多文档原子 group

内部 `NativeStore` 已支持多源 prepare/统一接受发布、immutable manifest、group-closed
版本边界和 typed 完整/delta 传递。所有成员使用同一批明确的 writer IDs，先暂定、
完整验证后才消耗 counters；失败不发布合法前缀，不以 rewind 修复已消耗的 stream。

manifest 按 document 排序，绑定每成员 exact root/base、事务 ID 和 before/after frontier；
`group:<SHA-256>` 的 `editor/group/v1` digest 由规范 members body 派生，事务 payload
包含该 group 引用。这个关系不含自身 payload/revision hash，避免自引用。
group IDs 不是 actor/发送者认证；public opaque ID 契约没有改变。

同一闭包规则覆盖 revisions/fork/merge/checkout 和 typed target/可验证 known/接受边界，
缺组成员报 frozen 的精确 `missing` 和 `missingManifests`；即使 payload 尚缺，已知 manifest
的 before 链仍可给出传递要求。不追源 head latest、不自动扩大固定成员或文档域。
本地版本/传递结果必须包含每个触及组的全部成员及因果祖先。

逐源图各自无环还不足够；store 检查跨源 group dependency DAG，并拒绝同组成员的
before 向量遗漏已观察祖先组在另一写入源的成员。不能靠最终 target 补一个 merge
来掩盖原子提交创作时不一致的 before。

typed export 只取捕获 target 的因果集合，与可验证 known 做精确差；
未知 known 安全重发 target closure，不用 counter 知识前缀。
typed acceptance 一起暂存所有源、group/transaction registry 和 caches，整组预算
包含 manifests/targets；通过后不移动任何现存 head。显式 documents 域不足整组拒绝。

多源小图枚举用独立扁平 all-or-none membership oracle，各源文本/provenance 对照独立
规格模型；另有三源/三 head seeded 状态机、半组负对照、跨组环、不一致 before、
整组超预算/后源损坏回滚及 counter 不消耗。详见
[group 设计、typed 边界与证据](./editor-transaction-groups.md)。
未实现 public wire codec/defer、生产活性寄存器/undo、pin/位置导出、Diff 或公开工厂；
没有 durable ACK、真实多进程网络或整体大历史性能验收。
