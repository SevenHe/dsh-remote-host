# 已知问题：远端短抖动导致渲染进程崩溃（已修复）

## 状态

`config.streamRelay` 默认开启。仅远端窗口将原生 mux 指向远端挂载路径，由官方连接层重连。混合窗口保留本地 mux，由本机宿主重连远端 mux，按会话归属读取历史。`streamRelay: false` 切回旧版分流和重连。

## 触发条件（历史记录）

远端连接**短抖动**（几百毫秒断开后立即恢复）时，渲染进程以 SIGTRAP / brk #0 死亡；不打印任何 V8 fatal；.ips 落在同一条指令；死亡前最后一条事件是 listener-attach（readyState 0），15-17 秒后才重启（crashpad 写报告延迟）。

## 根因分析（历史记录）

已实测排除：同步重入/深递归（depth 恒 1）、replay 扇出（remote-open 从未出现）、监听器挂错 socket（三处 socketId 一致）、已 open 的 race、物理内存 OOM（MALLOC 17-25MB）、JS 栈溢出（崩溃时 depth=3，基线 11）。

判别实验结论：**不创建重连 socket -> 0 崩溃；创建 -> 5/5 崩**（即使把创建动作移到新栈上仍然崩）。触发点是「插件自己新建远端 mux socket」这个动作本身。

## 仅远端窗口修复原理

1. routeCreateWebSocket 命中 mux URL 时不再构建 router，而是用 mountSocketUrl 改写路径后返回原生 socket（openSocket），插件不持有连接、不重连；
2. 宿主侧既有 proxyUpgrade 中继把 /devbox/api/remote.mux 转发到远端，Host 与 cookie 由它补；
3. 官方连接层自己处理断线与重连，实测同一抖动序列 0 崩溃；
4. 默认开启，可显式关闭回退。

## 验证记录

- 干净单实例（trace-on 仅 1 次）：stream-relay 出现，指向 ws://.../devbox/api/remote.mux；
- 5 轮 0.6s 极短抖动：RENDER_GONE = 0，boots 恒 1；
- 数据完好：totalMembers = 87、远端会话 112 条、分组 71；
- token 级流式仍在：主区文本长度按 300ms 采样逐步增长（2762 -> 2768 -> 2873 -> 2925），非一次性跳满。

## 收口验证（默认开启、无显式配置键，单实例）

### 项 1：正确口径的 rows

README 里没有 streamRelay 键，profile 也没写 —— 验证的是**新默认值**本身：

| 指标 | 值 |
| --- | --- |
| trace-on | 1（单实例） |
| stream-relay | 出现（默认开启生效） |
| totalMembers | 87 |
| expanded（点击 6 个未展开组后） | 1 |
| **展开后 rows** | **1** |

说明：分组是**手风琴式**（同时只允许一个展开），所以连点 6 个组后 expanded 仍为 1，rows=1 是真实 UI 行为而非测量副作用；rows>0 达标。

### 项 2：长断开 5s x 3（同一实例）

| 指标 | 值 | 要求 |
| --- | --- | --- |
| RENDER_GONE | **0** | 0 |
| boots | **1** | 1 |
| composer | 1 | 可用 |
| rows | 1 | 有行 |
| totalMembers | 87 | 数据未丢 |
| degrade-handoff | **0** | 新路径不需要降级 |
| reconnect-enter / listener-attach / remote-unavailable | **0 / 0 / 0** | 我们的 router 完全没跑 |
| stream-relay | 14 | 新路径在工作 |

三轮长断开后页面持续采样：composer=1、rows=1、nodes=3675、block=1、boots=1。

**结论**：两项达标，默认开启可以合并。我们的 mux router 在整轮里一次都没被调用（reconnect-enter / listener-attach 均为 0），
连接与重连完全由官方连接层承担 —— 这就是路径 B 的根治。
