# 本机实例口径（唯一标准）

> 任何 agent、任何协作方改动本机运行态前，先读本文件。违反本节会造成「App 加载了非验证代码」这类事故。

## 1. 唯一的 App

| 项 | 值 |
|---|---|
| 路径 | `/Applications/DeepSeek Harness.app` |
| 版本 | `0.2.2-rc.5`（与远端 Host 严格同版本） |
| 必须包含客户端补丁 | `app.asar` 内 `storeFor` 命中 > 0（否则远端会话模型位会显示「请选择模型」） |
| 校验命令 | `LC_ALL=C grep -ac storeFor "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"` |
| 备份/残留 | 不允许出现第二个同名 `.app`；旧版放 `~/Workspace/dsh-app-backup/` |

## 2. 唯一的插件代码

| 项 | 值 |
|---|---|
| 仓库 | `~/Workspace/dsh-remote-host` |
| 同步基线 | `main` 与 `origin/main` 一致 |
| 运行代码 | 当前 checkout 包含 `origin/main` 和宿主侧 mux 分流。修复进入上游前，同一个目录使用已验收的 `drh-mux-relay` 分支 |
| profile 软链 | `~/.dsh/profiles/desktop/node_modules/dsh-remote-host` → 上面的仓库根目录 |
| 禁止 | 指向任何 `dsh-rh-*` 验证 worktree（那是临时分支） |

校验同步基线、链接和当前 checkout。

```bash
R=$HOME/Workspace/dsh-remote-host
env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin git -C "$R" rev-parse main origin/main   # 两个 SHA 必须相同
readlink -f ~/.dsh/profiles/desktop/node_modules/dsh-remote-host                                                # 必须是 $R
env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin git -C "$R" merge-base --is-ancestor origin/main HEAD
test -f "$R/lib/remote-mux.js" && grep -q "host mux relay" "$R/lib/index.js"
```

## 3. 禁止的临时修改

- 禁止把 `dsh-rh-*` 验证 worktree 设成 profile 软链；
- 禁止直接改 `/Applications/DeepSeek Harness.app` 的内容（签名与 asar 完整性会被破坏）；
- 禁止在 `main` 上提交未经验证的实验代码。会话路由变更用实机重开和本地、远端历史加载做验收；
- 禁止写 `~/.dsh/profiles/desktop/**` 做测试：测试必须用独立 `DSH_HOME` 的 lab profile。

## 4. 自愈任务的硬约束

`scripts/ensure-profile.mjs`（以及任何 launchd 自愈任务）必须满足：

- **只在目标不存在时创建**软链；已存在且指向一个合法 checkout 时**绝不覆盖**；
- 同一 Label 只允许存在一个 plist（本机曾出现两个同名 Label 的 plist，导致每 30 分钟把软链改成实验分支）。

当前已清理：两个 `ensure-profile` plist 均已从 LaunchAgents 移除，备份在 `~/Workspace/dsh-app-backup/`。

## 5. Git 工具链注意事项

本机 shell 环境带有**残缺的 Git 配置变量**（只有 `GIT_CONFIG_VALUE_*`，没有匹配的 `GIT_CONFIG_KEY_*`），会让 `git` 直接 `fatal: unable to parse command-line config`，**并使 `git status` 输出为空从而被误判为「工作树干净」**。

所有自动化脚本调用 git 时，必须用干净环境：

```bash
env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin" git -C "$R" status --porcelain
```

## 6. 启动前自检（一条命令）

```bash
bash scripts/preflight.sh
```

预检核对 App 和模型补丁、唯一安装路径、插件链接、同步基线、当前 checkout 的宿主侧 mux 分流和自愈 plist。
