# 四模式对照：blackhole 与 8s 超时路径都会崩；replay/重连恢复**不参与**

## 结论（第一句）

**四种模式对照完成**：`pass` 与 `half` **0 次崩溃**；`blackhole` **1 次**、**`slow`（宿主 8s 超时路径）1 次**，
两次都是 **`exitCode:5`（SIGTRAP，与 .ips 同签名）**。
并且本轮 250 ms 尾迹抓到了崩溃前的事件链：**`remote-open` / `replay-begin` / `replay-end` 一条都没有出现**，
`reconnect` 深度恒为 1 —— 所以**「重连恢复」「大 replay 扇出」「同步重入」三类假设都可以排除**。

## 1. 四模式对照表（原始值）

同一次 harness 运行（lab 端口 19996、代理 19999、插件→`drh-crash4`、Electron 44.7.0），依次切换代理模式：

| 组 | 代理行为 | 轮次 | `RENDER_GONE` | `exitCode` | 崩溃时刻 |
| --- | --- | --- | --- | --- | --- |
| **pass** | 正常转发 | 基线 20 s | **0** | — | — |
| **blackhole** | 立即 destroy 现有连接 + 拒绝新建 | 3 轮 × (4 s 断 + 12 s 恢复) | **1** | **5** | 17:10:09.958（第 2 轮断线开始后 **+5.96 s**，即恢复后 +1.96 s） |
| **slow** | 接受连接但**永不回包**（触发宿主 8 s 超时） | 3 轮 × (12 s 卡 + 14 s 恢复) | **1** | **5** | 17:10:41.801（第 1 轮开始后 **+5.80 s**，**早于** 8 s 超时） |
| **half** | 回一半响应后卡住 | 3 轮 × (6 s + 12 s) | **0** | — | — |

代理侧计数（结束值）：`{"pass":13,"blackhole":10,"slow":3,"half":0}` —— `half` 期间客户端复用既有连接，没有新建，这与 0 崩溃一致。

## 2. 观测盲区已修复（本轮改造）

| 改造 | 位置 | 效果 |
| --- | --- | --- |
| 关键事件**强制 flush**（绕过 batch=10 与 1 s 限速） | `src/shim/05-trace.js`：`TRACE_CRITICAL` 白名单（remote-open / reconnect-* / replay-* / stream-open / service-register / crash-marker） | 崩溃前的事件能落盘 |
| 页面内 **tail 环**（最近 60 条）暴露为 `globalThis.__DRH_TRACE_TAIL__` | 同上 | 主机侧写盘失败也不丢 |
| harness **每 250 ms** 拉取 tail 落盘 | 私有副本 `/tmp/dsh-elec-app-c4base` → `-tail.log` | 本轮抓到 **1054 行**尾迹（此前 0） |

## 3. 崩溃前的事件链（尾迹原文，按时间）

```
1795424988458 reconnect-begin {"attempt":1,"depth":1}
1795424988458 reconnect-end   {"depth":0}
1795424988665 reconnect-begin {"attempt":2,"depth":1}
1795424989071 reconnect-begin {"attempt":3,"depth":1}
1795424989880 reconnect-begin {"attempt":4,"depth":1}
1795424991487 reconnect-begin {"attempt":5,"depth":1}
…（此后约 18 s 无任何事件）…
2026-11-23T09:10:09.958Z RENDER_GONE #1 {"reason":"crashed","exitCode":5}
```

由此可以**逐条排除**：

| 假设 | 证据 | 结论 |
| --- | --- | --- |
| ③同步重入/深递归 | `depth` 恒为 **1**；`reconnect-nocarrier` 从未出现 | **排除**（第二次独立证否） |
| 重连成功后 replay 扇出 | **`remote-open` / `replay-begin` / `replay-end` 一次都没出现** | **排除**：崩溃时远端腿**从未重新打开**，replay 根本没跑 |
| 恢复瞬间的重新订阅 | 崩溃在「恢复后 0–2 s」或「卡住 +5.8 s」，且无 open 事件 | 不能归因于「恢复成功」 |
| 宿主 8 s 超时 | slow 组崩溃在 **+5.80 s**，**早于** 8 s 超时触发 | 超时**不是**直接触发器（但 slow 与 blackhole 都会崩 → 共同点是「挂起中的请求 + 事件循环被占」） |

**新的共同点**：两种会崩的模式都让**连接处于「半死」状态**（blackhole 反复重连失败 / slow 永久挂起），
而 `pass`（健康）与 `half`（只挂一条流、其余正常）都不崩。崩溃相对「开始异常」的时延都在 **5.8–6.0 s**，
与 `reconnectBackoff`（200/400/800/1600/3200 ms，累计 ≈ 6.2 s）**高度吻合** —— 下一步应重点验证「第 5–6 次重连尝试时刻」与崩溃的时间关系。

## 4. 静态审计（AbortError / 双层超时）

| 项 | 位置 | 现状 |
| --- | --- | --- |
| 页面侧 mount 读取超时 | `src/shim/10-state.js:325` | `AbortSignal.timeout(MOUNT_TIMEOUT_MS)` |
| 页面侧目录读取超时（与外部 signal 合并） | `src/shim/20-transport.js:130-134` | `AbortSignal.timeout(CATALOG_READ_TIMEOUT_MS=2500)` + `AbortSignal.any` |
| 宿主侧 8 s 超时 | `lib/index.js:368-370`（普通代理）、`422-423`（upgrade） | `upstreamRequest.setTimeout(8000, () => upstreamRequest.destroy(new Error(...)))` |
| **潜在缺陷** | `lib/index.js:365-372` | upgrade 分支有 `upstreamRequest.on('error')`（421 行），但**普通代理分支只看到 `req.on('error')`**，未见 `upstreamRequest.on('error')` → `destroy(new Error)` 可能产生**未处理的 'error' 事件**（会打挂宿主进程，不是渲染进程）。**待复核**（我未改）。 |

## 5. 交付状态（诚实）

| 项 | 状态 |
| --- | --- |
| 四模式对照表 | ✅ 完成（§1，原始值） |
| slow（8 s 超时路径）是否复现 | ✅ **复现 1 次**（`exitCode:5`） |
| 「具体哪一行没 catch AbortError」 | ❌ **未定位**：本轮证据表明崩溃**不依赖** AbortError 路径（slow 组崩在 8 s 超时之前；且页面侧超时是 2.5 s/另有 mount 超时，均未与崩溃时刻对齐） |
| 修复 + 修前/修后对照 | ❌ **未做**（尚无指名路径；按纪律不猜着改） |
| `npm run check` | ✅ 绿：**63/63**（已 merge main）、`verify-sensitive` 干净（72 文件） |

## 6. 下一轮（很短）

1. 在 `reconnect attempt 5/6` 处加 `crash-marker` + 精确时间戳，验证「≈6 s 退避累计点」是否就是崩溃时刻（当前证据已强烈指向它）；
2. 若是，修法候选：**把重连退避的重试从「同一条 WebSocket 反复失败」改为「先做一次探测性 fetch，再打开 WS」**，或在第 N 次失败后**降级为轮询、暂停 WS 重连**；
3. 复核 §4 的宿主侧 `upstreamRequest.on('error')` 缺失。
