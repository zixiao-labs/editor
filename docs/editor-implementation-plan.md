# Editor 分阶段实施计划

状态：G0/G1 门禁已通过。P2 已发布默认 native backend/factory、版本化 wire codec、显式 defer 事件、pin/位置导出与完整 Diff（API D13），并保留产品后端接入（D11）与外部只读文本源（D12）。公开 native undo adapter、session undo 栈与 P3–P8 仍待完成。当前实测、剩余事项见 [实施记录](./editor-progress.md)；不把下面的验收项当作已有测试结果。

## 1. 工作流、基线与阶段边界

- Workflow：`maintainer-original`；内部需求；默认分支 `main`。
- 本轮观察到的 editor HEAD：`872a1490877d4e77cd6fb39965652914b5fefb4b`，分支名 `main`。实施前重新记录基线与外部修改，不重置用户内容；不把该 SHA 当作 CRDT revision。
- 仅 editor。合同、API 与本文是允许的设计输入；用户截图只作局部 Diff 呈现结构参考，不查图中文件。
- 用户已确认 B、严格选区策略、可选连字字体、TS/JS/JSON + TypeScript LSP、单次提交 Agent Diff，并要求继续。不再重复询问这些选择。
- 没有上游 Subharness 配置/依赖；不调用其专属角色、canary 或 Vercel 计费凭据。不换另一路模型工具来冒称运行过这些角色。
- 当前执行者为本会话单一实现者，不启动未请求的子代理。下面是逻辑工作线，不是假装存在的并行 agent。
- 先给计划，再测试优先实现。G0 算法规格和 G1 工具/类型门禁通过前不写 CRDT runtime；不建以后替换的临时同步内核。

## 2. 工作线与依赖

| 工作线 | 责任/拟议文件域 | 依赖 |
| --- | --- | --- |
| A：核心 | `src/history/**`、`src/model/**`、`src/coordinates/**` | G0/G1 |
| B：headless 交互 | `src/session/**`、`src/projection/**`、`src/diff/**`、`src/collaboration/**` | A 的历史/事务契约 |
| C：语言 | `src/languages/**`、`src/lsp/**` | 源快照/变更事件、G1 依赖审查 |
| D：视觉/输入 | `src/shaping/**`、`src/vgpu/**`、`src/browser/**` | B 的 session/Diff、C 的分类接口 |
| E：交付 | `playground/**`、`tests/**`、构建与 consumer fixture | 各工作线可验证入口 |

表中列出的是实施责任边界，不代表各工作线已实现。当前单线执行；未来若用户明确启用代理，再为互不修改同文件的任务分配 worktree，不能未经授权并行改同一套公共类型。共享类型/exports/manifest 一次由一个实现任务修改。

```text
G0 算法规格与独立验证设计
  ↓
G1 工具链、依赖审查、公共类型契约
  ↓
P2 历史/坐标/heads/组事务
  ↓
P3 选区、undo、MultiBuffer
  ↓
P4 历史同步/presence + 单次 Agent Diff（首个 headless 端到端里程碑）
  ↓
P5 增量语法 + 真实 LSP
  ↓
P6 真实塑形/字体 + vgpu 编辑视图/输入
  ↓
P7 局部 Diff 片段 + playground
  ↓
P8 构建、consumer、资源/性能/可访问性证据
```

不从 P7 的静态 UI 倒推“底层已完成”；所有 UI 演示必须使用前面真实提交、源映射和 Diff 输出。

## 3. G0：独立 CRDT 算法关口

下一实施任务先写 `docs/editor-crdt-design.md`，不是运行时代码。任务必须：

1. 阅读可公开引用的论文，记录确切版本/章节/URL与适用性质；只用论文和标准，不查目标参考仓库、其测试或研究侧笔记。
2. 至少比较 RGA 类序列 CRDT 与 Fugue/FugueMax 的可说明方案。不得只引用摘要便宣布选型；明确本库采用/修改哪些规则，不把名称当证明。
3. 给出持久 op ID/stream、因果依赖、根/base 身份、版本等价性、并发插入/删除/替换、run 交织、缺父节点与重复处理的形式规则。
4. 单独定义 stable position 的 affinity、删除、旧版本回看及 not-yet-created；演算 ASCII、非 BMP、组合字符、CRLF 的最小例子。
5. 定义会话本地 undo 的补偿/删除效果和 redo；证明不会误删远端插入，不复活仍被其他删除覆盖的内容。跨文档 group 是额外一致性规则，不宣称序列算法论文已经解决。
6. 定义低效但独立的 oracle/小模型：输入 accepted op 集合从头求值，不复用生产索引、缓存或排序 helper；说明哪些性质只能用声明式不变量验证。
7. 记录可判定的验收和反例；对能力缺口主动报告。若论文方案不能支撑 API D3/D4/D5，先请求重开决策，不悄悄实现另一语义。

验收设计：

- 小因果图枚举所有合法 delivery 顺序，混入重复与缺依赖；无效图/同 ID 异 payload/未知 base 必须拒绝。
- 至少三副本 seeded 随机 insert/delete/replace、离线/重连、fork、精确 merge；保存 seed、操作序列和最小化反例。
- 收敛之外检查连续输入非交织、仅删除已观察内容、历史快照和 provenance。
- 用故意损坏的平局顺序/缺依赖路径作为 negative control，证明测试能检出错误，而不是所有副本共用同一 bug。
- 不把正常顺序字符串 oracle 冒充并发意图证明；不宣称随机测试是形式证明。

G0 退出条件：论文规则与本库扩展可逐条审查，所有 API 语义有支撑或明确列为阻塞。只有没有未解决语义冲突时才进入核心实现；没有额外产品取舍时不再要求一次泛泛的“继续”。

## 4. G1：工具、依赖与类型契约

### 环境

确认实际使用 pnpm 12.15.0。前面的临时文档查询输出是宿主 12.3.4，不能作为项目验收环境。使用项目指定版本的运行方式，不修改全局安装或现有选定工具版本来绕过；不能满足就具体报告。

保留 manifest 与锁的现有工具选择；需要新增依赖时单独列准确版本、许可、包体/资产、官方文档与为何必要。禁止为重建锁而顺便升级 Lightning、Nasti、tsdown 或 TypeScript。保留既有其他依赖，不做无关清理。

按准确版本查 Lightning 的 runtime/type/browser 能力与 CLI、Nasti dev server、tsdown ESM/declaration 输出；没有核查前不编造参数。项目最终测试框架只有 Lightning，不另换一个框架冒称通过指定验收。

vgpu 安装进入范围时按 skill：先看 manifest/lock/本地 binary；无既定选择则稳定 `vgpu@latest` 并记录解析精确版本，再读其本地随包 docs。不得把研究侧曾查询的 0.6.0 当作项目 pin，不用 prerelease。parser/runtime、语法/query、shaper、字体、server 同样需版本与许可审查。

### 类型与打包骨架，先写失败测试

- 将 `editor-api.md` 声明落实为类型契约，验证不同 ID、坐标、revision、source/projection、checkpoint 不能互换。
- headless consumer 只用 ES lib，不需要 DOM 声明；CancellationSignal、随机源不泄露 DOM 类型。
- `CommitReceipt` 为 head/session 共用源前后 checkpoint，单次 Diff 能直接消费，保存/恢复选区不混入历史。
- 检查所有代码块使用的公开签名；差异先在文档列明，不用私有逃生口使例子“通过”。
- 明确入口图、资源借用关系；parser/font/WASM/playground 不被无条件打进 root。

退出条件：准确工具就绪、依赖台账可审查、类型测试可运行且失败/修复证据可重现。没有依赖批准或真实能力证据时，保留阻塞，不假称骨架已可用。

## 5. P2：源快照、坐标与原生历史

先写测试，再实现选定算法和数据结构；生产可以用 chunk/run 索引，oracle 保持简单独立。

已完成第一块内部实现：不可变 materialization 视图、三种单位的坐标索引、
source snapshot 句柄、guard/affinity 位置解算与转换。第二块已实现规范 root/revision、
writer stream、同 base 批量替换、FugueMax 墓碑排序、typed 因果接受与单文档物化，
并与规格模型/独立 oracle 差分；源视图的已验证输入现在可由真实历史层供应。
第三块已实现内部文档登记、writer 所有权、不可变版本集、隔离 heads/CAS/ABA、
精确 merge/checkout、历史/位置/provenance 查询及微任务事件/资源借用。
head 可持有多个固定成员；多文档 commit 现在经 manifest 与整体暂存统一发布。
按用户要求，先于 group 补齐文本存储基础：持久化多路 B+ SumTree、summary/dimension
cursor、chunked rope 已接入实际写入与坐标/快照，并检查结构共享和不变量；
随后已接入 CRDT 全序/可见性 chunk 索引、身份/子树边界定位与 revision delta 物化，
连续 forward run 与观察删除按批更新，native snapshot 共享索引，不再重放整张身份图。
因果闭包/拓扑排序、历史 Map 浅复制和 rope 等值扫描仍需后续性能工作；
不把这些成本掩盖在 rope primitive 的复杂度后面。多文档 group/闭包/域边界及 typed
完整/delta 传递也已接通，包含跨组环与 before 一致性检查、精确缺成员报告和独立差分。
这不是安全 codec 或公共 `createHistoryStore`，尚无 pending 与 pin/
位置导出。用户随后明确要求开放可替换历史后端，已先实现公开产品接入层：
完整 implementation、描述/命名空间、opaque 值、格式/能力协商与生命周期有统一边界；
上层依赖 `HistoryStore/EditingHead`，不依赖 native 类。backend-owned selective-undo
端口不规定内部寄存器算法。默认 group 活性内核现已接通，包括精确 revision generation、
共享代表 tie key、独立删除标签、跨源控制原子性和 no-effect 真实历史；session 栈尚未实现。
外部文本源已支持产品 gap buffer/persistent snapshot，只读布局不要求使用完整历史；
任意兼容 head 也能有界读取到同一接缝。只读 shaping/view 尚只有类型，不冒充 GPU runtime。
codec/defer/retention、Diff 与默认 provider/factory 已按此顺序完成并公开（D13）；
下一项接公开 native undo adapter，再进入 P3/P4。下列整体交付与退出条件中，
pin/导出位置保留、版本化 codec 与缺依赖 reject/defer 已满足；跨进程持久化、
durable ACK 与真实 browser/IME 验收仍未满足。

交付：

- 文档/base/根登记、writer/stream、immutable revisions/snapshots、offset 转换。
- 因果查询、保留历史 materialization、位置解算/转换、provenance。
- 隔离 heads、CAS、同 base 批量事务、精确 pinned merge、checkout。
- 版本化 codec、未知格式/图/引用验证、限额、重复、缺依赖 reject/defer。
- 多文档 group 的完整本地接受/发布与 membership/域检查；pin/导出位置保留。

先失败的测试包括：old snapshot 不变、同内容不同历史、导入不推进 head、源 head 继续编辑不扩张 pinned merge、ABA、非法批次不改变任何文档、损坏包不部分接受、完整历史 round trip、位置删除与历史缺失区分、三副本乱序收敛。

退出条件：G0 不变量通过独立小模型/seeded 测试；不止于两个实例最终字符串相同。公开历史查询和隔离头已可在无浏览器环境真实使用。

## 6. P3：公开选区、undo 与 MultiBuffer

交付：

- selection CRUD/primary/方向/save/restore/事件与 stable ID。
- uniform/per-selection 同一批量接口，exact alias 去重、重叠拒绝、相邻/端点规则。
- 会话本地 group undo/redo 的新因果补偿，选区恢复与 partial/no-effect。
- identified excerpts、一对多源映射、显式边界、只读装饰、重复片段与源更新。
- 单范围跨 excerpt 拒绝，多源多 selection 的本地原子提交与 undo。

先失败的测试包括：反向/重复/caret、删 primary、空集、输入 map 缺多项、远端 merge 不覆盖集合、事件读不到半提交、listener 重入/异常、重复 excerpt 不写两遍、边界两侧、移除 occurrence 的 suspended、任一源失败整组不变。

退出条件：独立 consumer 仅调用公开 API，完成多选区与多源编辑/撤销，不读取 UI 内部状态。

## 7. P4：协作端口与单次 Agent Diff

这是首个 **headless 端到端里程碑**。

### 历史同步与 presence

按同一个 store codec/integration 实现客户端和服务器可调用的 port，不再发明一套接收排序。

测试 transport 由宿主 fixture 驱动：显式 offer/knowledge、未知 peer frontier 补发、重复/乱序/断线重连、缺依赖、格式/base 不兼容、group 越域拒绝、未发布隔离历史不泄露。fixture 中区分 memory accepted 与模拟 durable ACK，不把后者当库保证。

presence 测 source anchors/方向/primary、epoch/sequence、防旧包续命、TTL、断开 remove、unresolved、限额；不修改本地集合或历史。服务器 fixture 不创建 session/GPU，不宣称已构建产品同步服务。

### Diff

测试后实现 `store.diff({change})`、版本集比较、结构化 codec 与 unified formatter。先保证精确范围和可重建性，再做索引/大文件优化。receipt 入口是 Agent 默认路径。

独立测试覆盖插入/删除/替换、多文档、重复 excerpt、空文本/空差异、LF/CRLF/CR-only、缺结尾换行、非 ASCII/grapheme、重复行确定性、取消/输出预算、标签注入、disposed/未知历史。用独立 patch reader 在精确 base 重建 target；这个 reader 是测试 oracle，不变成公共 Git API。

演示必须包含：一个 Agent head 提交 → receipt → 结构化 report/unified 输出；另一个副本收到历史后由产品显式 merge。再加入人工并发，证明区间 Diff 与单次 receipt Diff 不混淆。

退出条件：没有浏览器也能运行该完整流程；可保存/重放精确历史与输出，存在可复现独立测试而非截图。

## 8. P5：增量语法与真实 LSP

交付语言 registry、许可审核的 TS/JS/JSON grammar/query、真正树复用、异步 revision/generation 校验和主题分层。

先失败测试：语法编辑后范围更新、非 ASCII 坐标、复用旧树且旧快照不变、晚到结果不能覆盖新版本、同源重复 excerpt 复用分类。全量正确不证明增量；记录重用与变化范围证据。

LSP 先 protocol fixture，再真实 TypeScript server。测试初始化/能力/full/incremental/none、UTF 编码、batch→顺序变化、源 URI 绑定、请求前 sync、取消/超时/断线、generation、无 version diagnostics、completion edits 与跨文档 WorkspaceEdit 的原子拒绝。

真实服务器操作覆盖 diagnostics、completion、hover、definition、semantic tokens；逐项记录实际 capability 与返回证据。若服务器不提供某能力或无版本 diagnostics，诚实记录约束，不假造结果、不宣告未实现能力。

退出条件：真实源坐标/版本下的 server 工作流通过。浏览器 transport 注入可用，不能依赖浏览器自行 spawn。可选开发桥保持 localhost/白名单。

## 9. P6：字体、真实塑形、vgpu 与输入

先独立验证所选 shaper/font/rasterizer：glyph ID、cluster、advance/offset、caret stops、bidi/grapheme、中文 fallback。默认 Plex 资产来源真实；许可审查后选一个 opt-in 连字字体，不冒名。

连字 on/off 必须有实际 glyph/cluster 与图像变化，源文本/复制值不变；仅 CSS/截图/字符替换不通过。layout 用相同数据做选择几何/hit-test，不逐字符量宽拼接假塑形。

用获选 vgpu 版本本地 docs 实现 atlas/裁剪/viewport/DPR/设备生命周期。真实 browser WebGPU 跑可见区渲染、resize/DPR、滚动、字体加载、device-loss/no-WebGPU、释放；shader 编译不能替代实际帧。

输入测试包括中文 composition、paste、primary IME、撤销归组、组合目标被远端删除、焦点交接和产品自有输入元素。自动事件 fixture 与真实系统输入证据区分；不能只发送 keydown 后声称 IME 通过。

退出条件：真实编辑、选区与 geometry 在 GPU 视图一致，detach 后 headless 继续；未能运行的 OS/浏览器/输入路径明确标记，不虚构通过。

## 10. P7：局部 Diff 片段与 playground

实现 `mountVgpuDiffView`，消费 P4 真 report，复用 P6 layout/GPU 和 P5 分类接口，不复制一份文本模型。截图只决定信息结构，演示内容独立编写。

组件/产品边界：

- 库：局部 hunks、增删/context 行、主题 token、非颜色标记、旧/新源映射、GPU 资源、只读状态。
- playground：文件标签、展开/收起、打开源文件、复制、提交说明、选择 receipt；不把这些产品控件塞进 editor core。
- 不生成思考记录/工具调用模型，不做整套聊天或 review 工作台。

实际交互检查：新增/删除/替换、多个文件/多个 hunk、长行/12 行上限内滚动、行号切换、暗亮主题、focus/reduced motion、plain→syntax 异步更新、旧源删除行的语法上下文、report 固定后源继续编辑、片段激活带正确 side/revision。

playground 用 vanilla TypeScript + Nasti dev server，演示真实多选区、可编辑 MultiBuffer、隔离 head/历史快照、精确 merge、单次 Agent Diff、同步 fixture、真实 LSP 和字体切换；不采用静态图片假交互。

退出条件：真实 browser GPU 截图/操作记录可审查，片段来自实际 receipt；Nasti 仅 dev，不混入生产入口。

## 11. P8：生产构建、consumer 与交付证据

tsdown 输出 ESM/declarations，检查公开 exports、资产 lazy load、tree shaking、headless import 无 DOM/GPU/network side effects。真实包 consumer smoke test 不依赖源码路径别名。

按入口记录产物/gzip、依赖/资产体积和前后基线；G1 先立入口预算与测量方法，不在未选依赖前伪造包体数字。parser/WASM/font 不无条件打进 root，playground/server bridge 不进发布物。

性能测可见区而非仅总耗时：编辑到帧、解析失效范围、glyph/atlas 命中、滚动/DPR、长历史 materialization、并发整合和 dispose 后资源；记录设备、数据集与 cold/warm，不凭主观“流畅”结案。

读屏与键盘导航单列真实验收平台和限制，隐藏 textarea 不算完成；颜色对比、非颜色增删标记、reduced motion 和中文输入均要有证据。

交付记录包含每阶段确切命令/版本/结果/seed、未运行项、限制、依赖来源/许可和与 API 的符合性。当前未授权发布包、push、PR 或合入；即使全测通过也不能代替授权。

## 12. 验证命令约定与当前结果

下面是分阶段建立的**脚本契约**，不是声称当前 manifest 已有所有脚本；`test:browser`、`test:lsp`、`playground:dev` 仍未实现。内部 CLI 参数必须核查锁定版本文档后实现，不凭记忆拼 flags。

```sh
pnpm --version
pnpm install --frozen-lockfile
pnpm test
pnpm test:types
SEED=424242 pnpm test:crdt
pnpm test:browser
pnpm test:lsp
pnpm build
pnpm test:consumer
pnpm playground:dev
```

执行者必须先确认第一条为 12.15.0；`test:lsp` 必须启动/连接真实获选 server，`test:browser` 必须有真实 WebGPU/字体检查，不把 mocks 别名为同一个通过项。需要本机输入/读屏时另外记录手工步骤与平台。运行长期 dev server 时给出明确停止方式，不能无限等待而假称通过。

**原设计线程当时的结果**：只做文档设计/计划和结构、链接、空白检查；未运行以上实现期命令，未新增生产依赖，未编译文档示例。

**续接结果**：已完成 [G0 算法规格](./editor-crdt-design.md) 和可运行规格检查器，并建立 G1 核心/协作/[集成类型](./editor-integration-contracts.md)、Lightning、tsdown 七入口、无 DOM/DOM consumer 与锁定文档签名门禁。下一项为 P2 测试优先实现。完整证据和未完成项见 [实施记录](./editor-progress.md)，不把测试小模型当作生产内核，也不把类型当作已实现的集成。
