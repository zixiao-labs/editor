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
先分配 group/transaction IDs，再编码 manifest；revision digest 在内容确定后计算。
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
