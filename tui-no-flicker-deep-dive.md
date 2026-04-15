# 终端不闪烁的秘密：从 Alt Screen 到 Claude Code NO_FLICKER

> 一份关于终端渲染原理、TUI 开发范式、以及 Claude Code NO_FLICKER 实现机制的技术总结。

---

## 一、终端的两块屏幕

### 你以为终端只有一个屏幕，其实有两个

终端模拟器（iTerm2、Ghostty、Kitty、Windows Terminal 等）内部维护着**两块独立的屏幕缓冲区**：

- **主屏幕（Main Screen）**：日常 shell 使用的那个。特点是有 **scrollback**——内容可以无限往下追加，超出可见区域的部分存在终端的回滚缓冲区里，用户可以鼠标滚轮或 Shift+PageUp 往回翻看历史。
- **备用屏幕（Alternate Screen / Alt Screen）**：一块和终端窗口等大的**固定画布**。没有 scrollback，退出后内容消失，主屏幕原样恢复。

你每天都在用 alt screen——**vim、less、htop、man、top** 打开时进入，退出后恢复 shell 内容，好像什么都没发生过。

### 切换方式

程序只需要往 stdout 写两条转义序列：

```
进入 alt screen：ESC[?1049h   （DEC Private Mode 1049 — terminfo 中叫 smcup）
退出 alt screen：ESC[?1049l   （rmcup）
```

终端模拟器收到这些序列后执行对应操作。这不是操作系统的功能，是终端模拟器自己实现的。

### 这套设计从哪来的

来自上世纪 70 年代的 **DEC VT100 系列硬件终端**（1978 年）。VT100 是第一款广泛支持 ANSI 转义序列的视频终端，奠定了现代终端标准。主/备屏幕切换最初是硬件功能。后来 **xterm**（1984 年，X Window System 的标准终端）用软件模拟了这些行为，成为事实标准。

备用屏幕的演进经历了三代 DEC 私有模式：
- **Mode 47**：最早的备用屏幕切换
- **Mode 1047**：xterm 扩展，增加了清屏行为
- **Mode 1049**：最常用，组合了保存/恢复光标和屏幕切换

现在所有主流终端模拟器都支持 Mode 1049。

---

## 二、闪烁从哪来

### 主屏幕渲染 TUI 的困境

主屏幕像一卷纸带，只能往下追加内容。当程序需要更新 UI 时：

```
假设终端 10 行高，UI 内容有 30 行

第 1-20 行：已经滚到 scrollback 里了
第 21-30 行：当前可见区域 ← 光标只能在这里移动
```

光标的定位指令（`ESC[行;列H`）**只能在当前可见区域内工作**。终端没有暴露任何接口让程序修改 scrollback 中的内容——这是设计上的有意选择：scrollback 是给人翻历史用的只读记录，程序不该篡改它。

所以当 scrollback 里的旧内容需要更新时，程序**无法局部修改**，唯一的选择是：

```
第 1 步：清掉整个屏幕（ESC[2J）
         ← 这一瞬间屏幕是空白的
第 2 步：从头重新画全部内容
         ← 新内容开始出现
```

**第 1 步和第 2 步之间的空白瞬间 = 闪烁。**

内容越长越严重，因为超出一屏的部分越多，全量重画的数据量越大，空白持续时间越长。

### 如果内容没超出一屏呢？

不会闪。光标能到所有内容的位置，可以局部修改。闪烁不是主屏幕的"默认行为"，而是 scrollback 导致光标够不到旧内容时的**副作用**。

---

## 三、Alt Screen 为什么不闪

Alt screen 没有 scrollback，画布大小固定等于终端窗口。光标能移到任意位置：

```
第 3 行第 5 列的字从 "a" 变成 "b"
→ ESC[3;5H    光标移到 (3,5)
→ 写 "b"
→ 完事，其他位置纹丝不动
```

**不需要清屏，不需要重画，没有空白瞬间。**

类比：
- **主屏幕更新** = 擦黑板重写，擦的时候是空白的
- **Alt screen 更新** = 直接改几个字，其他内容不动

### 代价是什么

Alt screen 没有 scrollback，内容超出屏幕就没了。所以程序必须**自己实现滚动**：在内存里维护全部数据，用户滚动时重新计算可见区域，把对应的那一页画上去。终端不知道在"滚动"，它只看到"这些位置的字变了"。

| | 主屏幕 scrollback | Alt screen 模拟滚动 |
|---|---|---|
| 谁管滚动 | 终端模拟器 | 程序自己 |
| 历史存在哪 | 终端的回滚缓冲区 | 程序的内存 |
| 程序能控制吗 | 不能 | 完全控制 |
| 实现成本 | 零，终端白送 | 得自己写全套滚动逻辑 |

---

## 四、TUI 渲染的经典范式

在 alt screen 上高效渲染 UI，业界积累了几十年的经验。

### 4.1 双缓冲（Double Buffering）

维护前后两个屏幕缓冲区（screen buffer），在内存中完成所有绘制，计算出新旧两帧的差异，然后一次性把变化写到终端。避免了"边画边显示"导致的视觉撕裂。

这是 **ncurses**（1993 年起，C 语言 TUI 基石库）确立的经典做法，几乎所有后续框架都继承了。

### 4.2 Cell 级 Diff

逐单元格（cell = 一个字符位置 + 样式属性）比较新旧帧，只输出变化的 cell：

```
旧帧: [H][e][l][l][o][ ][ ][ ]
新帧: [H][e][l][l][o][!][ ][ ]
                      ^ 只有这一个 cell 变了
→ 光标移到第 6 列，写 "!"
```

ncurses、Ratatui（Rust）、Claude Code 的 Ink 渲染器都采用这个策略。

### 4.3 硬件滚动（DECSTBM）

终端支持设定滚动区域（`ESC[top;bottom r`），然后用 `ESC[nS`（上滚）/ `ESC[nT`（下滚）让终端**硬件级**移动行内容。比逐行重写快一个数量级，特别适合聊天列表、日志流这种内容频繁上推的场景。

### 4.4 即时模式 vs 保留模式

- **即时模式（Immediate Mode）**：每帧声明完整 UI，框架 diff 后渲染。Ratatui 是典型代表。简单直观，但每帧都要构建完整 UI 树。
- **保留模式（Retained Mode）**：维护组件树/DOM，状态变化时按需更新子树。Ink（React 模型）、Textual（Python）是代表。首次渲染成本高，但增量更新高效。

### 4.5 同步渲染（Synchronized Output）

现代终端支持 **DEC Mode 2026**（也叫 BSU/ESU），用 `ESC[?2026h` 开始、`ESC[?2026l` 结束，告诉终端"这之间的输出是一帧，攒着一起显示"。防止中间状态被用户看到。iTerm2、Ghostty、Kitty 都支持。

---

## 五、各主流 TUI 框架一览

| 框架 | 语言 | 渲染模式 | Alt Screen | 关键特点 |
|---|---|---|---|---|
| **ncurses** | C | 双缓冲 + cell diff | 支持 | TUI 基石，终端无关性（terminfo） |
| **Bubble Tea** | Go | 函数式（Elm Architecture） | 内建支持 | Charm 生态，`v.AltScreen = true` 一行搞定 |
| **Ink** | Node.js | React reconciler + Yoga 布局 | 需手动实现 | 组件化，但最初设计面向主屏幕顺序输出 |
| **Ratatui** | Rust | 即时模式 + 双缓冲 | 内建支持 | 高性能，社区活跃 |
| **Textual** | Python | CSS 样式 + 异步 widget | 内建支持 | 基于 Rich，甚至可通过 Web 运行 |
| **Blessed** | Node.js | 类 curses 高级 widget | 支持 | 已停止维护 |

注意 **Ink 是个异类**：它最初的设计目标是在主屏幕上渲染类似 npm 进度条的 UI，不是全屏应用。React 的组件模型非常适合 TUI，但 Ink 缺少 alt screen、虚拟滚动、鼠标事件等全屏 TUI 的基础设施。Claude Code 在 Ink 之上硬造了这一整套（`src/ink/` 目录），工程量巨大。

---

## 六、Claude Code NO_FLICKER 实现详解

### 6.1 整体架构

```
CLAUDE_CODE_NO_FLICKER=1
  → isFullscreenEnvEnabled() 返回 true
  → REPL 根节点包裹 <AlternateScreen> 组件
  → 进入 alt screen + 启用鼠标追踪
  → 所有内容在 <FullscreenLayout> 中渲染
    → 消息列表在 <ScrollBox> 中虚拟滚动
    → 底部输入框通过 flexbox 固定
```

### 6.2 关键组件

**`<AlternateScreen>`**（`src/ink/components/AlternateScreen.tsx`）

mount 时发送转义序列进入 alt screen：
```
ESC[?1049h    进入备用屏幕
ESC[2J        清屏
ESC[H         光标归位
+ 鼠标追踪启用码
```

unmount 时关闭鼠标追踪 + 退出 alt screen，恢复主屏幕。

高度约束为终端行数（`height={terminalRows}`），确保内容永远不超出画布。

**`<ScrollBox>`**（`src/ink/components/ScrollBox.tsx`）

核心的虚拟滚动容器。在内存中维护完整内容，根据 `scrollTop` 值只渲染可见区域：

- `scrollTo(y)` / `scrollBy(dy)`：直接修改 DOM 节点的 scrollTop，绕过 React 状态更新，零开销
- `stickyScroll`：流式输出时自动跟到底部，用户手动上翻时解除
- `scrollToElement(el)`：延迟到渲染时读取 Yoga 布局值，避免数据过期

**渲染器**（`src/ink/renderer.ts`）

将 React 组件树（通过 Yoga 计算 Flexbox 布局）渲染到内存中的 screen buffer（cell 二维数组）。

关键优化：alt screen 模式下把 viewport 高度设为 `terminalRows + 1`，使 `shouldClearScreen()` 永远为 false——从逻辑上堵死了全量重绘路径。

**差分输出**（`src/ink/log-update.ts`）

对比前后两帧的 screen buffer，生成最小化的终端输出：

1. **Cell diff**：逐 cell 比较，只输出变化的字符和样式
2. **DECSTBM 硬件滚动**：当 ScrollBox 的 scrollTop 变化时，用终端硬件指令移动行内容，再在内存中对前一帧做同样的移动，使后续 diff 只发现新行是"变化"
3. **Blit 优化**：未变化的子树直接从前一帧 buffer 复制（blit），不重新渲染

代码里有个函数叫 `fullResetSequence_CAUSES_FLICKER()`——"会导致闪烁的全量重绘"。alt screen 模式的核心目标就是**永远不走到这个函数**。

### 6.3 流式输出时的渲染流程

AI 一个 token 一个 token 吐出来时：

```
收到新 token
  → React 更新消息组件
  → ScrollBox 的 stickyScroll 检测到内容增长 + 用户在底部
    → 自动把 scrollTop 设到新的 maxScroll
  → Yoga 重新布局（只计算变化的节点）
  → render-node-to-output 画到新的 screen buffer
    → 没变的节点 blit（从前一帧复制）
    → 只重新渲染变化的子树
  → log-update diff 新旧 buffer
    → 内容上移？→ DECSTBM 硬件滚动，只补画新行
    → 其他差异？→ 光标定位 + 写几个字符
  → 输出到 alt screen（可能整帧只有几十字节）
```

### 6.4 环境变量体系

```bash
CLAUDE_CODE_NO_FLICKER=1              # 开启全屏无闪烁模式
CLAUDE_CODE_NO_FLICKER=0              # 强制关闭（即使是内部员工）
CLAUDE_CODE_DISABLE_MOUSE=1           # 保留全屏但关闭鼠标捕获（保留键盘翻页）
CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1    # 只禁用点击，保留滚轮
```

默认行为：
- Anthropic 内部员工（`USER_TYPE=ant`）：默认开启
- 外部用户：默认关闭，需手动 `=1` 开启
- tmux -CC 模式（iTerm2 集成）：自动禁用（alt screen 会破坏 iTerm2 的 tmux 集成）

### 6.5 边界情况处理

- **tmux -CC 检测**：通过 `tmux display-message -p '#{client_control_mode}'` 同步探测，避免异步竞态
- **SIGCONT 恢复**：进程挂起恢复后重新进入 alt screen + 重新启用鼠标追踪
- **编辑器交接**：vim/nano 会自己发 smcup/rmcup，Claude Code 在编辑器退出后重新进入 alt screen
- **终端 resize**：重新断言鼠标追踪，不重新发 `ESC[?1049h`（iTerm2 会把它当清屏）
- **信号退出清理**：signal-exit 时确保退出 alt screen、关闭鼠标追踪，不留脏状态

---

## 七、Crush 的对比

Charm 的 Crush 从第一天就走 alt screen 路线，因为 Bubble Tea v2 天然支持：

```go
func (m *UI) View() tea.View {
    v.AltScreen = true                              // 一行进 alt screen
    v.MouseMode = tea.MouseModeCellMotion            // 一行开鼠标
    canvas := uv.NewScreenBuffer(m.width, m.height)  // 内存画布
    m.Draw(canvas, canvas.Bounds())                  // 画到内存
    v.Content = canvas.Render()                      // 一次性输出
    return v
}
```

| | Claude Code (Ink) | Crush (Bubble Tea v2) |
|---|---|---|
| Alt Screen | 手动发转义序列，自建 `<AlternateScreen>` 组件 | `v.AltScreen = true` |
| 双缓冲 | 自建 screen buffer + cell-level diff | 框架内建 |
| 虚拟滚动 | 自建 `<ScrollBox>` + viewport culling | `list.List` lazy rendering |
| 鼠标 | 手动启用 SGR mode 1000/1002/1006 | `v.MouseMode = tea.MouseModeCellMotion` |
| 硬件滚动 | 实现了 DECSTBM 优化 | 未实现 |
| Diff 粒度 | Cell 级（只写变化的字符） | 帧级（整帧渲染后由框架 diff） |

Claude Code 的 cell-level diff 在 SSH 等高延迟场景下带宽更省，但实现复杂度高出一个数量级。

---

## 八、一句话总结

进入 alt screen 得到一块固定大小的白板，在内存里算好新旧两帧的差异，只把变化的部分写上去。主屏幕全程挂起，不参与渲染。而闪烁正来自于**主屏幕清屏重画之间的空白瞬间**。

这是 TUI 领域几十年的标准做法，vim/htop/ncurses 从一开始就这么干。Claude Code 因为 Ink 框架的历史包袱绕了一大圈才补上，Crush 则因为 Go 生态（Bubble Tea）的成熟从第一天就具备。本质上是同一个思路，工程复杂度不同。

---

## 附录：ANSI 转义序列速查

终端控制指令统一格式为 `ESC[` + 参数 + 命令字母，其中 `ESC` 是转义字符（`\x1b`，十六进制 1B），`ESC[` 合称 **CSI**（Control Sequence Introducer）。

### 拆解示例

以 `ESC[2J`（清除整个屏幕）为例：

```
ESC     [     2     J
 ↓      ↓     ↓     ↓
转义符  CSI   参数   命令
\x1b    [     2     J
```

### 光标控制

| 序列 | 含义 |
|---|---|
| `ESC[H` | 光标归位（左上角） |
| `ESC[3;5H` | 光标移到第 3 行第 5 列 |
| `ESC[nA` | 光标上移 n 行 |
| `ESC[nB` | 光标下移 n 行 |
| `ESC[nC` | 光标右移 n 列 |
| `ESC[nD` | 光标左移 n 列 |

### 擦除操作

| 序列 | 含义 |
|---|---|
| `ESC[J` 或 `ESC[0J` | 擦除光标到屏幕末尾 |
| `ESC[1J` | 擦除屏幕开头到光标 |
| `ESC[2J` | 擦除整个屏幕（**闪烁的元凶**） |
| `ESC[K` 或 `ESC[0K` | 擦除光标到行末 |
| `ESC[2K` | 擦除整行 |

### 滚动区域（DECSTBM）

| 序列 | 含义 |
|---|---|
| `ESC[5;20r` | 设第 5~20 行为滚动区域 |
| `ESC[r` | 重置滚动区域为全屏 |
| `ESC[nS` | 滚动区域内上滚 n 行 |
| `ESC[nT` | 滚动区域内下滚 n 行 |

### 样式（SGR）

| 序列 | 含义 |
|---|---|
| `ESC[0m` | 重置所有样式 |
| `ESC[1m` | 粗体 |
| `ESC[3m` | 斜体 |
| `ESC[4m` | 下划线 |
| `ESC[38;5;196m` | 前景色：256 色中的第 196 号（红色） |
| `ESC[48;5;21m` | 背景色：256 色中的第 21 号（蓝色） |
| `ESC[38;2;255;100;0m` | 前景色：TrueColor RGB(255,100,0) |

### DEC 私有模式（`?` 前缀）

| 序列 | 含义 |
|---|---|
| `ESC[?25h` | 显示光标 |
| `ESC[?25l` | 隐藏光标 |
| `ESC[?1049h` | **进入 alt screen**（smcup） |
| `ESC[?1049l` | **退出 alt screen**（rmcup） |
| `ESC[?2004h` | 启用 bracketed paste 模式 |
| `ESC[?2026h` | 启用同步渲染（BSU，Begin Synchronized Update） |
| `ESC[?2026l` | 结束同步渲染（ESU） |

### 鼠标追踪（SGR 模式）

| 序列 | 含义 |
|---|---|
| `ESC[?1000h` | 启用基本鼠标追踪（点击） |
| `ESC[?1002h` | 启用按钮事件追踪（点击 + 拖拽） |
| `ESC[?1003h` | 启用全事件追踪（移动 + 点击 + 拖拽） |
| `ESC[?1006h` | 启用 SGR 扩展模式（精确坐标，突破 223 列限制） |

### 记忆技巧

命令字母是有规律的：
- **H** = Home / 定位（cursor **H**ome）
- **J** = 擦屏（erase in **J**... 历史原因，VT100 沿用）
- **K** = 擦行（erase in line，紧跟 J 的下一个字母）
- **m** = 样式（SGR，**m**ode）
- **r** = 滚动区域（scroll **r**egion）
- **S/T** = 上滚/下滚（**S**croll up / scroll down 用 **T** 因为紧跟 S）
- **h/l** = 启用/禁用模式（**h**igh = on，**l**ow = off）

---

*调研基于 Claude Code v2.1.88 源码（`cc-v2.1.88-full/src/`）。*
*2026-04-02*
