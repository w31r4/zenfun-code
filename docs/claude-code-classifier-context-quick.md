# Claude Code Classifier 省流版

> 只回答三个问题：抽出哪些信息，为什么抽这些信息，具体怎么抽。

## 1. 抽出哪些信息

Claude Code 的 classifier 不会读取整份主对话。它只拿下面几类材料：

1. `user` 消息里的 text block
2. `assistant` 消息里的 `tool_use`
3. 当前正在审批的那个动作
4. 单独注入的 `CLAUDE.md` 前缀

默认不直接拿这些：

- `assistant` 的普通文字说明
- 普通 `tool_result`
- 普通 `system` 消息

这里要注意两个边界：

- classifier 拿的是 `user` 里的 text block，不是所有 `user` 内容  
  所以普通工具的 `tool_result` 虽然常常挂在 `user` 消息上，但不会直接进 classifier。

- `CLAUDE.md` 不属于主循环 transcript 抽样  
  它是启动时额外注入的一段长期用户前缀。

## 2. 为什么抽这些信息

因为 classifier 不是第二个主模型，它只做一件更窄的事：

> 审批“当前这个动作能不能放行”。

要完成这件事，它只需要两类核心信息：

### 2.1 授权来源和边界

它需要知道：

- 用户这轮到底说了什么
- 用户有没有明确授权
- 用户有没有明确设边界
- 项目里有没有长期有效的用户约定

所以它要拿：

- `user` 文本
- `CLAUDE.md`

### 2.2 当前动作结构

它还需要知道：

- agent 现在到底准备做什么
- 这个动作是不是越权
- 这个动作是不是超出了用户原本范围

所以它要拿：

- `assistant tool_use`
- 当前正在审批的动作

### 2.3 为什么不拿大部分其他内容

因为这些内容虽然可能有用，但不适合做审批主材料：

- `assistant` 的普通文字说明，是 agent 自己写给自己的解释
- `tool_result`、网页内容、搜索结果、MCP 返回，更接近外界证据

Claude Code 的设计取向是：

- 不让 agent 自己的解释影响审批
- 不让外界返回直接升级成授权

## 3. 具体怎么抽

实际实现分三步。

### 3.1 从主对话里抽历史材料

`buildTranscriptEntries()` 会从主对话里抽：

- `user` 消息里的 text block
- `assistant` 消息里的 `tool_use`
- `attachment.queued_command.prompt` 这类按 `user` 算的输入

对应代码：

- [yoloClassifier.ts](/Users/zfang/workspace/zenfun-code/cc-v2.1.88-full/src/utils/permissions/yoloClassifier.ts:302)

### 3.2 压缩 `tool_use`

`assistant tool_use` 不是原样进入 classifier。

每个工具都会先走 `toAutoClassifierInput()`，把原始输入压成“最小安全相关投影”。

默认情况下，这个投影甚至可以是空字符串，也就是这个工具默认不向 classifier 暴露任何安全相关输入。

对应代码：

- [yoloClassifier.ts](/Users/zfang/workspace/zenfun-code/cc-v2.1.88-full/src/utils/permissions/yoloClassifier.ts:382)
- [Tool.ts](/Users/zfang/workspace/zenfun-code/cc-v2.1.88-full/src/Tool.ts:754)

### 3.3 单独补上 `CLAUDE.md` 和当前动作

`CLAUDE.md` 不从主对话里“找出来”，而是 classifier 在构造 prompt 时单独注入一条前缀 `user` 消息。

当前正在审批的动作，也会单独格式化后再拼到 classifier prompt 末尾。

对应代码：

- [yoloClassifier.ts](/Users/zfang/workspace/zenfun-code/cc-v2.1.88-full/src/utils/permissions/yoloClassifier.ts:445)
- [yoloClassifier.ts](/Users/zfang/workspace/zenfun-code/cc-v2.1.88-full/src/utils/permissions/yoloClassifier.ts:1017)
- [context.ts](/Users/zfang/workspace/zenfun-code/cc-v2.1.88-full/src/context.ts:155)

## 最后一句话

Claude Code classifier 的核心不是“尽量理解整段会话”，而是：

> 从主对话里抽出审批所需的最小材料。

这份最小材料就是：

- 这一轮的用户文本
- 长期有效的 `CLAUDE.md`
- agent 的动作结构
- 当前要审批的动作本身

如果想看长版推导，见 [claude-code-classifier-context-philosophy.md](/Users/zfang/workspace/zenfun-code/docs/claude-code-classifier-context-philosophy.md:1)。
