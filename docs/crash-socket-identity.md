# 判定表结论：病灶是「为重连 socket 挂监听器之后立即崩」

## 结论（第一句）

按判定表：reconnect-enter 每次都有（degraded/pending 均 false）、attempt-run 有（attempt 1 与 2）、
短抖动轮次**没有** attempt-early-return、且 connect-return / attempt-socket / listener-attach 三者 socketId 完全一致、
挂监听器时 readyState 恒为 0 —— 所以**不是挂错对象，也不是已在 open 的 race**。
真正观测：**listener-attach 就是崩溃前最后一条事件**，open/error/close 一个都没来，
连我的 abandon 看门狗（2.5s）都没机会跑；之后 15-17 秒才出现新实例，那是 crashpad 落盘延迟，**不是冻结**。

## 1. 原始打点（极短抖动 2 轮）

    18:28:54.036 attempt-socket   socketId=4 readyState=0 attempt=2
    18:28:54.036 listener-attach  socketId=4 readyState=0 mode=listener
    (无 open / 无 error / 无 close / 无 abandon)
    10:29:09.119 RENDER_GONE #1 crashed exitCode=5     <- 15s 后（crashpad 写入）
    18:29:09.857 connect-return kind=local socketId=1  <- 新实例启动

第二轮同样：connect-return / attempt-socket / listener-attach 同 id（3 与 4），同样无后续事件。

| 判定表行 | 命中 |
| --- | --- |
| reconnect-enter 缺失 | 否 |
| attempt-run 缺失 | 否 |
| attempt-early-return 有 | 否（短抖动轮次无） |
| socketId 不一致 | 否（三者同 id） |
| 全都正常却仍无 remote-open | **是** |

对最后一行的纠正：不是 race（挂监听器时 readyState=0），而是**挂上之后立刻死亡**（同一 tick）。

## 2. 顺带生效的修复（长断开路径）

    18:34:02.070 listener-attach   socketId=6 readyState=0
    18:34:04.571 attempt-abandoned socketId=6 readyState=3
    18:34:04.571 degrade-handoff   unavailableMs=5578
    PHASE2 三轮：0 崩溃

「放弃卡在 CONNECTING 的 socket 并重试」在长断开有效；**短抖动崩得太快，看门狗来不及跑**，对路径 B 无效。

## 3. 交付状态

| 项 | 状态 |
| --- | --- |
| 三条 + 两条 socket 身份打点（socketId/readyState/mode） | 已提交 |
| 判定表结论 | 命中最后一行，但不是 race，而是「挂监听器后立即崩」 |
| abandon+retry 修复（bbddd74） | 长断开有效（0 崩溃 + degrade 5578ms），短抖动无效 |
| 短抖动 5 轮 RENDER_GONE | 5 次（未改善） |
| 长断开 3 轮 RENDER_GONE | 0 次 |
| npm run check | 74/74 |

## 4. 建议换思路（这条我确实需要你定）

路径 B 已压缩到「为重连 socket 调配 addEventListener / 之后第一段同步代码」。两条可走：

1. 转向**官方客户端侧**：真实 App 的死亡同样紧跟 remote-open/attach，怀疑官方层在 leg 重连后同步重订阅触发 V8 内部 abort（我无权改其 bundle，需要那侧证据）；
2. 换**隔离环境的 V8 观测**：harness 加 js-flags 打开 trace-gc / trace-deopt 或加大 stack，抓崩溃瞬间的 V8 活动，目标是拿到 Fatal error 原文（多次尝试都因 V8 不打印而失败）。
