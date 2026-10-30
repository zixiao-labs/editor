# Editor 实施记录

## 当前结论

原线程的下一项 **G0 算法规格与独立验证设计已完成**，并建立可运行的规格检查器；
已补齐 **G1 核心/协作/集成公共类型、工具与七入口门禁**。
尚未选择/安装的集成运行时依赖仍需在 P5/P6 审查；这不是可用编辑器交付。
**P2 已有内部源视图、生产单文档 FugueMax 事务，以及 store/head 编排**：
登记/查询、writer 所有权、隔离 heads/CAS/ABA、精确 merge/checkout、事件和借用已实现。
**文本层已补齐持久化 B+ SumTree + chunked rope 并接入写入/快照/坐标路径**；
**CRDT 全序/可见性、身份/子树定位和 revision delta 物化已接入**，native snapshots
直接共享索引，不再为每笔写入重放整张身份图或编译完整 guard 表。
因果闭包/历史 Map 管理与 rope 等值扫描仍有全量成本，整笔 commit 不等于 O(log n)。
**多文档原子 group、manifest、闭包/域校验与 typed 传递已接通**，失败不发布合法前缀，
不消耗 writer counters，不扩大固定 head 成员或传输域。
**用户已确认开放 CRDT/历史后端替换，公开接入层已实现**：完整产品工厂、协议描述、
身份/opaque 隔离、资源归属及可选 selective-undo/defer 能力，不再把 FugueMax 当作公共前提。
**默认 group 活性内核已接通**：revision-local generation/shared-ID winner、独立删除标签、
跨文档原子控制和 meaningful no-effect 历史；不是 session undo 栈。
**外部只读文本源已公开**：产品 gap buffer/持久快照无需 history/rope/SumTree；
兼容 history head 可接到同一有界读端口。只读 shaping/view 仍只有类型。
**默认完整历史 backend 与版本化 wire codec 已发布**（`createHistoryStore`，API D13）：
codec、显式 defer/pending 事件、pin/位置导出与完整 Diff 均可按包名调用；
公开 native undo adapter 与 session 栈仍待完成，P3–P8 未实现；
内部生产差分通过不能当成完整生产历史验收，或把类型当可调用工厂。

上一轮基线：用户恢复四份原设计文档后的 `b688a6e84f3a98d4ea51aaaa57288aa9462436ba`。
G1 集成基线：用户拉取恢复上一轮交付后的 `da2d9f58708649bb7b50c1a5647e6eb2281f32c2`。
P2 源视图基线：用户恢复完整 G1 后的 `7df01a80faa9ee56dede18b28bacd131e7ccf672`。
事务基线：用户拉取源视图交付后的 `73e3c38`，当时工作区干净。
heads 基线仍为 `73e3c38`，前轮事务实现和文档尚未提交，已完整保留并续写。
本轮存储基线仍为 `73e3c38` 加前述未提交实现；不丢弃之前的源码/文档改动。
CRDT 索引轮仍基于相同 HEAD 及未提交存储实现，全部保留；无新增外部参考输入。
group 轮仍为 `73e3c38` 加前述未提交实现，未重置既有改动或引入外部参考资料。
后端轮基线是用户提交上述工作后的 `2629761`；切换后工作区干净，已复跑 103 项
及 typecheck。原拟默认活性寄存器工作尚未改 runtime，就按用户确认优先补后端替换边界。
当前活性/只读文本源轮基线是用户提交后端接入层后的 `1428514`；工作区初始干净，
已先复跑 114 项及 typecheck。没有回退或覆盖用户提交。
Workflow 仍为 `maintainer-original`，仅 editor；原设计线程是用户指定的继续工作来源。
此前未读取参考实现/研究目录/其他 worktree；本轮用户另指定 Zed 公开 Rope/SumTree
文章（含文内示意片段）作为设计输入，未跟进其仓库、测试或视频，未搬运其中实现。
单执行者；未启动子代理、未使用上游专属 Subharness/计费配置。

| 阶段 | 状态 | 证据/剩余 |
| --- | --- | --- |
| G0 | 完成规格与独立验证设计 | `editor-crdt-design.md`、规格模型、枚举 oracle、负对照；不是形式化证明 |
| G1 核心/协作 | 契约与工具门禁通过 | branded IDs、head/session checkpoints、receipt/Diff、协作类型；root 另有公开后端接入运行时 |
| G1 集成类型 | 本轮契约/入口门禁通过 | 语言/LSP/shaping/vgpu/browser、六个 type-only 子入口、无 DOM/DOM consumer、12 个规范代码块与负对照；运行时依赖审查仍留给安装阶段 |
| P2 | 默认 backend/factory、codec、defer、保留与 Diff 已公开 | `createHistoryStore`、字节 codec、pending 事件、pin/位置导出、Diff 按包名可运行；公开 native undo adapter 待完成 |
| P3/P4 | 未开始 | session/undo/MultiBuffer、同步/presence、结构化与 unified Agent Diff |
| P5–P8 | 未开始 | 增量语法/真实 LSP、字体与 vgpu、输入/读屏、Diff view/playground、完整交付 |

## 上一轮变更：G0 与核心/协作骨架

- 独立比较 RGA/Fugue/FugueMax，选 FugueMax，写清 origin 排序和 tombstones。
- 定义 root/writer/因果 revision、隔离历史、规范批次、稳定 cut、效果寄存器 undo、
  group 闭包与同步域；没有把逐字符布局固化为公共协议。
- 单文档测试模型与不用 parent/side 的 factorial oracle 分开；oracle 最多七元素。
  三副本随机历史有局部字符串 oracle、重连/重复/乱序、旧 snapshot/provenance 检查；
  小图枚举合法 delivery，坏排序/缺依赖负对照会被检出。因果缩减器有独立反例测试。
- 核心/协作接口是 type-only，运行时只导出可验证身份构造器和 `EditorError`；
  无 `not implemented` 工厂，不输出生产 CRDT 成功假象。
- 公共身份构造器限制非空/control-free/完整 Unicode/1024 UTF-8 字节，原串保留。
  这是辅助类型的工程校验，不把产品身份当认证；历史存在性仍须由 store 验证。

## 上一轮实际验证

环境 Node 24.15.0、pnpm 12.15.0；固定工具版本未升级，锁和 workspace 未改。

- `pnpm install --frozen-lockfile`：通过。
- 红→绿：先加入规格测试，`pnpm test:crdt` 因模型不存在失败；实现测试模型后通过。
  先加入类型测试，`pnpm test:types` 因入口不存在失败；实现类型后通过。
- `pnpm test`：18 项规格检查器及基础运行时测试通过。
- `pnpm test:types`：Lightning 的核心/协作类型用例，包括非法 ID/坐标/CAS、
  混合 Diff 输入、选区不可变和 session receipt 兼容。
- `pnpm typecheck`：项目 TypeScript 7.0.2 检查源码、测试和独立构建配置。
- `SEED=424242 pnpm test:crdt`；另测 `SEED=0` 和 `SEED=4294967295`：
  三副本随机场景与小规模独立 oracle 均通过。每 seed 16 个 24-事务随机历史，
  加 12 个 6-元素独立 oracle 历史；失败包含可重放输入，不宣称随机是证明。
- `pnpm build`：tsdown ESM/declarations 通过。首次 TS classic API 错误后改用
  独立 isolated-declarations 构建配置，未改变工具版本。
- `pnpm test:consumer`：实际产物包名 import、独立 Node ESM 的 DOM/network tripwires、
  root gzip 预算三项检查，以及 ES2022-only、无 DOM/Node ambient、
  `skipLibCheck: false` 声明检查。

上述命令的通过只覆盖当前基础入口和测试模型。没有运行 `test:browser`、`test:lsp`
或 `playground:dev`，它们尚无实现；没有 GPU、真实 LSP、字体连字、系统 IME、
读屏或性能验收。没有发布、push、PR、commit 或合入共享分支。

## G1 集成契约与入口隔离

- 补齐 `LanguageFactories`/`LspFactories`/`ShapingFactories`/
  `VgpuFactories`/`BrowserFactories` 及辅助类型，具体责任见
  [集成契约](./editor-integration-contracts.md)。明确语言选择、完整源分类、可信 edit 链、
  ready/stale/unversioned、CAS 源 edit proposal、font-unit/CSS-pixel/generation、
  Diff 激活源映射和 composition 可恢复文本。
- 新增 `/collaboration` 与五个集成子入口。全部只导出类型，
  没有 `not implemented` 工厂。root 原有运行时和协作类型兼容。
- ES-only 与 DOM 配置分离，构建允许 DOM 不等于允许 root 声明泄露 DOM。
  真实产物消费者分别无 DOM/有 DOM 检查，两个 fixture 都禁 ambient Node 类型且
  `skipLibCheck: false`；browser fixture 检查原生 `AbortSignal` 结构兼容。
- 规范文档 12 个 TS 代码块直接提取编译，并与公开声明/工厂双向核对；
  `pointUtf16(number)` 改成 string 的负对照失败。没有复制一份签名后只测副本。
- 入口/所有权、未实现边界与包体记录已更新；新增可重复的
  `pnpm measure:package`，声明计入去重闭包，不被共享 chunk 的命名/拆分误导。

### G1 实际验证

环境仍为 Node 24.15.0、pnpm 12.15.0，工具未升级、无新增依赖、锁文件未改。
先运行恢复基线全套门禁，再加入失败的集成类型测试，补齐声明后转绿。
文档验证器最初因辅助类型映射不全失败，补齐后成功；没有修改规范签名绕过检查。

| 命令 | 实际结果 |
| --- | --- |
| `pnpm --version` | 12.15.0 |
| `pnpm install --frozen-lockfile` | 通过 |
| `pnpm test` | 18 项通过；生产核心仍未实现 |
| `pnpm test:types` | 2 个 ES-only fixture + 1 个 DOM fixture 通过，含正向工作流和拒绝用例 |
| `pnpm typecheck` | ES-only、DOM、isolated-declarations 构建配置通过 |
| `SEED=424242 pnpm test:crdt` | 16 项规格检查通过 |
| `SEED=0 pnpm test:crdt`、`SEED=4294967295 pnpm test:crdt` | 各 16 项通过 |
| `pnpm build` | 七入口 ESM/declarations 通过 |
| `pnpm test:consumer` | 两类声明 consumer 编译通过，5 项 Lightning 检查通过，含规范文档及负对照 |
| `pnpm measure:package` | 七入口测量完成；root JS 仍为 1,949 bytes / gzip 802 bytes，六个子入口 JS 为 0 bytes |

本轮没有运行尚未实现的 `test:browser`、`test:lsp`、`playground:dev`；
没有真实 parser 增量复用、LSP、字体、GPU、IME、读屏或性能验收。
不把 DOM 类型 fixture 称作真实浏览器测试。没有 commit、push、发布、PR 或合入。

## 本轮变更：P2 源快照、坐标与稳定位置

- 新增生产侧 `TextIndex`：UTF-16/UTF-8/scalar 精确边界与双向转换，共用单 scalar
  Unicode 校验；不夹紧 offset，不切 surrogate，不归一化 Unicode/EOL。
  combining mark 和 CRLF 内部仍是合法低层 scalar 边界，未增加行列/grapheme API。
- 新增内部 `SourceRevision`，从包含墓碑的全序/可见性建立不可变源视图，
  返回符合既定 `TextSnapshot` 的句柄。输入数组/元素不是内部可变别名；
  points/ranges/positions/resolutions 运行时冻结，dispose 幂等，释放句柄持有的视图引用。
- guard 身份与 before/after affinity 分开解释，START/END 使用独立哨兵类型。
  deleted 提供两种未来 affinity 不同的修复值，不重写原 token；
  guard 未出现在目标 materialization 时为 not-yet-created，不要求捕获 revision 的无关操作。
  position 的私有 WeakMap payload 不保留整个视图，不能靠 spread/cast 伪造。
- 全序一次编译为私有 guard → 可见前缀秩索引，避免递归/逐次扫描长墓碑链。
  建立视图 O(全部元素 + 可见文本)，UTF-16/UTF-8 边界校验 O(log 可见元素)，
  guard 解算 O(1)。首版为完整索引，不宣称已实现 run/chunk 增量更新或大历史性能验收。
- 先加入两个失败的 unit 文件，确认因生产模块不存在而失败，再实现并转绿。
  新增独立 Unicode 前缀编码对照、immutable/disposal/错误 revision/伪造位置、
  affinity 修复、30,000 元素长墓碑间隙用例。
- 新增位置差分：六事务固定历史及每 seed 12 个六事务历史，枚举其所有因果闭合 cut，
  两两比较每个合法边界/affinity 的解算。独立 factorial oracle 供应全序，
  规格模型供应可见性与期望解算，不复用生产前缀索引。
  swap-affinity/discard-tombstones 两种测试负对照被检出，并能缩减到仍失败的因果反例；
  随机失败输出 seed、完整历史和缩减候选。

### 内部边界与尚未覆盖项

`SourceRevisionInput` 是**已验证 materialization 的内部接缝**，不是导入协议或安全解码器。
本层不建立/认证 root/revision digest，不验证因果图、顺序或 visibility，也不查询历史存在性。
未来 history 层必须先拒绝 UNKNOWN_REVISION/HISTORY_UNAVAILABLE，再调用本层解算；
不能把未知历史构造成空视图后返回 not-yet-created。本轮没有接入该历史层。

测试 adapter 使用规格模型的可见性，不代表生产删除/undo effects 已通过验收；
原有三副本收敛测试仍只覆盖规格模型。新模块没有从 `tests` 导入/搬用实现，
没有接入包入口，也没有增加半实现的公共工厂。公开产物仍只有身份/错误运行时，
故其包体未变不衡量新内部实现。store 借用/retention、position codec/跨进程保留尚未实现。

### P2 本轮实际验证

Node 24.15.0、pnpm 12.15.0；无新增依赖，manifest、锁、公共签名与 exports 未改。
先复跑恢复基线的全部 G1 门禁，再进行测试优先实现与下列最终检查：

| 命令 | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过，工具版本未变 |
| `pnpm test` | 34 项通过，新增 16 项只验收坐标/快照/位置层 |
| `pnpm test:types` | 两个 ES-only fixture 与一个 DOM fixture 通过 |
| `pnpm typecheck` | ES-only、DOM、isolated-declarations 三配置通过 |
| `SEED=424242 pnpm test:crdt` | 19 项通过，含新位置差分 |
| `SEED=0 pnpm test:crdt`、`SEED=4294967295 pnpm test:crdt` | 各 19 项通过 |
| `pnpm build` | 七公开入口 ESM/declarations 通过，新内部模块尚未接入入口 |
| `pnpm test:consumer` | 两类声明 consumer 与 5 项 Lightning 检查通过 |
| `pnpm measure:package` | 七入口数值未变；root JS 1,949 bytes / gzip 802 bytes |

未运行真实 browser/LSP/playground/IME/读屏或性能验收；
未完成/验收生产 CRDT 收敛、heads、CAS、merge、group、codec 与历史 round trip。
没有 commit、push、发布、PR 或合入共享分支。

## 本轮变更：P2 原生单文档事务

- 新增 `src/history`，不搬用/导入测试模型，不改已锁定公共 API、exports 或依赖。
  精确 UTF-8 framing + 同步 SHA-256 建立 root/revision 身份；revision 使用非冗余
  frontier，不把相同文本当相同历史，也不把 stream counter 当连续因果前缀。
- writer 分配 128-bit stream、单调 uint64 counter；安全随机不可用时报错，
  注入随机源的可变字节不保留为别名，dispose 幂等。完整 writer/store 生命周期未接入。
- 同 base 批量替换先校验全部坐标/Unicode/metadata、规范化 aliases 和冲突，
  允许相邻非空范围，拒绝 caret 端点冲突；右到左生成 observed deletes 和 insertion runs。
  在消耗 writer ID 前对同时替换的字符串结果和 typed 表示预算做检查。
- FugueMax 生产树保留墓碑和 origin，维护双向 threaded 全序；
  right siblings 比较 origin 的列表秩，不比较 origin ID。
  本地长 run 和根链无需递归；50,000 元素用例包含 30,000 根元素、
  20,000 非 BMP 插入及全删除，未将其当大历史性能基准。
- typed `accept` 校验暂存图、依赖 frontier、根、观察删除与生成 gap，
  同 ID 同规范 payload 幂等，异 payload 拒绝。非法批次没有有效前缀残留。
  显式闭包查询/集合并不引入 latest head；未登记 revision 拒绝，
  验证后的物化接到已有 `SourceRevision`，输出创建事务/actor 归因。
- 新增 16 项测试：SHA-256 标准向量和独立 framing golden；身份、批次、
  原子拒绝、metadata/budget、别名、位置、长链；三副本每 seed 16 个 24-步随机编辑场景，
  每 seed 12 个六事务小图的全部因果 cut 与独立 factorial oracle 对照。
  测试 adapter 只展开 frontier/重命名 ID，不计算排序、gap 或 visibility。
- right-origin ID-only、反转 ties 两种错误均被 oracle 检出。right-origin 五节点图
  可以已是 1-minimal；测试不再错误地要求每个反例都能继续缩小。
  reversed-tie 使用独立插入 fixture，避免将依赖 base 改序后的验证失败冒充排序对照。
  随机失败携带 seed、完整原生事务和因果缩减候选。

### 本轮内部边界

这是**typed、单文档、非 wire 的生产内核**。没有安全 byte decoder、defer/pending
队列、group manifest/域闭包或效果活性寄存器；不能把默认 active 的 observed deletes
称为已验收的生产 undo。8 MiB/100,000 operations 目前检查内部 JSON 批次表示，
最终 codec 加入 envelope/group 后仍须检查实际可导出体积。

没有导出 `createHistoryStore` 或其他半成品公共工厂。root 登记冲突的多文档 store
工作流、heads/CAS/ABA、精确 checkout、position codec/retention 与事件生命周期仍未接入。
内部 snapshot 的 UNKNOWN_REVISION/guard 区别已测，但真实 store 工作流仍须重测。
每次查询重放闭包、分支重建 origin 秩和保留完整闭包的成本可能为二次量级；
不宣称已有增量 chunk 索引或长历史性能验收。内部编码细节见算法规格第 9 节。

### P2 事务实际验证

Node 24.15.0、pnpm 12.15.0。先重跑恢复基线门禁，再加入两个失败 unit 文件
（因生产模块缺失而失败），补齐实现后转绿。随后加入生产差分测试并修正负对照
fixture/缩减预期；最终结果如下。manifest、锁和工具版本未改。

| 命令 | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过 |
| `pnpm test` | 50 项通过，新增 16 项 |
| `pnpm test:types` | 两个 ES-only fixture 与一个 DOM fixture 通过 |
| `pnpm typecheck` | ES-only、DOM、isolated-declarations 三配置通过 |
| `SEED=424242 pnpm test:crdt` | 23 项通过，含生产事务差分 |
| `SEED=0 pnpm test:crdt`、`SEED=4294967295 pnpm test:crdt` | 各 23 项通过 |
| `pnpm build`、`pnpm test:consumer` | 七入口构建、两类声明 consumer 和 5 项 Lightning 门禁通过 |
| `pnpm measure:package` | 七入口数值未变；root JS 1,949 bytes / gzip 802 bytes，内部事务尚未入包 |

未运行尚无实现的真实 browser/LSP/playground、系统 IME/读屏或性能验收；
未验收安全 codec round trip、pending、生产 undo、heads/CAS、group 与完整历史 store。
没有 commit、push、发布、PR 或合入共享分支。

## 本轮变更：P2 内部 store、隔离 heads 与查询

- 新增 `NativeStore` 内部编排，不修改公共签名/exports，不导出缺方法的
  `createHistoryStore`。文档/base/text 精确登记与重复幂等；版本集复制输入并冻结值，
  外部 iterable 的 entry 在迭代时即捕获，不保留 live head 或可变 Map。
- writer 的 store 所有权与 head 借用独立验证；相同 actor/replica 可有不同 stream，
  但在本 store 中不复用活跃、已退役或已见历史的 stream。
  外来 typed 历史不能扩展本地租用 stream，也不能跨文档复用事务 ID。
- fork 固定成员且不追随其他 head；共享 writer 的两个隔离 head 仍只依赖自己的 base。
  CAS 校验 head/stamp/版本集；checkout 回到相同 revision 后旧 expect 仍被 ABA 拒绝。
  merge 接受成员子集的精确版本，source 后续编辑不扩张已捕获集合；checkout 要求完整
  相同成员，移动指针而不造补偿操作。
- commit 在 staged clone 上准备/验证后发布。统一 no-change 规则：别名/冲突先校验，
  再移除文本相同的替换；相邻替换抵消导致净文本不变也不分配空 CRDT op。
  同文本不同历史仍可由真实改动往返产生。
  头可持有多个文档，但当前一次 commit 只写单源，跨源批次在任何发布前明确拒绝，
  不用空 manifest 或部分提交冒充 group 原子性。
- 接通全部 `HistoryQueries` 形状：revision/transaction、因果关系、绑定精确版本的
  分页 cursor、provenance、位置解算/转换。父 revision 由去掉每个 maximal transaction
  的直接因果集合确定，不依赖接收到达顺序或第一次 merge 的调用路径。
  未知历史在真实 store 路径中报错，guard 的 deleted/not-yet-created 保持区别。
- receipt/checkpoint/事件冻结，receipt 私有登记防伪造。源状态先完整发布，事件再按
  commit 序在 microtask 通知；同步重入写入拒绝。监听错误交 error sink，不回滚、
  不阻断其他监听器；无 sink 或 sink 抛错时异步暴露，不静默忽略。
  no-change commit/merge 不推进 stamp，显式同 revision checkout 仍推进 stamp 并通知。
- store/head/writer/snapshot 借用分别释放，活动资源阻止所有者 dispose；
  dispose 幂等且无级联销毁。已复制版本集/receipt/文本不随句柄释放失效。
- 新增 15 项 unit 和 1 项 seeded 状态机测试。每 seed 12 个 32 步场景逐步核对三个
  head 的精确因果集合、文本、provenance 与旧快照，包含离线编辑、捕获 merge、
  checkout 和 ABA。模型从 receipt 的事务 ID 与参考闭包独立生成，不读取生产排序。
  失败保存完整 replay，不把原有事务缩减器冒称为命令级缩减器。

### 本轮验证与未完成边界

先重跑 50 项基线和 typecheck，再加入失败的 store unit 文件（模块不存在），
补齐实现后转绿并加入状态机差分。Node 24.15.0、pnpm 12.15.0，无新增依赖、工具升级、
manifest/锁/公共 API 变更。

| 命令 | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过 |
| `pnpm test` | 66 项通过，本轮新增 16 项 |
| `pnpm test:types` | 两个 ES-only fixture 与一个 DOM fixture 通过 |
| `pnpm typecheck` | ES-only、DOM、isolated-declarations 三配置通过 |
| `SEED=424242 pnpm test:crdt` | 24 项通过，含真实 head 状态机差分 |
| `SEED=0 pnpm test:crdt`、`SEED=4294967295 pnpm test:crdt` | 各 24 项通过 |
| `pnpm build`、`pnpm test:consumer` | 七入口构建、两类声明 consumer 与 5 项 Lightning 门禁通过 |
| `pnpm measure:package` | 七入口数值未变；root JS 1,949 bytes / gzip 802 bytes，内部 store/head 尚未入包 |

typed 接受仍不是安全 bytes codec，没有 pending/defer、跨文档 group manifest/域闭包、
生产效果活性寄存器、pin/导出位置或 Diff。singleton group 引用不等于已实现跨源组。
checkout 已提供生命周期事件，但没有 session，不宣称已验收 undo/redo 清栈。
公共 `HistoryStore` 还包含 P4 的 `diff` 方法；工厂必须等全部契约齐全后才导出，
不为提前宣称 P2 公开验收而增加抛 `not implemented` 的方法或重开已锁定 API。
未运行真实 browser/LSP/playground、系统 IME/读屏、完整 codec round trip 或性能验收。
没有 commit、push、发布、PR 或合入共享分支。

## 本轮变更：P2 持久化 Rope 与 B+ SumTree

- 根据用户反馈，先补存储基础而不是继续堆 group。阅读用户指定的
  [公开文章](https://zed.dev/blog/zed-decoded-rope-sumtree) 后撤回 AVL 提案，
  改为真实多路 B+ SumTree；未跟进仓库链接、测试或视频，没有搬运其 Rust 实现。
- 新增 `src/collections/sum-tree.ts`：非根占用 8–16、叶子等深、根收缩/增长、
  每个 item/child 与节点聚合摘要、可结合且不必交换的 summary algebra；
  split/concat/splice 沿边界路径复制，维护完整占用，不 flatten 旧序列重建。
  cursor 沿单调数值 dimension seek，返回完整前缀摘要，支持 bias、零权重和连续 next。
- 新增 `src/text/rope.ts`：1024 UTF-16 units 上限的 scalar-safe chunks，
  split/replace/concat seam 合并以避免碎片；三种长度、跨块 CRLF、首尾行、
  最长行/最早 row 摘要。文本/换行不归一化，低层仍能表达 CRLF 内部边界。
- `TextIndex` 从全篇 scalar prefix arrays 改为同一 rope 上的树摘要查询；
  SourceRevision 验证可见 scalar stream 后复用 rope，snapshot 不复制整篇文本。
  source memo 使用 WeakRef，活动快照仍强持有视图；不强留每次查询产生的完整 guard map。
- `NativeHistory.prepare` 直接做持久 rope replace 和 scalar stream 核对，
  完整接受后复用私有登记的本地 draft root。detached import 仍从验证后的 effects 物化，
  不信任输入带来的文本缓存。clone 共享 root/rope/不可变值，不重哈希和重分块初始文本；
  事务/revision Map 仍浅复制，不宣称整个 history clone O(1)。
- 新增 12 项测试：B+ 不变量、随机 splice、非交换摘要、cursor 边界/访问量，
  Unicode/CRLF/最长行合成、rope 随机编辑和旧版本、真实 head/native 写入集成。
  容器测试先因模块不存在失败；集成测试先因扁平 TextIndex 不接受 rope、
  native history 没有文本树而失败，接通后转绿。
- 结构性界限：100,000 items 单点修改保留 >95% 旧节点；1,048,576 UTF-16 units
  rope 单点替换保留 >80% 旧节点；两者新增节点均 <100。真实 accepted revision
  同样有节点共享；禁止 `TextRope.toString` 并检查实际 replace 调用的 head workflow 通过。
  这是结构性验收，不是墙钟性能基准或形式化复杂度证明。

### 本轮实际验证

Node 24.15.0、pnpm 12.15.0。先复跑原 66 项与 typecheck，再测试优先实现。
manifest、锁、公共 API/exports 与依赖未改。

| 命令 | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过 |
| `pnpm test` | 78 项通过，本轮新增 12 项 |
| `pnpm test:types`、`pnpm typecheck` | 既有类型 fixture 与三配置通过 |
| `SEED=0/424242/4294967295 pnpm test:crdt`（分别执行） | 各 24 项通过 |
| `SEED=0 pnpm exec lightning run tests/unit/rope.test.ts` | 4 项通过 |
| `SEED=4294967295 pnpm exec lightning run tests/unit/rope.test.ts` | 4 项通过；424242 由全套默认测试覆盖 |
| `pnpm build`、`pnpm test:consumer` | 七入口构建、两类声明 consumer 与 5 项门禁通过 |
| `pnpm measure:package` | 七入口数值未变；root JS 1,949 bytes / gzip 802 bytes，内部存储模块尚未入包 |

**剩余成本明确保留**：CRDT 身份图仍重放，visible IDs/观察删除/效果一致性核对、
冷物化和首次位置 guard 索引仍可能全量扫描；rope 等值比较也可能读全文。
Map 浅复制和右 origin 秩尚未增量化，不能把 rope 的树高界限冒充完整 commit 的复杂度。
本轮没有完成 group、生产 undo、codec/defer、pin/位置导出或公共工厂；
没有真实 browser/LSP/IME/读屏、跨线程 transfer 或完整大历史性能验收。
实现边界见 [存储设计](./editor-storage-design.md)。未 commit、push、发布、PR 或合入。

## 本轮变更：P2 CRDT chunk 索引与 revision delta

- 新增 `SequenceIndex`：64-entry chunks 的持久 B+ full/visible/UTF-16/UTF-8 摘要，
  保留 tombstone values；enter/exit 零文本 markers 让深层子树边界可直接定位。
  三层持久身份/chunk/版本级父定位，不给共享节点写 mutable parent，不用 fractional
  labels、整篇 rank map 或 L/R 长链遍历。
- 新增 `OrderedMap`，复用同一 SumTree 的 last-key summary 与 `seekBy`；稠密批次
  合并局部范围、稀疏批次分治，未改动 ranges 保留共享。index fringe 更新删除 retired
  locators，当前索引不累积已退役的 parent/chunk entries。
- `FugueSequence.clone` 共享不可变根。child lists 持久化且空/单 child 特化；
  right-origin 排序仍按当前 full-order rank，未改变 FugueMax 的 causal gap 规则。
- 连续 forward insertion 合为一次 chunk splice；观察删除按受影响 chunks 修改
  visibility、按连续可见区间更新 rope。首个逐 scalar 路径导致完整测试超过 120 秒，
  已修正并重跑通过；没有把超时结果算成功。
- `NativeHistory` 缓存 validated causal materializations；精确命中直接共享，多 frontier
  从事务数最多的已缓存 frontier member 闭包出发，只应用差集 effects，不按 writer
  counter/text 猜祖先。typed import 的 gap/ordinal/base-visible targets 仍逐项验证，
  index/text/cache 与接受图一起暂存后发布；非法批次不泄漏合法前缀。
- native `SourceRevision` 直接共享已验证 order/rope pair；捕获、解析与删除修复查询
  持久索引，不枚举整篇 guards。独立 elements-input 接缝仍复制/验证全部输入，
  未把内部受信入口包装成 codec；活动快照与旧 branches 保留原根。
- 新增 **11 项测试**：ordered map/批量更新、200 次 index 随机 splice 和 live locator
  审计、批量 visibility、accepted index 共享、冷 merge delta、真实 head 禁枚举及
  批量 splice 计数、native positions 的每 causal cut 独立模型差分/墓碑负对照、
  40 并发 siblings/runs 及顺逆交付。既有 factorial oracle 与规格模型仍独立，未搬入生产。
- 结构证据：32,768-scalar accepted 单点替换，order 与 identity 两类树各保留 >90%
  旧节点、新节点 <150；已有 20 笔历史的真实 head 将一个 scalar 替换为 1,000 scalars，
  prepare/accept 各一次 run splice，旧 effects 零重放，位置修复/坐标转换通过。

### 本轮实际验证

Node 24.15.0、pnpm 12.15.0、HEAD `73e3c38`。manifest、lock、公共契约/exports 未改。

| 命令 | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过 |
| `pnpm test` | 89 项通过，较前轮 78 项新增 11 项 |
| `pnpm test:types` | ES-only 两 fixture、DOM 一 fixture 通过 |
| `pnpm typecheck` | ES-only、DOM、isolated declarations 三配置通过 |
| `SEED=0/424242/4294967295 pnpm test:crdt`（分别执行） | 各 26 项通过 |
| `pnpm build`、`pnpm test:consumer` | 七入口构建、两类 consumer 编译与 5 项门禁通过 |
| `pnpm measure:package` | 七入口数值不变；root JS 1,949 bytes / gzip 802 bytes，内部索引尚未入包 |
| `git diff --check` | 通过 |

仍有历史 closure/Kahn/完整数组与 Map 浅复制的成本（长历史可能二次量级），
prepare rope 等值核对可能流读全文；显式全文/provenance 输出、冷 merge 的 effects 差集
也不是 O(log n)。每 scalar 仍有 metadata/markers，未完成身份 run 压缩或历史 retention。
没有完整大历史墙钟/内存基准、browser/LSP/IME/读屏或跨线程 transfer 验收。
实现与边界见 [存储设计](./editor-storage-design.md)。未 commit、push、发布、PR 或合入。

## 本轮变更：P2 多文档原子 group

- `NativeStore` 支持多文档 commit：先复制/验证全部源 edits，按 document 排序生成
  owner-bound drafts，再以暂定 IDs finalize 和完整暂存；统一通过后才消耗 counters、
  发布全部文档与 group/transaction registry，生成一个 checkpoint/receipt/event。
  后文档非法、整组超预算或闭包失败不留下合法前缀。no-op 文档不产生空成员/事务。
- `NativeWriter.plan/commit` 只在提交暂定 allocation 时推进 counter；
  放弃、重复、stale 或伪造的 plan 不会改流。不通过回退已公开 counter 实现回滚。
- 新增 immutable manifest，绑定每成员 document/exact root/base、transaction ID 和
  before/after frontier；规范 members body 以 `editor/group/v1` 派生 digest，
  事务 payload 含 group 引用，不 hash 自身 payload/revision。旧 singleton 占位引用已替换，
  public opaque ID/receipt 契约未改。
- 同一 `assertGroupClosed` 覆盖 revisions/fork/merge/checkout、local candidate 和 typed
  export/import 边界；缺成员列精确 frozen `missing` 与 `missingManifests`，沿已知 manifest
  before 链追传递要求，即使 required payload 尚缺。不会追 latest、自动登记 root、扩大
  head membership 或 transfer documents 域。
- 额外拒绝跨文档 group dependency cycle（即使逐源图无环），以及同组 before 向量
  遗漏祖先组在另一个写入源的成员；不能以最终 target 再 merge 掩盖创作时的不一致。
- 新增内部 `exportTyped/acceptBundle`：捕获 exact target，对可验证 group-closed known
  做因果集合差，未知 known 安全补发 target closure；typed acceptance 整组验证后接受，
  不移动已有 heads。显式 documents whitelist 域不足拒绝，不是网络授权。
  整个 typed envelope 的 manifests/targets/事务合计受 8 MiB/100,000 effects 限制。
  这不是公开 opaque bundle、安全 byte decoder、defer 或同步端口。
- 新增 **14 项测试**：11 个 group 单测、writer allocation 单测、两个多源差分。
  既有“跨源未支持应拒绝”用例更新为真正多源提交验收，其固定 head membership 断言保留。
  新测试先因缺 group 模块失败；接通后补完整反例与独立差分，没有改公开契约来绕过。
- 四组八成员图枚举 144 个逐源合法 cuts：独立 flat all-or-none oracle 认定 10 个完整、
  134 个半组，生产接受/拒绝一致，各源文本/provenance 与独立规格模型一致。
  三源/三 head 每 seed 8 × 32 步状态机混合多源离线编辑、captured merge/checkout、
  typed target 传递与旧 snapshots；失败保留 seed/run/完整操作，不冒用单事务 shrinker。

### 本轮实际验证

Node 24.15.0、pnpm 12.15.0、HEAD `73e3c38`。实施前复跑 89 项基线通过；
`package.json`、lock、public exports/类型契约未改，无新增依赖或 Node/DOM API。

| 命令 | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过 |
| `pnpm test` | 103 项通过，新增 14 项 |
| `pnpm test:types`、`pnpm typecheck` | 三类型 fixture、ES-only/DOM/isolated declarations 三配置通过 |
| `SEED=0/424242/4294967295 pnpm test:crdt`（分别执行） | 各 28 项通过 |
| `pnpm build`、`pnpm test:consumer` | 七入口构建、两类 consumer 编译与 5 项门禁通过 |
| `pnpm measure:package` | 七入口数值不变；root JS 1,949 bytes / gzip 802 bytes，内部 group 尚未入包 |
| `git diff --check` | 通过 |

整笔 commit 的历史 closure、Map、group DAG/before 校验和 rope 等值扫描仍有全量成本；
未做完整大历史时间/内存基准。未完成 wire codec/defer、生产 group 活性寄存器/undo、
pin/位置导出、Diff 或公共工厂；没有真实 browser/LSP/IME、跨进程网络/transfer 或 durable ACK。
实现与证据见 [group 设计](./editor-transaction-groups.md)。未 commit、push、发布、PR 或合入。

## 本轮变更：公开可替换历史后端

- 用户先补充两篇公开文章，随后明确确认“替换 CRDT/历史后端”，不是只配置产品模式。
  已阅读全文、记录来源；未跟进文章中的代码仓库/测试/视频。默认 FugueMax 没有被改成
  DeltaDB，也不强迫外部后端使用 generation/count；公共边界按用户决定扩展为 API D11。
- 新增 `HistoryBackendDefinition/Descriptor/Context`、完整 `HistoryStoreImplementation`、
  `HistoryBackendProtocol` 及 `HistoryUndoProvider`。`HistoryStore.backend` 声明 family/
  contract/algorithm/格式/能力，`undo` 是可选后端端口；同步 offer 复用同一 protocol 类型。
- 公开 `defineHistoryBackend` 路由产品工厂并包装完整 store；拒绝缺方法、能力/端口不符、
  重复使用已打开 implementation/facade。没有公开假的无参 `createHistoryStore` 或 native
  provider。上层通过 `historyStoreFor(head)` 找到 store，不做 native `instanceof`。
- SDK 发行带 family/algorithm/kind namespace 的 ID，以及 store/issuer-local positions、
  receipts/undo tokens 和 format-bound 的 portable position tokens/bundles。
  入口先校验归属再调用 provider；同协议仍由 provider 校验 root、闭包、codec/预算。
  这不是安全 sandbox、认证或跨进程 decoder。
- facade 统一 handle 所有权、head/writer/undo 借用、pin/snapshot/exported position 与
  异步 Diff 的资源保留；成功 dispose 幂等，通知微任务排队/取消、同步重入拒绝，
  caller revision sets/checkpoints/ranges/query 参数只捕获一次。
- selective undo 是 opaque capture/apply 端口，方向明确、回真实 receipt，
  不含默认引擎的寄存器/节点布局；session 栈、分组和 selection restoration 仍待实现。
- 新增 11 项 runtime 接入测试与一个 ES-only type fixture。使用明确标注的 scripted
  port doubles 验证路由/隔离/能力/生命周期，不冒充两个完整 CRDT 或算法 conformance。
  既有默认内核的独立模型、factorial oracle 和 group state machine 保持不变。
- 新测试先因缺模块失败；构建 consumer 检出旧 API 文档缺 backend 字段，已同步契约。
  另检出旧依赖 regex 把错误字符串 `import"` 当作语法，改成带负对照的 VM 静态依赖
  解析，保留 dynamic-loading/native-markers 禁入检查，未通过改错误文案绕过门禁。

### 本轮实际验证

Node 24.15.0、pnpm 12.15.0，HEAD `2629761`。没有新增依赖/升级工具；
锁与七入口 export map 未改。`package.json` 只把新 type fixture 加入命令；
root 的公开 runtime exports 与历史接口按用户授权扩展。

| 命令 | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过 |
| `pnpm test` | 114 项通过，较基线新增 11 项 |
| `pnpm test:types` | ES-only 三 fixture、DOM 一 fixture 通过 |
| `pnpm typecheck` | ES-only/DOM/isolated declarations 三配置通过 |
| `SEED=0/424242/4294967295 pnpm test:crdt`（分别执行） | 各 28 项通过 |
| `pnpm build`、`pnpm test:consumer` | 七入口构建、两类 consumer 编译与 5 项门禁通过 |
| `pnpm measure:package` | root JS 28,644 bytes / gzip 6,887；不含默认 CRDT，子入口 runtime 仍空 |
| `git diff --check` | 通过 |

当前只证明公开接入层行为，不证明第三方引擎算法、codec、安全或 durable 存储正确；
尚无生产替代引擎或默认 native adapter，默认 undo、codec/defer、pin/位置导出、Diff、
session/view 均未因此完成。没有大历史性能/内存、真实 browser/LSP/IME 或多进程验收。
consumer 的 VM flag 只用于测试子进程解析，生产库不需要实验 flag 或 Node API。
用法和具体边界见 [后端协议](./editor-history-backends.md)。未 commit、push、发布、PR 或合入。

## 本轮变更：默认 group 活性与外部只读文本源

- `NativeHistory` 为每个精确 revision 保存 original-group/activity 持久 maps；
  控制事务无 text effects，generation 严格从自身 depends 闭包 winner 加一。
  register 比较 `(generation, shared representative ID)`；多文档共用首规范成员 ID，
  不用各源不同成员 ID 导致 split winner，也不读 store-global 最新值。
- `FugueSequence` 保留 creator、独立 delete tags、active delete count 与 group effect
  持久列表；只更新该组受影响元素/区间/chunks，不递归隐藏其他 creator 的远端后代，
  不移除 tombstones，不在 redo 复制新 IDs。旧 cuts/快照/归因保持不变。
- `NativeStore.setGroupActive` 与 commit 共用原子 publication；控制组恰好覆盖原组文档，
  校验 observed original/domain/generation、整组一致性/manifest/闭包和预算后发布。
  结果按 effect identity 报 applied/partial/no-effect；no-effect 控制仍产生真实历史。
  当前 domain 是非恢复 writer stream + actor/replica，不是认证或 session 持久化。
- 根入口新增 `createTextSource`/`textSourceFromHead` 与独立的 read version/point/range。
  snapshot lease 保留旧文本；versioned lease 前后检查 mutation/ABA，拒绝撕裂读。
  source 借用产品 buffer/head，仅管理读 leases 和订阅；活动 read 阻止关闭 source。
  读取有界、Unicode scalar-safe、通知合并；历史增加 `TextSnapshot.readUtf16`，
  适配不需要展平全文/复制到第二份存储，不拉入默认 rope/SumTree/CRDT 到公开 root。
- `/shaping` 与 `/vgpu` 增加只读布局/view 类型，不要求 session/history；只读坐标不能
  进入 edit/history/输入桥。快速/完整模式由产品显式替换 source，不暗中迁移旧坐标、
  追补未记录的历史或销毁任一 owner。API D12 与只读接入文档记录该授权扩展。
- 新增 **15 项 runtime 测试**：7 个 group 内核单测、2 个独立模型差分/负对照、
  6 个文本源单测；沿用真实双侧 UTF-16 gap buffer、原 history 独立规格模型和包级门禁。
  控制测试先因缺方法失败。补 emoji adapter 反例后发现 raw 探测与 history scalar-safe
  读取不兼容，修为小窗口扩展/裁剪，未放宽原 range 合同。
  visibility 批次重复更新回到原值的反例也先失败，已修成最后值生效且净无变化复用旧根。
- 三隔离 cuts 每 seed 8 × 32 步 edits/controls/joins 对照独立 replay，比较文本、
  身份与归因并保留旧 cuts；跨源 tie fixture 令各源成员 ID 排序相反，own-ID mutant
  被检出。typed 完整/重复控制 roundtrip、一致 singleton 伪装半控制组、坏后源均已测。
  32,768-root 单元素控制禁止整图/全序枚举且 order nodes 共享 >90%；
  100k 文本局部读禁止展平大 rope。以上不是整笔 commit 或大历史性能基准。

### 本轮实际验证

Node 24.15.0、pnpm 12.15.0、HEAD `1428514`。无新增依赖/工具升级；
manifest、lock、export map 未改。公共接口按用户授权增加只读文本接缝与有界 history 读取。

| 命令 | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过，lock 未改 |
| `pnpm test` | 23 文件、129 项通过，较基线新增 15 项 |
| `pnpm test:types` | ES-only 三 fixture、DOM 一 fixture 通过，含只读坐标/编辑输入隔离负例 |
| `pnpm typecheck` | ES-only/DOM/isolated declarations 三配置通过 |
| `SEED=0/424242/4294967295 pnpm test:crdt`（分别执行） | 各 30 项通过 |
| `pnpm build`、`pnpm test:consumer` | 七入口构建、两类包名 consumer 与 5 项门禁通过 |
| `pnpm measure:package` | root JS 36,500 bytes / gzip 8,627；不含 native/rope/SumTree，六子入口仍为空 runtime |
| `git diff --check` | 通过 |

没有真实 shaper/GPU/browser/IME/LSP、读屏或跨进程/共享内存验收；未选择/安装 vgpu runtime，
只读 view 仍不可调用。没有替代完整生产后端或默认公开工厂，session undo 栈、
wire codec/defer、pin/位置导出和完整 Diff 尚未实现。
设计与限制见 [group 活性](./editor-transaction-groups.md#7-默认-native-group-活性寄存器)、
[文本源](./editor-text-sources.md)。未 commit、push、发布、PR 或合入。

## 本轮变更：默认 native backend、codec、defer、保留与 Diff

- 公开 `createHistoryStore(options?)`（API D13）：默认 FugueMax 内核经既有
  `defineHistoryBackend` 接入层发布为完整 `HistoryStore`，全部分布式 ID 经 SDK
  命名空间发行，`store.backend` 报告 family `zixiao:editor-native`、
  algorithm `fugue-max/sequence-v1`、独立 history/position 格式 ID；
  `capabilities` 为 `{ selectiveUndo: false, deferredImport: true }`。
  产品替换整套引擎仍走 D11，不需要 patch 本库。
- 新增版本化字节 codec：`encodeHistoryBundle`/`decodeHistoryBundle`、
  `encodePositionToken`/`decodePositionToken`。信封为 magic + codec 版本 +
  精确 payload 长度 + 规范 UTF-8 JSON；自带严格 UTF-8 解码器（拒绝 overlong、
  代理编码与截断），解码在建立 opaque 值前验证未知字段、身份 pattern、
  canonical frontier、自引用依赖、manifest digest 与 8 MiB/100,000 限额；
  从不写入任何 store。位置 token payload 为 `{v,document,root,guard,affinity}`，
  元素/根身份形状严格校验，版本 1 之外报 `UNSUPPORTED_FORMAT`。
- 新增 pin 与位置导出/导入：`pin` 验证精确版本集（含 group 闭包）；
  `exportPosition` 读取本地 opaque 位置、登记依赖并发行格式 token；
  `importPosition` 校验 document/root 与 payload 后以本地 issuer 重建位置。
  持有 pin/导出位置阻止 store 释放，释放幂等。
- 新增 defer/pending：显式 defer 的缺依赖批次进入 32 MiB 有界暂存，
  按 canonical payload 去重（重复导入返回同一 `HistoryPendingId`）；
  同 ID 异 payload 以“较新声明获胜”驱逐旧 pending 并发拒绝事件。
  后续导入按 FIFO 重试，整体接受或拒绝，经 `store.onImport` 在 microtask
  投递事件；同步重入写入拒绝，监听异常进入 error sink。
- 新增完整 Diff：`store.diff` 支持 receipt 与 versions 两种基准，输出不可变
  `DiffReport`（schemaVersion 1）：结构化 replacements 为 scalar 级最大差异段，
  grapheme intraline marks 仅作展示细分；hunks 按 LF patch 行组织、CR 保留、
  缺尾换行标记、context 0–1000；budget 按文档记录的确定性度量检查，不截断；
  `CancellationSignal` 报 `CANCELLED`。`formatUnifiedDiff` 输出确定性 unified
  patch：默认标签为安全编码的文档身份、缺席侧 `/dev/null`、标签控制字符报
  `INVALID_DIFF_LABEL`、formatter 输出同样受预算约束。grapheme 分段使用平台
  `Intl.Segmenter`（ICU，记录为平台设施），只影响展示 marks。
- 公开接口新增 `HistoryStore.onImport`、`HistoryImportEvent`、`HistoryPendingId`；
  pending 报告携带 `id`。`tests/consumer/api-document.test.ts` 扩展为也能双向核对
  “文档自身声明的运行时函数”（如 codec 函数）。
- 新增 **22 项测试**：4 项 codec（含损坏字节语料与非规范 JSON）、11 项 native
  backend 集成（含约 7 MiB×4 的 pending 上限、跨 store 位置/历史 roundtrip、
  驱逐事件、订阅生命周期）、6 项 Diff（含随机编辑下 hunk/unified 双独立重建
  oracle、预算与取消）、1 项 facade 导入事件归一化。

### 本轮实际验证

Node 24.15.0、pnpm 12.15.0，HEAD `e25fa64` 加本轮未提交实现与文档。
无新增依赖/工具升级；manifest、lock、七入口 export map 未改（root runtime 导出
按 D13 用户授权扩展）。

| 命令 | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile`（沿用锁定安装） | 通过 |
| `pnpm test` | 26 文件、151 项通过，较基线 129 项新增 22 项 |
| `pnpm typecheck` | ES-only/DOM/isolated declarations 三配置通过 |
| `pnpm test:types` | ES-only 三 fixture、DOM 一 fixture 通过，含 codec/事件/品牌负例 |
| `SEED=424242 pnpm test:crdt` | 30 项通过 |
| `pnpm build`、`pnpm test:consumer` | 七入口构建、两类 consumer 编译与 5 项门禁通过；Node 子进程冒烟含真实建 store/提交/Diff/codec roundtrip |
| `pnpm measure:package` | root 214,235 bytes / gzip 51,720（预算 128 KiB）；六子入口 runtime 仍为空 |
| `git diff --check` | 通过（提交前复核） |

默认 factory 的行为证据来自真实内核经同一接入层的端到端测试，不是第二个 CRDT；
这不证明第三方后端算法、持久存储、跨进程网络或 durable ACK。公开 undo adapter、
session 栈、Diff 视图、真实 browser/LSP/IME 与性能基准仍未实现或未运行。
没有 commit、push、发布、PR 或合入共享分支。

## 下一项

接公开 native undo adapter（capability `selectiveUndo` 翻 true：capture/apply 复用
活性内核、多组原子发布），随后进入 P3 会话分组/选区/MultiBuffer 与 P4 同步端口、
Diff 视图。默认工厂已发布，后续修改不得破坏已锁定 descriptor 兼容性，
不靠 not-implemented 方法提前开放。
产品仅渲染快速模式已经可以独立适配存储，真实 shaping/GPU view 在集成阶段另行实现，
不将本轮有界读端口或类型检查当作绘制成功。
核心与集成分别保持无 DOM/DOM 的声明边界；P2 的生产实现必须与规格模型和独立
oracle 差分，不能把 `tests/crdt/support` 移到生产或以两份同算法输出相等结案。
如果算法扩展或依赖能力发现与锁定 API 的真实冲突，再具体报告，不泛泛等待“继续”。
