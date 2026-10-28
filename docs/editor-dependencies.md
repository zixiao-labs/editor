# 工具与依赖台账

本阶段未新增或升级依赖，manifest 的原有 devDependencies 版本选择和锁文件保持不变。
实际执行：Node 24.15.0、pnpm 12.15.0。`pnpm install --frozen-lockfile` 成功。

| 工具 | 实装版本 | 许可 | 核查依据与用途 |
| --- | --- | --- | --- |
| `@lightning-js/lightning` | 3.1.2 | MIT | 随包 README/package.json、`lightning --help`、`lightning run --help`；runtime/type tests |
| `@nasti-toolchain/nasti` | 2.7.0 | MIT | 随包 manifest、`nasti --help`；未来 playground dev server，不用作生产库构建 |
| `tsdown` | 0.23.2 | MIT | 随包 manifest/CLI、[声明生成文档](https://tsdown.dev/options/dts)；ESM/declarations |
| `typescript` | 7.0.2 | Apache-2.0 | 随包 manifest、`tsc --version`；源与 consumer 类型检查 |
| `tsrs` | 0.18.0-ts7.1.0-dev.20260929 | Apache-2.0 | 保留原 manifest 选择；本阶段不调用 |
| `pnpm` | 12.15.0 | MIT | `pnpm --version`；冻结依赖安装 |

Context7 对 `@lightning-js/lightning` 的检索只返回了电视 UI 的同名 Lightning，
没有使用该不相关结果。改读准确实装 3.1.2 的随包文档与 CLI。
临时 `pnpm dlx ctx7@latest` 的子进程报告 pnpm 12.3.4，不能作为项目检查环境；
上述安装/测试/构建直接由项目 12.15.0 执行。

Lightning 自己带有 Nasti 和 TypeScript 等传递依赖；不改它们来强行统一。
源/产物 consumer 另用项目 TypeScript 7.0.2 检查，不能把 Lightning 内部 typecheck
使用的编译器冒称成项目 tsc。测试工具的传递 Nasti 与项目生产构建边界分开。

## TypeScript 7 的声明生成

首次 tsdown build 明确报错：TypeScript 7 不提供它所需的 classic compiler API。
采用错误提示和官方文档支持的 `isolatedDeclarations` + Oxc 路径，
使用独立 `tsconfig.build.json`，没有降级 TypeScript 或升级 tsdown。
随后 ESM/declarations build 和 `skipLibCheck: false` 的 ES-only consumer 均通过。

## 尚未选定的运行时依赖

生产 bundle 当前无外部运行时依赖。`vgpu`、parser/runtime/grammars/queries、
shaper/rasterizer、IBM Plex Mono 资产、可选连字字体及真实 TypeScript LSP server
尚未安装；不能把公共文档查询当作已安装或已验收。

按实施阶段记录版本、许可、资产来源、运行时/下载体积、文档与能力实测后再添加。
vgpu 依项目 skill：无既定版本才选稳定 latest，然后只按准确实装版本的本地 docs
开发。默认 Plex 不变；可选连字字体只作明确 opt-in，仍需许可审查。

G1 本轮只增加本库的 type-only 集成契约，没有运行第三方适配器。
因此不为查文档而提前选择/安装上述依赖；它们的审查与能力门禁仍在 P5/P6。
tsdown 多入口查询使用 Context7 `/rolldown/tsdown`，并用本地 0.23.2 `--help`
核对 `files`、`--root`、`--dts` 等实际参数；没有使用会重写 exports 的自动生成选项。
直接 `npx ctx7@latest` 被项目的 pnpm devEngines 拒绝，改用临时 `pnpm dlx ctx7@latest`；
它仍报告子进程 pnpm 12.3.4，不作为本项目验证环境。项目安装/构建/测试均为 12.15.0。

P2 源快照/坐标/位置层也未新增依赖，没有 DOM、`TextEncoder` 或 Node API。
测试的独立 UTF-8 对照使用标准 `encodeURIComponent` 编码 Unicode 前缀。
本轮 Context7 查询仍只命中电视 UI 的同名包，继续以本地 Lightning 3.1.2
README/manifest 核查测试用法；没有使用不相关文档，也没有修改项目工具版本。

P2 单文档事务内核仍无新增依赖。为保持同步注册与 ES-only 边界，按
[FIPS 180-4](https://doi.org/10.6028/NIST.FIPS.180-4) 实现同步 SHA-256，
标准向量与独立 Node `crypto` 计算的 framing golden 用于验证。
Node `crypto` 只在独立测试数据生成命令中使用，不进入源码或产物。
本轮 `pnpm dlx ctx7@latest` 已找到正确的 `/zixiao-labs/lightning`，
核查 matcher/run 用法并与本地实装 3.1.2 README 对照；不把索引的 main 当作固定版本。
临时 CLI 子进程仍显示 pnpm 12.3.4，项目门禁直接使用 12.15.0。

## 包体门禁

原 G1 基础入口只有身份/错误运行时；当前 root 增加通用后端接入层，
仍不能代表完整默认 CRDT/Diff 包体。root 不得静态引入 parser/font/WASM/GPU/playground。
为后续 P2–P4 设置 root ESM **128 KiB gzip 报警预算**，超出需说明实测原因及取舍，
不得截断代码。可选入口与资产预算在选择各依赖时建立，不伪造尚无产物的数字。

`pnpm build && pnpm measure:package` 可重测下表。JS 是该入口文件大小；
声明闭包沿产物中的相对 import/re-export 递归去重，gzip 是闭包各文件单独压缩后求和，
不同入口之间共享 chunk 不相加为“总包体”。不依赖不稳定的生成 chunk 名称。

| 入口 | JS bytes / gzip | 声明闭包 bytes / gzip |
| --- | --- | --- |
| root | 28,644 / 6,887 | 32,445 / 8,629 |
| `/collaboration` | 0 / 20 | 27,030 / 7,039 |
| `/languages` | 0 / 20 | 25,900 / 6,712 |
| `/lsp` | 0 / 20 | 29,028 / 7,390 |
| `/shaping` | 0 / 20 | 27,552 / 7,188 |
| `/vgpu` | 0 / 20 | 30,989 / 8,345 |
| `/browser` | 0 / 20 | 27,688 / 7,277 |

对比原 root JS 1,949 / 802，本轮因公开接入层增加 runtime；仍低于 128 KiB gzip 预算。
旧单入口声明与现在共享 chunk 的闭包大小不可直接比较。
空文件 gzip 20 bytes 是压缩格式开销，不是实际适配器。
consumer 检查包含 root gzip 预算与六个子入口无运行时导出的门禁；
产物与 `.context` 不提交。未来实现各适配器时才替换相应零运行时门禁并制定真实预算。

### 此前 P2 阶段记录（非本轮包体结果）

P2 内部源视图及单文档事务内核尚未接入公开入口。此前各轮七入口数值保持
原身份/错误基线，不是坐标/位置/事务实现或完整 P2 运行时的包体测量。

P2 store/head 编排同样没有新增依赖、DOM 或 Node API；microtask 调度使用 ES Promise，
不为调度器引入平台 ambient 类型。内部模块仍未导出，最新七入口测量数值不变，
不能用它衡量新增 store/head 运行时。项目门禁继续由 pnpm 12.15.0 执行。

Rope/SumTree 同样无新增依赖。用户指定的公开文章
[Zed Decoded: Rope & SumTree](https://zed.dev/blog/zed-decoded-rope-sumtree)
用作数据结构设计输入，未跟进其仓库/测试/视频或搬运文中 Rust 实现。
多路 B+ tree、chunked rope 与 Unicode helper 均为本库 TypeScript 代码；
JS GC/WeakRef 不等同于 Rust Arc 或线程间零复制。内部模块未入公开入口，
七入口测量仍不衡量这些新增内部实现，详见 [存储设计](./editor-storage-design.md)。

CRDT chunk 索引/身份定位/delta 物化继续复用该 B+ SumTree，没有新增依赖或平台 API。
持久 ordered map 同样由现有树实现；本地 WeakMap object locators 不是持久 CRDT IDs。
公共 exports/manifest/lock 未改，本轮重测的七入口数值仍与上表相同；这不是完整 CRDT
运行时体积或大历史时间/空间验收。

多文档 group 复用现有同步 SHA-256/规范 JSON、持久 history roots 和 ES Map/WeakMap；
无新增依赖、Node/DOM API 或网络实现。typed bundle 不是公开 wire codec，
counter plan 不使用额外随机流。内部模块仍未入包，七入口体积不代表这些新增运行时；
见 [group 设计](./editor-transaction-groups.md)。

### 可替换后端接入

公开 `defineHistoryBackend`/context SDK/facade 没有新增依赖或 Node/DOM API，
不导入 native CRDT/rope/SumTree。`package.json` 只扩展 type fixture 命令，
dependency、lock 与七入口 export map 未改；root 的 runtime 导出按用户确认扩展。
上表是这轮重新 build/measure 的结果，不含完整默认内核。

consumer 门禁发现旧 regex 将错误字符串末尾的 `import"` 当成 JS 依赖；
现在用 Node VM module parser 检查静态 import/re-export 并带真实依赖负对照，
继续禁止 dynamic loading，另检查无 native 内核 markers。
`--experimental-vm-modules` 仅用于 consumer 测试子进程的语法解析，可能输出
ExperimentalWarning；不是生产库或产品运行时要求，生产 Node ESM smoke 不带该 flag。
