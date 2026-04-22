# Claude Code 分类器上下文设计哲学与方法论

> 面向实现者的说明文档。本文不先从“哪些东西可信”讲起，而是先从一个更具体的问题讲起：Claude Code 正常主循环里的对话到底长什么样，classifier 又是怎么从这份主对话里抽取材料的。

## 一句话结论

Claude Code 的 classifier 不是第二个主模型。  
它不是来“完整理解整段会话”的，而是来做一次更窄的事：

> 对当前这个高风险动作做安全审批。

所以它不会吃下整份主对话，而是从主对话里只抽一小部分真正和审批有关的内容。

---

## 1. 先看正常的 Claude Code 主循环对话

先不要看 classifier，先看主循环本身。

一个最普通的工具调用回合，大致是这样：

```text
user:
  帮我修一下 src/foo.ts 里的类型错误

assistant:
  我先看文件
  tool_use: Read("src/foo.ts")

user:
  tool_result: "文件内容……"

assistant:
  tool_use: Edit("src/foo.ts", ...)

user:
  tool_result: "编辑成功"

assistant:
  已修好，原因是……
```

这就是 Claude Code 主循环最基础的形状：

- 用户给任务或约束
- assistant 给普通文字说明，或者发出 `tool_use`
- 运行时执行工具
- 工具结果再回到会话里
- assistant 根据结果继续下一步

这里最重要的一点是：

> 主循环里的“对话记录”本来就不只是用户自然语言和 assistant 自然语言。

它还包含：

- `assistant` 发出的 `tool_use`
- 工具执行后回来的 `tool_result`
- 一些本地命令、slash command、系统包装生成的协议文本

也就是说，Claude Code 的主对话本来就是“自然语言 + 工具结构 + 协议文本”的混合体。

---

## 2. 本地命令会让主对话看起来更不像“纯聊天”

如果用户在 Claude Code 里跑的是本地命令，主对话会更明显地呈现出“协议文本”这一面。

例如 bash 输入大致会被记成这样：

```text
user(meta):
  <local-command-caveat>下面这些内容是本地命令生成的……</local-command-caveat>

user:
  <bash-input>git status --short</bash-input>

user:
  <bash-stdout>...</bash-stdout>
  <bash-stderr>...</bash-stderr>
```

slash command 也类似，常见形状是：

```text
user:
  <command-name>/model</command-name>
  <command-message>model</command-message>
  <command-args>sonnet</command-args>

user:
  <local-command-stdout>Set model to Sonnet</local-command-stdout>
```

所以如果你只带着“主对话应该是用户原话和 assistant 原话”这个预设去看 Claude Code 源码，很容易误会很多地方。

更准确的理解是：

> Claude Code 的主对话是一份统一的会话账本，里面既有自然语言，也有工具结构，也有本地交互产生的协议文本。

---

## 3. classifier 不是重建一份新对话，而是从主对话里抽样

现在再看 classifier。

classifier 并不会维护一份独立的“安全专用会话历史”。它做的事情更简单：

> 直接从现有主对话里抽一部分内容，重新拼成一份更小的审批 transcript。

所以理解 classifier 的关键，不是先问“它怎么看世界”，而是先问：

1. 主对话里本来有什么
2. classifier 从中拿走了什么
3. 它为什么只拿这些

---

## 4. classifier 从主对话里拿了哪些东西

按当前实现，classifier 主要拿四类东西：

1. `user` 消息里的 text block
2. `assistant` 消息里的 `tool_use`
3. 当前正在审批的那个动作
4. 可选的 `CLAUDE.md` 前缀

这里有两个非常关键的细节。

### 4.1 它拿的是 `user` 通道里的文本，不是“纯用户原话”

classifier 复用的是 Claude Code 现有消息系统里的 `user` 通道。

这意味着它看到的不是一份单独整理出来的“用户意图清单”，而是：

- 用户自然语言请求
- 用户明确边界
- 某些本地命令包装文本
- 某些 slash command breadcrumb
- 某些后来被放进 `user` 通道里的协议内容

所以更准确的说法是：

> classifier 读取的是“主对话里落在 `user` 通道上的文本”，不是“经过提纯的纯用户原话”。

### 4.2 它拿的是 `user` 里的 text block，不是所有 `user` 内容

这点很重要。

主对话里很多工具结果本来也是挂在 `user` 消息上的，但它们通常是 `tool_result` block，不是 text block。

classifier 在抽历史时，对 `user` 只拿 text block，所以：

- `user` 里的普通文本会进 classifier
- `user` 里的协议文本如果也是 text，也会进 classifier
- `user` 里的 `tool_result` block 不会直接进 classifier

这也是为什么 `bash-stdout` 这种东西会进，而普通工具的 `tool_result` 默认不会进。

原因不是前者更“可信”，而是前者被包成了 text，后者没有。

### 4.3 `CLAUDE.md` 不属于主循环抽样，它属于额外注入的长期用户前缀

`CLAUDE.md` 在这里要单独看，因为它和前面两类来源都不一样。

它不是：

- 主循环里自然滚出来的一轮轮对话
- 某个工具结果
- assistant 自己的说明

它更像是：

- 持久化的用户指令
- 长期有效的用户边界
- 项目级共享工作约定

所以如果放到 classifier 语境里，`CLAUDE.md` 最准确的定位不是“当前这轮 user 输入”，而是：

> 启动时额外注入的一段长期用户前缀。

这也解释了为什么它值得进入 classifier。

因为如果 auto mode 只看本轮聊天，它就看不到很多用户并不会每轮都重讲、但又确实长期有效的东西，比如：

- 不要 push
- 改完先跑测试
- 某些目录不要碰
- 某类改动必须遵守特定流程

所以 `CLAUDE.md` 被带进 classifier，不是为了补充“更多世界事实”，而是为了补充：

- 长期用户意图
- 长期用户边界
- 长期项目约定

---

## 5. classifier 明确不拿哪些东西

默认不会直接进入 classifier 历史视图的，有三类最重要：

- `assistant` 的普通文字说明
- `tool_result`
- 普通 `system` 消息

所以 classifier 看到的并不是完整主对话，而是一个非常偏心的切片：

- 偏向 `user` 侧文本
- 偏向 `assistant` 的动作结构
- 有意丢弃 assistant 自己的解释
- 有意丢弃大部分工具结果

---

## 6. 为什么只拿这些，这是抽象层

如果只从抽象层说，Claude Code 的 classifier 其实只想解决两个问题：

1. 这次动作是不是用户真的允许做
2. agent 现在具体打算做什么

围绕这两个问题，主对话里的内容可以粗分成四类：

- 授权和边界
- 当前动作
- agent 自己的解释
- 外界返回的结果

Claude Code 只愿意把前两类当审批主材料。

### 6.1 为什么要拿 `user` 文本

因为用户是授权主体。

classifier 如果看不到用户说了什么，就没法判断：

- 用户有没有明确要求这件事
- 用户有没有明确禁止这件事
- 用户是不是只给了一个模糊目标，而 agent 自己把动作扩大了

所以 `user` 文本必须进入 classifier。

### 6.2 为什么要拿 `assistant tool_use`

因为 classifier 不是在审批“想法”，而是在审批“动作”。

只有看到当前工具调用和关键参数，classifier 才知道：

- agent 现在到底想做什么
- 这个动作是不是越权了
- 这个动作是不是超出了用户原本的范围

所以 `assistant tool_use` 也必须进入 classifier。

### 6.3 为什么不拿 assistant 的普通文字说明

因为那是 agent 自己写给自己的解释。

如果把这些解释也送进 classifier，结构就会变成：

- agent 先决定要做什么
- agent 再写一段“为什么我觉得可以”
- classifier 根据这段话批准它

这会让审批器失去独立性。

所以 Claude Code 的态度很明确：

> agent 自己的解释，不能拿来给自己洗白。

### 6.4 为什么不拿大部分工具结果

因为工具结果虽然可能有用，但它们不是授权来源。

网页、搜索、MCP、Slack、shell 输出、文件内容，这些都可能：

- 被外界操纵
- 被局部截断
- 被 agent 误读
- 被 agent 拿去猜参数

它们可以帮助理解局面，但不能自动升级成“用户已经授权”。

所以 Claude Code 默认把工具结果挡在 classifier 主材料之外。

### 6.5 为什么还要额外引入 `CLAUDE.md`

因为主循环 transcript 解决的是“这一轮刚刚发生了什么”，而 `CLAUDE.md` 解决的是“这个项目长期希望 Claude 怎么做”。

这两者不是一回事。

如果没有 `CLAUDE.md`，classifier 就只能根据当前这几轮聊天判断风险。这样会漏掉很多长期有效、但用户不会每次都重讲的约定和边界。

所以 `CLAUDE.md` 在抽象层上的作用，不是提供更多证据，也不是替代权限系统，而是给 classifier 补上一层：

- 跨会话稳定存在的用户意图
- 跨会话稳定存在的用户边界
- 项目级共享工作方式

它更接近“standing brief”或“长期项目说明”，而不是一段普通聊天记录。

---

## 7. 为什么会出现 `bash-*` / `local-command-*` 这些“看起来不纯”的东西

这正是很多人第一次读源码时最困惑的地方。

答案其实不神秘：

> 因为 classifier 复用的是主对话，而主对话本来就不是纯聊天记录。

`bash-input`、`bash-stdout`、`local-command-caveat` 这些东西，并不是 classifier 专门发明的概念。  
它们首先是 Claude Code 主会话协议的一部分，用来服务：

- 主模型后续轮次理解上下文
- 本地命令和 slash command 的转录
- UI 展示
- 会话存储与恢复

classifier 只是后来从这份共享会话账本里抽样。

所以它们之所以会出现在 classifier 里，不是因为它们被认定为“授权信息”，而是因为：

- 它们本来就在主对话里
- 它们又恰好是 `user` 通道里的 text
- classifier 的抽取规则刚好会把它们带进去

---

## 8. 抽象层收口：进入 classifier 和有资格授权，是两回事

到这里，最容易建立起一个更准确的判断框架：

### 8.1 机械层问题

它会不会进 classifier？

当前规则很简单：

- `user` text 会进
- `assistant tool_use` 会进
- 其他默认不进

### 8.2 语义层问题

它进来以后，算什么？

这时才需要继续分：

- 它是许可
- 是边界
- 是动作
- 是证据
- 还是只是结构

最关键的一句就是：

> 进入 classifier，不等于它就有资格变成授权依据。

例如：

- 用户明确说“去做”：这是许可
- 用户明确说“别做”：这是边界
- `tool_use` 投影：这是动作
- `bash-stdout`：更接近证据
- `local-command-caveat`：更接近结构

所以真正的安全边界不在“它有没有进入 classifier”，而在：

> 它进入以后，能不能被当成许可或边界。

---

## 9. 具体落实又是怎么实现的，这是实际层

上面说的是抽象层。下面落到代码。

### 9.1 主对话怎么产生

主对话的基础消息类型在 [cc-v2.1.88-full/src/utils/messages.ts](/Users/zfang/workspace/zenfun-code/cc-v2.1.88-full/src/utils/messages.ts:460)。

`createUserMessage()` 说明了一件事：Claude Code 的 `user` 消息只是一个统一容器。  
它可以装：

- 人类键盘输入
- 协议文本
- 元信息
- 工具结果

也就是说，源码层面并没有一条“这里只能装纯用户原话”的硬边界。

### 9.2 本地命令文本怎么进入主对话

`processBashCommand()` 在 [processBashCommand.tsx](/Users/zfang/workspace/zenfun-code/cc-v2.1.88-full/src/utils/processUserInput/processBashCommand.tsx:30) 里会直接创建：

- `createSyntheticUserCaveatMessage()`
- `<bash-input>...</bash-input>` 对应的 `user message`
- `<bash-stdout>...</bash-stdout><bash-stderr>...</bash-stderr>` 对应的 `user message`

这就是为什么 bash 相关标签会以 text 的形式进入主对话。

slash command 也类似。  
`processSlashCommand()` 在 [processSlashCommand.tsx](/Users/zfang/workspace/zenfun-code/cc-v2.1.88-full/src/utils/processUserInput/processSlashCommand.tsx:593) 一带，会把 command breadcrumb 和 `local-command-stdout` 作为消息写回会话。

另外，`normalizeMessages()` 在 [messages.ts](/Users/zfang/workspace/zenfun-code/cc-v2.1.88-full/src/utils/messages.ts:2079) 还会把某些 `local_command system message` 转成 `user message`，目的是让主模型后续轮次还能引用前面的命令结果。

### 9.3 classifier 怎么从主对话抽样

真正的抽取规则在 [yoloClassifier.ts](/Users/zfang/workspace/zenfun-code/cc-v2.1.88-full/src/utils/permissions/yoloClassifier.ts:302) 的 `buildTranscriptEntries()`。

它只做三件事：

- 取 `attachment.queued_command.prompt`，按 `user` 算
- 取 `user` 消息里的 text block
- 取 `assistant` 消息里的 `tool_use`

这里有两个实现细节特别重要：

1. 对 `user`，它只取 text block  
   这就是为什么 `tool_result` block 不直接进入 classifier。

2. 对 `assistant`，它只取 `tool_use`  
   注释写得很直白：assistant text 是 model-authored，可能会影响 classifier 的判断。

### 9.4 `CLAUDE.md` 是单独注入 classifier 的，不走主对话抽样

`CLAUDE.md` 的加载链路在 [context.ts](/Users/zfang/workspace/zenfun-code/cc-v2.1.88-full/src/context.ts:155) 和 [claudemd.ts](/Users/zfang/workspace/zenfun-code/cc-v2.1.88-full/src/utils/claudemd.ts:1)。

这里有两个关键点：

1. `getUserContext()` 会先读取并缓存 `claudeMd`  
   它本来就是用户上下文的一部分，而不是 classifier 临时去扫描磁盘现拼出来的。

2. classifier 不从主循环 transcript 里“找出” `CLAUDE.md`  
   它会在 [yoloClassifier.ts](/Users/zfang/workspace/zenfun-code/cc-v2.1.88-full/src/utils/permissions/yoloClassifier.ts:445) 通过 `buildClaudeMdMessage()` 单独构造一条前缀 `user` 消息。

而且这条前缀消息的包装语义写得非常明确：

- 这是用户提供给 agent 的配置
- 在评估动作时，应当把它视为用户意图的一部分

所以从实现上看，`CLAUDE.md` 不属于“主对话抽样”这一层，而属于“classifier 前缀注入”这一层。

### 9.5 `tool_use` 不是原样进入 classifier

`toCompactBlock()` 在 [yoloClassifier.ts](/Users/zfang/workspace/zenfun-code/cc-v2.1.88-full/src/utils/permissions/yoloClassifier.ts:382) 里会对每个 `tool_use` 调 `toAutoClassifierInput()`。

这意味着 classifier 看到的不是整份原始工具输入，而是每个工具自己声明的“最小安全相关投影”。

默认实现甚至是空字符串。  
`Tool` 的默认值在 [Tool.ts](/Users/zfang/workspace/zenfun-code/cc-v2.1.88-full/src/Tool.ts:754)：

> `toAutoClassifierInput` 默认返回 `''`，也就是“这个工具默认不向 classifier 暴露任何安全相关输入”。

这也说明了 Claude Code 的态度：

> classifier 只看动作里真正跟安全审批有关的那一小块，不看整份工具输入。

### 9.6 当前动作会单独再送一次

`classifyYoloAction()` 在 [yoloClassifier.ts](/Users/zfang/workspace/zenfun-code/cc-v2.1.88-full/src/utils/permissions/yoloClassifier.ts:1017) 一带，会把“当前正在审批的动作”单独格式化，再拼到 classifier prompt 的最后。

这表示 classifier 不只是看历史，还会明确看：

- 现在这一刻准备执行的那个动作

这和“审批器”的定位是完全一致的。

---

## 10. 给实现者的实际方法论

如果以后你要往 classifier 周边加东西，最稳的判断顺序是：

### 第一步：先问它会不会进入主对话

如果它根本不进主对话，那 classifier 当然也看不到。

### 第二步：再问它会不会以 `user text` 或 `assistant tool_use` 的形式出现

只有这两条主路，默认会被 classifier 抽走。

### 第三步：最后才问它在审批里是什么角色

只需要问：

- 它是许可
- 边界
- 动作
- 证据
- 还是结构

如果它只是证据或结构，就不要让它越级成授权。

---

## 11. 最终总结

这篇文档真正想说明的其实只有四句话：

1. Claude Code 的主循环对话，本来就是“自然语言 + `tool_use` + `tool_result` + 协议文本”的混合会话账本。
2. classifier 不是重新造一份新对话，而是从这份主对话里抽一个小切片。
3. 这个切片主要是“`user` 通道里的 text + `assistant tool_use` 的最小投影 + 当前动作”，再加上一段单独注入的 `CLAUDE.md` 长期用户前缀，而不是整份主会话。
4. 这样设计的目的，是同时保留两类审批材料：这一轮里的授权来源与动作结构，以及跨会话稳定存在的用户意图和边界；同时尽量排除 assistant 自我解释和外界返回对审批的污染。
