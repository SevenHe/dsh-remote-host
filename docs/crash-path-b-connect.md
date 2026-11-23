# 路径 B：connect() 死 socket 修复无效（原始数据 + 纠正判断）

## 结论（第一句）

按方案改了 connect()（不复用 CLOSING/CLOSED）+ attempt() 的 stale-socket 兜底后：
**RENDER_GONE 从 5 次降到 4 次，仍然崩；更关键的是 remote-open 与 replay-* 依然一次都没出现**。
所以 connect() 复用死 socket **不是**路径 B 的阻断点 —— 我上一条判断有误，此处纠正。

## 1. 修后原始数据（极短断开 0.6s x 5 轮）

    18:17:16 warmup pass 12s
    18:17:28 round 1 drop 0.6s ... 18:19:52 round 5 recover 35s   (5 轮全部跑完)
    RENDER_GONE #1 10:17:44.828 exitCode:5
    RENDER_GONE #2 10:18:20.834 exitCode:5
    RENDER_GONE #3 10:18:56.022 exitCode:5
    RENDER_GONE #4 10:19:32.068 exitCode:5

面包屑（5 轮合计）只有 status-open-enter/exit 成对出现：

    1795429023749 status-open-enter {}
    1795429023752 status-open-exit  {}
    1795429065800 status-open-enter {}
    1795429065801 status-open-exit  {}
    1795429101778 status-open-enter {}
    1795429101793 status-open-exit  {}
    1795429137006 status-open-enter {}
    1795429137014 status-open-exit  {}
    1795429173050 status-open-enter {}
    1795429173050 status-open-exit  {}

**仍然没有** remote-open / open-handled / replay-enter / replay-send / replay-done，
也没有 stale-socket / leg-dropped-stale。

## 2. 纠正判断

1. attempt() 的 onOpen 从未执行 —— remote-open 是它的第一条打点；
2. 守卫没被触发 → 本场景 connect() 并没有返回 CLOSING/CLOSED 的缓存 socket；
3. 但 status-open-* 有 → 腿 socket 是「别处」新建并打开的（最可能是页面正常流量的 open 帧触发 connect），
   即腿被日常流量复活，**重连状态机并未参与**。

所以阻断点在 reconnectRemote() 的入口守卫或 attempt() 的调度链，不是 socket 复用。

## 3. 本次改动处置

- 改动本身是**正确的防御性修复**（复用死 socket 确属 bug），有 2 条单测覆盖，**保留**（commit d9b2933）；
- 但它**不是路径 B 的修复**，**不能算解决崩溃**。

## 4. 交付状态

| 项 | 状态 |
| --- | --- |
| 改动（connect 守卫 + stale 兜底 + 2 单测） | 已提交 d9b2933 |
| 极短断开 5 轮 修后 RENDER_GONE | **4 次**（修前 5 次）→ 未修好 |
| 每轮完整链路 remote-open→replay-* | **仍然完全没有** |
| 长断开 3 轮路径 A 对照 | 未跑（修复未生效，A 的代码未改动） |
| npm run check | 74/74 通过（main 72 + 新增 2） |

## 5. 下一步（方向已修正，很短）

在 reconnectRemote 入口与 attempt 内加 3 条 critical 打点：
reconnect-enter{degraded,pending} / attempt-run / attempt-early-return{reason}。
同一极短断开序列跑一次即可判定：

- attempt-run 从不出现 → 卡在 reconnectRemote 的守卫（degraded/pending 未复位）；
- 出现但紧跟 early-return → 直接看 reason；
- 都正常却没有 remote-open → 下一层查 addEventListener 的对象身份。
