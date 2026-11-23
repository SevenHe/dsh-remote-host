# 方向 1 接线修复 + 单实例验证（初步可行，但两条硬指标未同时满足）

## 结论（第一句）

**接线修好了，新路径真的跑了**（证据：stream-relay 事件 17 次、目标 ws://127.0.0.1:19988/devbox/api/remote.mux），
单实例 5 轮极短抖动下 **RENDER_GONE = 0、boots = 1**（页面从未重载）；
但两条硬指标**未同时满足**：rows 仍为 0（可能只是分组折叠，未证实恢复），**token 级流式未验证**。
所以：方向 1 **初步可行**，需要一次干净确认才能算成立。

## 1. 接线 diff（lib/index.js 三处 + 一处打点）

1. buildShimScript 签名末尾加 streamRelay；
2. settings 白名单加：if (streamRelay === true) settings.streamRelay = true；
3. 调用点：const streamRelay = config?.streamRelay === true，并把它传给 buildShimScript(...)；
4. shim 侧在 trace 安装处补一条 shim-config 打点（critical）。

修复前：配置到不了 shim → STREAM_RELAY 永远 false → stream-relay 0 次（与上一轮观测一致）。
修复后：同一 profile（streamRelay: true）立刻出现 stream-relay 事件。

## 2. 三个数字（单实例，5 轮 0.6s 抖动）

| 指标 | 值 | 说明 |
| --- | --- | --- |
| RENDER_GONE | **0** | timeup crashes=0，boots 恒 1（无重载） |
| rows | **0** | 未满足；但 nodes=3661 / composer=1 / block=1，rows=0 也可能是分组折叠所致，未证实 |
| 流式证据 | **部分** | 事件级：announce 55 次 / 328s、stream-relay 17 次 → mux 通道活着；**token 级未验证** |

伴随观测：reconnect-enter 2 次、listener-attach 2 次（旧 router 仍被少量触发，可能在非 mount 路径或全局 WS 路径）。

## 3. 本轮数据的一个瑕疵（如实标注）

drops 日志出现两套（19:29:34 drop 2 / 19:29:52 drop 1 ...），说明**上一个残留脚本的循环仍在跑**，
两套循环同时切换代理模式 → 实际抖动次数**多于** 5 次（不是更少）。
即使如此 harness 仍 0 崩溃、boots=1，方向上更有利，但**严格说仍需一次真正单实例的干净跑**。

## 4. 方向判定

- 不是「流式丢失」：mux 通道经 relay 仍在工作（announce 持续 328s），也没有退化成 streams:false 的行为（那是单腿）。
- 不是「仍崩」：0 崩溃。
- 卡在「恢复可证实」与「token 级流式」两点上，属于**验证不足**，不是方案失败。

## 5. 下一步（一轮）

1. 先 pkill 干净并确认 pgrep 为空（这次残留循环是硬伤）；
2. 单实例跑 5 轮，确认 RENDER_GONE=0 且 **rows>0**（先把分组展开再采样，避免折叠假阴性）；
3. 流式：向远端会话发一条短消息，用两次采样比较 composer 下方文本长度（逐字增长=流式仍在）；
4. 若三条都过 → 方向 1 成立，补单测与文档后合并。
