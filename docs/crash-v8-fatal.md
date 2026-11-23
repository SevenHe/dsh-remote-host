# 渲染进程崩溃：V8 fatal 捕获尝试（自建 Electron 隔离入口）

状态：**仍未捕获 fatal 原文**。逐组记录时长/内存曲线，严格区分
**「跑完未复现」/「没跑到」/「跑到但被打断」**。

## 0. 结论先行

- **A 组（忠实负载、隐藏窗口、trace 开）：跑满 600 s，0 崩溃，0 fatal** → 跑完未复现。
- **D 组（忠实负载 + 持续 UI 操作）：跑满 480 s，0 崩溃，0 fatal** → 跑完未复现。
- **B 组（可见窗口）：没跑到** —— lab 起不来（`LAB_FAILED`，插件全部 waiting `webServer`，堆栈在 `node:net`，疑似端口占用）。**不是阴性结果**。
- **关键效力折扣**：A/D 运行窗口内（06:05–06:29Z）**桌面 App 一次未崩**（最近一次 13:42:02 本地 = 05:42Z，早于实验）。所以「没崩」**与「桌面本来处于安静期」无法区分**。
- 环境与崩溃报告完全一致（§1），方法有效，但**样本时机不对**。

## 1. 环境一致性

```
start electron=44.7.0 v8=15.2.124.28-electron.0 chrome=152.0.7977.130 node=24.21.0
[dsh-remote-host] mounted http://devbox.example.com:3080 at /devbox as "devbox"
```
崩溃报告里 `electron: 44.7.0`、`node: 24.21.0` —— 一致；挂载真实远端（69~70 组 / 数百会话），payload 与桌面同量级。

## 2. A 组：隐藏窗口 + trace 开（跑完未复现）

| 项 | 值 |
| --- | --- |
| 时长 | **600 s**（06:05:29Z → 06:15:29Z），`timeup crashes=0`，exit 0 |
| 采样 | 119 次 / 5 s |
| DOM 节点 | **恒 2390**（零抖动） |
| `#drh-remote-block` / `boots` | 恒 1 / 恒 1（无重载） |
| JS heap | **34.0 – 50.0 MB**，振荡回收，无单调上升 |
| `render-process-gone` | **0** |
| stderr | 142 行，fatal 匹配 **NONE** |

boot 期捕获一条已知插件 bug（另一 agent 在修）：`workspace/not-found: workspace "drh:claim" not found`；只出现 1 次，其后 600 s 无重试风暴、无崩溃。

## 3. B 组：可见窗口（**没跑到**）

```
LAB_FAILED
Plugins waiting for services (8): … missing: webServer
（堆栈 node:net:2666）
```
lab 服务未起来（端口绑定失败可能性最大，19988 可能被占用）。**整组未进入 Electron 阶段**，不产生任何崩溃结论。需换端口重跑。

## 4. D 组：忠实负载 + 持续 UI 操作（跑完未复现）

动机：用户观察「崩溃与 agent 大量产出/界面持续刷新重合」；A 组页面完全空闲，D 组补「一直在动」。
操作（每 1.5 s）：随机展开/折叠分组、随机开视图菜单再关、随机 `mouseover` 会话行（触发 hover 卡）、`scrollBy` 上下滚动。

| 项 | 值 |
| --- | --- |
| 时长 | **480 s**（06:20:53Z → 06:28:53Z），exit 0 |
| 采样 | 92 次 / 5 s |
| 交互 | **≈300 次**（30 tick × 10），全部返回 ok |
| DOM 节点 | 2541 → **2732**（展开/折叠波动，符合预期） |
| JS heap | **35.3 – 51.2 MB**，振荡 |
| `render-process-gone` / unresponsive / did-fail-load | **0 / 0 / 0** |
| stderr | 135 行，fatal 匹配 **NONE** |

## 5. 效力折扣（必须与结论一起看）

桌面 App 在 06:05–06:29Z 期间**没有任何新崩溃报告**（最近一次 13:42:02 本地）。因此「A/D 没崩」**不能**推出「该负载不会崩」。反之，若当时桌面崩了而我这两组没崩，才是强证据 → **下次应「守株待兔」**：盯着崩溃报告，桌面一崩就在同一分钟起 harness 对照。

## 6. 差异变量矩阵

| # | 差异 | 状态 |
| --- | --- | --- |
| 1 | `dsh-app://` 自定义协议（改 origin / secure-context / storage 分区 / CORS） | **未试**（§7，唯一改我们 fetch/WS 语义的变量） |
| 2 | 可见窗口 + GPU 合成 | **没跑到**（B 组，需换端口） |
| 3 | 桌面 preload / 捆绑插件（cua 等） | **未试**（需桌面 preload 产物） |
| 4 | streams / remoteBlock / trace 开关 | A、D 全开；B 拟关 trace 但未跑起 |
| 5 | 真实远端 payload | **已具备** |
| 6 | 持续 UI 操作 | **已覆盖**（D ≈300 次交互，0 崩溃） |

## 7. C 组（dsh-app://）可行性

1. `protocol.registerSchemesAsPrivileged([{scheme:'dsh-app', privileges:{standard:true, secure:true, supportFetchAPI:true, corsEnabled:true}}])`（须在 ready 前）；
2. handler 把 `dsh-app://…` 代理到 lab `http://127.0.0.1:PORT/…`，让页面 origin 变成 `dsh-app://`；
3. **难点**：cookie 按 origin 存，lab 下发的 `dsh-auth-*` 不会带到新 origin，需在 harness 用 `session.cookies.set` 手动种入，否则 API 全 401、行为不可比。

## 8. 下一步（按性价比）

1. **B 组换端口重跑**（可见窗口，10 分钟）。
2. **守株待兔式对照**：监控 `~/Library/Logs/DiagnosticReports`，桌面崩后立刻同负载跑 10 分钟。
3. **C 组自定义协议**（含 cookie 种入），10–15 分钟。
4. 推动桌面 App 增加受支持的隔离入口（`--user-data-dir` 透传 / `DSH_ELECTRON_USER_DATA`），用真桌面进程带日志跑，消除保真度差距。

## 9. 产物与清理

| 组 | evidence | stderr | 端口 | profile |
| --- | --- | --- | --- | --- |
| A | `/tmp/dsh-elec-evidence-long.log` | `/tmp/dsh-elec-stderr-long.log` | 19987 | eleclong |
| B | （无） | （无） | 19988（启动失败） | eleclongB |
| D | `/tmp/dsh-elec-evidence-longD.log` | `/tmp/dsh-elec-stderr-longD.log` | 19990 | eleclongD |

未 kill/attach 用户桌面 App（只读观察）；未改共享资产 `/tmp/dsh-elec-run`、`/tmp/dsh-elec-app`（D 用复制件 `/tmp/dsh-elec-app-d`）；收尾按 `profile eleclong` 与 `/tmp/dsh-elec-app-d` 精确清理，**不**泛匹配 `dsh-elec-app`。
