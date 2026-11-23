
# 渲染进程崩溃排查 playbook（crash-triage）

> 这份文档只讲**怎么取证**，不含任何环境相关的真实地址/账号。适用于 `EXC_BREAKPOINT / SIGTRAP` 这类「渲染进程被杀」问题。

## 1. 先分类，再取证

| 现象 | 典型签名 | 先看什么 |
|---|---|---|
| 进程被杀 | `EXC_BREAKPOINT` / `SIGTRAP`，`CrRendererMain` | `.ips` + 宿主自己的 crash 日志 |
| 卡死/白屏后重启 | 无 `.ips`，日志出现长空档 | trace 心跳序列（是否断档）+ 堆/节点曲线 |
| OOM | `EXC_BREAKPOINT` 但 `MALLOC` 很大 / `FatalProcessOutOfMemory` | `vmSummary` 的 `MALLOC`、`Writable regions` |

**判据**：`MALLOC` 只有几十 MB、JS 堆几十 MB、`Memory Tag 253 ≈ 48G / 6 万 regions` 在每次崩溃里都是**同一个常量**（V8 指针压缩 cage）时，**可以排除 OOM**——不要往「内存爆了」的方向查。

## 2. 取证顺序（从便宜到贵）

1. **系统崩溃报告**：`~/Library/Logs/DiagnosticReports/*Renderer*.ips`（JSON，两段：首行 header + 正文）。取 `procLaunch`（进程启动时间）与 `captureTime`（崩溃时间）算存活时长；用**存活时长与重启时刻去对齐日志**，判断「这次崩溃带的是哪一版代码」。
2. **应用自己的崩溃日志**：打包应用通常会在 `~/Library/Logs/<AppName>/crash-*-renderer.log` 落一份。**注意**：它往往写着 `no error-level renderer console output was captured` —— 也就是**不含 fatal 文本**，不要以为漏看。

> 1.14.7 起本插件自身补了这条缺失证据：页面里的 `error`/`unhandledrejection`/`console.error` 会进面包屑并立即上报（上限 20 条/次加载），见 `src/shim/05-trace.js` 与 `CHANGELOG.md` 1.14.7「渲染进程 JS 错误取证」。判断“没有渲染进程错误”前，先看插件面包屑。
3. **统一日志**：`log show --last 30m --predicate 'process CONTAINS "<App>"'`。通常只有噪音；能捞到就赚。
4. **我们自己的 trace**（若插件埋了点）：心跳（heap/nodes/renders/DOM 计数）+ 交互面包屑。用来回答「崩溃前在做什么、资源是否在涨」。**注意上传失败时日志会断档，断档≠卡死**。
5. **stderr 捕获（唯一能拿到 fatal 文本的路）**：
   ```bash
   ELECTRON_ENABLE_LOGGING=1 ELECTRON_ENABLE_STACK_DUMPING=1 \
     "/Applications/<App>.app/Contents/MacOS/<App>" --enable-logging=stderr \
     > /tmp/app-debug.log 2>&1
   ```
   崩溃后 grep：`grep -nE 'Fatal error|Check failed|Received signal|SIGTRAP' /tmp/app-debug.log`。

## 3. 为什么 `.ips` 往往指不到代码

- 故障线程的帧常落在 **JIT 代码区**：`usedImages` 里对应条目 `name` 为空、`uuid` 全 0、`base` 为 0，帧只有巨大偏移 → 不可符号化（那是 V8 编译后的 JS）。
- 落在 Electron Framework 的帧，`atos -o <FW> -l <base> <pc>` 通常只回「最近符号 + 几十 MB 偏移」，等于没有信息（框架被 strip）。
- 因此**不要**花时间在 `.ips` 上做符号化；直接用第 2 节的 stderr 通道。

## 4. 用「配置阶梯」缩小责任面（每级一次重启，记录结论）

| 级别 | 关掉什么 | 若不崩说明 | 若仍崩说明 |
|---|---|---|---|
| 1 | 最激进的全局 hook（如替换 `globalThis.WebSocket`） | 该 hook 是元凶 | 排除它 |
| 2 | 自绘渲染层（保留数据面） | 问题在渲染/DOM | 问题在数据面注入 |
| 3 | 插件整行禁用 | 就是插件 | 与插件无关，转查宿主/环境 |

每级都要**记录版本与时间线**（进程启动时间 + 崩溃时间 + 该级生效时间），否则结论无效——真实案例里就是因为「配置写入时间晚于进程启动」，差点把一个假设当成结论。

## 5. 已经排除过的假设（避免重复劳动）

- **内存耗尽 / JS 堆 OOM**：`MALLOC` 只有 20~25MB、堆 50~90MB、cage 常量不变。
- **DOM 节点/容器泄漏**：崩溃实例里我们自己的容器计数（cards/menus/panels/roots/rows/groups/body）全部恒定。
- **替换全局 WebSocket**：带该开关关闭后仍崩（时间线对齐可证）。
- **编辑器里改代码被实时加载**：插件没有文件监听、`selfUpdate` 关闭，页面只在加载时读取一次；且多次崩溃发生在工作区干净的时间段。

## 6. 采集清单（提交问题时的最小证据集）

1. 崩溃报告路径 + `procLaunch` / `captureTime`
2. 崩溃前 2 分钟的 trace 尾部（含断档位置）
3. 最后一次交互（点/键/滚轮的目标摘要）
4. stderr 里 `# Fatal error ... Check failed: ...` 原文（有则是决定性证据）
5. 该进程加载的插件版本（commit）与配置开关状态
