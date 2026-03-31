# Claude Code Subagent 机制完全解析

> 基于 Scribe trace 数据 + 本地文件系统的实证逆向分析
> cc_version=2.1.84，2026-03-26
>
> 数据来源：多个 Claude Code 会话，3000+ 条 API trace，覆盖 general / explore / plan / code-architect 等 agent 类型；`.claude/` 目录下的 session JSONL、subagent JSONL、meta.json 持久化数据

---

## 目录

1. [架构总览](#1-架构总览)
2. [Subagent 的创建时机与触发方式](#2-subagent-的创建时机与触发方式)
3. [Agent Tool 定义：模型看到的注册表](#3-agent-tool-定义模型看到的注册表)
4. [用户自定义 Agent 的文件系统](#4-用户自定义-agent-的文件系统)
5. [执行流程：从触发到结果回传](#5-执行流程从触发到结果回传)
6. [内置 Agent 类型详解](#6-内置-agent-类型详解)
7. [父子 Agent 通信机制](#7-父子-agent-通信机制)
8. [持久化与生命周期管理](#8-持久化与生命周期管理)
9. [工具对比矩阵](#9-工具对比矩阵)
10. [附录：完整系统提示词](#10-附录完整系统提示词)

---

## 1. 架构总览

Claude Code 的 subagent 机制是一个**单层委托架构**。Primary agent 通过 `Agent` tool call 将任务分发给独立的子进程，每个子进程运行自己的 agent loop（多轮工具调用），完成后将结果文本作为 tool_result 返回给 Primary。

```
用户输入
  │
  ▼
Primary Agent (Opus 4.6, adaptive thinking, 52 tools)
  │
  ├─ tool_use: Agent {subagent_type: "Explore", prompt: "..."}
  │   └─ Explore Loop (Haiku 4.5, 45 tools, READ-ONLY)
  │       ├─ Round 1: Glob → tool_result
  │       ├─ Round 2: Grep → tool_result
  │       ├─ Round 3: Read → tool_result
  │       └─ 返回文本报告 + agentId 元数据
  │
  ├─ tool_use: Agent {prompt: "...", model: "sonnet"}
  │   └─ General Loop (Sonnet 4.6, 46 tools, 可写)
  │       ├─ Round 1: Write → tool_result
  │       └─ 返回执行报告 + agentId 元数据
  │
  ├─ tool_use: Agent {subagent_type: "Plan", prompt: "..."}
  │   └─ Plan Loop (Opus 4.6, 43 tools, READ-ONLY)
  │       ├─ Round 1: Read → tool_result
  │       ├─ Round 2: Grep → tool_result
  │       └─ 返回设计方案 + agentId 元数据
  │
  └─ Primary 接收所有 tool_result，综合决策，输出给用户
```

### 核心设计原则

1. **单层不可递归** — `Agent` 工具只存在于 Primary 的 tools 数组中。所有 subagent 都没有 Agent 工具，无法再 spawn 子 agent。这从 API 层面硬性阻断了递归。
2. **上下文隔离** — 每个 subagent 有独立的消息历史（独立的 JSONL 文件），标记为 `isSidechain: true`。子 agent 的中间思考、工具调用结果不会污染 Primary 的上下文窗口。Primary 只看到最终的 tool_result 文本。
3. **工具沙箱** — 不同 agent 类型有不同的工具范围。CC 在构建 API 请求时根据 agent 定义的白名单/黑名单过滤 `tools` 数组，subagent 根本看不到被排除的工具。
4. **模型分层** — 搜索任务用便宜快速的 Haiku，写代码和设计架构用 Opus/Sonnet，通过 `model` 参数或 agent 定义的 frontmatter 控制。
5. **并行执行** — Primary 可以在一个响应中发出多个 Agent tool_use block，CC runtime 并行启动所有 subagent，等待全部完成后把结果一起返回给 Primary 的下一轮请求。

---

## 2. Subagent 的创建时机与触发方式

Claude Code 的 subagent 触发方式相比 OpenCode 更加简洁——**本质上只有一种：模型自主调用 Agent tool**。CC 完全信任 LLM 的意图识别能力来决定何时、用什么类型的 subagent。

### 2.1 模型自主调用（唯一的核心路径）

Primary agent 在 loop 过程中，基于用户任务和上下文，自主判断是否需要调用 `Agent` tool。判断依据来自两方面：

**Agent tool 的 description 本身**——里面详细说明了每种 agent 的适用场景：

```
"When NOT to use the Agent tool:
- If you want to read a specific file path, use Read instead
- If searching for a specific class definition, use Glob instead
- If searching within 2-3 files, use Read instead"
```

以及每个 agent 类型的触发描述：

```
"- Explore: Fast agent specialized for exploring codebases. Use this when
  you need to quickly find files by patterns..."
"- Plan: Software architect agent for designing implementation plans. Use
  this when you need to plan the implementation strategy..."
```

**系统提示词中的使用指南**——Primary 的系统提示词里有明确的 Agent tool 使用建议：

```
"Use the Agent tool with specialized agents when the task at hand matches
the agent's description. Subagents are valuable for parallelizing independent
queries or for protecting the main context window from excessive results."

"For broader codebase exploration and deep research, use the Agent tool with
subagent_type=Explore."
```

### 2.2 Primary 的 Subagent Prompt 写作指引

模型决定调用 Agent 时，需要构造 `description` 和 `prompt` 两个参数。CC 通过**两层指引**告诉 Primary 如何写好这些参数：

**第一层：system prompt `# Using your tools` 章节** — 决策层面（何时用/不用 Agent）

这是 Primary 系统提示词（27K 字符的 system block [2]）中专门有一段关于 Agent 工具的使用指引：

```
"- Use the Agent tool with specialized agents when the task at hand matches
  the agent's description. Subagents are valuable for parallelizing independent
  queries or for protecting the main context window from excessive results,
  but they should not be used excessively when not needed. Importantly, avoid
  duplicating work that subagents are already doing - if you delegate research
  to a subagent, do not also perform the same searches yourself.
- For simple, directed codebase searches (e.g. for a specific file/class/function)
  use the Glob or Grep directly.
- For broader codebase exploration and deep research, use the Agent tool with
  subagent_type=Explore. This is slower than using the Glob or Grep directly,
  so use this only when a simple, directed search proves to be insufficient or
  when your task will clearly require more than 3 queries."
```

这段指引建立了三条关键决策规则：
1. **不要过度使用** — subagent 有价值（并行化、保护上下文窗口），但不要滥用
2. **不要重复工作** — 如果已经委托给 subagent，Primary 自己就不要做同样的搜索
3. **Explore 的启动阈值** — 只有当简单搜索不够或明确需要 3 次以上查询时才用

**第二层：Agent tool description 的 Usage notes** — 执行层面（怎么写 prompt）

在 Agent tool 的 description 文本中（上面 3.2 节已完整展示），Usage notes 告诉模型如何构造调用参数：

```
"- Provide clear, detailed prompts so the agent can work autonomously and
  return exactly the information you need.
- Clearly tell the agent whether you expect it to write code or just to do
  research (search, file reads, web fetches, etc.), since it is not aware
  of the user's intent
- Each Agent invocation starts fresh — provide a complete task description."
```

核心 prompt 写作原则：
1. **自主性** — prompt 要足够详细，让 subagent 能独立完成任务，不需要追问
2. **明确意图** — 必须告诉 subagent 是"写代码"还是"做研究"（subagent 看不到用户的原始请求）
3. **完整性** — 每次调用都是全新的（无历史上下文），所以 prompt 必须自包含
4. **结果预期** — 明确说明"返回什么信息"（subagent 的输出对用户不可见，Primary 需要中继）

**第三层（隐含）：Example 中的模式示范**

Agent tool description 末尾的 `<example>` 块展示了两个模式：

```xml
<example>
user: "Please write a function that checks if a number is prime"
assistant: [writes code using Write tool]
<commentary>
Since a significant piece of code was written and the task was completed,
now use the test-runner agent to run the tests
</commentary>
assistant: Uses the Agent tool to launch the test-runner agent
</example>
```

这个例子教模型一个 pattern：先做自己的工作（写代码），然后调用 subagent 做后续工作（跑测试）。`<commentary>` 标签是给模型看的"内心独白"提示，指导它在什么时机做出调用决策。

> 这三层指引的分工：system prompt 管"该不该用"，tool description 管"怎么调用"，examples 管"什么 pattern"。模型综合这三层信息来决定是否调用 Agent、选择什么类型、以及如何撰写 prompt。

### 2.3 Proactive 调用

某些用户自定义 agent 在 description 中声明了 "should be used proactively"，Agent tool description 中对此有专门指引：

```
"If the agent description mentions that it should be used proactively, then
you should try your best to use it without the user having to ask for it
first. Use your judgement."
```

这意味着 Primary 可能在用户没有显式要求的情况下主动 spawn 某些 subagent（比如 code-reviewer 在写完代码后自动触发）。

### 2.3 Claude Code 没有的触发方式

与 OpenCode 不同，CC **不存在**以下触发路径：
- **没有 `@agent` 语法** — 用户不能在输入中通过 `@explore` 这样的标记来强制调用特定 subagent
- **没有 CLI 命令直接映射到 subagent** — `/agents` 命令只用于创建/管理 agent 定义文件，不是调用入口
- **没有调用前的权限拦截层** — CC 不像 OpenCode 那样在模型调用 Agent tool 和实际执行之间插入权限判定（deny/allow），Agent 调用本身直接执行。但 subagent 内部的工具执行**仍然走权限检查**——权限行为取决于 subagent 的**前台/后台模式**：前台 subagent 将权限弹窗冒泡到父级 TUI，后台 subagent 通过 `shouldAvoidPermissionPrompts` 标志将 `ask` 静默转为 `deny`（详见 [subagent-permission-management.md](./permission-system/subagent-permission-management.md)）。

> CC 的哲学是：把所有 agent 类型和使用指南写进 Agent tool 的 description，让 LLM 自己决定。用户对 subagent 行为的控制主要通过编写/修改 `.claude/agents/*.md` 文件来实现。Subagent 内部的权限管理取决于运行模式——前台 subagent（日常绝大多数情况）可以向用户请求权限确认，后台 subagent 则静默拒绝需要确认的操作。

---

## 3. Agent Tool 定义：模型看到的注册表

Agent tool 作为 Anthropic Messages API 的 `tools` 数组中的一个 tool definition 发送。它**只存在于 Primary 请求中**——从 trace 确认，所有 subagent 的 `tools` 数组里都没有 Agent 工具。

### 3.1 参数 Schema

```json
{
  "name": "Agent",
  "input_schema": {
    "type": "object",
    "properties": {
      "description": {
        "description": "A short (3-5 word) description of the task",
        "type": "string"
      },
      "prompt": {
        "description": "The task for the agent to perform",
        "type": "string"
      },
      "subagent_type": {
        "description": "The type of specialized agent to use for this task",
        "type": "string"
      },
      "model": {
        "description": "Optional model override for this agent.",
        "type": "string",
        "enum": ["sonnet", "opus", "haiku"]
      },
      "run_in_background": {
        "description": "Set to true to run this agent in the background.",
        "type": "boolean"
      },
      "isolation": {
        "description": "Isolation mode. \"worktree\" creates a temporary git worktree.",
        "type": "string",
        "enum": ["worktree"]
      }
    },
    "required": ["description", "prompt"],
    "additionalProperties": false
  }
}
```

| 参数 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `description` | ✅ | — | 3-5 词任务摘要，用于 UI 显示和 meta.json 持久化 |
| `prompt` | ✅ | — | 完整任务描述，成为 subagent 的首条 user message |
| `subagent_type` | ❌ | `"general-purpose"` | 指定 agent 类型，从 description 中的注册表选择 |
| `model` | ❌ | 继承父级或 agent frontmatter 定义 | 短名: sonnet/opus/haiku |
| `run_in_background` | ❌ | `false` | 后台执行，Primary 不等待结果，继续处理其他工作 |
| `isolation` | ❌ | 无隔离 | `"worktree"` 在 git worktree 副本中隔离运行 |

### 3.1.1 `run_in_background`：前台/后台模式与权限影响

`run_in_background` 是一个**可选布尔参数**，由**模型的 tool_use 响应体**决定（不是用户输入，不是硬编码）。它决定了 subagent 的运行模式，并直接影响权限行为：

| 维度 | 前台 (省略或 `false`) | 后台 (`true`) |
|------|---------------------|---------------|
| **父 agent 行为** | 阻塞等待子 agent 完成 | 继续执行其他工作，完成后通知 |
| **AbortController** | 共享父级 | 创建独立 |
| **权限弹窗** | 冒泡到父级 TUI | 不可冒泡，`ask` 静默转 `deny` |
| **典型场景** | Explore、Plan、研究类任务 | 多个独立并行任务 |

**Scribe trace 实证**：对 20 个 Claude Code session（数千次 API 请求）全量扫描，仅发现 **1 个 session** 中模型返回了 `run_in_background: true`：

| Session | 日期 | 用户 Prompt | Agent 调用 | `run_in_background` |
|---------|------|------------|-----------|---------------------|
| `019d42e7dc07` | 03-31 | 权限系统调研 | 2× Explore | 均未设置（前台） |
| `019d4252dd1b` | 03-31 | 工具对齐任务 | 多次 | 均未设置（前台） |
| `019d4209b6aa` | 03-31 | 权限系统调研 | 多次 | 均未设置（前台） |
| `019d2e3e8bae` | 03-27 | 代码探索 | 多次 | 均未设置（前台） |
| `019d2a121bfe` | 03-26 | 功能开发 | 多次 | 均未设置（前台） |
| `019d283ff76b` | 03-26 | 架构分析 | 多次 | 均未设置（前台） |
| `019d240b0eb1` | 03-25 | 工具并行研究 | 多次 | 均未设置（前台） |
| **`019d24b3ba86`** | **03-25** | **`请你用多个subagent打印helloworld`** | **3× general-purpose** | **全部 `true`（后台）** |

唯一的后台调用实例：

```jsonc
// 用户: "请你用多个subagent打印helloworld" → 模型返回 3 个并行后台 agent
{
  "name": "Agent",
  "id": "call_function_yatznupr113r_1",
  "input": {
    "description": "Print Hello World 1",
    "prompt": "Print \"Hello World 1\" to stdout using the Bash tool. Simply run: echo \"Hello World 1\"",
    "subagent_type": "general-purpose",
    "run_in_background": true    // ← 模型主动设置，3 个 agent 并行约 8s 完成
  }
}
```

> **结论**：`run_in_background: true` 是极低频事件。模型仅在任务明确要求"多个独立 agent 并行执行、且不需要等待结果"时才会设置。日常的 Explore、Plan、general-purpose 调用**全部是前台**，因此权限弹窗可以冒泡到 TUI。这解释了为何用户会收到 Explore subagent 的 WebSearch 权限确认请求。

### 3.2 Description 即注册表：完整的 Agent Tool 提示词

Agent tool 的 `description` 字段是一个**动态生成的巨型字符串**（实测 ~12,000 字符，取决于注册的用户自定义 agent 数量）。这段文本**就是模型看到的全部信息**——模型通过阅读它来决定是否调用 Agent、选择哪个类型、传递什么参数。

以下是从 trace 提取的完整 description（用户自定义部分用 `{{placeholder}}` 标注）：

```
Launch a new agent to handle complex, multi-step tasks autonomously.

The Agent tool launches specialized agents (subprocesses) that autonomously
handle complex tasks. Each agent type has specific capabilities and tools
available to it.

Available agent types and the tools they have access to:
- general-purpose: General-purpose agent for researching complex questions,
  searching for code, and executing multi-step tasks. When you are searching
  for a keyword or file and are not confident that you will find the right
  match in the first few tries use this agent to perform the search for you.
  (Tools: *)
- statusline-setup: Use this agent to configure the user's Claude Code
  status line setting. (Tools: Read, Edit)
- Explore: Fast agent specialized for exploring codebases. Use this when
  you need to quickly find files by patterns (eg. "src/components/**/*.tsx"),
  search code for keywords (eg. "API endpoints"), or answer questions about
  the codebase (eg. "how do API endpoints work?"). When calling this agent,
  specify the desired thoroughness level: "quick" for basic searches, "medium"
  for moderate exploration, or "very thorough" for comprehensive analysis
  across multiple locations and naming conventions.
  (Tools: All tools except Agent, ExitPlanMode, Edit, Write, NotebookEdit)
- Plan: Software architect agent for designing implementation plans. Use this
  when you need to plan the implementation strategy for a task. Returns
  step-by-step plans, identifies critical files, and considers architectural
  trade-offs.
  (Tools: All tools except Agent, ExitPlanMode, Edit, Write, NotebookEdit)
- claude-code-guide: Use this agent when the user asks questions ("Can
  Claude...", "Does Claude...", "How do I...") about: (1) Claude Code (the
  CLI tool) - features, hooks, slash commands, MCP servers, settings, IDE
  integrations, keyboard shortcuts; (2) Claude Agent SDK - building custom
  agents; (3) Claude API (formerly Anthropic API) - API usage, tool use,
  Anthropic SDK usage. **IMPORTANT:** Before spawning a new agent, check if
  there is already a running or recently completed claude-code-guide agent
  that you can continue via SendMessage.
  (Tools: Glob, Grep, Read, WebFetch, WebSearch)
{{- 以下为用户自定义 agent，从 ~/.claude/agents/*.md 和 .claude/agents/*.md 动态加载 -}}
- {{agent-name}}: {{agent-description}} (Tools: {{agent-tools}})
- {{agent-name}}: {{agent-description}} (Tools: {{agent-tools}})
[... 每个 .claude/agents/*.md 文件生成一个条目 ...]

When using the Agent tool, specify a subagent_type parameter to select which
agent type to use. If omitted, the general-purpose agent is used.

When NOT to use the Agent tool:
- If you want to read a specific file path, use the Read tool or the Glob
  tool instead of the Agent tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo",
  use the Glob tool instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files,
  use the Read tool instead of the Agent tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above


Usage notes:
- Always include a short description (3-5 words) summarizing what the agent
  will do
- Launch multiple agents concurrently whenever possible, to maximize
  performance; to do that, use a single message with multiple tool uses
- When the agent is done, it will return a single message back to you.
  The result returned by the agent is not visible to the user. To show the
  user the result, you should send a text message back to the user with a
  concise summary of the result.
- You can optionally run agents in the background using the run_in_background
  parameter. When an agent runs in the background, you will be automatically
  notified when it completes — do NOT sleep, poll, or proactively check on
  its progress. Continue with other work or respond to the user instead.
- **Foreground vs background**: Use foreground (default) when you need the
  agent's results before you can proceed — e.g., research agents whose
  findings inform your next steps. Use background when you have genuinely
  independent work to do in parallel.
- To continue a previously spawned agent, use SendMessage with the agent's ID
  or name as the `to` field. The agent resumes with its full context preserved.
  Each Agent invocation starts fresh — provide a complete task description.
- Provide clear, detailed prompts so the agent can work autonomously and
  return exactly the information you need.
- The agent's outputs should generally be trusted
- Clearly tell the agent whether you expect it to write code or just to do
  research (search, file reads, web fetches, etc.), since it is not aware
  of the user's intent
- If the agent description mentions that it should be used proactively, then
  you should try your best to use it without the user having to ask for it
  first. Use your judgement.
- If the user specifies that they want you to run agents "in parallel", you
  MUST send a single message with multiple Agent tool use content blocks.
- You can optionally set `isolation: "worktree"` to run the agent in a
  temporary git worktree, giving it an isolated copy of the repository. The
  worktree is automatically cleaned up if the agent makes no changes; if
  changes are made, the worktree path and branch are returned in the result.
```

这段文本可以拆分为三个功能层：

1. **Agent 注册表** — 内置类型（general-purpose, Explore, Plan, claude-code-guide, statusline-setup）和用户自定义类型混排在同一个列表中。每个条目包含名称、一句话描述、可用工具列表。**模型通过阅读这段纯文本来决定选择哪个 agent 类型——没有结构化的 agent 列表 API，完全靠 LLM 的语言理解做路由。**
2. **负面指引** — "When NOT to use" 列表，防止模型在简单任务上过度使用 subagent（比如读一个已知路径的文件不需要 spawn Explore）。
3. **使用规范** — 并行执行、前台/后台策略、SendMessage 续传、worktree 隔离等高级用法的详细说明。

### 3.3 动态更新机制

Agent tool description 在**每次构建 Primary API 请求时重新生成**：

1. CC 启动时扫描 agent 定义文件目录
2. 内置 agent 类型（硬编码在 Go binary 中）+ 用户自定义 agent（`.claude/agents/*.md`）合并
3. 为每个 agent 提取 `name`、`description`、`tools` 信息，拼接成 description 字符串
4. 整个字符串作为 Agent tool 的 `description` 字段发送

这意味着：
- 添加/删除/修改 `.claude/agents/*.md` 文件后，**下一个 Primary 请求**就会反映变化
- Agent tool 的 description 可能随会话推进而变化（如果中间有 agent 文件变更）
- Description 中的工具名（如 `LS`, `NotebookRead`, `TodoWrite`, `BashOutput`）是 Agent SDK 层面的抽象名称，与实际 Anthropic API tools 数组中的名称可能不完全一致

---

## 4. 用户自定义 Agent 的文件系统

### 4.1 定义文件位置

CC 从两个层级加载 agent 定义：

```
~/.claude/agents/                    ← 全局 agent（所有项目共享）
  gsd-executor.md
  gsd-planner.md
  gsd-verifier.md
  ...

<project>/.claude/agents/            ← 项目级 agent（只在该项目下可用）
  code-architect.md
  code-reviewer.md
  ...
```

全局和项目级的 agent 合并后一起注册到 Agent tool description 中。

### 4.2 文件格式

每个 `.md` 文件使用 YAML frontmatter + Markdown body：

```markdown
---
name: gsd-executor
description: Executes GSD plans with atomic commits, deviation handling, checkpoint protocols.
tools: Read, Write, Edit, Bash, Grep, Glob
color: yellow
---

<role>
You are a GSD plan executor. You execute PLAN.md files atomically,
creating per-task commits, handling deviations automatically...
</role>

## Core Process
1. Read PLAN.md
2. Execute each task
...
```

### 4.3 Frontmatter 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | Agent 类型名称，用于 `subagent_type` 参数匹配 |
| `description` | string | 一行描述，嵌入 Agent tool description |
| `tools` | string | 逗号分隔的工具白名单（如 `"Read, Write, Edit, Bash, Grep, Glob"`） |
| `model` | string? | 默认模型（sonnet/opus/haiku），可被调用时 override |
| `color` | string? | UI 显示颜色 |

> 从 trace 确认：`feature-dev:code-architect` 定义了 `tools: Glob, Grep, Read, WebFetch, WebSearch`，实际 API 请求中 `tools` 数组精确只有这 5 个工具。白名单过滤在 CC runtime 层执行，模型收到的 tools 数组已经过滤完毕。

### 4.4 系统提示词的拼接规则

用户自定义 agent 的系统提示词由 CC 自动拼接，Markdown body 只是其中一部分：

```
[Block 0] Billing Header
  x-anthropic-billing-header: cc_version=2.1.84.f51; cc_entrypoint=cli; cch=00000;

[Block 1] Identity（自动注入，用户不写）
  You are Claude Code, Anthropic's official CLI for Claude.

[Block 2] Markdown Body（来自 .md 文件）
  You are a senior software architect who delivers comprehensive...
  ## Core Process
  ...

[Block 3] Standard Notes（自动注入）
  Notes:
  - Agent threads always have their cwd reset between bash calls,
    as a result please only use absolute file paths.
  - In your final response, share file paths (always absolute, never relative)...
  - For clear communication with the user the assistant MUST avoid using emojis.

[Block 4] Environment（自动注入）
  <env>
  Working directory: /Users/zfang/workspace/empty
  Is directory a git repo: No
  Platform: darwin
  Shell: zsh
  OS Version: Darwin 24.5.0
  </env>
  You are powered by the model named Sonnet 4.6...
```

从 trace 验证：`code-architect` 的系统提示词确实以 `"You are Claude Code, Anthropic's official CLI for Claude.\nYou are a senior software architect..."` 开头——**Identity 前缀是 CC 自动注入的**，用户的 Markdown body 紧随其后。

---

## 5. 执行流程：从触发到结果回传

当 Primary 的 LLM 响应中包含 `tool_use: Agent` 时，CC runtime 开始执行以下流程：

### 5.1 Step 1: Agent 类型解析与初始化

CC 从 `subagent_type` 参数匹配 agent 定义。匹配源：
- 内置类型（general-purpose, Explore, Plan, claude-code-guide, statusline-setup）
- 用户自定义类型（从 `.claude/agents/*.md` 加载的定义）

如果 `subagent_type` 省略，默认使用 `general-purpose`。

同时为此次调用生成一个**17 位 hex 的 agentId**（如 `a326d912dc8360845`），这是该 subagent 实例的唯一标识。

### 5.2 Step 2: 系统提示词构建

根据 agent 类型组装系统提示词。三段式结构所有 agent 都一样，但 Block 2（角色定义内容）差异巨大：

| Agent 类型 | Block 2 内容 | 长度 |
|-----------|-------------|------|
| General | "Do what has been asked; nothing more, nothing less" + 搜索/分析指南 | ~1.5KB |
| Explore | "file search specialist" + READ-ONLY 禁令 + 速度优化指令 | ~2KB |
| Plan | "software architect" + READ-ONLY 禁令 + 4步流程 + Critical Files 格式要求 | ~2.5KB |
| User-defined | 用户写的 Markdown body | 自定义 |
| Primary（对比） | 完整的 CC 系统提示词（安全策略+工具指南+memory+git+...） | ~27KB |

### 5.3 Step 3: System-Reminder 注入

System-reminder 是嵌入在 **user message** 中的 `<system-reminder>` XML 块，不是 system prompt 的一部分。

注意：system-reminder 和 system prompt 是两个不同的注入位置。从 raw API payload 验证：
- **system prompt**（API 的 `system` 参数）：包含角色定义 + gitStatus（尾部追加）
- **system-reminder**（API 的 `messages` 中 user 角色的消息体内）：包含 claudeMd、currentDate 等动态内容

**Primary 注入 4 个 system-reminder 块**（在 user message 中）：

| # | 内容 | 来源 |
|---|------|------|
| 1 | SessionStart hook 上下文（superpowers 等 skill bootstrap） | Hooks 系统 |
| 2 | MCP Server Instructions（context7, weixin 等服务器的使用说明） | MCP 注册 |
| 3 | 可用 Skills 列表（deferred tools 提示） | Skill 注册表 |
| 4 | claudeMd（CLAUDE.md + MEMORY.md）+ currentDate | 上下文注入 |

**同时在 system prompt 尾部追加 gitStatus**（如果是 git repo）：

```
// system[2] 的末尾（角色定义内容之后）
...
gitStatus: This is the git status at the start of the conversation.
Current branch: main
Status:
M file1.py
...
```

gitStatus 放在 system prompt 而不是 system-reminder 中，意味着它**参与 prompt caching**——git status 变化会影响缓存命中。

**Subagent 注入 1 个 system-reminder 块**（在 user message 中），内容取决于工作目录：

```xml
<system-reminder>
As you answer the user's questions, you can use the following context:
# claudeMd                    ← 仅当工作目录有 CLAUDE.md 时才出现
Contents of /path/to/CLAUDE.md (project instructions):
[CLAUDE.md 内容]

Contents of /path/to/memory/MEMORY.md (user's auto-memory):
[MEMORY.md 内容]

# currentDate                 ← 始终出现
Today's date is 2026-03-26.
</system-reminder>
```

**同时在 subagent 的 system prompt 尾部也追加 gitStatus**（如果是 git repo）——从 Explore 的 raw payload 验证，gitStatus 在 system block [2] 中。

**关键差异**：
- Hooks、MCP instructions、Skills 列表 **只给 Primary**——subagent 不知道 hooks 的存在
- CLAUDE.md/MEMORY.md **按工作目录有无决定**——如果 subagent 运行在 `/workspace/empty`（无 CLAUDE.md），system-reminder 只有 `currentDate`；如果运行在有 CLAUDE.md 的目录，会注入完整的 claudeMd + MEMORY.md
- gitStatus 在 **system prompt** 中注入（不是 system-reminder），对所有有 git repo 的工作目录都适用

**为什么拆分两个位置**：这个设计服务于 **Prompt Caching**。Anthropic 的 prompt caching 基于 system prompt 前缀匹配。将变化频率高的内容（MEMORY.md 每轮可能变化）放在 user message 的 system-reminder 中，system prompt 保持相对稳定（角色定义不变，gitStatus 在会话内不变），缓存命中率最高。

### 5.3.1 tool_result 中的重复注入机制

除了初始 user message 中的 system-reminder，CC 还会在 **tool_result 消息中反复注入额外的 system-reminder**。这是一个多轮对话中的**约束强化机制**——防止模型在长对话中"遗忘"关键约束。

从 trace 验证的注入模式：

**General subagent 的 tool_result 注入**：

```
Round 1: user → [system-reminder: currentDate]
                 "Research the Go logging library..."
Round 2: tool_result → [system-reminder: MCP Server Instructions]
                        {WebSearch 的执行结果}
Round 3: tool_result → (无 reminder)
                        {Read 的执行结果}
```

General 在 tool_result 中只注入 **MCP Server Instructions**（指导模型如何使用 MCP 工具），且不是每个 tool_result 都有——通常出现在首次 tool_result 或间隔若干轮后。

**Explore subagent 的 tool_result 注入**（明显更重）：

```
Round 1: user → [system-reminder: claudeMd + currentDate]
                 "Explore the codebase..."
Round 2: tool_result → [system-reminder: MCP Instructions]
                        [system-reminder: Plan mode warning]
                        [system-reminder: READ-ONLY reminder]
                        {Glob 的执行结果}
Round 3: tool_result → (无 reminder)
                        {Grep 的执行结果}
Round 4: tool_result → [system-reminder: READ-ONLY reminder]
                        {Read 的执行结果}
...
Round N: tool_result → [system-reminder: Plan mode + Task tools]
                        [system-reminder: READ-ONLY reminder]
                        {后续工具结果}
```

Explore 的 tool_result 中出现 **4 种 system-reminder**，按频率排列：

| Reminder 类型 | 内容 | 出现频率 |
|--------------|------|---------|
| **READ-ONLY 强化** | `"CRITICAL: This is a READ-ONLY task. You CANNOT edit, write, or create files."` | 几乎每隔 1-2 个 tool_result |
| **Plan mode 警告** | `"Plan mode is active. The user indicated that they do not want you to execute yet..."` | 间歇出现 |
| **MCP Instructions** | `"# MCP Server Instructions\nThe following MCP servers have provided instructions..."` | 首次 + 间歇 |
| **Task tools 提醒** | `"The task tools haven't been used recently..."` | 偶尔出现 |

**READ-ONLY 强化 reminder 的完整内容**：
```
CRITICAL: This is a READ-ONLY task. You CANNOT edit, write, or create files.
```

这条极短的 reminder 在 24 个 tool_result 中出现了 **19 次**——接近每个 tool_result 都注入。这是 Explore 的第三层只读保障（系统提示词 + 工具黑名单 + tool_result 反复提醒），针对的是长对话中模型可能"忘记"自己是只读的问题。

**General 没有 READ-ONLY reminder**（因为 General 可以写文件），也没有 Plan mode warning。它只有 MCP Instructions 这一种 tool_result 注入。

> 这个机制在文档的其他地方没有对应的架构——它是 CC runtime 内部的行为，不通过 Agent tool 参数或 agent 定义文件控制。

### 5.4 Step 4: 工具范围过滤

CC 根据 agent 定义过滤 `tools` 数组。两种模式：

- **白名单**（`tools: Read, Write, Edit, Bash`）→ 只保留列出的工具
- **黑名单**（内置 agent 的 "All tools except Agent, Edit, Write, NotebookEdit"）→ 全集减去排除项

过滤结果是**最终的**——subagent 收到的 `tools` 数组中不包含被排除的工具定义。即使系统提示词没有提到限制，模型也无法调用不在 tools 中的工具。

但有一个值得注意的细节：**MCP 工具全量继承**。即使是 READ-ONLY 的 Explore subagent，也收到了完整的 MCP 工具列表（Playwright browser 工具、context7、weixin 等 25+ 个）。CC 目前没有对 MCP 工具做 agent-level 过滤。

### 5.5 Step 5: Subagent Loop 执行

Subagent 进入独立的 agent loop，流程与 Primary 类似：

```
Round 1: 发送 API 请求 (system + [user: task_prompt])
         ↓
         模型返回 tool_use (如 Glob)
         ↓
         CC 执行 Glob，得到 tool_result
         ↓
Round 2: 发送 API 请求 (system + [user: task, assistant: tool_use, user: tool_result])
         ↓
         模型返回 tool_use (如 Read)
         ↓
         CC 执行 Read，得到 tool_result
         ↓
Round N: 发送 API 请求 (system + [完整历史])
         ↓
         模型返回 end_turn (任务完成)
         ↓
         提取最终文本作为 subagent 输出
```

每一轮请求都发送**完整的消息历史**。从 trace 观察到的最大轮数：

| Agent 类型 | 观察到的最大轮数 | 说明 |
|-----------|---------------|------|
| General (简单写文件) | 2 轮 | write → done |
| General (Web research) | 4 轮 | WebSearch → Read → ... → done |
| Explore (Haiku) | 10+ 轮 | 搜索链很长，一个文件引出另一个 |
| Plan (Opus) | 7-8 轮 | 深度阅读多个文件后输出方案 |
| code-explorer (31 tool_uses) | 30+ 轮 | 大规模代码探索 |

**并行执行**：当 Primary 在一次响应中发出多个 Agent tool_use 时，CC runtime 并行启动所有 subagent。从 trace 时间戳确认——Turn 2 的 3 个 Sonnet subagent 首次请求时间差在毫秒级。所有 subagent 完成后，tool_result 一起返回给 Primary 的下一轮请求。

### 5.6 Step 6: 结果回传

Subagent loop 结束后，CC 将结果包装为 `tool_result` 返回给 Primary。结果格式为文本 + 元数据尾部：

```
[子 agent 的最终自然语言回答]

agentId: a326d912dc8360845 (use SendMessage with to: 'a326d912dc8360845' to continue this agent)
<usage>total_tokens: 20138
tool_uses: 1
duration_ms: 13591</usage>
```

这个 tool_result 成为 Primary 对话历史中的一条 `user` 消息（`tool_result` 类型的 content block），Primary 在下一轮请求时读取它来获得 subagent 的执行结果。

**未观察到截断机制**：在所有分析的 trace 和本地文件中，没有发现类似"输出超长 → 截断 → 原文落盘 → 返回截断文本 + 文件路径"的模式。CC 可能依赖 context compression（会话过长时自动压缩旧消息）来处理 token 超限的情况，而不是在 subagent 输出层面做截断。

---

## 6. 内置 Agent 类型详解

### 6.1 General-Purpose（默认之选）

**触发**：`Agent {prompt: "..."}` 或 `Agent {subagent_type: "general-purpose", prompt: "..."}`

General-Purpose 是模型在**未指定 `subagent_type` 时的默认选择**。这一点在 Agent tool description 中明确写道：`"If omitted, the general-purpose agent is used."`

从 trace 数据看，这也是**使用最频繁的 agent 类型**——在分析的会话中，General 的调用次数远超 Explore 和 Plan。模型倾向于在大多数任务场景（写文件、做研究、执行修改）下直接发出 `{description, prompt}` 而不额外指定 subagent_type，让 CC 走默认路径。

一个典型的 trace 中的 General 调用，注意**没有 `subagent_type` 字段**：

```json
{
  "description": "Research rs/zerolog",
  "model": "sonnet",
  "prompt": "Research the Go logging library rs/zerolog. Find:\n1. Latest version number (check GitHub releases or go.pkg.dev)\n2. Performance benchmark data (allocations, ns/op) - look for official benchmarks\n3. Structured logging API style - show a typical usage example\n\nReturn all findings in a concise format. This is research only, do not write any files."
}
```

这里 `subagent_type` 完全缺失，CC 将其路由到 `general-purpose`。同时 `model: "sonnet"` 显式降级到 Sonnet（比 Opus 便宜，用于研究类任务够用），体现了 Primary 对成本的自主优化。

**系统提示词核心**（完整版见[附录 A](#a-general-purpose-完整系统提示词)）：

```
"You are an agent for Claude Code, Anthropic's official CLI for Claude.
Given the user's message, you should use the tools available to complete
the task. Do what has been asked; nothing more, nothing less. When you
complete the task, respond with a concise report covering what was done
and any key findings — the caller will relay this to the user, so it only
needs the essentials."
```

**能力特征**：
- ✅ 可以读写文件（Edit, Write, NotebookEdit）— 这是 General 与 Explore/Plan 的核心区别
- ✅ 可以执行 Bash 命令
- ✅ 可以使用 MCP 工具
- ✅ 可以创建/管理 Tasks
- ❌ 不能 spawn 子 agent（无 Agent 工具）
- ❌ 不能与用户交互（无 AskUserQuestion）
- ❌ 不能进入 Plan 模式（无 EnterPlanMode）

**系统提示词中的行为约束**：

```
"Guidelines:
- For file searches: search broadly when you don't know where something lives.
- For analysis: Start broad and narrow down.
- Be thorough: Check multiple locations, consider different naming conventions.
- NEVER create files unless they're absolutely necessary.
- NEVER proactively create documentation files (*.md) or README files."
```

**模型选择**：不指定 `model` 则继承 Primary 当前模型，指定了就用指定的。上面的研究任务例子中 Primary 是 Opus，但显式传了 `model: "sonnet"` 降级——研究类任务用 Sonnet 够了，省 token。

**从 trace 中的更多调用样本**：

```json
// 并行写 3 个文件（Turn 1, 无 model 指定 → 继承 Opus）
// 注意：全部没有 subagent_type，走默认 general-purpose
{"description": "Write server.go HTTP service", "prompt": "Create the file /Users/zfang/workspace/empty/server.go with the following specs. Use the Write tool.\n\nA simple Go HTTP server with:\n- Package: main\n- Port: 8080 (read from PORT env var with 8080 as default)\n- Routes:\n  - GET / → responds with \"Hello, World!\\n\" (200)\n  - GET /health → responds with JSON {\"status\":\"ok\"} (200, Content-Type application/json)\n- Use only stdlib (net/http, encoding/json, os, fmt, log)\n- Clean, idiomatic Go code\n- No external dependencies"}
{"description": "Write server_test.go tests", "prompt": "Create the file /Users/zfang/workspace/empty/server_test.go with the following specs..."}
{"description": "Write Dockerfile", "prompt": "Create the file /Users/zfang/workspace/empty/Dockerfile with the following specs..."}

// 并行 Web 研究（Turn 2, 显式 model: "sonnet" 降级）
// 注意：description 略有缩写，prompt 包含详细的研究要求
{"description": "Research uber-go/zap library", "model": "sonnet",
 "prompt": "Research the Go logging library uber-go/zap. Find:\n\n1. **Latest version number** - search the web for the current latest release version\n2. **Performance benchmark data** - find benchmark numbers (ns/op, allocs/op)...\n3. **Structured logging API style** - show a concise code example...\n\nUse WebSearch to find this information. Be thorough and get actual numbers. Return your findings in a clear, structured format."}
{"description": "Research rs/zerolog library", "model": "sonnet",
 "prompt": "Research the Go logging library rs/zerolog. Find:\n\n1. **Latest version number** - ...\n2. **Performance benchmark data** - ...\n3. **Structured logging API style** - ...\n\nUse WebSearch to find this information..."}
{"description": "Research log/slog library", "model": "sonnet",
 "prompt": "Research the Go standard library log/slog package. Find:\n\n1. **Version info** - which Go version introduced it...\n2. **Performance benchmark data** - ...\n3. **Structured logging API style** - ...\n\nUse WebSearch to find this information..."}
```

### 6.2 Explore

**触发**：`Agent {subagent_type: "Explore", prompt: "..."}`

**系统提示词核心**（完整版见[附录 B](#b-explore-完整系统提示词)）：

```
"You are a file search specialist for Claude Code, Anthropic's official
CLI for Claude. You excel at thoroughly navigating and exploring codebases.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from:
- Creating new files (no Write, touch, or file creation of any kind)
- Modifying existing files (no Edit operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state"
```

**双重只读保障**：
1. **提示词层**：明确列出禁止行为清单，甚至细化到 redirect operators 和 heredocs
2. **工具层**：API `tools` 数组中不包含 Edit、Write、NotebookEdit——即使模型想写也没有可用工具

**速度优化指令**（Explore 独有）：

```
"NOTE: You are meant to be a fast agent that returns output as quickly
as possible. In order to achieve this you must:
- Make efficient use of the tools that you have at your disposal
- Wherever possible you should try to spawn multiple parallel tool calls
  for grepping and reading files"
```

这条指令使得 Explore 在单次响应中经常发出 3-5 个并行的 Glob/Grep/Read 调用。配合 Haiku 模型的低延迟，实现快速搜索。

**Bash 使用限制**（比 General 更严格）：

```
"- Use Bash ONLY for read-only operations (ls, git status, git log, git diff, find, cat, head, tail)
- NEVER use Bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install"
```

**默认模型**：Haiku 4.5（最快最便宜，适合搜索）

**从 trace 中的实际调用样本**：

```json
{
  "subagent_type": "Explore",
  "description": "Explore enter_agent_sdk codebase",
  "prompt": "Thoroughly explore the codebase at /Users/zfang/workspace/enter_agent_sdk.
  I need a comprehensive understanding of:
  1. Project structure — list all top-level directories
  2. Package organization — what packages exist
  3. Dependencies — go.mod
  4. Code size — Go files, test files, LOC
  5. Key interfaces
  6. Test coverage
  7. Build/CI
  8. Documentation
  Be very thorough. This is research only — do not modify anything."
}
```

调用方（Primary）在 prompt 中可以指定 thoroughness level（"quick"/"medium"/"very thorough"），Explore 据此调整搜索深度。这不是 API 参数，而是自然语言约定。

### 6.3 Plan

**触发**：`Agent {subagent_type: "Plan", prompt: "..."}`

**系统提示词核心**（完整版见[附录 C](#c-plan-完整系统提示词)）：

```
"You are a software architect and planning specialist for Claude Code.
Your role is to explore the codebase and design implementation plans.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ==="
```

**与 Explore 的关键差异**：

| 维度 | Plan | Explore |
|------|------|---------|
| 默认模型 | Opus 4.6（需要强推理能力） | Haiku 4.5（搜索不需要深度推理） |
| max_tokens | 64000 | 32000 |
| 目标 | 产出设计方案 + Critical Files 列表 | 产出搜索报告 |
| 内置流程 | 4 步结构化流程 | 自由搜索 |
| 速度要求 | 无特别强调 | "fast agent"，鼓励并行调用 |

**强制 4 步流程**（嵌入在系统提示词中）：

```
"## Your Process
1. **Understand Requirements**: Focus on the requirements provided
2. **Explore Thoroughly**: Read files, find patterns, understand architecture
3. **Design Solution**: Create implementation approach, consider trade-offs
4. **Detail the Plan**: Step-by-step strategy, dependencies, challenges"
```

**强制输出格式**：

```
"## Required Output
End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- path/to/file1.ts
- path/to/file2.ts"
```

**从 trace 中的实际调用样本**：

```json
{
  "subagent_type": "Plan",
  "description": "Analyze skill & session systems",
  "prompt": "Analyze these two subsystems in /Users/zfang/workspace/enter_agent_sdk:
  1. **Skill System (skill/ + agent reminder injection)**
     - How skills are loaded from .md files
     - YAML frontmatter parsing
     - How skills are injected as system-reminder messages
  2. **Session Persistence & Recovery**
     - The SessionStore interface
     - How messages are persisted (append-only)
     - The Resume() recovery logic
  Read the relevant source files and provide a detailed architectural analysis."
}
```

### 6.4 其他内置类型

**claude-code-guide**：
- 用途：回答关于 Claude Code 本身的使用问题
- 工具：仅 Glob, Grep, Read, WebFetch, WebSearch（5 个）
- 特殊：description 中提到"Before spawning a new agent, check if there is already a running or recently completed claude-code-guide agent that you can continue via SendMessage"

**statusline-setup**：
- 用途：配置 CC 状态栏设置
- 工具：仅 Read, Edit（2 个）

### 6.5 模型选择与配置

**模型决定链**：指定了就用指定的，没指定就继承。

```
Agent tool call 的 model 参数     ← 有就用这个（最高优先级）
    ↓ (没有)
Agent 定义的 frontmatter model    ← 有就用这个（Explore 默认 haiku，Plan 默认 opus）
    ↓ (也没有)
继承 Primary 的当前模型           ← General 走这条路（所以 Primary 是 Opus 它就是 Opus）
```

**从 trace 验证的实际配置**：

| 场景 | model | max_tokens | thinking | temperature |
|------|-------|-----------|---------|------------|
| Primary (Opus) | claude-opus-4-6 | 64000 | `{"type":"adaptive"}` ✅ | — |
| General (继承 Opus) | claude-opus-4-6 | 64000 | ❌ 无 | 1 |
| General (override Sonnet) | claude-sonnet-4-6 | 32000 | ❌ 无 | 1 |
| Explore (默认 Haiku) | claude-haiku-4-5-20251001 | 32000 | ❌ 无 | 1 |
| Plan (默认 Opus) | claude-opus-4-6 | 64000 | ❌ 无 | 1 |
| code-architect (frontmatter Sonnet) | claude-sonnet-4-6 | 32000 | ❌ 无 | 1 |

**关键发现：Thinking 是 Primary 独享的。** Primary 使用 `{"thinking": {"type": "adaptive"}}`（Extended Thinking），所有 subagent **一律不启用 thinking**。这是重要的成本优化——thinking tokens 很贵，subagent 的任务（搜索、写代码、设计方案）通常不需要深度推理链。

---

## 7. 父子 Agent 通信机制

### 7.1 通信模型概述

Claude Code 的父子通信是**单向、批量、异步**的：

```
Primary 发出 Agent tool_use
    ↓
    CC runtime spawn subagent 进程
    ↓
    Subagent 独立运行 loop（Primary 此时阻塞等待）
    ↓
    Subagent loop 结束
    ↓
    CC runtime 将结果包装为 tool_result 返回给 Primary
    ↓
Primary 的下一轮请求收到 tool_result
```

在整个过程中，子 agent 的中间工具调用、思考过程、hook 事件**不会传递到父 agent 的 API 层面**。父 agent 只看到最终的文本结果。

### 7.2 agentId 机制

每个 subagent 实例分配一个 **17 位 hex 字符串**作为唯一标识：

```
a326d912dc8360845
a59ef8576669c1cc9
ac893ff497a65030f
```

agentId 在以下位置出现：

1. **子 agent JSONL 的每条记录**：`"agentId": "a326d912dc8360845"`
2. **meta.json 文件名**：`agent-a326d912dc8360845.meta.json`
3. **tool_result 末尾**（Primary 可见的唯一位置）：

```
[子 agent 的回答文本]

agentId: a326d912dc8360845 (use SendMessage with to: 'a326d912dc8360845' to continue this agent)
<usage>total_tokens: 20138
tool_uses: 1
duration_ms: 13591</usage>
```

### 7.3 Usage 元数据

每个 subagent 的 tool_result 末尾都携带使用统计：

```xml
<usage>total_tokens: 87341
tool_uses: 31
duration_ms: 155907</usage>
```

从该 session 的所有 subagent usage 统计：

| agentId | agentType | description | total_tokens | tool_uses | duration |
|---------|-----------|-------------|-------------|-----------|----------|
| a326d91 | general-purpose | Write server.go | 20,138 | 1 | 13.6s |
| a59ef85 | general-purpose | Write Dockerfile | 20,102 | 1 | 13.8s |
| a99090b | general-purpose | Write server_test.go | 20,382 | 1 | 15.9s |
| aaaf160 | general-purpose | Research zap | 23,952 | 5 | 43.0s |
| a081e74 | general-purpose | Research zerolog | 24,801 | 8 | 77.8s |
| aec81c3 | general-purpose | Research slog | 26,383 | 8 | 79.9s |
| ac893ff | Explore | Explore codebase | — | — | — |
| a1fb70f | code-explorer | Trace tool paths | 87,341 | 31 | 155.9s |
| a07e6cf | code-architect | Analyze protocol | 73,677 | 37 | 192.9s |

可以看到清晰的模式：简单写文件任务 ~20K tokens / 1 tool / 14s；Web 研究 ~25K tokens / 5-8 tools / 40-80s；深度代码探索 ~75-87K tokens / 30+ tools / 2.5-3 min。

### 7.4 SendMessage 续传机制

Agent tool description 中提到：

```
"To continue a previously spawned agent, use SendMessage with the
agent's ID or name as the `to` field. The agent resumes with its full
context preserved."
```

tool_result 中的 `agentId` 末尾也有提示：

```
(use SendMessage with to: 'a326d912dc8360845' to continue this agent)
```

**但从 trace 数据和 tools 数组中，SendMessage 工具未出现在 Primary 的 52 个工具中。** 在所有分析的会话中，也没有观察到 Primary 实际调用过 SendMessage。

SendMessage 大概率是为 **multi-agent team 模式**设计的（多个 agent 协作通信的场景），而非常规的单 Primary + subagent 模式。在当前标准使用模式下，subagent 是一次性的——Primary spawn 一个 subagent，等它完成，取结果。agentId 和 SendMessage 的提示是为 team 模式的 agent 间通信预留的能力，但在我们的 trace 数据（标准 CLI 模式）中没有使用证据。

### 7.5 isSidechain 标记

子 agent 的 JSONL 记录中每条都标记 `"isSidechain": true`，父 session 的记录是 `"isSidechain": false`。

这个标记的作用：
- **UI 层面**：侧链消息不在主对话界面中显示
- **上下文管理**：侧链消息不会混入父 agent 的 API 请求消息历史
- **身份识别**：用于区分同一个 session JSONL 文件中的主链和侧链记录

### 7.6 实时进度通知（推测）

CC 的 CLI 界面可以实时显示子 agent 的工具调用进度（如 "Explore: Glob → Grep → Read..."）。但这个进度信息**不出现在 API trace 中**。

从子 agent JSONL 中观察到 `type: "progress"` 记录，包含 hook 事件（PreToolUse、PostToolUse），但这些是写入磁盘的日志，不是 API 通信。

实时进度通知很可能走的是 **CC 进程内部的 IPC 机制**（如 stdout pipe 或内存事件），不经过 Anthropic API。这是一个从外部 trace 无法观察到的黑箱环节。

---

## 8. 持久化与生命周期管理

### 8.1 存储结构

```
~/.claude/projects/-Users-zfang-workspace-empty/
│
├── a2839f01-...-a98b5e7f19c9.jsonl          ← 父 session 完整对话记录 (1.9MB)
│                                                 isSidechain: false
│                                                 包含 user/assistant/progress 记录
│                                                 包含所有 subagent 的 tool_result（含 agentId + usage）
│
├── a2839f01-...-a98b5e7f19c9/               ← 父 session 的附属目录
│   │
│   ├── subagents/                           ← 子 agent 持久化目录
│   │   ├── agent-a326d912dc8360845.jsonl    ← 子 agent 完整对话历史 (7KB)
│   │   │                                        isSidechain: true
│   │   │                                        包含 user/assistant/progress 记录
│   │   │
│   │   ├── agent-a326d912dc8360845.meta.json ← 子 agent 元数据
│   │   │   {"agentType":"general-purpose",
│   │   │    "description":"Write server.go HTTP service"}
│   │   │
│   │   ├── agent-ac893ff497a65030f.jsonl    ← Explore agent (297KB, 大量搜索)
│   │   ├── agent-ac893ff497a65030f.meta.json
│   │   │   {"agentType":"Explore",
│   │   │    "description":"Explore enter_agent_sdk codebase"}
│   │   │
│   │   ├── agent-a198ff09a839d2d4c.jsonl    ← Plan agent (185KB)
│   │   ├── agent-a198ff09a839d2d4c.meta.json
│   │   │   {"agentType":"Plan",
│   │   │    "description":"Analyze skill & session systems"}
│   │   │
│   │   └── ... (本 session 共 16 个 subagent)
│   │
│   └── tool-results/                        ← 父 session 的上下文压缩落盘
│       ├── b2xd2lc10.txt                       （非 subagent 输出，而是压缩的旧消息）
│       └── ...
│
└── ~/.claude/sessions/                       ← 运行时状态（非持久化）
    └── 2614.json
        {"pid":2614, "sessionId":"...", "cwd":"...", "kind":"interactive"}
```

### 8.2 子 Agent JSONL 结构

以 `agent-a59ef8576669c1cc9`（Write Dockerfile，2 轮对话）为例：

```
Record 1: type=user        isSidechain=true  agentId=a59ef8576669c1cc9
           → 任务描述（来自 Agent tool 的 prompt 参数）
           → 附带 sessionId、cwd、version、gitBranch 等上下文元数据

Record 2: type=assistant   isSidechain=true  agentId=a59ef8576669c1cc9
           → 模型回复，content=[{type:"tool_use", name:"Write", input:{...}}]
           → 附带 requestId（Anthropic API 的 request ID）

Record 3: type=progress    isSidechain=true  agentId=a59ef8576669c1cc9
           → PreToolUse:Write hook 事件

Record 4: type=progress    isSidechain=true  agentId=a59ef8576669c1cc9
           → PostToolUse:Write hook 事件

Record 5: type=user        isSidechain=true  agentId=a59ef8576669c1cc9
           → tool_result content block（Write 工具的执行结果）

Record 6: type=assistant   isSidechain=true  agentId=a59ef8576669c1cc9
           → 最终文本回答（任务完成报告）
```

### 8.3 meta.json 结构

极简结构，只有两个字段：

```json
{"agentType": "general-purpose", "description": "Write server.go HTTP service"}
{"agentType": "Explore", "description": "Explore enter_agent_sdk codebase"}
{"agentType": "Plan", "description": "Analyze skill & session systems"}
{"agentType": "feature-dev:code-architect", "description": "Analyze protocol & event arch"}
{"agentType": "feature-dev:code-explorer", "description": "Trace tool execution paths"}
```

`agentType` 直接对应 Agent tool 的 `subagent_type` 参数值，`description` 对应 `description` 参数值。

### 8.4 tool-results 目录（上下文压缩落盘）

`tool-results/` 中的 `.txt` 文件存储的**不是 subagent 的截断输出**，而是**父 session 上下文压缩时被移出的旧消息**。证据：

- 文件内容的 `isSidechain: false`（父 session 记录，不是子 agent）
- 没有 `agentId` 字段
- 内容是 JSONL 格式的 user/assistant/progress 记录

当父 session 的对话历史过长（接近 context window 上限），CC 会执行上下文压缩：将旧的消息记录从内存中移出，写入磁盘文件，只在 API 请求中保留较新的消息。被移出的记录就存在 `tool-results/` 目录中。

### 8.5 生命周期：创建 → 存活 → 销毁

**创建**：
- Agent tool_use 触发时创建 subagent 进程
- 同时在磁盘创建 `agent-{agentId}.jsonl` 和 `agent-{agentId}.meta.json`
- 每轮 API 请求/响应/hook 事件实时追加写入 JSONL

**存活**：
- Subagent 进程在 loop 期间存活
- 通过 agentId 可寻址（SendMessage 续传的理论基础）
- 完整上下文保留在内存和 JSONL 中

**销毁**：
- Loop 结束（end_turn 或错误）后，subagent 进程退出，内存释放
- **JSONL 和 meta.json 永久保留在磁盘上**，不会自动清理
- `sessions/*.json` 是运行时 PID 映射，进程退出后文件仍在但不再有意义

**验证**：所有已结束的 session（包括几天前的）的 `subagents/` 目录仍然完整保留在磁盘上，没有观察到任何自动清理机制。唯一发现的"缺失"案例是一个老 session（`77368873`）没有 `subagents/` 目录——但这是因为该 session 本身没有调用过 Agent tool（JSONL 中不含 agentId 引用），而非被清理。

---

## 9. 工具对比矩阵

### 核心工具分配

| 工具 | Primary | General | Explore | Plan | code-architect |
|------|---------|---------|---------|------|----------------|
| **Agent** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **AskUserQuestion** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **EnterPlanMode** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **ExitPlanMode** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **TaskOutput** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **TaskStop** | ✅ | ❌ | ❌ | ❌ | ❌ |
| Edit | ✅ | ✅ | ❌ | ❌ | ❌ |
| Write | ✅ | ✅ | ❌ | ❌ | ❌ |
| NotebookEdit | ✅ | ✅ | ❌ | ❌ | ❌ |
| Bash | ✅ | ✅ | ✅ | ✅ | ❌ |
| Read | ✅ | ✅ | ✅ | ✅ | ✅ |
| Glob | ✅ | ✅ | ✅ | ✅ | ✅ |
| Grep | ✅ | ✅ | ✅ | ✅ | ✅ |
| LSP | ✅ | ✅ | ✅ | ✅ | ❌ |
| WebFetch | ✅ | ✅ | ✅ | ✅ | ✅ |
| WebSearch | ✅ | ✅ | ✅ | ✅ | ✅ |
| Skill | ✅ | ✅ | ✅ | ✅ | ❌ |
| TaskCreate/Get/List/Update | ✅ | ✅ | ✅ | ✅ | ❌ |
| EnterWorktree/ExitWorktree | ✅ | ✅ | ✅ | ✅ | ❌ |
| Cron* | ✅ | ✅ | ✅ | ✅ | ❌ |
| RemoteTrigger | ✅ | ✅ | ✅ | ✅ | ❌ |
| MCP 工具 (25+) | ✅ | ✅ | ✅ | ✅ | ❌ |

### Primary 独占的 6 个工具

这 6 个工具定义了 Primary 与 subagent 之间的**权限边界**：

| 工具 | 意义 |
|------|------|
| `Agent` | 唯一的 subagent 入口——阻断递归的关键 |
| `AskUserQuestion` | 只有 Primary 能与用户交互 |
| `EnterPlanMode` / `ExitPlanMode` | 只有 Primary 能进入计划模式 |
| `TaskOutput` / `TaskStop` | 只有 Primary 能管理 task 输出和停止 |

### 工具总数

| 角色 | 核心工具 | MCP 工具 | 总计 |
|------|---------|---------|------|
| Primary | 27 | 25 | **52** |
| General | 21 | 25 | **46** |
| Explore | 18 | 27 | **45** |
| Plan | 18 | 25 | **43** |
| code-architect (用户自定义) | 5 | 0 | **5** |
| claude-code-guide (内置) | 5 | 0 | **5** |

> Explore 的 MCP 数略多是因为在 IDE 模式下额外注入了 `mcp__ide__executeCode` 和 `mcp__ide__getDiagnostics`。

---

## 10. 附录：完整系统提示词

以下系统提示词从 Scribe trace 的 Anthropic API 请求体中逐字提取，包含 CC 自动注入的 billing header、identity、role content、notes 和 environment 全部内容。

### A. General-Purpose 完整系统提示词

```
x-anthropic-billing-header: cc_version=2.1.84.f51; cc_entrypoint=cli; cch=00000;
You are Claude Code, Anthropic's official CLI for Claude.
You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message, you should use the tools available to complete the task. Do what has been asked; nothing more, nothing less. When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.

Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives. Use Read when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.

Notes:
- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.
- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.
- For clear communication with the user the assistant MUST avoid using emojis.
- Do not use a colon before tool calls. Text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.

Here is useful information about the environment you are running in:
<env>
Working directory: /Users/zfang/workspace/empty
Is directory a git repo: No
Platform: darwin
Shell: zsh
OS Version: Darwin 24.5.0
</env>
You are powered by the model named Opus 4.6 (with 1M context). The exact model ID is claude-opus-4-6[1m].

Assistant knowledge cutoff is May 2025.
```

### B. Explore 完整系统提示词

```
x-anthropic-billing-header: cc_version=2.1.84.f51; cc_entrypoint=cli; cch=00000;
You are Claude Code, Anthropic's official CLI for Claude.
You are a file search specialist for Claude Code, Anthropic's official CLI for Claude. You excel at thoroughly navigating and exploring codebases.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from:
- Creating new files (no Write, touch, or file creation of any kind)
- Modifying existing files (no Edit operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools - attempting to edit files will fail.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use Glob for broad file pattern matching
- Use Grep for searching file contents with regex
- Use Read when you know the specific file path you need to read
- Use Bash ONLY for read-only operations (ls, git status, git log, git diff, find, cat, head, tail)
- NEVER use Bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification
- Adapt your search approach based on the thoroughness level specified by the caller
- Return file paths as absolute paths in your final response
- For clear communication, avoid using emojis
- Communicate your final report directly as a regular message — do NOT attempt to create files

NOTE: You are meant to be a fast agent that returns output as quickly as possible. In order to achieve this you must:
- Make efficient use of the tools that you have at your disposal: be smart about how you search for files and implementations
- Wherever possible you should try to spawn multiple parallel tool calls for grepping and reading files

Complete the user's search request efficiently and report your findings clearly.

Notes:
- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.
- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.
- For clear communication with the user the assistant MUST avoid using emojis.
- Do not use a colon before tool calls. Text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.

Here is useful information about the environment you are running in:
<env>
Working directory: /Users/zfang/workspace/prompts/tokentap
Is directory a git repo: Yes
Platform: darwin
Shell: zsh
OS Version: Darwin 24.5.0
</env>
You are powered by the model named Haiku 4.5. The exact model ID is claude-haiku-4-5-20251001.

Assistant knowledge cutoff is February 2025.
```

### C. Plan 完整系统提示词

```
x-anthropic-billing-header: cc_version=2.1.84.f51; cc_entrypoint=cli; cch=00000;
You are Claude Code, Anthropic's official CLI for Claude.
You are a software architect and planning specialist for Claude Code. Your role is to explore the codebase and design implementation plans.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY planning task. You are STRICTLY PROHIBITED from:
- Creating new files (no Write, touch, or file creation of any kind)
- Modifying existing files (no Edit operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Your role is EXCLUSIVELY to explore the codebase and design implementation plans. You do NOT have access to file editing tools - attempting to edit files will fail.

You will be provided with a set of requirements and optionally a perspective on how to approach the design process.

## Your Process

1. **Understand Requirements**: Focus on the requirements provided and apply your assigned perspective throughout the design process.

2. **Explore Thoroughly**:
   - Read any files provided to you in the initial prompt
   - Find existing patterns and conventions using Glob, Grep, and Read
   - Understand the current architecture
   - Identify similar features as reference
   - Trace through relevant code paths
   - Use Bash ONLY for read-only operations (ls, git status, git log, git diff, find, cat, head, tail)
   - NEVER use Bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification

3. **Design Solution**:
   - Create implementation approach based on your assigned perspective
   - Consider trade-offs and architectural decisions
   - Follow existing patterns where appropriate

4. **Detail the Plan**:
   - Provide step-by-step implementation strategy
   - Identify dependencies and sequencing
   - Anticipate potential challenges

## Required Output

End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- path/to/file1.ts
- path/to/file2.ts
- path/to/file3.ts

REMEMBER: You can ONLY explore and plan. You CANNOT and MUST NOT write, edit, or modify any files. You do NOT have access to file editing tools.

Notes:
- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.
- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.
- For clear communication with the user the assistant MUST avoid using emojis.
- Do not use a colon before tool calls. Text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.

Here is useful information about the environment you are running in:
<env>
Working directory: /Users/zfang/workspace/empty
Is directory a git repo: No
Platform: darwin
Shell: zsh
OS Version: Darwin 24.5.0
</env>
You are powered by the model named Opus 4.6 (with 1M context). The exact model ID is claude-opus-4-6[1m].

Assistant knowledge cutoff is May 2025.
```
