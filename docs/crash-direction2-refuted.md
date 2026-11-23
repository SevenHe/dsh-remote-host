# 方向 2 否证：把 socket 创建移出同步栈并不能避免崩溃

## 结论（第一句）

**方向 2 否证。** 修正守卫后（attempt 只排队、runAttempt 同步干活），实验有效性达标
（listener-attach = 10 > 0，attempt-queued/attempt-run 各 10），
但极短抖动 0.6s x 5 轮仍然 **RENDER_GONE = 5（5/5 崩）**，rows 仍为 0。
结合实验 B（完全不创建 socket -> 0 崩溃），结论收敛为：
**触发点是「创建重连 socket 这个动作」本身，与它在哪层栈上执行无关。**

## 1. 本轮三个原始数字

| 指标 | 值 | 说明 |
| --- | --- | --- |
| listener-attach | **10** | > 0，证明 socket 真的被创建，实验有效（不是上一次那种 0 次） |
| attempt-queued / attempt-run | 10 / 10 | 排队与执行一一对应，没有 717 次空转 |
| **RENDER_GONE** | **5** | 5 轮全崩，exitCode:5，与不延迟创建时完全一致 |
| rows | 0 | 仍无会话行；boots=3（崩了多次） |

掉线时刻：19:10:02 / 19:10:31 / 19:10:59 / 19:11:28 / 19:11:57；
崩溃：11:10:48 / 11:11:16 / 11:11:45 / 11:12:13 (Z) + 1 次更早 —— 每轮一次。

## 2. 三个实验合起来的完整判据

| 实验 | 条件 | RENDER_GONE | 结论 |
| --- | --- | --- | --- |
| A（有效版=本轮方向 2） | 创建 socket，但在 setTimeout 的新栈上 | **5/5** | 移出同步栈**无效** |
| B | 完全不创建 socket | **0** | 不创建就**不崩** |
| 历史基线 | 在定时器回调里直接创建 | **5/5** | 创建即崩 |

三者合起来：**创建动作**是触发点，栈位置不是。

## 3. 因此修法只剩方向 1

既然只要我们自己 new WebSocket 就会崩，插件侧唯一可行的路线是**不再自建 mux socket**：

1. 远端腿断开后**不重连**，只把状态标为 error 并让页面感知；
2. 用轻量探测（例如 fetch 一次 session/list）判断远端是否恢复；
3. 恢复后**让官方连接层自己去连**（刷新页面 / 触发客户端自己的 reconnect），或交由宿主侧中继。

这与「交还官方层」不同：之前交还的是我们自己的 mux socket 关闭（官方层随后仍会连到我们的 router，
我们依旧要在 router 里新建远端腿）；方向 1 要求的是**根本不承担远端连接**。

## 4. 代码状态（临时实验代码已回退）

- 已回退：attempt/runAttempt 拆分、attemptDeferred、attempt-queued 全部移除；
- 保留真实修复：死 socket 守卫（d9b2933）、放弃卡死 CONNECTING socket（bbddd74）；
- 保留诊断打点（socketId / readyState / stackDepth / attempt-* / connect-return / listener-attach）；
- npm run check：74/74。
