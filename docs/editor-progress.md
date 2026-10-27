# Editor 实施记录

## 当前结论

原线程的下一项 **G0 算法规格与独立验证设计已完成**，并建立可运行的规格检查器；
G1 已完成核心/协作类型骨架与工具/ES-only 构建门禁，**仍非整个 G1 或编辑器交付**。
生产 CRDT 与 P2–P8 没有实现，不能把规格模型当运行时或把类型当可调用工厂。

基线：用户恢复四份原设计文档后的 `b688a6e84f3a98d4ea51aaaa57288aa9462436ba`。
Workflow 仍为 `maintainer-original`，仅 editor；没有读取参考实现、其他研究线程/
目录或其他 worktree。原设计线程是用户明确指定的继续工作来源，不从其外获取算法。
单执行者；未启动子代理、未使用上游专属 Subharness/计费配置。

| 阶段 | 状态 | 证据/剩余 |
| --- | --- | --- |
| G0 | 完成规格与独立验证设计 | `editor-crdt-design.md`、规格模型、枚举 oracle、负对照；不是形式化证明 |
| G1 核心/协作 | 骨架和工具门禁通过 | branded IDs、head/session checkpoints、receipt/Diff、selection/projection、协作端口类型；仅身份/错误有运行时 |
| G1 集成类型 | 待完成 | 语言/LSP/shaping/vgpu/browser 的完整辅助类型及示例类型契约；可选入口声明/依赖审查 |
| P2 | 未开始 | 生产历史内核与安全 codec、原子多文档 group、真实历史/位置/heads 验收 |
| P3/P4 | 未开始 | session/undo/MultiBuffer、同步/presence、结构化与 unified Agent Diff |
| P5–P8 | 未开始 | 增量语法/真实 LSP、字体与 vgpu、输入/读屏、Diff view/playground、完整交付 |

## 本次变更

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

## 实际验证

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

## 下一项

完成 G1 的集成入口/辅助类型与文档示例门禁，再按 G0 规格测试优先实现 P2。
核心与集成分别保持无 DOM/DOM 的声明边界；P2 的生产实现必须与规格模型和独立
oracle 差分，不能把 `tests/crdt/support` 移到生产或以两份同算法输出相等结案。
如果算法扩展或依赖能力发现与锁定 API 的真实冲突，再具体报告，不泛泛等待“继续”。
