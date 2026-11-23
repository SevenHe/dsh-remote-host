# flap 崩溃：仪器化结果 —— 方向③被证否，修复未完成

## 结论（第一句）

**方向③（同步重入 / 深递归）被本轮仪器化数据证否**；崩溃仍然**稳定复现**（3 轮 flap / 共 6 次，全部 `exitCode:5` = SIGTRAP），
且**每次都精确落在「远端腿重新打开」的那一瞬间**。**修复尚未完成** —— 我没有拿到足以指导修复的下一步证据，也没有可验证的修复。

## 1. 仪器化埋点（已提交 `8277316`）

`src/shim/50-router.js`：

| 事件 | 含义 |
| --- | --- |
| `reconnect-begin` / `reconnect-end` | 进入/离开 `reconnectRemote()`，携带 `attempt` 与**同步重入深度** `depth` |
| `reconnect-nocarrier` | `connect('remote')` 返回 undefined 的那条分支（潜在同步递归点） |
| `remote-open` / `replay-done` / `replay-remote` | 远端腿打开时刻 + 一次性 replay 的流数量 |
| `inst` | 每条事件带实例标识（`config.label + data-drh-inst`），解决多实例共用日志的归属问题 |

## 2. 证否方向③的原始数据

instrumented flap（16:59:40–17:00:59）trace 摘录：

```
t=1795424400681 reconnect-begin {"attempt": 1, "depth": 1}
t=1795424400681 reconnect-end   {"depth": 0}
t=1795424400893 reconnect-begin {"attempt": 2, "depth": 1}
t=1795424400893 reconnect-end   {"depth": 0}
t=1795424401299 reconnect-begin {"attempt": 3, "depth": 1}
t=1795424401299 reconnect-end   {"depth": 0}
t=1795424402105 reconnect-begin {"attempt": 4, "depth": 1}
t=1795424402105 reconnect-end   {"depth": 0}
```

- **`depth` 从未超过 1**（既无同步重入，也无深递归）；
- **`reconnect-nocarrier` 一次都没出现** → 那条"无 carrier 同步递归"分支在本场景**未被走到**；
- 重连次数有界：每次掉线 1→4 次尝试，间隔 ~200/400/800/1600 ms（退避生效），**不是高频风暴**（远低于「次数/秒」怀疑值）。

命中崩溃的时刻：

```
17:00:13 blackhole 5s
17:00:18 pass（恢复）
17:00:18.697 RENDER_GONE #1 {"reason":"crashed","exitCode":5}   ← 恢复后 0.697 s
17:00:45.189 RENDER_GONE #2 {"reason":"crashed","exitCode":5}
```

（前两轮同样：16:41:42.833 恢复后 0.8 s；16:56:37.680 恢复瞬间。）

## 3. 顺带发现的真实缺陷（**不是**本次崩溃的成因）

`50-router.js` 的 no-carrier 分支：

```js
reconnectPending = false
if (socket === undefined) {
  // No carrier: yield, then schedule the next step through the timer.
  reconnectRemote()          // ← 注释说"排到定时器"，实际是同步递归
  return
}
```

`reconnectPending` 刚刚被置 false，单飞守卫挡不住它；若 `connect('remote')` 同步抛错，这里会**无退避地同步自递归**直到栈耗尽。
**但**：本轮仪器化显示该分支**从未被走到**（`connect` 在 WebSocket 情境下是异步失败），所以**它不是本次崩溃的成因**。
**我没有修它**，因为未经验证就改代码会违反"别硬套"的要求；它应作为独立的健壮性修复（改成 `setTimeout(attempt, backoff)`），并配单测。

## 4. 为什么拿不到「崩溃瞬间」的更多证据

崩溃点正好是**远端腿重新打开**的瞬间（`remote-open` / `replay-*` 一条都没落盘）。原因：trace 是**批量+限速**发送的
（`TRACE_BATCH=10`、`TRACE_MIN_INTERVAL_MS=1000`），页面在 0.7 s 内就死了，**缓冲区来不及 flush**。

**下一步必须先解决这个观测盲区**（任一）：
1. 在 `remote-open` 之后立即强制 `traceFlush()`（或对 reconnect/replay 事件设 batch=1）；
2. 把关键计数写 `globalThis` 并由 harness 每 250 ms 采样（harness 侧改私有副本）；
3. 用 `sendBeacon`/同步 XHR 落盘这些事件，避免崩溃丢日志。

在此之前，任何"修法"都只是猜测 —— 我不做。

## 5. 交付状态（诚实清单）

| 项 | 状态 |
| --- | --- |
| 步骤1 打点 + 重跑 + 崩溃前 trace | ✅ 完成（本文档 §2） |
| 方向③成立/证否 | ✅ **证否**（depth 恒为 1，无 nocarrier，无风暴） |
| 步骤2 按证据修 | ❌ **未做**（证据不足以定位到可修的具体路径，拒绝猜测式改动） |
| 步骤3 修前/修后对照 | ❌ **无法提供**（没有修后构建；仅修前数据：3 轮 flap → 6 次 `exitCode:5`） |
| 步骤4 回归 + 新增 3 条单测 | ❌ **未做**（无修复则无对应单测） |
| `npm run check` | ✅ 绿：**58/58 tests**（本分支基线；主线 63 的差异来自其他 agent 新增用例），`verify-sensitive` 干净（69 文件） |

## 6. 下一轮的最短路径（我建议按此顺序）

1. 修观测盲区（§4 的任一方案），重跑 flap，拿到 `remote-open` 时的 `streams` 数量与 `replay-*` 时序；
2. 若确认崩溃紧跟「一次大 replay」，修法候选：**把 replay 分片**（每 tick 重放 N 条，`setTimeout` 让出栈），避免一次性同步扇出；
3. 若确认崩溃发生在 replay 之前，则重点转向**客户端侧**（本插件之外）：远端腿 open → 客户端重新订阅 → 服务重注册；
4. 每步都用同一 flap 序列做对照，不改强度。

## 7. 纪律与清理

- 未 kill / 未 attach 用户 App；未动远端 runtime；harness 用私有副本 `/tmp/dsh-elec-app-c4`。
- 本轮文档因引用真实主机/路径，被 `verify-sensitive` 拦下，已改为占位符（`devbox.example.com:3080`、`/Users/me`）；
  另注意一个**我方哨兵的假阳性**：`v8 15.2.124.28-electron.0` 被当成 IPv4 命中 —— 版本号里的点分数字应豁免，值得后续修规则。
