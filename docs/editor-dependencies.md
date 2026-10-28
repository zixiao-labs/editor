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

## 包体门禁

当前 G1 基础入口基线由 `pnpm build` 输出测量；它只有身份/错误运行时，
不能代表未来完整 CRDT/Diff 包体。root 不得静态引入 parser/font/WASM/GPU/playground。
为后续 P2–P4 设置 root ESM **128 KiB gzip 报警预算**，超出需说明实测原因及取舍，
不得截断代码。可选入口与资产预算在选择各依赖时建立，不伪造尚无产物的数字。

`pnpm build && pnpm measure:package` 可重测下表。JS 是该入口文件大小；
声明闭包沿产物中的相对 import/re-export 递归去重，gzip 是闭包各文件单独压缩后求和，
不同入口之间共享 chunk 不相加为“总包体”。不依赖不稳定的生成 chunk 名称。

| 入口 | JS bytes / gzip | 声明闭包 bytes / gzip |
| --- | --- | --- |
| root | 1,949 / 802 | 26,947 / 7,123 |
| `/collaboration` | 0 / 20 | 23,051 / 6,000 |
| `/languages` | 0 / 20 | 21,925 / 5,676 |
| `/lsp` | 0 / 20 | 25,053 / 6,355 |
| `/shaping` | 0 / 20 | 23,577 / 6,153 |
| `/vgpu` | 0 / 20 | 27,014 / 7,308 |
| `/browser` | 0 / 20 | 23,713 / 6,242 |

对比上一轮 root JS 仍是 1,949 / 802，未增加运行时；
上一轮单入口声明 21,278 / 4,839 与现在拆分后的入口文件大小不可直接比较。
空文件 gzip 20 bytes 是压缩格式开销，不是实际适配器。
consumer 检查包含 root gzip 预算与六个子入口无运行时导出的门禁；
产物与 `.context` 不提交。未来实现各适配器时才替换相应零运行时门禁并制定真实预算。

P2 内部源视图尚未接入公开入口。本轮重新 build/测量的七入口数值与上表一致，
不是新坐标/位置实现或完整 P2 运行时的包体测量。
