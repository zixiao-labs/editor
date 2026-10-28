# Editor 实施记录

## 当前结论

原线程的下一项 **G0 算法规格与独立验证设计已完成**，并建立可运行的规格检查器；
已补齐 **G1 核心/协作/集成公共类型、工具与七入口门禁**。
尚未选择/安装的集成运行时依赖仍需在 P5/P6 审查；这不是可用编辑器交付。
**P2 已开始：内部源快照/坐标/稳定位置层已实现并验证**；生产 CRDT 事务、
历史 store、隔离 heads、codec 与 group 仍待实现，P3–P8 未实现。
不能把位置层差分当成完整生产历史验收，或把类型当可调用工厂。

上一轮基线：用户恢复四份原设计文档后的 `b688a6e84f3a98d4ea51aaaa57288aa9462436ba`。
G1 集成基线：用户拉取恢复上一轮交付后的 `da2d9f58708649bb7b50c1a5647e6eb2281f32c2`。
本轮 P2 基线：用户恢复完整 G1 后的 `7df01a80faa9ee56dede18b28bacd131e7ccf672`。
Workflow 仍为 `maintainer-original`，仅 editor；没有读取参考实现、其他研究线程/
目录或其他 worktree。原设计线程是用户明确指定的继续工作来源，不从其外获取算法。
单执行者；未启动子代理、未使用上游专属 Subharness/计费配置。

| 阶段 | 状态 | 证据/剩余 |
| --- | --- | --- |
| G0 | 完成规格与独立验证设计 | `editor-crdt-design.md`、规格模型、枚举 oracle、负对照；不是形式化证明 |
| G1 核心/协作 | 骨架和工具门禁通过 | branded IDs、head/session checkpoints、receipt/Diff、selection/projection、协作端口类型；仅身份/错误有运行时 |
| G1 集成类型 | 本轮契约/入口门禁通过 | 语言/LSP/shaping/vgpu/browser、六个 type-only 子入口、无 DOM/DOM consumer、12 个规范代码块与负对照；运行时依赖审查仍留给安装阶段 |
| P2 | 进行中，内部源视图通过 | 已有快照/坐标/guard 位置层；生产 CRDT/历史 store、安全 codec、heads 与原子多文档 group 待实现 |
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

## 下一项

继续 P2 原生历史层：先落实 root/revision 规范身份、writer/stream、生产 FugueMax
事务与 materialization，将验证后的历史接到已有源视图；再完成隔离 heads/CAS、
精确 merge/checkout、安全 codec 与本地原子 group。未知历史与未创建 guard 的区别
须在真实 store 工作流重测，不能只依赖内部视图用例。
核心与集成分别保持无 DOM/DOM 的声明边界；P2 的生产实现必须与规格模型和独立
oracle 差分，不能把 `tests/crdt/support` 移到生产或以两份同算法输出相等结案。
如果算法扩展或依赖能力发现与锁定 API 的真实冲突，再具体报告，不泛泛等待“继续”。
