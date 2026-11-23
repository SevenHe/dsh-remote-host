# 决定性对照：崩溃依赖 shim 的 mux 接管（streams: true）

## 结论（第一句）

**同一 flap 序列下，`streams: true` → 2 次崩溃（`exitCode:5` ×2）；`streams: false` → **0 次**。**
崩溃**依赖我们 shim 的 mux 路由接管**（`createMuxRouter`），与「远端腿不可用」本身无关 —— 官方客户端在同样断连下**不会**崩。

## 1. 两组对照（原始值，唯一变量是 `streams`）

| 组 | profile | flap 序列 | `RENDER_GONE` | `exitCode` | 崩溃时刻 |
| --- | --- | --- | --- | --- | --- |
| **A（有 mux 接管）** | `streams: true` | blackhole ×3 + slow ×3（同一脚本） | **2** | **5, 5** | 17:10:09.958 / 17:10:41.801 |
| **B（无 mux 接管）** | `streams: false` | **完全相同**（blackhole ×3 + slow ×3） | **0（NONE）** | — | — |

B 组阶段全部跑完（原始标记）：
```
17:15:44 PHASE blackhole begin … 17:16:20 round blackhole 3 end … 17:16:32 PHASE blackhole end
17:16:32 PHASE slow begin … 17:17:36 round slow 3 end … 17:17:50 PHASE slow end
```

## 2. 与上一轮 250 ms 尾迹合起来看，机制清晰了

- **崩溃前没有任何 `remote-open` / `replay-*`**（远端腿**从未重新打开**）；
- `reconnect` 深度恒 1，尝试 1→5 次后静默约 18 s；
- 崩溃相对「异常开始」为 **5.80 s / 5.96 s**，接近 `reconnectBackoff` 累计（200+400+800+1600+3200 ≈ **6.2 s**）；
- **`pass` / `half` 不崩**，`blackhole` / `slow` 崩；
- **`streams:false` 完全不崩**。

→ 机制：**远端腿长期不可用时，我们的 mux 路由把页面那条 socket 一直挂着**（官方连接层收不到数据、流开不起来）→ 客户端判定服务不可用 → 逐步演化为渲染进程 trap。
这也解释了为什么官方客户端在纯断网下不会崩：**它的连接层有自己的超时/重连/降级逻辑，而我们的接管把它挡住了**。

## 3. 两个「顺手项」的复核结果（都是**误报**，已纠正）

| 疑点 | 复核 | 结论 |
| --- | --- | --- |
| 宿主 `lib/index.js` 普通代理分支缺 `upstreamRequest.on('error')` | 实际**有**：`proxyRequest()` 里 `httpRequest(...)` 之后紧跟 `upstreamRequest.on('error', (error) => … 502 …)`；upgrade 分支亦有 `upstreamRequest.on('error', () => socket.destroy())` | **不是缺陷**（我此前只 grep 了窄窗口，判断有误，纠正） |
| `50-router.js` no-carrier 分支同步递归 | 递归只有 **1 层**：`reconnectRemote()` 内部会先置 `reconnectPending = true`、再 `setTimeout(attempt, backoff)` 后返回；仪器化也显示 `depth` 恒 1、`reconnect-nocarrier` 从未触发 | **不是无界递归**（注释措辞不准，但行为正确）。可选的措辞/结构清理，非缺陷 |

## 4. 修复方向（下一步，尚未实施）

依据第 2 节的机制，修法收敛为：**远端腿不可用时不要占着页面 socket**。

1. **快速失败可见**：连续失败达到阈值（建议 **5 次 / 累计 ≈6 s**，即崩溃前的时间窗）后进入**降级模式**：
   - 用**正常关闭码**关闭页面侧 socket（`1012` service restart 或 `1001` going away），把控制权交还官方连接层（它有自己的重连/降级）；
   - 停止继续反复开 WS，改为**探测性 fetch / 轮询**（例如每 5–10 s 一次轻量 `session/list`）判断远端是否恢复；
   - 恢复后再重新接管 mux。
2. **状态对外可见**：降级期间保持 `publishStatus('remote','error')`，避免 UI 表现为「静默挂起」。
3. 保持单飞与有界退避不变。

**未实施原因**：本轮预算用尽在对照实验与两处误报复核上；修复需要改 `50-router.js` 的 client socket 生命周期并重跑同一 flap 序列做修前/修后对照，属于必须一次做完并验证的改动，**不做半成品**。

## 5. 交付状态

| 项 | 状态 |
| --- | --- |
| 第 2 步决定性对照（streams false/true） | ✅ **完成**：2 vs **0** |
| mux 假设 | ✅ **确认** |
| 第 1 步 socket 状态时间线 | ⚠️ 部分：已证明「崩溃前远端腿从未 open、reconnect 停在 5 次」，但**页面 socket 的 `readyState` 逐 250 ms 时间线未采集**（需要 shim 暴露 socket 状态，未做） |
| 第 3 步修复 | ❌ 未实施（见 §4） |
| 第 4 步修前/修后对照 | ❌ 未做 |
| 两个顺手项 | ✅ 复核为**非缺陷**并纠正 |
| `npm run check` | ✅ 63/63（已含 main） |

## 6. 修复时的验证清单（照此做即可）

1. 同一 flap 序列（blackhole ×3 + slow ×3）跑修复后构建，要求 `RENDER_GONE` = **0**；
2. 功能仍正常：能打开会话、composer `contenteditable=true`；
3. 恢复后**确实重新接管** mux（日志出现一次成功的 remote-open + replay）；
4. 降级期间 UI 有 error 状态、不静默。
