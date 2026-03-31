# zenfun-code / Claude Code v2.1.88 Rebuild

这个仓库包含 Claude Code 2.1.88 的可构建工程整理版本。

## 目录说明

- `cc-v2.1.88-full`：推荐使用，完整源码目录（含 `vendor/`），可直接安装依赖、编译、运行。
- `cc-v2.1.88-build`：早期修复与验证目录，用于恢复/调试构建链路。
- `cc-v2.1.88`：原始参考目录（上游 README 等）。
- `docs/`：分析文档。

## `full` 和 `build` 现在有什么区别

目前两者都能编译运行，构建脚本和关键修复已经对齐。主要差别：

- `cc-v2.1.88-full` 多了 `vendor/`，信息更完整，建议作为主目录继续开发。
- `cc-v2.1.88-build` 保留了历史修复过程，适合对照排障，不建议作为团队默认入口。

团队统一入口建议：**只使用 `cc-v2.1.88-full`**。

## 环境要求

- Bun `1.3+`
- Node.js `18+`（建议 20+）
- macOS / Linux

## 快速开始（推荐）

```bash
cd cc-v2.1.88-full
bun install
bun run build.ts
mkdir -p ~/.cache/node
node --localstorage-file="$HOME/.cache/node/localstorage.json" dist/cli.js
```

如果你看到 CLI 界面和 `❯` 输入提示，说明启动成功（它在等待交互输入，不是卡住）。

## 调试启动

```bash
cd cc-v2.1.88-full
mkdir -p ~/.cache/node
node --localstorage-file="$HOME/.cache/node/localstorage.json" dist/cli.js --debug-file /tmp/cc-run.log
tail -n 120 /tmp/cc-run.log
```

## 常见问题

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
cd cc-v2.1.88-full && bun install && bun run build.ts && mkdir -p ~/.cache/node && node --localstorage-file="$HOME/.cache/node/localstorage.json" dist/cli.js
```

