# 真实 App 的新证据：崩溃发生在**重连成功（remote-open）之后**，不是长时间断连

## 结论（第一句）

真实 App 的 trace 显示：**崩溃前最后一条事件几乎总是 `%remote-open``（远端腿重连成功 + replay）**，随后**心跳完全停止**（``hb`` 每 5 s 一条，但此时 15-34 s 内一条都没有），再过一段时间 App 重启。
即：**页面在「重连成功」的那一刻就冻结了**，不是死在断连期间。这解释了为什么 `DEGRADE_AFTER_MS=3500` 在真实 App 里**触发了 3 次却没能阻止崩溃** —— 那是**另一条路径**。

## 1. 原始证据（崩溃前最后一条链路，inst=devbox#-，App 18:04:42 重启前）

``
18:03:43.307 hb            {"heap":60470801,...}
18:03:53.307 hb            {"heap":71878229,...}
18:04:04.151 hb            {"heap":77401338,...}
18:04:07.241 remote-unavailable {"reason":"close","ms":0}
18:04:07.252 reconnect-begin    {"attempt":1,"depth":1}
18:04:07.252 reconnect-end      {"depth":0}
18:04:08.261 remote-available   {"afterMs":1020}
18:04:08.261 remote-open        {"streams":2}      <- 重连成功、replay 2 条
（此后 34 秒：无 hb、无任何事件）
18:04:42.016 trace-on          <- 新实例启动（上一个已死）
``

断连只持续 **1 秒**（`close` → `remote-open afterMs=1020`），**远低于 3.5 s 降级阈值**，所以这条崩溃与降级逻辑无关。

## 2. 统计（真实 App 的 boot 相关性）

``
boot 17:05:28  last-event=remote-open  gap-before-boot=16s
boot 17:05:50  last-event=remote-open  gap-before-boot=19s
boot 17:10:10  last-event=remote-open  gap-before-boot=16s
boot 17:10:42  last-event=remote-open  gap-before-boot=15s
boot 17:20:59  last-event=remote-open  gap-before-boot=16s
boot 17:21:31  last-event=remote-open  gap-before-boot=16s
boot 17:27:50  last-event=remote-open  gap-before-boot=16s
boot 18:04:42  last-event=remote-open  gap-before-boot=34s
``

- 这些 boot 的「最后一条事件」**都是 `remote-open`，之后 gap 15-34 s；
- 正常时 `hb` 每 5 s 一条，**gap 内一条 hb 都没有 → 主线程在 `remote-open` 之后停止执行**（冻结）；
- 其余 boot 的 last-event 多为 `hb`（那些更像正常重启），说明该模式**特定于重连成功**。

## 3. 机制：两条独立路径（此前被混为一谈）

| 路径 | 触发 | 表现 | 对策 | 现状 |
| --- | --- | --- | --- | --- |
| **A 长时间不可用** | 远端腿持续不可用 > 3.5 s | lab 里 ~5.8-6.0 s 崩（`exitCode:5`） | `degrade()` 交还 mux | ✅ lab 已验证 0 崩溃（`degrade-handoff` x3） |
| **B 重连成功后的 replay/重订阅** | 短抖动后**重连成功**（1 s 内） | 真实 App：`remote-open` 之后**立刻冻结**，~16 s 后进程消失 | **无** | ❌ **未修**，这是 App 现在仍崩的原因 |

路径 B 的现场细节：
- `remote-open {streams:2}` 已落盘（critical flush 生效），但紧邻的 `replay-begin` **没有落盘**；
- 代码顺序是 `onOpen` → `remote-open` → `replayRemoteStreams()` → `replay-begin`，两者都在 critical 白名单里、都会强制 flush；
- **`replay-begin` 缺失** ⇒ 冻结发生在 `remote-open` 之后、`replay-begin` 之前的**极窄区间**；
- 与 replay 体量无关（只有 2 条流）→ **不是量的问题，是那一刻主线程停住**（死循环/重入/阻塞调用）。

## 4. 下一步（定位路径 B）

1. 把 `onOpen` 拆细打点：`open-handled` → `replay-enter` → 每条 `replay-send{i}` → `replay-exit`，全部 critical，精确到「停在哪条语句之前」；
2. lab 里专门复现路径 B：**极短断开（≤1 s）→ 立即恢复**，并让 replay 有多条流（多开会话/follow），目标是打出 `remote-open` 后立即冻结；
3. 若停在 replay 内部：重点查 `sendLeg('remote', …)` 在 socket 未 open 时的 outbox 缓冲，以及 merge 分支（`flushMerged`/`maybeEnd`）是否可能同步递归；
4. 若停在 `remote-open` 与 replay 之间：重点查 `publishStatus('remote','open')` 触发的官方客户端 status 监听器是否同步重订阅。

## 5. 对「降级修复」的评价（据实）

- **解决了路径 A**：同一 lab 序列 `RENDER_GONE` 2 → 0，`degrade-handoff` x3，`unavailableMs` ≈ 5533；
- **无法解决路径 B**：真实 App 降级 3 次仍崩，因为崩溃在**短抖动重连成功**之后，走不到降级；
- 3.5 s 阈值在真实短抖动下基本不触发，**不会造成二次伤害**；路径 B 需独立修复。

## 6. 交付状态

| 项 | 状态 |
| --- | --- |
| 崩溃前事件原文 | ✅ §1（含 `remote-open`、缺失 `replay-begin`） |
| 「降级后为何仍崩」机制 | ✅ **两路径分离**，App 走 B |
| 真实 App 是否含我的改造 | ✅ main 已含 `TRACE_CRITICAL` / `__DRH_TRACE_TAIL__` / `degrade-handoff` / `entry.inst` |
| 路径 B lab 复现 | ❌ 未做（预算用于证据分析） |
| 路径 B 修复 | ❌ 未做（需先按 §4.1 细分打点） |
