# Zenfun Code v2.1.88

> Claude Code 的重建工程，目标是：能编译、能运行、尽量全功能。  
> 名字叫 `Zenfun Code`，因为我们认真搞工程，也要留一点幽默感。
>
> 默认策略：**feature flag 全开（排除极少数明显不适用项）**。

仓库：`https://github.com/w31r4/zenfun-code.git`

## 先记住这一条（默认全开）

- 编译期 `feature('...')`：默认全开
- 运行期 GrowthBook 布尔 gate：默认全开
- 只有少数明确排除项不会强开

快速验证：

```bash
cd cc-v2.1.88-full
bun run build.ts
# 你会看到类似：
# Feature gates: enabled 84, excluded 6
```

## 3 分钟上手

```bash
git clone https://github.com/w31r4/zenfun-code.git
cd zenfun-code
bun run setup
bun run build
bun run start
```

看到交互提示符 `❯` 就是启动成功（它在等你输入，不是卡死）。

## 目录入口

- `cc-v2.1.88-full`：主工程目录（开发、构建、运行都在这里）
- `cc-v2.1.88`：参考目录（保留上游结构）

## 我实际跑过的可用性测试

在 `cc-v2.1.88-full` 已通过：

```bash
bun run build.ts
bash scripts/run-claude-local.sh --version
bash scripts/run-claude-local.sh --help
bash scripts/run-claude-local.sh auth status
node dist/cli.js --version
```

说明：并行执行 `build.ts` 和 `node dist/cli.js` 时，可能短暂出现 `ERR_MODULE_NOT_FOUND`（因为构建会先删除旧 `dist/cli.js`），串行执行即可。

## 全开策略（默认）

本仓库当前是“完整优先”策略：

- 编译期 `feature('...')`：自动扫描源码并默认开启（不是手工白名单）
- 仅排除明显不适用的 6 个开关：  
  `ABLATION_BASELINE`、`ALLOW_TEST_VERSIONS`、`HARD_FAIL`、`OVERFLOW_TEST_TOOL`、`IS_LIBC_GLIBC`、`IS_LIBC_MUSL`
- 运行期 GrowthBook 布尔 gate：默认强制开启（`CLAUDE_CODE_ENABLE_ALL_GATES` 默认等价于开启）

可手动控制：

```bash
# 关闭全开
CLAUDE_CODE_ENABLE_ALL_GATES=0 bash scripts/run-claude-local.sh

# 排除指定 gate（逗号分隔）
CLAUDE_CODE_ENABLE_ALL_GATES_EXCLUDE=tengu_xxx,tengu_yyy bash scripts/run-claude-local.sh

# 精确覆写某些 gate/config
CLAUDE_CODE_GB_OVERRIDES='{"tengu_ccr_bridge":false}' bash scripts/run-claude-local.sh
```

## 打包分发

```bash
# 远程安装依赖模式（产物更小）
bun run pack

# 本地内置依赖模式（产物更大，但开箱即跑）
bun run pack:vendor
```

默认输出目录：`cc-v2.1.88-full/release/cc-v2.1.88`

远程模式测试：

```bash
cd cc-v2.1.88-full/release/cc-v2.1.88
./install-runtime.sh
node cli.js --version
```

Vendor 模式测试：

```bash
cd cc-v2.1.88-full/release/cc-v2.1.88
node cli.js --version
```

## 常见问题（短版）

1. `--localstorage-file was provided without a valid path`

```bash
unset NODE_OPTIONS
mkdir -p ~/.cache/node
node --localstorage-file="$HOME/.cache/node/localstorage.json" cc-v2.1.88-full/dist/cli.js
```

2. 启动后“没反应”  
大多数情况是已经进入交互模式，正在等待你输入。

## 现实边界（必须说明）

- 本地“全开”不等于服务端“全授权”。  
  订阅、OAuth scope、组织资格、远端策略这些仍由服务端决定。
- 这是一套可开发/可部署的重建工程，不是 Anthropic 内部发布流水线的 1:1 复制品。
