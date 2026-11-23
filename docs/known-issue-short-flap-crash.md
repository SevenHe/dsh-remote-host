# 已知问题：远端短抖动导致渲染进程崩溃（已修复）

## 状态

**已修复**：config.streamRelay **默认开启** —— 挂载的 mux 连接不再由插件自建，只把 URL 改写到挂载路径、交给官方连接层，连接与重连全部由官方层负责。显式 streamRelay: false 仍可回退旧的 mux router（逃生门）。

## 触发条件（历史记录）

远端连接**短抖动**（几百毫秒断开后立即恢复）时，渲染进程以 SIGTRAP / brk #0 死亡；不打印任何 V8 fatal；.ips 落在同一条指令；死亡前最后一条事件是 listener-attach（readyState 0），15-17 秒后才重启（crashpad 写报告延迟）。

## 根因分析（历史记录）

已实测排除：同步重入/深递归（depth 恒 1）、replay 扇出（remote-open 从未出现）、监听器挂错 socket（三处 socketId 一致）、已 open 的 race、物理内存 OOM（MALLOC 17-25MB）、JS 栈溢出（崩溃时 depth=3，基线 11）。

判别实验结论：**不创建重连 socket -> 0 崩溃；创建 -> 5/5 崩**（即使把创建动作移到新栈上仍然崩）。触发点是「插件自己新建远端 mux socket」这个动作本身。

## 修复原理

1. routeCreateWebSocket 命中 mux URL 时不再构建 router，而是用 mountSocketUrl 改写路径后返回原生 socket（openSocket），插件不持有连接、不重连；
2. 宿主侧既有 proxyUpgrade 中继把 /devbox/api/remote.mux 转发到远端，Host 与 cookie 由它补；
3. 官方连接层自己处理断线与重连，实测同一抖动序列 0 崩溃；
4. 默认开启，可显式关闭回退。

## 验证记录

- 干净单实例（trace-on 仅 1 次）：stream-relay 出现，指向 ws://.../devbox/api/remote.mux；
- 5 轮 0.6s 极短抖动：RENDER_GONE = 0，boots 恒 1；
- 数据完好：totalMembers = 87、远端会话 112 条、分组 71；
- token 级流式仍在：主区文本长度按 300ms 采样逐步增长（2762 -> 2768 -> 2873 -> 2925），非一次性跳满。
