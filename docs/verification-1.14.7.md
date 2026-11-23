# 1.14.7 交付复核（只读验证）

复核时间 2026-11-23；分支 `drh-verify`（自 main `64c22f3` = 1.14.7）。本文件只记录**实测原始值**与**文档/实现对不上之处**，不改产品代码。

环境：lab `DSH_HOME=<lab-home>`，profile `verifylab`，端口 **19991**；插件软链 `→ <main-checkout>`（`readlink -f` 已验证，version **1.14.7**）；`node_modules` 先 `cp -a` 再单独软链；upstream 为真实 devbox `http://<devbox-host>:<port>`（mount `/devbox`），cookie 取自 `<dsh-home>/dsh-remote-host/cookie.txt`。渲染侧用我们自己的 Electron harness（`/tmp/dsh-elec-app-verify`，CDP 9444），**未启动第二个 GUI App**。

## 1. 1.14.7 插件回归 — **通过**

打开远端会话的方式：把 `localStorage["dsh.sessions.current"]` 指向远端 sessionId 后重载（即 `docs/regression.md:366` 记录的姿势），避免依赖 block 的分组展开。

| 断言 | 原始值 |
|---|---|
| 页面能加载 | `readyState: "complete"`，`document.body.innerText` **5074** 字符，`title: "DeepSeek Harness"` |
| 远端已连上且知道会话 | `__DSH_REMOTE_HOST_STATE__.ids` = **112**；`__DSH_REMOTE_HOST_STATUS__` = `{"remote":"open","local":"open"}` |
| 远端会话能打开 | `localStorage["dsh.sessions.current"]` = `{"sessionId":"worker-f66c323325e08795860e3897681034e5"}`；页面无「会话不可用/无法打开/加载失败」文案（`sessionOpenError: false`）；会话统计渲染为 `3 轮 240 步·261 tok/s 36.4M tok·缓存命中 98%24%` |
| composer 可用 | `document.querySelector('[contenteditable="true"]')` **命中**（`composerEditable: true`） |
| 远端行没泄漏进原生列表 / 「未分组」 | 原生侧带 `data-session-id` 且 id ∈ 远端集合的元素 = **0**（`nativeRemoteRows: 0`）；`未分组` 标题数 = **0**（`ungroupedHeadings: 0`） |

截图：`/tmp/verify-remote-session.png`。

## 2. 模型位现状基线 — **与任务给的预期不符（需 lead 注意）**

任务给的预期是「仍显示占位（远端还是 rc.5 老 Host）」。实测**不是**占位：

| 取值点 | 原始值 |
|---|---|
| composer 区域文本（`div`，`form`/`[class*=composer]` 命中） | `发消息或创建任务, / 调用指令, @ 文件或对话完全权限DeepSeek V4.1 Flash (CPA)Max3 轮 240 步·261 tok/s36.4M tok·缓存命中 98%24%` |
| 模型位叶子文本 | `["DeepSeek V4.1 Flash (CPA)", "Max"]` |
| 全页是否出现「请选择模型」 | **false** |
| 权限位 | `完全权限` |

即：模型位**已解析出 `DeepSeek V4.1 Flash (CPA)` + `Max`**，不是占位。可能原因（未逐一证实）：① 远端 Host 已被升级、开始提供 `deepseek-v4.1-flash`；② 两端模型 id 已重合，本机目录即可解析。**结论：这条不能记为「与 1.14.7 实现不符」**，但必须纠正「仍是占位」的预期；建议 lead 先确认远端 Host 版本再决定要不要保留这条基线。

## 3. 打包产物可安装性 — **通过（静态）**

DMG：`<build-dir>/deepseek-harness-0.2.3-alpha.2-mac-arm64-unsigned.dmg`（279,014,056 B）。
挂载卷名 `/Volumes/DeepSeek Harness 0.2.3-alpha.2-arm64`（**含空格**，脚本解析挂载点要按 `/Volumes/.*` 取，否则会拿到错路径）。`.app` 已 `cp -a` 到 `<preview-dir>/`，**全程未启动**。

| 校验 | 原始值 |
|---|---|
| `codesign -dv` | `Identifier=com.deepseek.harness`；`Format=app bundle with Mach-O thin (arm64)`；`Signature=adhoc`；`flags=0x10002(adhoc,runtime)`；**`TeamIdentifier=not set`**；`Sealed Resources version=2 rules=13 files=6300` |
| `Info.plist` | `CFBundleShortVersionString=0.2.3-alpha.2`、`CFBundleVersion=0.2.3-alpha.2`、`CFBundleIdentifier=com.deepseek.harness` |
| 架构 | `arm64`（thin） |
| `Contents/Resources/app.asar` | 可读，**215,114,352** B |
| 关键包版本（asar 内） | `dsh`=`0.2.3-alpha.2`、`dsh-web-frontend`=`0.2.3-alpha.2`、`dsh-client-connection`=`0.2.3-alpha.2`、`dsh-host-webserver`=`0.2.3-alpha.2`、`dsh-client-ui-workspace`=`0.2.3-alpha.2`、`dsh-web-app`=`0.2.3-alpha.2` |

可安装性注意：**adhoc 签名 + 无 TeamIdentifier + 未公证**，用户机器上会被 Gatekeeper 拦（需 `xattr -dr com.apple.quarantine` 或“仍要打开”）。这不是缺陷，是 unsigned 构建的预期行为。

## 4. 文档一致性 — **两处需修（已在本分支修掉）**

### 4.1 对不上实现的条目

| # | 位置 | 文档说法 | 实际 | 处置 |
|---|---|---|---|---|
| 1 | `docs/regression.md:396` | `npm run check`：**51/51** | 实测 **58/58**（`CHECK_EXIT=0`） | 已改为 58/58 |
| 2 | `docs/crash-triage.md:19`、`docs/crash-ssh-forensics.md:70` | 应用崩溃日志「往往写着 `no error-level renderer console output was captured`」，读起来像是**没有**渲染进程错误证据 | 1.14.7 新增取证通道：`src/shim/05-trace.js:284-315` 捕获 `error`/`unhandledrejection`/`console.error`，经 `traceFailure`（`05-trace.js:207-216`，`traceNextAt=0` 立刻 flush）进面包屑；上限 `TRACE_FAILURE_LIMIT = 20`（`05-trace.js:194`）。该通道只在 `CHANGELOG.md:13` 写过，崩溃类文档没有交叉引用 | 已在两处加一行交叉引用（不改原有结论，只补“现在有这条通道”） |

### 4.2 已确认**一致**的条目

- **「同一次页面生命周期内切宿主需重载」写清了**：`docs/regression.md:412-414`（「已知限制（重要）…必须重载页面才会切换…验收请以「重载后正确」为准」）+ `CHANGELOG.md:16-18`。本次实测也走「重载后」路径，与该限制不矛盾。
- **模型目录来源与实现一致**：`session/modelCatalog` 已在 `src/shim/20-transport.js:103,198` 路由、`src/shim/80-install.js:169` 覆盖 rpc 载体；8 KiB 上限 `src/shim/10-state.js:226`（`PROJECTION_VALUES_MAX_BYTES = 8192`）；超时 `20-transport.js:125`（`CATALOG_READ_TIMEOUT_MS = 2500`）与 `10-state.js:315`（`MOUNT_TIMEOUT_MS = 2500`）。与 `docs/regression.md:398-424` 的描述逐条对得上。
- `docs/sensitive-data.md`：**无需**记录渲染错误取证。该文件规范的是**公开仓库里不得出现内网信息**，与“运行时把错误文本写入本机日志”无关（后者不出仓库）。此为核对结论，不是遗漏。

## 结论一览

| # | 项目 | 结果 |
|---|---|---|
| 1 | 1.14.7 插件回归（加载/远端会话/composer/无泄漏） | **通过** |
| 2 | 模型位基线 | **实测非占位**（`DeepSeek V4.1 Flash (CPA) Max`）→ 与任务预期不符，需 lead 确认远端版本后更新基线 |
| 3 | 打包产物静态可安装性 | **通过**（adhoc、版本/asar/包版本一致；Gatekeeper 需手动放行） |
| 4 | 文档一致性 | **2 处已修**（测试数 51→58、崩溃文档补交叉引用）；其余一致 |
