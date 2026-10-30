# 文本存储：持久化 Rope 与 B+ SumTree

状态：内部生产实现已接入单源写入、快照、CRDT chunk 索引与 delta 物化；
因果图管理尚未全面增量化，也未公开包入口。
实测命令与阶段状态见 [实施记录](./editor-progress.md)。

## 1. 设计输入与边界

用户明确提供了 Zed 的公开文章
[Rope & SumTree，2024-04-23](https://zed.dev/blog/zed-decoded-rope-sumtree)。
本轮阅读文章及其文内示意片段，采用其中公开说明的多路 B+ sequence、
summary composition、dimension cursor、persistent rope 原理；没有继续打开仓库源码、
测试、视频或其他参考实现，也没有搬运文章中的 Rust 实现片段。
这是输入来源记录，不是法律或“完全未接触参考代码”的认证。

最初拟议的 AVL 已撤回。这里的 SumTree 确实是 B+ tree，不把任意加权二叉树叫作
文章所述的结构；TypeScript 实现、接口与参数由本库自行设计。没有新运行时依赖。

## 2. SumTree 的不变量

实现位于 `src/collections/sum-tree.ts`：

- 所有 payload 只存在于 leaf；内部节点持有子树及各自 summary。
- 非根 leaf 的 item 数、非根 branch 的 child 数均为 **8–16**。
  非空根 leaf 可有 1–16 items，branch 根可有 2–16 children；空树用 null root。
  所有 leaf 等深，每个节点缓存 height、item count、聚合 summary。
- 每个 leaf 缓存 item summaries，branch 缓存 child summaries。边界重排复用已有
  summary，不重新扫描旧 payload。节点和所有索引数组冻结。
- `SummaryOps` 的输入 item/summary 必须不可变，`add` 必须有单位元、可结合且纯；
  不要求交换律。不把内部 typed 接缝冒充可接受任意可变对象的安全 decoder。
- bulk build 均匀分配每一层，不能留下过小的最后一个 child。
  concat 合并边界、溢出后再均匀分配；高度不同时只沿较高树的边缘下降。
  split 复用完整侧枝，并通过 concat 修复切口的欠占用；不留下 unary internal root。
- splice 只构造插入数据及切口/重平衡路径；未改动子树保留对象身份。
  不先把旧树 flatten 成数组再重建。

`SumCursor` 绑定不可变 root。它按调用者提供的**单调数值 dimension** seek，同时
聚合完整前缀 summary，因此可沿 UTF-8 定位并取得 UTF-16/scalar/行摘要。
left bias 选择首个 inclusive end >= target 的 item，right bias 选择 end > target；
零权重 items 和 end-of-tree 有独立测试。`done` 与 `item === undefined` 分开，
不占用泛型 payload 的 undefined 值。`next` 使用保留的祖先路径，不从根反复 seek。
`seekBy` 还可按单调的完整 prefix predicate 定位，例如 ordered map 的最后 key >= target；
不把字符串 key 或对象身份强行转成数值 dimension。

## 3. Rope 和文本摘要

`src/text/rope.ts` 在 SumTree 上保存不可变 `RopeChunk`：

- 每块最多 **1024 UTF-16 units**，边界只能落在完整 Unicode scalar 之间。
  相邻块若总长度不超过上限则合并，split/replace 的 seam 同样归一，
  防止长时间小编辑留下无限多个微小块。这不是 grapheme 分块。
- summary 包含 UTF-16/UTF-8/scalar 长度、逻辑换行数、首尾行 UTF-16 长度、
  最长行 UTF-16 长度和最早的最长行 row，以及边界 LF/CR 状态。
- CRLF 跨块时只计一次换行；CR-only/LF 同样保留。summary 合成不修改原文本，
  不执行 NFC、EOL 归一化或替换孤立 surrogate。
- offset 转换由 B+ summary seek 加一个有界 chunk 扫描完成，拒绝 surrogate/
  UTF-8 字节内部边界。低层 offset 仍允许位于 CR 与 LF 之间。
  本轮没有新增公开行列/grapheme API。
- fromChunks 的每个输入片段必须是合法 Unicode；不能靠两个非法 surrogate 片段
  互相补齐。内部 chunk builder 不会制造这种边界。
- split/slice/concat/replace 返回共享子树的新值，旧快照不变。
  仅显式 `toString()`/`TextSnapshot.text()` 拼接完整字符串；不因此突破 JS 字符串上限。

seek 随树高而非全文长度工作；叶内扫描上限固定。生成插入文本本身仍需读取/验证
该文本，显式输出完整字符串仍为全文成本。这里没有 Rust Arc、跨线程 transfer 或
多线程安全的运行时承诺；共享是同一 JS realm 内的不可变对象共享，由 JS GC 回收。

## 4. 实际接入路径

`head.commit → NativeHistory.prepare → TextRope.replace → accept → SourceRevision/TextIndex`

- revision 保存实际的 immutable rope，不是只用它算一个临时字符串 oracle。
  prepare 用 base scalar 坐标从右到左替换，再与 effects 增量产生的 rope 等值核对，
  不用完整字符串拼接做发布前比对；这个等值核对仍可能流读全文。
- 只有在该 history 实例私有 WeakMap 登记过的、冻结的 local prepare 结果，
  才能在完整接受验证后传递其 rope root。detached typed import 不信任这个缓存，
  仍从 effects 独立验证/物化。merge/import 复用已缓存的因果子集，见第 6 节。
- history clone 共享 root 登记、rope 和不可变 revision 值，不重算初始文本摘要或重分块。
  但事务/revision/cache Map 仍是浅复制，**history clone 不是整体 O(1)**。
- `TextIndex` 不再保存全篇 scalar 前缀数组；它直接封装同一个 rope。
  source snapshot 和 provenance 的坐标查询不再重建完整可见文本的 string index。
- native `SourceRevision` 直接共享 history-owned 的已验证 index/rope pair，并核对
  三种长度摘要，不枚举元素/编译完整 guard map。独立 elements-input 路径仍逐 scalar
  检查传入 rope 并复制输入。前者是内部受信接缝，不是 untrusted materialization decoder。
  source view 使用 WeakRef memo；活动 snapshot 仍强持有视图及其索引根，保留保证
  不因弱 memo 回收而失效。冷 source view 也不再扫描整篇 CRDT order。

## 5. 证据与尚未消除的成本

新增测试不只比较最终字符串：

- 审计占用、等深、height/count、每个 item/child/aggregate summary；
  测根增长/收缩、不同高度 concat、切口欠占用和随机 splice。
- 100,000-item 树单点修改保留 >95% 原节点、新节点 <100；
  dimension 回调访问量受 fanout × height 界约束。
- 1,048,576 UTF-16 units 的 rope 单点替换保留 >80% 原节点、新节点 <100；
  旧版本仍可读，反复 insert/delete 不积累微小 chunks。
- 独立 Unicode 编码/flat string oracle 对照，跨 chunk CRLF 和最长行 tie，
  两种 summary 合成括号顺序，seeded 随机编辑与保留旧 roots。
- 真实 head commit 在禁止 `TextRope.toString` 时仍完成，并检查确实调用了
  `TextRope.replace`，避免“未接入容器，所以 tripwire 没触发”的假阳性。
  已接受 native revision 有真实节点共享；独立 typed import 的文本与它相同。

这些是结构性界限和正确性证据，不是墙钟 benchmark 或形式化复杂度证明。
下一阶段的 CRDT 接入如下。

## 6. CRDT 全序、身份与 revision delta

`src/history/sequence-index.ts` 将 full order 保存为最多 **64 entries/chunk** 的 B+ 树：

- 每个元素有 enter/value/exit 三个 entries，START 同样有三个零文本 entries。
  只有 value 含 `NativeElement`，两个 marker 在 full/visible/text dimensions 权重为零。
  墓碑 value 的 full 权重仍为 1、visible/text 为 0，不丢弃 guard 身份。
  这是 chunked index 和批量 run 写入，不宣称已压缩每 scalar 的身份/元数据存储。
- 摘要包含 chunk/entry/full/visible 数量及 UTF-16/UTF-8 长度。按 visible dimension
  seek 可以跨过整段墓碑；`visibleRange` 仅枚举请求的删除范围，不先生成全文 visible IDs。
- `src/collections/ordered-map.ts` 复用相同 B+ balancing，以 last-key prefix seek 查找
  string/numeric key。batch update 合并稠密变更范围，稀疏 keys 分治并保留中间子树；
  不为了少数远隔 keys flatten 整张 map，也不引入另一套 hash/平衡树实现。
- 三层持久 locators：entry key → immutable chunk/offset，chunk → leaf/offset，
  tree node → version-local parent/prefix。共享 B+ 节点不含可变 parent。
  编辑只遍历新/retired fringe，遇到确认共享的旧节点就停止；移除不再 live 的 locator。
  本地 WeakMap object serial 只用于定位，不参与 CRDT 身份、排序或序列化。
- 身份查前缀要沿树高走版本级父定位，每层另查持久 map；当前是有界 chunk 扫描加
  多次树查询，不把它说成单次 O(log n)，也不使用随插入无限增长的 fractional order label。
  root 文本一次 bulk 建立，无按文档深度递归调用。
- FugueMax child lists 用相同 SumTree，空/单 child 特化。先按 right-origin **full rank**
  与 ID 二分定位 sibling，再用 enter/exit markers 定位子树边界，不沿长 L/R 链寻找。
  这些索引不改变算法 parent/side/right-origin 规则。
- 连续的新 forward chain 一次 splice；删除先验证/定位全部 targets，再按 chunks 批量
  改 visibility，并把连续可见范围合成 rope 删除。索引与 rope 从同一 staged effects
  更新；一笔 20,000-scalar 插入/50,000-scalar 删除不再逐 scalar 做持久 tree splice。

`NativeHistory` 的 materialization cache 同时持有 sequence/index/text roots：

1. 精确 revision cache 命中直接共享；本地 staging 克隆这些不可变根。
2. 冷多 frontier 物化，选其中已缓存、事务数最多的 frontier member 闭包；它必然是
   目标的因果子集。按目标的 causal order 只应用不在该闭包中的 transactions。
   不是对所有缓存做全局最优子集搜索，冷 merge 仍可能应用很多 effects。
3. 验证事务时从它的精确依赖物化出发，删除逐目标查询 base visibility（拒绝新插入/
   重复删除），插入验证声明 gap/ordinal。新的 uninterrupted forward chain 合批执行；
   typed import 不得跳过这些验证。
4. typed batch 在私有 history/index/cache 中全部验证，通过后一起发布；非法前缀的
   临时物化不会污染原实例。head 不因接受 history 移动，旧 snapshots/branches 保持原根。

新增验证：

- 200 次随机 index splice，每轮对照扁平顺序、每个身份的 full/visible prefix、摘要、
  chunk 范围，以及当前 locator 数量（没有累积 retired parent/chunk entries）。
- 10,000 元素批量隐藏保留全部 full order、Unicode 摘要正确、旧根未变；清空/再插入可用。
- 32,768-scalar accepted revision 单点替换：order 和 identity 两类树分别保留
  **>90% 原节点、新节点 <150**；clone 和旧 branch 持有原索引根。
- 独立 typed import 每个 transaction 只应用自己的新 effects；冷 merge 只应用选定
  因果子集之外的 effects，重复 source/text 查询及旧 revision 查询不再应用 effects。
- 真实 head 在已有 20 笔历史后禁止 full-order enumeration，替换为 1,000 scalars、
  坐标转换和 deleted-guard 修复仍通过；prepare/accept 各一次 run splice，计数非空。
- 真实 native index 在每个合法 causal cut 的位置捕获/目标解析两两对照独立模型；
  discarded-tombstone mutant 被检出；40 并发 siblings/runs 跨 child-tree/chunk 重平衡，
  正反交付与原有模型/小图 factorial oracle 差分保持通过。

首个逐 scalar 路径在完整测试中超过 120 秒，没有把它当作通过；合批修正后的完整
深链用例和全套检查已通过。测试运行时间不是大历史性能基准。

## 7. 仍保留的成本与后续

**整笔 commit 仍不是 O(log n)**：

- 因果 closure/Kahn 排序、完整 revision/transaction arrays、accepted/revision/cache Map
  浅复制仍按历史规模工作，长期保留这些数组可能达到二次量级。
- prepare 的净 no-op 与 effects/text 一致性 rope 等值核对可能读取全文；
  目标删除区间、插入文本、canonical JSON 与 metadata/byte 限额验证必须读实际输入。
- 显式 `elements`/provenance/text 输出仍可能枚举全篇；冷 merge/import 按选定因果子集
  之外的 effects 工作，不保证仅改动最终可见文本那么少。
- 每 scalar 仍有结构记录及 markers，locator 采用多层树查询而非最紧凑的 run-ID 编码；
  JS GC 回收结构共享对象，但没有历史 pin/retention/压缩策略验收。

多文档原子 group 已在后续轮接通，见 [group 设计与边界](./editor-transaction-groups.md)；
codec/defer、pin/位置导出、Diff 与默认公共工厂也已发布（见 [实施记录](./editor-progress.md)）；
另追踪因果图管理、ID/run 压缩与完整大历史的时间/空间基准。
生产 undo adapter、browser/LSP/IME/读屏、跨线程 transfer 验收仍未完成，
不能从内部树计数推导这些能力。
