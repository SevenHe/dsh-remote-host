# 判别实验结论：崩溃由「创建重连 socket」触发，而不是腿不可用本身

## 结论（第一句）

- **实验 B（完全不创建重连 socket）：5 轮极短抖动 → RENDER_GONE = 0，boots = 1（页面始终存活）**；
- **实验 A（本意把创建 socket 移出同步栈）：实现有 bug，退化成「从不创建 socket」，同样 0 崩溃 —— 无效数据，不算独立证据**；
- 与历史对照：只要真的创建重连 socket，短抖动就 5/5 崩。
=> 触发点是「我们创建重连 socket 这个动作」，不是「远端腿不可用」这个状态。

## 1. 实验 B 原始数据（0.6s x 5 轮）

    19:05:51 drop 1 / 19:06:20 drop 2 / 19:06:49 drop 3 / 19:07:17 drop 4 / 19:07:46 drop 5
    RENDER_GONE: 0        timeup crashes=0
    reconnect-enter: 2    reconnect-suppressed: 1
    composer=1  rows=0  nodes=2485  block=1  boots=1

两点说明：
1. 只有 1 次 reconnect-suppressed：第一次抖动后远端腿再没建立，后续 4 次抖动没有活连接可掉，所以不再进重连入口；
2. rows=0 是诊断实验的预期后果（彻底放弃恢复），说明「不崩」与「不恢复」是同一枚硬币，它不是可用性证明。

## 2. 实验 A 为何无效

把 socket 创建包进 setTimeout 后实测：attempt-deferred = 717 次，listener-attach = 0 次。
守卫写成「置 false 后立即调用 attempt()」，导致每次进入都再次走 defer 分支，实际从未创建 socket。
也就是说 A 的 0 崩溃等于 B 的条件（RENDER_GONE 0、boots=1、rows=0 与 B 一致），
**它不能回答「移出同步栈是否有用」**，如实标注为无效。

## 3. 修法方向（按你的要求先不动产品代码）

| 方向 | 内容 | 代价 |
| --- | --- | --- |
| 1 整体重写重连链 | 不自己 new WebSocket；用轻量 fetch 探测恢复后交还官方层重连 | 需重写 + 大量验证 |
| 2 延迟创建（修正版） | 修好实验 A 的守卫后重测「创建动作移出同步栈」 | 成本一轮，改动最小 |
| 3 不主动恢复 | 掉线只标记 error，等页面重载/用户操作 | 体验最差（区块 rows=0 半死） |

建议先做方向 2 的正确版本（一轮即可判定）；若仍崩，落到方向 1，并把「自己连 mux 不可靠」写进文档收口。

## 4. 代码状态（实验代码已回退）

- 已回退：SUPPRESS_RECONNECT（实验 B）、attemptDeferred（实验 A）全部移除；
- 保留真实修复：d9b2933 死 socket 守卫、bbddd74 放弃卡死 CONNECTING socket；
- 保留诊断：reconnect-enter / attempt-run / attempt-early-return / connect-return / attempt-socket / listener-attach / attempt-abandoned，携带 socketId / readyState / stackDepth；
- npm run check：74/74（回退后复验）。
