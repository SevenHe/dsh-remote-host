# 方向 C（栈溢出/栈守卫）：实验 1 直接否证；实验 2 无效

## 结论（第一句）

**栈假设被直接测量否证**：崩溃那一刻的真实 JS 调用栈深度是 **3 层**（基线首次连接是 11 层 / 远端 6 层），
且两轮抖动都是 **3 层、不递增**。深度没有达到「几百层」，也不随抖动次数增长。
实验 2（加大 JS 栈）**执行失败、数据无效**，不能作为证据。

## 1. 实验 1：真实栈深度（决定性）

打点位置与实测值（一次极短抖动 2 轮）：

| 打点 | stackDepth |
| --- | --- |
| connect-return（首次 local，基线） | **11** |
| connect-return（首次 remote，基线） | **6** |
| reconnect-enter | 4 |
| attempt-run | 3 |
| connect-return（重连新建 socket） | 4 |
| attempt-socket | 3 |
| **listener-attach（崩溃前最后一条）** | **3** |

原始片段：

    18:56:47.265 reconnect-enter  stackDepth=4
    18:56:47.466 attempt-run      stackDepth=3
    18:56:47.467 connect-return   socketId=3 rs=0 stackDepth=4
    18:56:47.467 attempt-socket   socketId=3 rs=0 stackDepth=3
    18:56:47.467 listener-attach  socketId=3 rs=0 stackDepth=3
    18:56:47.875 listener-attach  socketId=4 rs=0 stackDepth=3
    (随后崩溃)

判读：与基线同量级（甚至更浅，因为重连从定时器回调进入），**没有深栈**。
所以「native 栈爆在 brk」这条解释不成立 —— 至少不是 JS 调用栈耗尽。

## 2. 实验 2：加大 JS 栈 —— **无效数据，不采信**

用 --js-flags=--stack-size=8000000 起 harness，跑 5 轮极短抖动，结果表面上 RENDER_GONE=0，
但验证发现该结果是**假的**：

- 证据文件里 **sample 数 = 0**（harness 从未采到任何页面状态）；
- stderr 里有 **RangeError: Maximum call stack size exceeded**（harness 自身在启动阶段就炸了）；
- 也就是说页面根本没被加载/采样，**0 崩溃毫无意义**。

原因推测：--stack-size 作用于主进程 V8，8MB 反而让 harness 自身的启动路径（含我加的轮询/采样）爆栈。
若仍要做实验 2，应改用较小值（例如 2000000）或只在渲染进程侧设置（Electron 需通过
app.commandLine / RenderProcessPreferences），但**当前证据不支持继续投入**。

## 3. 交付状态

| 项 | 状态 |
| --- | --- |
| 实验 1（栈深度） | ✅ 完成：崩溃时 depth=3，基线 11 → **栈假设否证** |
| 实验 2（加大栈） | ❌ **执行失败**（harness 自身 RangeError，sample=0），数据无效 |
| 短抖动 5 轮 RENDER_GONE | 5 次（本轮 exp1 的 2 轮是 2 次） |
| npm run check | 74/74 |

## 4. 下一步（建议）

栈被排除后，剩下的实质线索只有一条：**死亡发生在「为重连 socket 挂 open 监听器」之后、同一 tick 内**，
且 V8 不打印任何 fatal。这使得最可能的解释回到「官方客户端在 leg 重连后同步重订阅触发 V8 内部 abort」——
这属于官方 bundle 侧，需要那一侧的证据（我无权改）。若还要在插件侧推进，唯一可试的是
**把 socket 创建 + 监听器挂载本身也移出同步栈**（setTimeout 0），看是否能改变死亡点；
但这与「延迟恢复工作」不同，属于一个新的实验，需要你确认是否值得再花一轮。
