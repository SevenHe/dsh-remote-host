# 复现成功：远端连接抖动 → 渲染进程 SIGTRAP 崩溃

## 结论（第一句）

**复现成功。** 用「可切换 TCP 代理 + 短时 blackhole」制造到真实 devbox 的连接抖动，
在官方 Electron 44.7.0 里 **2 次触发渲染进程死亡**，`reason: crashed`、**`exitCode: 5`**。
macOS 上 **signal 5 = SIGTRAP = EXC_BREAKPOINT**，与 38 份 `.ips` 里的 `brk #0` **同一签名**。
**但 stderr 里没有 V8 fatal 文本** —— 这解释了为什么统一日志(`log show`)里从来没有 V8 文本：
这条崩溃路径**不打印任何 fatal 消息**。

## 1. 复现装置（按 lead 规格）

| 组件 | 配置 |
| --- | --- |
| TCP 代理 | `node net.createServer`，`127.0.0.1:19999` → `10.37.114.43:3082`；`pass` / `blackhole` 双模式 |
| blackhole 行为 | **立即 destroy 全部存活连接**（150 ms 轮询）**并且拒绝新连接**（实测 `refused=6`），等价于 VPN 抖动 |
| lab | `DSH_HOME=/tmp/dsh-rh-c4-flap`，端口 19993，profile `c4flap`；`upstream: http://127.0.0.1:19999`、`authority` 保持真实远端、`cookieFile` 用真实 cookie |
| 插件 | 软链到 `/Users/bytedance/Workspace/dsh-rh-crash4`（含本轮新加的 `inst` 实例标识） |
| 渲染进程 | `/tmp/dsh-elec-run/.../Electron`（**44.7.0 / v8 15.2.124.28-electron.0 / chrome 152**，与崩溃报告一致）；harness 用**私有副本** `/tmp/dsh-elec-app-c4`（共享目录未动） |

lab 启动确认（原文）：
```
[dsh-remote-host] mounted http://127.0.0.1:19999 at /devbox as "devbox"
```

## 2. flap 序列与崩溃时刻（关键相关性）

```
16:41:04 FLAP begin
16:41:04 pass 20s
16:41:24 blackhole 3s
16:41:27 pass 10s
16:41:37 blackhole 5s
16:41:42 pass 10s          ← 恢复连接
16:41:42.833 RENDER_GONE #1 {"reason":"crashed","exitCode":5}   ← 恢复后 0.8 秒崩溃
16:41:52 blackhole 1s
16:41:53 pass 30s
16:42:09.195 RENDER_GONE #2 {"reason":"crashed","exitCode":5}   ← 又一次抖动后崩溃
16:42:23 FLAP end
16:42:48 done
```

**两次崩溃都发生在「连接恢复/抖动之后」**，其中第一次精确到**恢复后 0.8 s**。
代理侧同时可见 `refused=6`（blackhole 期间拒绝的新连接数）与 `live=0`（连接被清空）。

## 3. 原始证据

harness 证据文件 `/tmp/dsh-c4-flap-evidence.log`：
```
2026-11-23T08:41:42.833Z RENDER_GONE #1 {"reason":"crashed","exitCode":5}
2026-11-23T08:41:42.834Z reloading #1
2026-11-23T08:42:09.195Z RENDER_GONE #2 {"reason":"crashed","exitCode":5}
2026-11-23T08:42:09.206Z reloading #2
2026-11-23T08:42:48.794Z timeup crashes=2
```

Electron stderr `/tmp/dsh-c4-flap-stderr.log`（共 51 行，**只有这一句与崩溃有关**）：
```
Renderer process crashed - see https://www.electronjs.org/docs/tutorial/application-debugging for potential debugging information.
```
**没有** `Fatal error in` / `Check failed` / `Maximum call stack` / `SIGTRAP` 文本 —— 与 `.ips` 里「无 V8 文本」完全一致。

渲染进程心跳（崩溃前后稳定，排除 OOM）：
```
sample {"nodes":2485,"block":1,"boots":1,"memory":{"used":45434886,...}}   ← 崩溃前
sample {"nodes":2485,"block":1,"boots":2,"memory":{"used":46099197,...}}   ← 重载后
```
heap 全程 40–55 MB，nodes 恒定 2485。

## 4. 与软件栈的关系（重要，尚未做对照）

本轮 lab **启用了我们的插件**（`dsh-remote-host`），客户端是官方 rc.5 产物。
所以目前只能确定：**「连接抖动」足以让这个渲染进程以 SIGTRAP 死掉**。
**还不能确定**崩溃路径是否经过我们的 shim / 是否 DSH core 自身的问题 —— 需要下一个对照实验：
**同一 flap 序列、把插件 `disabled: true`**，若仍崩 → 与本插件无关（DSH 渲染层问题）；
若不崩 → 缩小到我们的断连处理路径。**这是下一步唯一必须做的实验。**

## 5. 若确认与我们的插件相关，最小修复方向（按可能性）

1. **未处理的 promise rejection**：断连时 shim 某条 `await` 链 reject 而无人 catch。
   注意：本轮 flap 窗口内 `renderer-trace.log` 里**只有 1 条** `failure`（`snapshot store 'dsh.sessions.current' rehydration failed`），
   **没有出现 rejection 风暴** → 说明 5 秒级 blackhole 下失败路径比较安静，**不是** rejection 刷屏。
2. **服务重注册风暴**：断连→重连触发 client 侧 service 反复注册/销毁（对应历史日志里的 `conversation service unavailable`）。
   本轮我**没有**在 flap 窗口观察到这条错误（它出现在此前 16:00/16:06 的窗口，且那批归属存疑，见 `docs/crash-attribution.md`）。
3. **重连期同步重入**（1.14.0 修过一次同类）：如果 shim 在 `close` 事件里同步 re-open，可能形成深递归 → V8 生成代码 trap 且**不打印 fatal**（与本现象吻合）。
   验证方式：在 `renderer-trace.log` 里看崩溃前最后 2 秒是否有高频 `trace-on` / 连接事件；本轮窗口内 `trace-on` 出现 5 次（抖动期间重连），**值得按 3 的方向深挖**。

## 6. 证据归属说明（承接上一轮）

- `renderer-trace.log` **多实例共用**；本轮已给每条事件加 `inst`（`config.label + data-drh-inst`，提交 `9e55246`）。
- 本轮 lab 的 `trace-on` 全是 `inst=devbox#-`（区块节点尚未挂载时 `data-drh-inst` 为空，回落为 `label#-`），
  说明**事件发生得比区块挂载更早** —— 这本身是有用信息：崩溃链在区块挂载前就开始了。
- 上一轮被判为「可能属于我们 e2e」的 `session/modelCatalog expected 1 argument(s)` 条目，**在本轮 flap 窗口内没有出现**。

## 7. 复现命令（可重跑）

```bash
bash /tmp/dsh-c4-flap.sh          # 代理 + lab + harness + flap 序列，一次跑完
# 关键产物
/tmp/dsh-c4-flap-evidence.log     # RENDER_GONE + 心跳
/tmp/dsh-c4-flap-stderr.log       # Electron stderr
/tmp/dsh-tcproxy.log              # 代理模式/ refused 计数
```

## 8. 清理

- harness 用私有副本 `/tmp/dsh-elec-app-c4`；**共享的 `/tmp/dsh-elec-app`、`/tmp/dsh-elec-run` 未改动**。
- 未 kill / 未 attach 用户桌面 App；未动远端 runtime。
- 收尾需 kill：`pkill -f 'profile c4flap'`、`pkill -f dsh-tcproxy.js`、`pkill -f dsh-elec-app-c4`。
