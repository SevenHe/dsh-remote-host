# 渲染进程崩溃：第二实例复现尝试（失败，卡点已定位）

目标：用**第二个 Electron 实例**（同一个 Electron 44.7.0 / 同一 V8）复现渲染进程崩溃，抓 `Fatal error in …` 原文。

结论：**未能启动第二实例**。原因不是配置错误，而是这个桌面 App 的**单实例锁是全局的**，且唯一能绕过它的手段（`--user-data-dir`）被该 App 的启动器**明确拒绝**。四次尝试的原始错误如下。

## 尝试记录（原始输出）

| # | 命令形态 | 结果 |
|---|---|---|
| 1 | `DeepSeek Harness --user-data-dir=… --profile elec --port 19981` | `bad option: --profile` |
| 2 | `DeepSeek Harness --user-data-dir=… --enable-logging=stderr --v=1 <bin.js> web --port 19981` | `bad option: --user-data-dir=…` / `bad option: --enable-logging=stderr` / `bad option: --v=1` |
| 3 | `DeepSeek Harness /tmp/elec-window-probe.js`（自建 BrowserWindow，企图用同一 Electron 承载 lab 页面） | 启动器把脚本当 **node** 执行：`Error: Cannot find module 'electron'` → 该 launcher 对「脚本参数」走 node 分支，拿不到 Electron 主进程 API |
| 4 | `DSH_HOME=<隔离> ELECTRON_ENABLE_LOGGING=1 DeepSeek Harness`（无脚本参数，走 GUI 主进程） | **进程立即退出**：无新 PID、无输出、`launcher alive? NO (exited)` |

尝试 4 的 PID 实测：

```
BEFORE: 37937 5408 55559 7817 85094 9056
AFTER : 37937 5408 55559 7817 85094 9056
NEW   :                     ← 空
launcher alive? NO (exited)
```

## 卡点根因（代码引用）

Asar 里唯一的单实例实现：

```js
/**
 * Claim the process-lifetime Desktop lock and route later launches to the owner.
 */
function claimDesktopSingleInstance(application, focusOwner) {
  if (!application.requestSingleInstanceLock()) {
    application.quit();                       // ← 第二个实例直接退出
    return false;
  }
  application.on("second-instance", focusOwner);   // 只允许「唤起 owner 窗口」
  return true;
}
```

三点后果：

1. **锁是全局的**：Electron 的 `requestSingleInstanceLock()` 以 **userData 路径**为键，而该 App 的 userData 固定在 `~/Library/Application Support/DeepSeek Harness`（不在 `DSH_HOME` 下，已实测该目录存在；`~/.dsh` 下没有 electron/userData 目录）。所以**换 DSH_HOME 不换 userData，锁仍然冲突** → 第二实例必然 `quit()`。
2. **唯一解法被拒**：把锁隔离需要改 userData，即 `--user-data-dir`；而该 launcher 对未知选项直接 `bad option` 退出（尝试 1/2）。Asar 里 `user-data-dir` 出现次数为 **0**，说明 App 自身也不支持该开关。
3. **不能自己写窗口**：launcher 把「首参是脚本」的情况转交 node（尝试 3），因此无法用 App 的 Electron 框架 + 自己的 `BrowserWindow` 去加载 lab 页面。

> 副作用说明：尝试 4 若真的被 owner 接受，会触发 `second-instance` → `focusOwner`（把用户窗口提到前台）。实测它是直接 `quit()`，用户窗口未被改变；但**可能被唤起过焦点**，这一点如实记录。

## 因此当前拿不到 V8 fatal 原文

- 用户正在运行的实例（PID 5408，已连续 3 天 15 小时）启动时没有 `ELECTRON_ENABLE_LOGGING`，它的 V8 fatal 不会落盘；**不能重启/attach 它**（纪律）。
- 第二实例（唯一替代方案）被上述全局锁挡住。
- Chrome（V8 159）同构实验不崩，但版本不同，**不能证否** Electron 44.7.0 的问题（见 `crash-ssh-forensics.md` §4）。

## 解除卡点需要什么（二选一）

1. **用户短暂退出 App**（约 2 分钟）。锁释放后我可以：
   ```bash
   DSH_HOME=/tmp/dsh-rh-electron-home ELECTRON_ENABLE_LOGGING=1 \
     "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" > /tmp/elec.log 2>&1
   ```
   这一次启动会拿到锁、开真正的 Electron 窗口、并把 V8 fatal 打到 `/tmp/elec.log`。DSH_HOME 隔离保证我的实验数据与用户数据分开；userData 会复用同一个（单实例，无并发风险）。**恢复**：关掉我的实例后用户正常启动即可。
2. **App 支持隔离**：加一个受支持的开关/环境变量（例如 `--user-data-dir` 透传，或 `DSH_ELECTRON_USER_DATA`），使第二实例能与用户实例并存。这样不必打扰用户。

## 复现矩阵现状

| 组 | 内容 | 状态 |
|---|---|---|
| 1 | ssh 不可达（`sshHost` 连不上 + upstream 不可达） | **未跑**（第二实例起不来）；宿主侧已证干净降级，Chrome 渲染进程未崩（见前一份文档） |
| 2 | 对照：禁用插件 | 未跑 |
| 3 | 大 transcript | 未跑 |
| 4 | 长时间空转 | 未跑 |

四组都依赖「能起一个带渲染进程的实例」，该前提当前不成立。

## 本次未做的事（纪律）

- 未 kill / 未重启 / 未 attach 用户正在用的实例（PID 5408 及 helpers 全程 PID 不变）。
- 未修改 `lib/**`、`scripts/**`、`test/**`；只写本文档。
- 起过的隔离资源已清理（lab 服务、headless Chrome、`/tmp` 下的临时 home/userData）。
