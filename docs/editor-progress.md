# Editor 实施记录

## 当前结论

原线程的下一项 **G0 算法规格与独立验证设计已完成**，并建立可运行的规格检查器；
本轮补齐 **G1 核心/协作/集成公共类型、工具与七入口门禁**，可进入 P2。
尚未选择/安装的集成运行时依赖仍需在 P5/P6 审查；这不是可用编辑器交付。
生产 CRDT 与 P2–P8 没有实现，不能把规格模型当运行时或把类型当可调用工厂。

上一轮基线：用户恢复四份原设计文档后的 `b688a6e84f3a98d4ea51aaaa57288aa9462436ba`。
本轮基线：用户拉取恢复上一轮交付后的 `da2d9f58708649bb7b50c1a5647e6eb2281f32c2`。
Workflow 仍为 `maintainer-original`，仅 editor；没有读取参考实现、其他研究线程/
目录或其他 worktree。原设计线程是用户明确指定的继续工作来源，不从其外获取算法。
单执行者；未启动子代理、未使用上游专属 Subharness/计费配置。

| 阶段 | 状态 | 证据/剩余 |
| --- | --- | --- |
| G0 | 完成规格与独立验证设计 | `editor-crdt-design.md`、规格模型、枚举 oracle、负对照；不是形式化证明 |
| G1 核心/协作 | 骨架和工具门禁通过 | branded IDs、head/session checkpoints、receipt/Diff、selection/projection、协作端口类型；仅身份/错误有运行时 |
| G1 集成类型 | 本轮契约/入口门禁通过 | 语言/LSP/shaping/vgpu/browser、六个 type-only 子入口、无 DOM/DOM consumer、12 个规范代码块与负对照；运行时依赖审查仍留给安装阶段 |
| P2 | 未开始 | 生产历史内核与安全 codec、原子多文档 group、真实历史/位置/heads 验收 |
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

## 本轮变更：G1 集成契约与入口隔离

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

### 本轮实际验证

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

## 下一项

按 G0 规格测试优先实现 P2：不可变源快照/坐标、原生历史、隔离 heads/CAS、
精确 merge/checkout、安全 codec 与本地原子 group。
核心与集成分别保持无 DOM/DOM 的声明边界；P2 的生产实现必须与规格模型和独立
oracle 差分，不能把 `tests/crdt/support` 移到生产或以两份同算法输出相等结案。
如果算法扩展或依赖能力发现与锁定 API 的真实冲突，再具体报告，不泛泛等待“继续”。
