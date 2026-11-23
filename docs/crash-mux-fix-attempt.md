# mux 机制确认 + 第一次修复尝试**无效**（如实记录）

## 结论（第一句）

1. **机制确认（决定性）**：同一 flap 序列下 `streams: true` → **2 次崩溃**（`exitCode:5` ×2），`streams: false` → **0 次**。崩溃**依赖我们 shim 的 mux 接管**。
2. **第一次修复尝试无效，已回退**：加了「连续 5 次重连失败 → 关闭页面 socket 交还官方连接层」，但修复后**同一序列仍崩 2 次**，且 `degrade-handoff` **一次都没触发**。原因：失败计数器挂在 `connect('remote')` **同步抛错**分支，而本场景失败是**异步**的（socket error/close）→ 计数器从未增加 → 降级从未执行。**代码已回退**，不留无效实现。

## 1. 决定性对照（唯一变量 `streams`）

| 组 | profile | 序列 | `RENDER_GONE` | `exitCode` |
| --- | --- | --- | --- | --- |
| A | `streams: true` | blackhole ×3 + slow ×3 | **2** | 5, 5 |
| B | `streams: false` | 完全相同 | **0** | — |

结合 250 ms 尾迹（崩溃前无 `remote-open`/`replay-*`，reconnect 深度恒 1，尝试 1→5 后静默 ~18 s，崩溃相对异常开始 ~5.8–6.0 s ≈ 退避累计 6.2 s）→ 机制：**远端腿长期不可用时 mux 把页面 socket 一直挂着，官方连接层收不到失败信号 → 服务判定不可用 → 渲染进程 trap**。官方客户端在同样断网下不崩（B 组）。

## 2. 修复尝试（已回退）与为何无效

```js
// attempt() 内（同步抛错分支）
reconnectFailures += 1
if (reconnectFailures >= DEGRADE_AFTER_FAILURES) { degrade(); return }
function degrade() { degraded = true; reconnectPending = false; clearTimeout(reconnectTimer)
  traceEvent('degrade-handoff', {...}); publishStatus('remote','error'); client.close() }
```

修复后同序列实测：
```
09:20:58.653Z RENDER_GONE #1 {"reason":"crashed","exitCode":5}
09:21:31.153Z RENDER_GONE #2 {"reason":"crashed","exitCode":5}
degrade-handoff 出现次数：0
```

**根因**：`connect('remote')` 在本场景**不抛异常**，返回 socket 后**异步**失败（error/close）→ 计数器永不增加。方向（交还控制权）我认为对，**钩子挂错**。

## 3. 下一次改动（明确到钩子）

1. 失败计数挂到**远端腿 socket 的 `error`/`close` 事件** + 每次 `attempt` 超时；
2. 阈值改用**时间窗**：「远端腿连续不可用 > 6 s」进入降级（对齐实测 5.8–6.0 s）；
3. 降级动作不变（`client.close()` + `publishStatus('remote','error')`）；
4. 验证：同一序列要求 `RENDER_GONE` = 0 且 `degrade-handoff` ≥ 3 次。

## 4. 两个「顺手项」复核：**都是误报**（已纠正）

| 疑点 | 复核 |
| --- | --- |
| 宿主 `lib/index.js` 普通代理分支缺 `upstreamRequest.on('error')` | **有**：`proxyRequest()` 内 `httpRequest(...)` 后紧跟 `upstreamRequest.on('error', …502…)`；upgrade 分支亦有 → **非缺陷** |
| `50-router.js` no-carrier 同步递归 | 仅 **1 层**（进入即置 `reconnectPending=true` 并 `setTimeout` 返回）；仪器化 depth 恒 1、`reconnect-nocarrier` 从未触发 → **非缺陷** |

## 5. 交付状态

| 项 | 状态 |
| --- | --- |
| 决定性对照 | ✅ 2 vs 0，mux 假设**确认** |
| socket 逐 250 ms 时间线 | ❌ 未采集 |
| 修复 | ❌ 尝试后**回退**（钩子错） |
| 修前/修后 | ⚠️ 有「修后仍崩 2 次」数据，但非有效修复对照 |
| 两个顺手项 | ✅ 非缺陷 |
| `npm run check` | ✅ **63/63**（回退后复验） |

**诚实结论**：问题收敛到「mux 接管 + 远端腿长期不可用」，有决定性对照；**修复未成功**，下一轮按 §3 重做。
