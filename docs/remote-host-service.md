# 远端宿主服务的两个自愈前提

插件要在远端宿主重启后自己恢复，必须满足两个前提。两者都**不在仓库里**，都部署在远端机器上；本文只记录做法，**任何密钥值、token、cookie 一律不写入仓库**。

失败表现（2026-11-26 事故）：宿主被看护进程重启后，本地挂载返回

```
dsh-remote-host: remote credential expired and could not be refreshed
```

远端工作区变红、打不开；记忆页（OpenViking）返回 502。

## 1. 入口横幅：可能不在 tmux 面板里

凭证是用宿主启动时打印的入口 URL（`dsh web: http://…?token=…`）换来的。插件原先只从 tmux 面板抓这一行（`tmux capture-pane -p -S -4000`），面板滚出 4000 行后就再也抓不到，于是**凭证过期即无法重铸**。

官方启动器会把宿主 stdout 重定向进日志，面板里根本没有横幅：

```text
~/.artifacts/dsh-superagent-<profile>-<stamp>-<pid>.log
```

所以 profile 里要告诉插件去哪个日志找：

```yaml
credential:
  sshHost: <ssh-alias>
  bannerLogGlob: '~/super_agent/.artifacts/dsh-superagent-*.log'
```

插件现在**一次 ssh 同时读两个来源**并按来源打标：启动器日志优先（它对应最新一次启动），tmux 面板作为兜底。日志 glob 只接受 shell 安全字符，含其他字符时直接忽略该来源。

## 2. 记忆运行时的 key：必须进宿主进程的环境

OpenViking 的配置把 root key 写成占位符：

```json
{ "server": { "auth_mode": "trusted", "root_api_key": "${OPENVIKING_API_KEY}" } }
```

宿主里的记忆运行时用同一个变量去调用它。**缺这个变量时每次读取都 401**，`/orchestrator/api/memory` 于是返回 502，面板的记忆页打不开。

坑在于：看护进程（cron）拉起宿主时**不继承任何交互式环境**，把变量写进 `~/.bashrc` 或只在手工会话里 export 都不算数。做法是把值放进一个 0600 文件，由启动器读它：

```bash
umask 077
mkdir -p ~/.config/super-agent/openviking
# 从正在运行的 OpenViking 进程环境里取一次（同用户可读），全程不回显
printf '%s' "$(tr '\0' '\n' < /proc/$(pgrep -f 'openviking-server --config' | head -1)/environ \
  | sed -n 's/^OPENVIKING_API_KEY=//p')" > ~/.config/super-agent/openviking/api-key
chmod 600 ~/.config/super-agent/openviking/api-key
```

然后让**实际被 cron 调用的那个启动器**在拉起宿主前注入它。注意有两个入口，两边都要覆盖：

- 交互式入口 `start-host.sh`：

  ```sh
  if [ -r "$HOME/.config/super-agent/openviking/api-key" ]; then
    OPENVIKING_API_KEY=$(cat "$HOME/.config/super-agent/openviking/api-key")
    export OPENVIKING_API_KEY
  fi
  ```

- cron 入口 `dsh-superagent`（它把宿主命令拼成字符串交给 tmux，所以注入要进那条命令）：

  ```python
  key_file = Path.home() / '.config/super-agent/openviking/api-key'
  env_prefix = ('OPENVIKING_API_KEY=$(cat ' + shlex.quote(str(key_file))
                + '); export OPENVIKING_API_KEY; ') if key_file.is_file() else ''
  command = ('umask 077; ' + env_prefix + 'exec ' + shlex.join([...]) + ' >> ' + log + ' 2>&1')
  ```

改完都要过一遍语法检查（`bash -n` / `python3 -m py_compile`），并留备份。

## 3. 验证

```bash
node scripts/remote-host-doctor.mjs --ssh <ssh-alias> \
  --banner-log-glob '~/super_agent/.artifacts/dsh-superagent-*.log'
```

它只读，检查四件事：日志里能拿到入口横幅、key 文件存在且是 0600、宿主进程环境里带这个变量、记忆接口经新凭证返回 200。任何一项失败就以非零退出。

端到端自愈验证（最有力的一条）：把本地 HTTP 凭证写坏再发一次请求，插件应当在**同一次请求内**从日志重铸并返回 200：

```bash
printf 'dsh_session=poisoned' > ~/.dsh/dsh-remote-host/cookie.txt
# 然后访问一次挂载，看是否仍然 200，且文件被重写成新的凭证
```

## 4. 不要写进仓库的东西

`docs/sensitive-data.md` 列出占位符约定。本文涉及的这些东西**永远不入库**：

- `OPENVIKING_API_KEY` 的值（只入库「文件路径 + 0600 + 启动器注入」这个做法）
- 入口 token、`dsh-auth-…` 凭证、cookie 内容
- 真实内网地址与用户名：一律写 `devbox.example.com:3080`、`/home/<user>`

`verify-sensitive` 会拦住 IP 字面量等泄露，提交前跑 `npm run check`。
