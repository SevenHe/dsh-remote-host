# 本机实例口径（唯一标准）

> 任何 agent、任何协作方改动本机运行态前，先读本文件，再跑 `bash scripts/preflight.sh`。
> 违反本节曾造成「退出 App 重开后远端挂载加载失败」这类事故（见 `docs/regression.md` 的 2026-11-24 条目）。

## 1. 唯一的 App

| 项 | 值 |
|---|---|
| 路径 | `/Applications/DeepSeek Harness.app` |
| 版本 | `0.2.2-rc.5`（与远端 Host 严格同版本） |
| 必须包含客户端补丁 | `app.asar` 内 `storeFor` 命中 > 0（否则远端会话模型位会显示「请选择模型」） |
| 备份/残留 | 不允许出现第二个同名 `.app`；旧版放 `~/Workspace/dsh-app-backup/` |

## 2. 唯一的插件代码

| 项 | 值 |
|---|---|
| 仓库 | `~/Workspace/dsh-remote-host` |
| 运行分支 | **`main`**，且 **`main` == `origin/main`** |
| 运行代码必须包含 | 宿主侧 mux 中继（`lib/remote-mux.js` 存在 + `lib/index.js` 含 `host mux relay`） |
| 依赖 | `ws`（宿主侧中继用）由**仓库内** `npm ci` 安装 |
| profile 软链 | `~/.dsh/profiles/desktop/node_modules/dsh-remote-host` → 上面的仓库根目录 |
| 禁止 | 指向任何 `dsh-rh-*` 验证 worktree（那是临时分支） |

### 2.1 为什么必须「两端同一版本」

客户端自 1.14.7 起**默认开启** `streamRelay`：它把页面的 mux URL 改写成 `/api/remote.mux`。
这个路径**只有宿主侧中继会提供**，远端 DSH 自己没有它（`GET /api/remote.mux` → 404）。
所以：

- 宿主侧中继 + 客户端改写 = 远端挂载正常；
- 只有客户端改写、宿主没有中继 = 页面 mux 被代理到远端拿 404 = **远端工作区/会话加载失败**。

**不要再把仓库检出到 `e546f2b` 或更早的提交**：那些提交里客户端已经默认开 relay，而宿主侧中继还只存在于分支上，属于不可运行的组合。`main` 已快进到同时包含两端的合并提交，`main` 本身即可运行。

### 2.2 依赖只在仓库里

profile 用 `link:` 指向本仓库，包管理器**不会**安装被链接包的依赖，所以 `ws` 只能由本仓库的 `node_modules` 提供（`package.json` 已声明，`package-lock.json` 已锁定）。一旦 `node_modules` 被清空（`git clean -xdf`、新克隆、`npm ci` 中断），宿主半个插件会在 import 阶段抛错，表现同样是「加载失败」。修复动作固定为：

```bash
cd ~/Workspace/dsh-remote-host && npm ci
```

### 2.3 校验

```bash
R=$HOME/Workspace/dsh-remote-host
G() { env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin git -C "$R" "$@"; }
G rev-parse --abbrev-ref HEAD              # 必须是 main
G rev-parse main origin/main              # 两个 SHA 必须相同
G merge-base --is-ancestor origin/main HEAD && echo ok
readlink -f ~/.dsh/profiles/desktop/node_modules/dsh-remote-host   # 必须是 $R
test -f "$R/lib/remote-mux.js" && grep -q "host mux relay" "$R/lib/index.js" && echo ok
node "$R/scripts/build-shim.mjs" --check  # lib/shim.js 必须等于 src/shim/* 拼接
```

## 3. 单一宿主

`~/.dsh` 同一份会话存储只允许**一个**宿主进程写。历史遗留的 launchd 任务 `com.deepseek.dsh.web`（`dsh web --host 127.0.0.1 --port 3080`，KeepAlive）会再起一个宿主，与桌面 App 共用会话存储、重复执行 profile 操作，已移除：

- 已 `launchctl bootout` 并移出 `~/Library/LaunchAgents/`；
- 备份：`~/Workspace/dsh-app-backup/com.deepseek.dsh.web.plist`；
- 想恢复浏览器版（非桌面）时，把 plist 放回 `~/Library/LaunchAgents/` 再 `launchctl bootstrap`，但**同时不要开着桌面 App**。

## 4. 禁止的临时修改

- 禁止把 `dsh-rh-*` 验证 worktree 设成 profile 软链；
- 禁止直接改 `/Applications/DeepSeek Harness.app` 的内容（签名与 asar 完整性会被破坏）；
- 禁止在 `main` 上提交未经验证的实验代码。会话路由变更用实机重开和本地、远端历史加载做验收；
- 禁止写 `~/.dsh/profiles/desktop/**` 做测试：测试必须用独立 `DSH_HOME` 的 lab profile；
- 禁止在 App 运行中把工作树在两个**树内容不同**的提交之间来回切（运行中的插件会读到写了一半的文件）。要换版本：先退 App，再切分支，再跑 preflight，再启动。

## 5. 自愈任务的硬约束

`scripts/ensure-profile.mjs` 只修 profile 的**注册状态**（`package.json` 的 bundle 条目与依赖、`cordis.patch.yml` 的配置行），**不创建、也不改写** `node_modules/dsh-remote-host` 软链。硬约束：

- 该脚本**不得触碰** profile 的 `node_modules/**`；若将来新增创建软链的逻辑，必须「只在不存在时创建，已存在且合法时绝不覆盖」；
- 同一 Label 只允许存在一个 `*.plist`（本机曾因两个同名 Label 的 plist 每 30 分钟把软链改成实验分支）。`scripts/install-selfheal.mjs` 现在会在发现同名 Label 的**其它** plist 时直接拒绝安装；
- 回归用例：`test/ensure-profile.test.mjs` 固定了「已注册时零改动」与「软链目标不得改变」。

当前状态：没有任何 `ensure-profile` plist 安装（`launchctl list | grep ensure-profile` 为空），历史 plist 备份在 `~/Workspace/dsh-app-backup/`。

## 6. Git 工具链注意事项

本机 shell 环境带有**残缺的 Git 配置变量**（只有 `GIT_CONFIG_VALUE_*`，没有匹配的 `GIT_CONFIG_KEY_*`），会让 `git` 直接 `fatal: unable to parse command-line config`，**并使 `git status` 输出为空从而被误判为「工作树干净」**。

所有自动化脚本调用 git 时，必须用干净环境：

```bash
env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin" git -C "$R" status --porcelain
```

## 7. 启动前自检（一条命令）

```bash
bash ~/Workspace/dsh-remote-host/scripts/preflight.sh
```

核对项（全绿才算可以启动）：

| 检查 | 拦住的问题 |
|---|---|
| `app bundle` / `app version` / `client model patch` | App 缺失、版本错、模型补丁丢失 |
| `single app bundle` | 装了两个同名 App，打开的可能是旧的那个 |
| `plugin symlink` | 软链指向验证 worktree |
| `main == origin/main` | 本地 main 被推进到实验提交 |
| `running checkout includes origin/main` | 检出在其它分支（正在跑未合入的代码） |
| `host mux relay for session routing` | 客户端要 relay、宿主没有 → 远端挂载加载失败 |
| `shim build matches sources` | `lib/shim.js` 与 `src/shim/*` 不一致（改了源码没重建） |
| `plugin dependency ws resolves` | 仓库 `node_modules` 缺依赖 → 插件加载即抛错 |
| `running host mounted the relay` | 文件是对的，但**正在跑的**宿主是旧代码（读它自己的启动日志） |
| `no second DSH host (dsh web)` / `no dsh web autostart` | 第二个宿主共用 `~/.dsh` |
| `no ensure-profile rewriter` | 自愈任务偷偷改软链 |

## 8. 标准动作（换版本/修代码之后）

1. `cd ~/Workspace/dsh-remote-host && npm ci`（缺依赖时）；
2. `bash scripts/preflight.sh` → 必须 `PREFLIGHT OK`（App 没开时 `running host` 显示 `none`，属正常）；
3. **退出** App（⌘Q，不是关窗口），确认进程没了：`pgrep -f "dsh-desktop-host/[l]ib/index.js"`；
4. 重新从「应用程序」启动；
5. 再跑一次 `bash scripts/preflight.sh`，此时 `running host mounted the relay` 必须为 `ok (pid …)`。
