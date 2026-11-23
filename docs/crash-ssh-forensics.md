# 渲染进程崩溃取证：ssh 不可达假设

状态：**未定位（未复现出 fatal 文本）**。本文件记录已确证的事实、已排除的方向、以及复现尝试的原始结果。所有数据来自崩溃报告与独立 lab，**未触碰用户正在使用的桌面 App**。

## 1. 结论先行

1. 34 份 `DeepSeek Harness Helper (Renderer)` 报告全部是**同一类崩溃**，且落在**同一条指令**上：ARM64 `brk #0`（`0xd4200000`），紧随 `0xd4400000`、`0xd4200020` —— 这是 V8 生成代码里的主动 trap 序列（TurboAssembler::Abort 家族），**不是野指针、不是物理内存耗尽**。
2. faulting thread 恒为 **CrRendererMain**（渲染进程的 JS 主线程），栈形如
   `JIT(JS) → v8::Function::Call → Electron Framework ×4 → brk`，
   即「JS 调了某个 V8 运行时入口，V8 主动 trap」。
3. **ssh 不可达 → 渲染进程崩溃：目前没有任何直接证据。** 我在独立 lab 里造出「ssh 必然失败 + upstream 不可达」的状态后，宿主侧干净降级（只打日志并退回直连），**Chrome 渲染进程 30 秒内没有崩溃、没有 fatal 文本**。
4. 反过来，lab 里观测到的是一个**客户端上报风暴**：30 秒内 `/devbox/__dsh_remote_host__/report` 被请求 **134 次**（≈4.5 次/秒），控制台 `[connection] connection lost, retry #1`。这是**值得继续查的线索**，但它本身没在 Chrome 里触发 brk。

> 诚实标注：结论 3 是「未复现」，不是「已排除」。要在 Electron 的 V8 上判定，必须用**第二个 Electron 实例**（独立 DSH_HOME/profile/端口）配 `--enable-logging=stderr`，Chrome 的 V8 版本不同，不足以证否。

## 2. 已确证事实（34 份报告，机器可复算）

| 维度 | 实测 |
| --- | --- |
| 报告总数 | 34（2026-11-18 → 2026-11-23） |
| exception | 34/34 = `EXC_BREAKPOINT`，codes `0x…001, 0x…`，**fault 地址末三位 34/34 都是 `f04`** |
| faulting instruction | 34/34 的 `instructionByteStream.atPC` 前缀 = `000020d4` = `0xd4200000` = `brk #0` |
| 栈（frame 0–4） | 34/34 完全相同：`Electron Framework+151019268` → `+10810012` → `+10807868` → `+10807584` → `+10806372` |
| frame 5+ | `?+<偏移>`，image 的 uuid **全零**（JIT 区，无法符号化）；偏移随进程不同而不同（JIT 页放置差异） |
| faulting thread | 全部 `CrRendererMain` / `com.apple.main-thread`（41 帧） |
| usedImages | 10（个别 11），其中恰好 **1 个零 uuid** 的 JIT image |
| 线程数 | 21 或 22 |
| `logWritingSignature` | 34/34 完全一致 |
| 渲染进程寿命 | 0.67 – 75.58 s，**中位数 ≈ 3 s** → 不是固定定时器 |
| 内存 | MALLOC 17–25 MB；writable regions written 5.4–7.3 MB（0%）→ **物理内存排除** |
| VM 区域数 | `Memory Tag 253` ≈ 60,000 个区域（48 GB **虚拟**），TOTAL ≈ 67,000 —— 区域数极多但**常驻极小** |

**为什么说不是 OOM**：`vmSummary` 里 `Writable regions: written=5576K resident=5576K`，`unallocated=5.8G(100%)`；MALLOC 仅 17–25 MB。真正的 OOM 会表现为 `Fatal process out of memory` + 常驻内存接近上限，这里两者都不成立。区域数巨大只说明**虚拟地址空间碎片/映射数量异常**，可作为后续线索，但不足以解释 brk。

## 3. ssh 路径：宿主侧是干净降级的（有原始日志）

独立 lab（`DSH_HOME=/tmp/dsh-rh-sshlab`，端口 19961，插件 = worktree 副本，`upstream=http://127.0.0.1:9`，`sshHost=dsh-unreachable-host-xyz`）：

```
2026-11-23T03:40:10.430Z apply: upstream=http://127.0.0.1:9 mount=/devbox streams=true ssh=dsh-unreachable-host-xyz
2026-11-23T03:40:11.452Z ssh tunnel: FAILED ssh: Could not resolve hostname dsh-unreachable-host-xyz: nodename nor servname provided, or not known
2026-11-23T03:40:11.453Z ssh tunnel: keeping direct dial: Error: ssh tunnel did not come up: ssh: Could not resolve hostname ...
```

- ssh 失败被 `try/catch` 接住并**退回直连**，宿主进程没有崩；
- 因此「ssh 失败」在**宿主侧**不是一个会抛到渲染进程的异常。

代码侧观察（只读，未改）：
- `openSshTunnel()` 里 `spawn('ssh', …)` **没有 `child.on('error')` 监听**（只轮询 `exitCode`）。当 `ssh` 二进制不存在（ENOENT）时会走 EventEmitter 未处理 `error` 路径；本例 ssh 存在，故未触发。
- `stderr += String(chunk).slice(0, 400)` 是**无界累加**（每 chunk 截 400 字，但总量不封顶）。ssh 反复输出时会持续增长 — 属于隐患，未见与 brk 相关。
- **版本差异（已逐行核对代码，重要）**：`main@e2c0f52` 的 `lib/index.js` 里 `openSshTunnel()` 是**单次尝试**版本（60 × 200ms 轮询后失败即 `throw`），**没有**退避重试。但共用日志 `/tmp/dsh-remote-host.log` 里出现过 `ssh tunnel: retry 1 in 500ms … retry 5 in 8000ms` —— 说明当时有**另一份未提交的 ssh 实现**在跑（P0 分支的实验），不是 main。**结论**：本文关于 ssh 行为的所有结论只对 `main@e2c0f52` 成立；ssh 代码定稿后必须用同一套方法重跑本取证，因为退避重试会改变「失败 → 渲染进程」的时间窗与重入形态。

## 4. 渲染进程复现尝试（Chrome）与结果

方法：`--headless=new --enable-logging=stderr --v=1`，独立 user-data-dir，打开上述 lab URL，等 30 s。

| 观测项 | 结果 |
| --- | --- |
| 页面 target 是否存活 | **存活**（30 s 后仍在） |
| V8 fatal 文本（`Fatal error`/`Check failed`/`Maximum call stack`/`Abort`/`SIGTRAP`） | **无** |
| `/devbox/__dsh_remote_host__/report` 请求数 | **134 次 / 30 s ≈ 4.5 次/秒** |
| 客户端控制台 | `[connection] connection lost, retry #1` |
| `/devbox/api/session/list`、`ws://…/devbox/api/remote.mux` | 均按预期发出并失败 |

**这个实验的效力有限**：崩溃发生在 Electron 44.7.0 自带 V8 上（报告里 `electron: 44.7.0, node: 24.21.0`），而我用的是 Chrome 159 的 V8。V8 内部 trap 的触发条件与版本强相关，**Chrome 不复现不能证明 Electron 不复现**。

## 5. 已排除 / 无法使用的证据源

1. **`/tmp/dsh-remote-host.log` 不能用于历史时间相关性**：它在每次插件加载时被重写，且**多实例共用同一路径**。我 lab 的 03:35 记录已消失；当前最早记录是 03:41:59 且 `sshHost` 是别的探针写的 `no-such-host-drh-probe`。崩溃时刻（03:15/03:17/03:32/03:34 UTC）**没有任何**该文件记录 —— 这是**缺失**，不是「没有发生」。
2. **App 自带 crash log（`~/Library/Logs/DeepSeek Harness/crash-*-renderer.log`）**：只记录 `Desktop renderer exited: crashed` + `(no error-level renderer console output was captured)`，其余是插件操作历史（文件自身标注 "context, not proof of cause"）。拿不到 V8 文本。

> 1.14.7 起插件的面包屑会捕获页面 `error`/`unhandledrejection`/`console.error`（立即上报、上限 20 条/次加载），是这条应用日志缺失证据的补充来源，见 `src/shim/05-trace.js`。
3. **统一日志（`log show`）**：崩溃窗口内没有任何 V8 Fatal/Check 文本（lead 已验，与此一致）。

## 6. 下一步需要什么（按信息量排序）

1. **第二个 Electron 实例**（独立 `DSH_HOME` + profile + 端口，`ELECTRON_ENABLE_LOGGING=1 --enable-logging=stderr`，stderr 落文件）跑 ssh 不可达场景 —— 这是唯一能拿到 Electron V8 fatal 原文的路径。若抓到 `Fatal error in …` / `Check failed:`，即为决定性证据。
2. **对照实验**：同一实例下 `sshHost` 有/无各跑一段（其余条件不变），比较是否只有带 ssh 才崩。
3. **上报风暴定量**：把 `/report` 速率（已知 ≈4.5/s）与崩溃前的最后 N 秒对齐 —— 需要在**持久化**日志里记录时间戳（当前日志会被重写），否则无法回溯。
4. 若 ssh 重试退避（500ms→8s）在最终版本生效，需确认**重试期间**渲染进程侧是否仍有同步重入；这是历史上 1.14.0 修过一类递归的地方。

## 7. 本次取证的边界

- 未重启/未 attach 用户正在使用的 App；所有实验在独立 `DSH_HOME`/端口/浏览器实例中完成。
- 未修改 `lib/**`、`scripts/**`、`test/**`；本文档之外无代码改动。
- 未能复现崩溃，故**不宣称** ssh 是根因。
