# Subagent 权限管理：Claude Code 逆向分析 vs Enter CLI 现状

> 基于 `cli.beautified.js` (v2.1.85) 逆向 + `agent/subagent.go` 源码对比
>
> **核心发现**：Claude Code 的 subagent 权限行为取决于**前台/后台模式**——后台 subagent 静默将 `ask` 转为 `deny`，前台 subagent 将权限提示冒泡到父级 TUI。Enter CLI 当前设计：只读 subagent 跳过权限检查，非只读 subagent 继承父级 TUI Checker。

---

## 目录

1. [前台 vs 后台 Subagent](#1-前台-vs-后台-subagent)
2. [Claude Code 的 Subagent 权限架构](#2-claude-code-的-subagent-权限架构)
3. [内置 Agent 的权限配置](#3-内置-agent-的权限配置)
4. [shouldAvoidPermissionPrompts 的决策流](#4-shouldavoidpermissionprompts-的决策流)
5. [父模式如何影响子 Agent](#5-父模式如何影响子-agent)
6. [Enter CLI 当前权限模型](#6-enter-cli-当前权限模型)
7. [CC vs Enter CLI 对比](#7-cc-vs-enter-cli-对比)
8. [设计差异的影响分析](#8-设计差异的影响分析)
9. [附录：Bundle 源码定位](#附录bundle-源码定位)

---

## 1. 前台 vs 后台 Subagent

Claude Code 的 Agent 工具有一个 `run_in_background` 参数，决定 subagent 是前台还是后台运行。这个区别是权限行为差异的**根本原因**。

### 1.1 什么是前台/后台

| 维度 | 前台 (foreground) | 后台 (background) |
|------|-------------------|-------------------|
| **触发方式** | `run_in_background` 省略或为 `false` | `run_in_background: true`，或 agent 定义中 `background: true` |
| **父 agent 行为** | 阻塞等待子 agent 完成 | 继续执行其他工作，完成后收到通知 |
| **AbortController** | 共享父级的 AbortController | 创建独立的 AbortController |
| **权限弹窗** | 可以冒泡到父级 TUI | 无法冒泡（没有人在等待 UI 交互） |
| **shouldAvoidPrompts** | **否** | **是** |

### 1.2 谁决定前台/后台

`run_in_background` 是 Agent 工具 schema 中的一个**可选布尔参数**，由**模型的 tool_use 响应**决定。

**Agent 工具的完整 input schema**（从 scribe trace 中提取）：

```jsonc
{
  "properties": {
    "description":      { "type": "string" },             // required
    "prompt":           { "type": "string" },             // required
    "subagent_type":    { "type": "string" },             // optional — 选择 agent 类型
    "run_in_background": { "type": "boolean" },           // optional — 前台/后台开关
    "model":            { "enum": ["sonnet","opus","haiku"] }, // optional
    "isolation":        { "enum": ["worktree"] }          // optional
  },
  "required": ["description", "prompt"]
}
```

**实际 trace 验证**（当前会话的 primary agent 响应）：

```jsonc
// 模型返回的 tool_use block — 没有 run_in_background 字段 → 前台
{
  "name": "Agent",
  "id": "toolu_01Ke8vJ2jEbUkgcRd9U7FaSv",
  "input": {
    "description": "Explore tool definitions and provider",
    "subagent_type": "Explore",
    "prompt": "I need to understand how tools are defined..."
    // 注意：没有 run_in_background → 默认前台
  }
}
```

**决策链**：模型生成 tool_use → Claude Code 解析 input → 读取 `run_in_background` 字段 → 计算 `isAsync`：

```javascript
// 语义还原
const isAsync = (
  input.run_in_background === true ||   // 模型在 tool_use 中设置
  agentDefinition.background === true   // 或 agent 定义中声明
) && !isTeammateMode;
```

> `isTeammateMode` 是实验性的 Agent Teams 功能标志，通常为 `false`。

### 1.3 何时产生前后台区别

- **模型在 tool_use 中设置** `run_in_background: true` → 后台（模型根据系统提示词中的指导自行决策）
- **Agent 定义中声明** `background: true` → 后台（目前内置 agent 均未设置此字段）
- **默认情况**（包括 Explore、Plan、general-purpose）→ **前台**

系统提示词中对模型的指导：
> "Use foreground (default) when you need the agent's results before you can proceed — e.g., research agents whose findings inform your next steps. Use background when you have genuinely independent work to do in parallel."

### 1.4 Scribe Trace 实证：`run_in_background` 实际使用情况

通过 scribe 对 20 个 Claude Code session（共数千次 API 请求）的全量扫描，仅在 1 个 session 中发现模型返回了 `run_in_background: true`。

**唯一的后台调用实例** — Session `019d24b3ba86`（2026-03-25）：

| 字段 | 值 |
|------|---|
| 用户 prompt | `请你用多个subagent打印helloworld` |
| 模型决策 | 3 个 Agent tool_use，全部 `run_in_background: true` |
| agent 类型 | `general-purpose` |
| 权限模式 | `acceptEdits`（父级） |
| 结果 | 3 个 agent 并行执行，约 8 秒完成（串行需 ~24 秒） |

```jsonc
// 模型的 tool_use 响应（3 个中的第 1 个）
{
  "name": "Agent",
  "id": "call_function_yatznupr113r_1",
  "input": {
    "description": "Print Hello World 1",
    "prompt": "Print \"Hello World 1\" to stdout using the Bash tool. Simply run: echo \"Hello World 1\"",
    "subagent_type": "general-purpose",
    "run_in_background": true    // ← 模型主动设置
  }
}
```

**所有其他 session 的 Agent tool_use 均未设置 `run_in_background`**，汇总如下：

| Session | 日期 | Agent 调用次数 | `run_in_background` | 说明 |
|---------|------|-------------|---------------------|------|
| `019d42e7dc07` | 03-31 | 2 | 均未设置（前台） | Explore 分析 tool 定义和 streaming |
| `019d4252dd1b` | 03-31 | 多次 | 均未设置（前台） | 工具对齐任务（文本中讨论了该字段，但 tool_use 中未使用） |
| `019d4209b6aa` | 03-31 | 多次 | 均未设置（前台） | 权限系统调研 |
| `019d2e3e8bae` | 03-27 | 多次 | 均未设置（前台） | 代码探索 |
| `019d2a121bfe` | 03-26 | 多次 | 均未设置（前台） | 功能开发 |
| `019d283ff76b` | 03-26 | 多次 | 均未设置（前台） | 架构分析（文本中提及，tool_use 未使用） |
| `019d240b0eb1` | 03-25 | 多次 | 均未设置（前台） | 工具并行研究（文本中讨论，tool_use 未使用） |
| **`019d24b3ba86`** | **03-25** | **3** | **全部 `true`（后台）** | **用户明确要求并行打印 Hello World** |

> [!NOTE]
> **结论**：`run_in_background: true` 是极低频事件。模型仅在任务明确要求"多个独立 agent 并行执行、且不需要等待结果"时才会设置。日常的 Explore、Plan、general-purpose 调用**全部是前台**——模型需要等待结果才能继续回复用户。

---

## 2. Claude Code 的 Subagent 权限架构

Claude Code 的 subagent 权限管理有**两层控制机制**，独立于 Primary agent 的 6 种权限模式（default / acceptEdits / bypassPermissions / dontAsk / plan / auto）。

### 2.1 第一层：Agent 定义级 `permissionMode`

每个 agent 定义可以声明自己的 `permissionMode` 字段：

```javascript
// claude-code-guide agent — 明确设为 dontAsk
{
  agentType: "claude-code-guide",
  permissionMode: "dontAsk",
  tools: [Glob, Grep, Read, WebFetch, WebSearch],
  model: "haiku",
}

// fork agent — 特殊的 bubble 模式
{
  agentType: "fork",
  permissionMode: "bubble",
  tools: ["*"],
  model: "inherit",
}

// Explore agent — 注意：没有 permissionMode
{
  agentType: "Explore",
  // permissionMode 未定义
  disallowedTools: [Agent, ExitPlanMode, Edit, Write, NotebookEdit],
  model: "haiku",
}

// Plan agent — 同样没有 permissionMode
{
  agentType: "Plan",
  // permissionMode 未定义
  disallowedTools: [Agent, ExitPlanMode, Edit, Write, NotebookEdit],
  model: "inherit",
}
```

### 2.2 第二层：`shouldAvoidPermissionPrompts` 标志

这是运行时标志，直接影响权限决策流。当 `shouldAvoidPermissionPrompts === true` 时，规则引擎的 `ask` 结果会被**静默转换为 `deny`**。

**关键：该标志仅在 `startSubAgent()` 中设置，且仅对后台 subagent 生效。**

`startSubAgent()` 为每个 subagent 创建一个 `getAppState` 闭包，其中包含权限上下文的计算逻辑：

```javascript
// startSubAgent() 内部的 getAppState 闭包（语义还原）
function subagentGetAppState() {
  const parentState = parentContext.getAppState();
  let permContext = parentState.toolPermissionContext;

  // 1. 如果 agent 定义有 permissionMode，且父级不在豁免列表中 → 使用定义的 mode
  if (agentDef.permissionMode
      && permContext.mode !== "bypassPermissions"
      && permContext.mode !== "acceptEdits"
      && permContext.mode !== "auto") {
    permContext = { ...permContext, mode: agentDef.permissionMode };
  }

  // 2. 计算是否应该避免权限弹窗
  const shouldAvoid =
    canShowPermissionPrompts !== undefined
      ? !canShowPermissionPrompts           // 显式传入时取反
      : agentDef.permissionMode === "bubble"
        ? false                             // bubble 模式永不设置
        : isAsync;                          // ← 关键：取决于前台/后台

  if (shouldAvoid) {
    permContext = { ...permContext, shouldAvoidPermissionPrompts: true };
  }

  return { ...parentState, toolPermissionContext: permContext };
}
```

> [!IMPORTANT]
> **`shouldAvoidPermissionPrompts` 的唯一决定因素是 `isAsync`**（对于内置 agent 而言）。
>
> - Explore/Plan 没有 `permissionMode`，`canShowPermissionPrompts` 也未传入
> - 所以 `shouldAvoid = isAsync`
> - **前台 Explore** → `isAsync = false` → `shouldAvoid = false` → **权限弹窗会冒泡到父级 TUI**
> - **后台 Explore** → `isAsync = true` → `shouldAvoid = true` → **ask 静默转 deny**

### 2.3 ~~`createToolContext()` 的兜底注入~~（已证伪）

之前的分析认为 `createToolContext()`（通用 subagent 上下文工厂）会兜底注入 `shouldAvoidPermissionPrompts: true`。实际上：

```javascript
// createToolContext() 的 getAppState 选择逻辑（语义还原）
const getAppState =
  childConfig.getAppState               // ← 如果传了自定义 getAppState，直接用
    ? childConfig.getAppState
    : childConfig.shareAbortController   // ← 共享 AbortController 时用父级的
      ? parentContext.getAppState
      : () => {                          // ← 默认路径：注入 shouldAvoid
          const state = parentContext.getAppState();
          if (state.toolPermissionContext.shouldAvoidPermissionPrompts) return state;
          return {
            ...state,
            toolPermissionContext: {
              ...state.toolPermissionContext,
              shouldAvoidPermissionPrompts: true,
            },
          };
        };
```

**`startSubAgent()` 总是传入自定义 `getAppState`**（上面 2.2 节的闭包），所以 `createToolContext()` 走第一个分支，兜底注入**永远不会执行**。

`createToolContext()` 的兜底逻辑只对不经过 `startSubAgent()` 的场景生效（如内部直接创建的工具上下文），与用户可见的 Agent 工具无关。

---

## 3. 内置 Agent 的权限配置

| Agent 类型 | `permissionMode` | 前台 shouldAvoid | 后台 shouldAvoid | 工具限制 | 前台权限效果 | 后台权限效果 |
|-----------|-----------------|-----------------|-----------------|---------|-----------|-----------|
| **Explore** | _(无)_ | `false` | `true` | 无 Write/Edit/Agent | **ask 冒泡到 TUI** | ask→deny |
| **Plan** | _(无)_ | `false` | `true` | 无 Write/Edit/Agent | **ask 冒泡到 TUI** | ask→deny |
| **general-purpose** | _(无)_ | `false` | `true` | 无 Agent | **ask 冒泡到 TUI** | ask→deny |
| **claude-code-guide** | `"dontAsk"` | `false` | `true` | Glob/Grep/Read/WebFetch/WebSearch | mode=dontAsk → ask→deny | ask→deny |
| **fork** | `"bubble"` | `false` | `false` (特殊) | `["*"]` 全部工具 | **ask 冒泡到 TUI** | **ask 冒泡到 TUI** |
| **statusline-setup** | _(无)_ | `false` | `true` | Read/Edit only | **ask 冒泡到 TUI** | ask→deny |

### 关键观察

1. **Explore/Plan 的只读保障是两层，不是三层**：
   - 工具黑名单（无 Write/Edit）
   - 系统提示词（"READ-ONLY MODE"）
   - ~~`shouldAvoidPermissionPrompts: true`~~ ← 仅后台模式生效

2. **前台 Explore 可以弹窗**：
   - WebSearch 的 `checkPermissions` 返回 `passthrough` → 转为 `ask`
   - 如果没有 allow 规则 → 弹窗等待用户确认
   - **这就是为什么你会收到 Explore subagent 的 WebSearch 权限请求**

3. **claude-code-guide 是个例外**：
   - 它有 `permissionMode: "dontAsk"`，不依赖 `shouldAvoidPermissionPrompts`
   - 在 `dontAsk` 模式下，`ask` 直接转 `deny`，无论前台/后台

4. **fork 是唯一永远能弹窗的 subagent**：
   - `permissionMode: "bubble"` 使 `shouldAvoid` 始终为 `false`
   - 即使后台运行也不会静默拒绝

---

## 4. shouldAvoidPermissionPrompts 的决策流

当某个 subagent 的工具调用触发权限检查，且最终结果为 `ask` 时：

```
规则引擎返回 ask
  │
  ├─ mode = "dontAsk"
  │    └─ ❌ deny（dontAsk 直接拒绝）
  │
  ├─ mode = "auto"
  │    ├─ safetyCheck 失败 + shouldAvoid=true → ❌ deny
  │    ├─ safetyCheck 失败 + shouldAvoid=false → ❔ 弹窗
  │    ├─ LLM 分类器判定安全 → ✅ allow
  │    ├─ LLM 分类器判定危险 + shouldAvoid=true → ❌ deny (或熔断 abort)
  │    └─ LLM 分类器判定危险 + shouldAvoid=false → ❔ 弹窗
  │
  ├─ mode = "default" 或其他
  │    ├─ shouldAvoid=true → ❌ deny（静默拒绝）
  │    └─ shouldAvoid=false → ❔ 弹窗（等待用户确认）  ← 前台 Explore 走这条路
  │
  └─ mode = "bypassPermissions"
       └─ 根本不会产生 ask（所有都直接 allow）
```

### 熔断机制

当 subagent 在 auto 模式下被分类器连续拒绝时：

```javascript
// 语义还原
if (totalDenials >= maxTotal || consecutiveDenials >= maxConsecutive) {
  if (shouldAvoidPermissionPrompts) {
    // 后台 subagent：直接 abort 整个 subagent
    throw new AbortError("Agent aborted: too many classifier denials in headless mode");
  }
  // 前台/Primary：降级到 default 模式（恢复弹窗）
}
```

---

## 5. 父模式如何影响子 Agent

`startSubAgent()` 中有一段关键的模式继承逻辑：

```javascript
// 语义还原
if (agentDef.permissionMode
    && parentMode !== "bypassPermissions"
    && parentMode !== "acceptEdits"
    && parentMode !== "auto") {
  // 使用 agent 定义的 mode
  childMode = agentDef.permissionMode;
} else {
  // 继承父级当前模式
  childMode = parentMode;
}
```

翻译成表格：

| 父级模式 | Agent 定义 mode | 子 Agent 实际 mode | 原因 |
|---------|----------------|-------------------|------|
| `default` | `dontAsk` | `dontAsk` | 父级不在豁免列表中，使用 agent 定义 |
| `default` | _(无)_ | `default` | 无覆盖，继承父级 |
| `acceptEdits` | `dontAsk` | `acceptEdits` | 父级在豁免列表中，忽略 agent 定义 |
| `bypassPermissions` | `dontAsk` | `bypassPermissions` | 父级在豁免列表中，忽略 agent 定义 |
| `auto` | `dontAsk` | `auto` | 父级在豁免列表中，忽略 agent 定义 |
| `default` | `bubble` | `bubble` | 父级不在豁免列表中，使用 agent 定义 |
| `bypassPermissions` | `bubble` | `bypassPermissions` | 父级在豁免列表中，忽略 agent 定义 |

> [!IMPORTANT]
> **`bypassPermissions` 是可传染的**——一旦父级在 bypass 模式，所有子 agent（包括 claude-code-guide 这种原本 dontAsk 的安全 agent）都继承 bypass 权限。

---

## 6. Enter CLI 当前权限模型

### 6.1 Permission Checker 接口

```go
// permission/permission.go
type Checker interface {
    Check(ctx context.Context, req Request) (bool, error)
}
```

Enter CLI 的权限检查是工具级的——每个需要权限的工具在执行前调用 `permission.CheckIfSet()`：

```go
// tool/coretool/bash.go — 非安全命令才检查权限
if !isSafeReadOnly(params.Command) {
    if err := permission.CheckIfSet(ctx, t.permCheck, permission.Request{
        ToolName:    "Bash",
        Description: desc,
        Params:      map[string]any{"command": params.Command},
    }); err != nil {
        return tool.ToolResult{}, err
    }
}
```

### 6.2 规则引擎

```go
// permission/settings.go — RuleChecker
// 评估顺序：deny → ask → allow，第一个匹配的规则胜出
func (c *RuleChecker) Check(ctx context.Context, req Request) (bool, error) {
    if c.matchAny(settings.Deny, req) { return false, ErrDenied }
    if !c.matchAny(settings.Ask, req) {
        if c.matchAny(settings.Allow, req) { return true, nil }
    }
    if c.Fallback != nil { return c.Fallback.Check(ctx, req) }
    return true, nil  // ← 无 Fallback 时默认 allow
}
```

### 6.3 Subagent 权限传递

```go
// agent/subagent.go
func buildChildAgent(parent *Agent, def *subagent.AgentDefinition) *Agent {
    permChecker := parent.permChecker
    var extraBashOpts []coretool.BashOption

    if def != nil && def.ReadOnly {
        permChecker = nil  // ← 只读 agent：完全跳过权限检查
        extraBashOpts = append(extraBashOpts,
            coretool.WithBashCommandFilter(coretool.CheckBashReadOnly))
    }

    registerBuiltinTools(child, parent.fileSystem, parent.shell,
        permChecker, nil, parent.webSearcher, extraBashOpts...)
}
```

### 6.4 当前行为总结

| Subagent 类型 | permChecker | Bash 过滤 | 效果 |
|-------------|------------|----------|------|
| **只读** (Explore, ReadOnly=true) | `nil` | `CheckBashReadOnly`（白名单命令） | 所有工具自动 allow，Bash 仅执行只读命令 |
| **可写** (general-purpose, ReadOnly=false) | `parent.permChecker` | 无额外过滤 | **直接继承父级的 TUI Checker → 可弹窗** |

---

## 7. CC vs Enter CLI 对比

### 7.1 核心设计差异

```
Claude Code:
  前台 subagent → 权限冒泡到父级 TUI（等效 Enter CLI 的可写 subagent 行为）
  后台 subagent → shouldAvoidPermissionPrompts=true → ask→deny（静默拒绝）

Enter CLI:
  只读 subagent → permChecker=nil（无权限检查）
  可写 subagent → parent.permChecker（TUI Checker）→ ask→弹窗
  （无前台/后台区分）
```

| 维度 | Claude Code | Enter CLI |
|------|-----------|-----------|
| **前台 subagent 遇到 ask** | 冒泡到 TUI 弹窗 | 冒泡到 TUI 弹窗（可写时） |
| **后台 subagent 遇到 ask** | 静默 deny | 不区分前后台 |
| **只读 subagent** | shouldAvoid(后台) + 工具黑名单 + 提示词 | permChecker=nil + Bash 白名单 |
| **权限模式概念** | 6 种模式 × shouldAvoid 标志 | 无模式概念，仅 Checker 传递 |
| **规则引擎** | deny→ask→allow，4 层配置源 | deny→ask→allow，单层配置 |
| **父级 bypass 传播** | 子 agent 继承 bypass | permChecker=nil（等效） |
| **LLM 分类器** | auto 模式下 subagent 可用 | 无 |
| **bubble 模式** | 仅 fork agent | **所有可写 subagent 默认行为** |
| **熔断机制** | 连续拒绝 → abort subagent | 无 |
| **dontAsk 场景** | claude-code-guide 内置 | 无等价物 |

### 7.2 安全影响

**CC 的前台模式与 Enter CLI 的可写模式等效**——都冒泡权限到 TUI。

**CC 的后台模式比 Enter CLI 更保守**——Enter CLI 没有后台 subagent 的概念，如果未来在 HTTP/AG-UI 模式下运行 subagent，需要引入类似机制。

### 7.3 等效性映射

| CC 行为 | Enter CLI 等效实现 |
|--------|-----------------|
| 后台 `shouldAvoidPermissionPrompts: true` | 需新增：`DontAskChecker` 包装器 |
| 前台权限冒泡（大多数场景） | 当前默认行为（继承父 checker） |
| `permissionMode: "dontAsk"` | 尚未实现 |
| 父级 bypass 继承 | `--dangerously-skip-permissions` 时 `permChecker=nil`（已实现） |
| auto 模式 LLM 分类器 | 尚未实现 |
| 熔断机制 | 尚未实现 |

---

## 8. 设计差异的影响分析

### 8.1 Enter CLI 当前方案的优势

1. **用户可控性强**：subagent 不会静默拒绝操作，用户始终可以决策
2. **实现简洁**：不需要额外的 `shouldAvoid` 标志和包装器
3. **调试友好**：所有权限决策都有 TUI 反馈

### 8.2 Enter CLI 当前方案的风险

1. **挂起风险**：在 HTTP/AG-UI 模式下，subagent 可能因等待权限确认而阻塞整个请求
   - 当前缓解：`ErrInterrupted` 机制可以中断 run 返回客户端
2. **提示疲劳**：多个并行 subagent 可能同时弹出权限请求
3. **CI/CD 不兼容**：headless 模式下 subagent 需要用户确认的操作会直接挂起

### 8.3 建议：按需引入 CC 模式

```go
// 建议新增：DontAskChecker 包装器
type DontAskChecker struct {
    Inner Checker
}

func (c *DontAskChecker) Check(ctx context.Context, req Request) (bool, error) {
    if c.Inner == nil {
        return false, ErrDenied
    }
    ok, err := c.Inner.Check(ctx, req)
    if errors.Is(err, ErrInterrupted) {
        return false, ErrDenied  // ask → deny（等效 shouldAvoid）
    }
    return ok, err
}
```

使用场景：
- CI/CD 模式（headless）→ subagent 用 `DontAskChecker`
- 交互式 TUI 模式 → subagent 保持当前的 `parent.permChecker`（bubble 行为）
- 未来 auto 模式 → subagent 用 LLM 分类器替代 TUI

---

## 附录：Bundle 源码定位

### 函数符号映射

| 语义名称 | Bundle 符号 | 位置 | 说明 |
|---------|-----------|------|------|
| `startSubAgent()` | `jk()` | L351438 | subagent 启动入口，含 getAppState 闭包 |
| `createToolContext()` | `nt6()` | L396867 | 通用工具上下文工厂 |
| `resolvePermission()` | `WM()` | L472802 | 权限决策主函数 |
| `evaluateToolPermission()` | `JTY()` | L472659 | 规则引擎 + checkPermissions 调用 |
| `preEvaluateToolPermission()` | `Bt1()` | L472621 | 快速路径权限评估 |
| `handleDenialLimit()` | `HTY()` | L472587 | auto 模式熔断处理 |
| `updateDenialTracking()` | `Wh6()` | L472576 | 更新拒绝计数 |
| `resetDenials()` | `h68()` | — | 重置连续拒绝计数 |
| `checkDenialLimit()` | `PXK()` | — | 检查是否达到拒绝上限 |
| `isAlwaysEnabled()` | `MC()` | L238206 | 始终返回 false（预留的功能开关） |

### Agent 定义符号

| Agent 类型 | Bundle 符号 | 位置 | permissionMode |
|-----------|-----------|------|----------------|
| Explore | `pF` | L237510 | _(无)_ |
| Plan | `RN8` | L261490 | _(无)_ |
| claude-code-guide | `yVq` | L261580 | `"dontAsk"` |
| fork | `GV6` | L238293 | `"bubble"` |

### shouldAvoidPermissionPrompts 关键位置

| 场景 | 位置 | 逻辑 |
|------|------|------|
| getAppState 闭包中计算 | L351493 | `shouldAvoid = canShow !== undefined ? !canShow : mode === "bubble" ? false : isAsync` |
| createToolContext 默认路径 | L396876 | 注入 `shouldAvoidPermissionPrompts: true`（但被 startSubAgent 的自定义 getAppState 绕过） |
| default 模式 fallback deny | L473010 | "Permission prompts are not available in this context" |
| safetyCheck deny | L472827 | "Safety check requires interactive approval" |
| auto 模式熔断 abort | L472601 | "Agent aborted: too many classifier denials in headless mode" |
| auto 模式 transcript 过长 | L472956 | "Agent aborted: auto mode classifier transcript exceeded context window" |

### Enter CLI 源码对照

| 功能 | 文件 | 说明 |
|------|------|------|
| Checker 接口 | `permission/permission.go` L28 | `Check(ctx, req) (bool, error)` |
| 规则引擎 | `permission/settings.go` L32 | `RuleChecker` — deny→ask→allow |
| subagent 权限传递 | `agent/subagent.go` L137-146 | ReadOnly → nil, 否则继承 parent |
| Bash 只读检查 | `tool/coretool/bash.go` L178 | `isSafeReadOnly()` — 安全命令前缀 |
| Bash 权限检查 | `tool/coretool/bash.go` L116 | `CheckIfSet()` — 非安全命令才检查 |
| 中断信号 | `permission/permission.go` L12 | `ErrInterrupted` — HTTP 模式使用 |
| Plan 模式目录豁免 | `permission/permission.go` L43 | `planModeDirKey` — Write/Edit 在 plan 目录内跳过 |
