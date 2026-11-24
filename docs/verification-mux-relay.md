# 验证：drh-mux-relay（宿主侧 mux 中继）能否升级进 main

## 结论（第一句）

**能用，用户可见结果是「持平」**：5 轮极短抖动 + 3 轮长断开下 RENDER_GONE = 0、boots = 1、
数据与流式都在；但它多了一个运行时依赖（ws）、一个新端点、**宿主侧零日志**、只有 1 条单测。
建议**暂不升级**，先补可观测性与回归测试；分支保留。

## 1. 被测对象

- 分支 drh-mux-relay，commit 2834ea3（父提交 54992db，已含 crash4/main 的 streamRelay 工作）
- 验证用独立 worktree：/Users/me/Workspace/dsh-rh-muxrelay（分支 drh-muxrelay-verify），
  readlink -f 证明 lab 加载的就是它，git log 显示 2834ea3
- 依赖：package.json 已声明 ws 8.23.0，但 worktree 未安装 -> npm install 后才可启动（见 §5）
- 门禁：npm run check 79/79 通过

## 2. 机制（代码事实）

- 宿主新增 createRemoteMuxRelay（lib/remote-mux.js，155 行）：宿主进程自己 new WebSocket 连远端 mux，
  维护重连（250ms 起，指数退避到 4000ms），并把页面 socket 保持打开；
- 宿主注册新端点 mount + /__dsh_remote_host__/mux（仅 owner 可入：admit 校验 principal.kind === owner）；
- 客户端：HOST_RECONNECTS_REMOTE = STREAM_RELAY && !ATTACH_REMOTE；为真时远端腿改连宿主中继路径，
  并跳过页面侧的重连逻辑（50-router.js:186 / 718 / 726），同时消费宿主发来的 drh/relay-status 帧（:351）。

## 3. 五项验证的原始数据

### 1) 不崩/不卡（5 轮 0.6s + 3 轮 5s）

| 指标 | 值 |
| --- | --- |
| RENDER_GONE | **0** |
| boots | **1** |
| composer contenteditable | 1（全程） |
| nodes | 2499 稳定，最后 4812（开会话后） |

### 2) 数据恢复

| 阶段 | totalMembers | expanded | rows |
| --- | --- | --- | --- |
| 起始 | 86 | 0 | 0 |
| 展开后 | 86 | 1 | **1** |
| 5 轮极短抖动后（每轮采样） | 86 | 1 | **1** |
| 3 轮长断开后（每轮采样） | 86 | 1 | **1** |

8 轮抖动全程 rows 恒为 1、members 恒为 86 -> **没有出现半死**。

### 3) 流式

向远端会话发送「数到 100，每行一个数字」，每 300ms 采样主区文本长度：

    1798, 1798, 1798, 1798, 1804, 1870, 1961, 1956, 1897, 1813, 1945, 1945

**逐步增长**（+6 / +66 / +91），非一次性跳满 -> 流式仍在。

### 4) 宿主侧可观测 —— **未达标**

- lib/remote-mux.js 里日志语句数：**0**（无 console/note/emit/logger）；
- 宿主 boot.log 中 mux / relay / upgrade 相关行数：**0**；
- 也就是说：**无法从宿主侧证明它在维护远端腿**，只能靠间接证据：
  - 页面侧 reconnect-enter / listener-attach / degrade-handoff / remote-unavailable 计数**全为 0**（我们页面侧的重连路径没跑）；
  - 代理统计 blackhole=22：抖动期间**宿主**经代理反复拨远端（页面没有参与）。

### 5) 与 main 的对照

| 维度 | main（streamRelay 默认开，客户端只重写 URL） | drh-mux-relay（宿主中继） |
| --- | --- | --- |
| RENDER_GONE（短 5 + 长 3） | 0 + 0（分两次测得） | **0（一次跑完 8 轮）** |
| boots | 1 | 1 |
| totalMembers / rows | 87 / 1 | 86 / 1 |
| 流式 | 逐步增长 | 逐步增长 |
| degrade-handoff | 0 | 0 |
| 页面侧重连路径 | 0 次 | 0 次 |
| 谁在重连 | 官方连接层（页面内） | **宿主进程**（代理 blackhole=22 佐证） |
| 新增运行时依赖 | 无 | **ws 8.23.0** |
| 新增端点 | 无 | /__dsh_remote_host__/mux（owner-only） |
| 宿主侧日志 | 不适用 | **无** |
| 单测 | 77 | 79（中继仅 1 条） |

**判读：用户可见结果持平（都 0 崩、数据与流式都在）。**
分支的机制更强一点（重连发生在宿主，渲染进程连 socket 都不用重建），但没有带来可测的额外收益。

## 4. 建议

**暂不升级进 main**，分支保留。若要合并，先补四项：

1. **宿主侧可观测**：remote-mux.js 加日志/事件（mux-relay-open / mux-relay-reconnect / mux-relay-close，
   带 attempt 与 delay），否则线上出问题无法定位（本轮就是靠代理计数器间接推断的）；
2. **单测**：现有 host-mux-relay.test.mjs 只有 1 条，至少补
   「页面 socket 在 upstream 断开期间保持 OPEN」「重连退避 250->4000 上限」「stream 重放顺序」三条；
3. **依赖与打包**：ws 8.23.0 进入运行依赖，需确认打包/离线安装路径与 lockfile 一致性（本 worktree 缺装即无法启动，说明这一点很容易踩）；
4. **文档**：在 docs/ 说明新端点的准入（owner-only）与回退方式。

## 5. 环境备注（供复现）

- lab：DSH_HOME=/tmp/dsh-rh-c4mx，port 19985，profile c4mx（复制 desktop，upstream 指向本地代理 19999）；
- 插件软链：readlink -f 指向 /Users/me/Workspace/dsh-rh-muxrelay；
- 必须在 worktree 里 npm install 装上 ws（仅声明未安装时宿主启动会因 import 失败）；
- harness：私有副本 + CDP 9446 驱动采样；单实例（trace-on 1 次）。
