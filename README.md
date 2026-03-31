# zenfun-code / Claude Code v2.1.88 Rebuild

这个仓库包含 Claude Code 2.1.88 的可构建工程整理版本。

仓库地址：`https://github.com/w31r4/zenfun-code.git`

```bash
git clone https://github.com/w31r4/zenfun-code.git
cd zenfun-code
```

## 目录说明

- `cc-v2.1.88-full`：主工程目录（含 `vendor/`），可直接安装依赖、编译、运行。
- `cc-v2.1.88`：原始参考目录（上游 README 等）。
- `docs/`：分析文档。

当前仓库已收敛到 `cc-v2.1.88-full` 单一入口进行开发与运行。

## 当前补齐状态（2026-03-31）

在 `cc-v2.1.88-full` 中，当前构建结果已经达到：

- `stubbedModuleCount = 0`（不再依赖缺失源码的构建 stub）
- `runtimeExternalImportCount = 4`（仅保留 `zod` 相关 external）
- `unexpectedRuntimeExternalImportCount = 0`（严格校验通过）

可用以下命令自检：

```bash
cd cc-v2.1.88-full
CC_STRICT_PARITY=1 bun run build.ts
cat dist/parity-report.json
```

说明：`STRICT_PARITY` 现在检查“是否有 stub 或未声明 external”。声明在 `build.ts` 的 external（当前主要是 `zod`）不算失败。

## 为什么还不是官方发布目录那种“单文件零依赖”

相对 `cc-v2.1.88` 官方发布目录，当前重建版本仍有两点现实差异：

- 官方包是 Anthropic 内部发布链路产物；本仓库使用 Bun 重建链路，行为不完全等价。
- 在当前 Bun 行为下，`zod` 全量内联会触发运行期符号丢失（如 `_gte3`），因此保留 `zod` external 以确保可运行。

## 环境要求

- Bun `1.3+`
- Node.js `18+`（建议 20+）
- macOS / Linux

## 快速开始（仓库根目录）

```bash
bun run setup
bun run build
bun run start
```

如果你看到 CLI 界面和 `❯` 输入提示，说明启动成功（它在等待交互输入，不是卡住）。

等价的子目录命令是：

```bash
cd cc-v2.1.88-full
bun install
bun run build
bun run start
```

## 调试启动

```bash
cd cc-v2.1.88-full
bun run start -- --debug-file /tmp/cc-run.log
tail -n 120 /tmp/cc-run.log
```

## 生成“官方目录布局”产物（可分发）

```bash
cd cc-v2.1.88-full
bun run build.ts
bun run pack:official-like
```

默认输出到 `cc-v2.1.88-full/release/cc-v2.1.88`，目录形态与官方包接近（`cli.js`、`package.json`、`README.md`、`LICENSE.md`）。

默认是**远程安装模式**（不打包本地 `node_modules`），产物内带 `install-runtime.sh`：

```bash
cd cc-v2.1.88-full/release/cc-v2.1.88
./install-runtime.sh
node cli.js --version
```

`install-runtime.sh` 会安装运行必需依赖（包含 `zod` 与 `@anthropic-ai/sandbox-runtime`）。

如果你要打成本地全内置版本（包含已安装的 runtime externals），用：

```bash
cd cc-v2.1.88-full
bun run pack:official-like:vendor
```

## 仍然无法“1:1 复制官方发布包”的部分

- 官方 npm 包由内部发布流水线生成，包含内部构建细节；本仓库是外部重建链路。
- 当前 Bun 对 `zod` 全量内联仍存在运行期符号丢失问题（如 `_gte3`），所以在构建阶段保留 `zod` external；远程安装模式依赖 `install-runtime.sh` 拉取该依赖，vendor 模式则会内置。
- `sandbox-runtime` 代码与依赖可随项目一起分发，但其底层隔离能力仍依赖目标机器平台与系统组件（例如 Linux 下的相关隔离工具）。
- 某些边缘集成（如你日志里 `pencil` MCP）依赖本机额外扩展/二进制文件路径，不属于源码缺失问题。

## 常见问题

### 0) sandbox 是不是必须？

不是启动必须项。默认行为是：sandbox 不可用时给出告警并继续运行；只有显式配置 `sandbox.failIfUnavailable=true` 才会拒绝启动。

### 1) `Warning: --localstorage-file was provided without a valid path`

原因：Node 运行时读取 localStorage 配置路径无效（常见于 `NODE_OPTIONS` 残留）。

处理：

```bash
unset NODE_OPTIONS
mkdir -p ~/.cache/node
node --localstorage-file="$HOME/.cache/node/localstorage.json" dist/cli.js
```

### 2) `trimEnd is not a function`

已在源码修复（`ultraplan` 的 prompt 加载做了字符串兜底）。如再次出现，先确认你在最新代码上重新执行了：

```bash
bun run build.ts
```

### 3) 启动后“没反应”

多数情况不是崩溃，而是已进入交互模式等待输入。确认终端里是否出现 `❯` 提示符。

## 一键验证命令（给新人）

```bash
bun run setup && bun run build && bun run start
```
