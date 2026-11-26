# Changelog

## 未发布

### 变更（侧栏：远端会话改由 `__DSH_HIDDEN_SESSIONS__` 隐藏，删除 claim workaround）

- **隐藏机制换成上游正式契约**：`group: none` 不再伪造 `workspace:drh:claim` 收拢远端会话，而是把已发布的远端 id 写进 `globalThis.__DSH_HIDDEN_SESSIONS__`（`Set<string>`），由 shipped 树的 `sessionVisible()` 跳过（配套上游补丁 `scripts/patches/hidden-sessions.patch`）。集合成员变化时才重建；`pagehide` 时释放（下一次 list 应答会重发，覆盖 back/forward cache 恢复）；该全局已被非 Set 值占用时不接管。
- **删除 claim workaround**：`claimRemoteSide()` 及其调用点、三处 create 改写（`withoutWorkspaceId` / `dropWorkspaceId` / rpc 分支）、`api-session/added` 抑制、client 的 `hideClaimSection`/`hideClaimOverflow` 与 `block.css` 两条规则。`session/create` 仍只按 `workspaceId` 判定（真实远端工作区 → mount），payload 不再被任何载体改写；远端 `api-session/added` 照常转发，另触发一次 list 重读以便隐藏集合尽快学到新 id。
- **保留** `single`/`workspace` 的既有行为（真实远端工作区记录）。catalog 仍由合并后的 `session/list` 供给，`sessions.retain` 不受影响。
- **回归**：`test/hidden-sessions.test.mjs` 7 例（发布 Set / 仅 none 发布 / 成员变化才重建 / pagehide 释放且下次 list 重发 / 非 Set 不接管 / 三种模式下任何 publish 结果都不再出现 claim / catalog 仍列远端 id）；`group-modes`、`create-routing`、`event-filter` 的 claim 用例按新行为改写。`node --test test/{group-modes,create-routing,session-list-merge,routing,client-*}` 56/56，页面级 shim/client 套件 111/111。本地 client 未打上游隐藏补丁，故「隐藏生效」需在打过补丁的环境端到端验证；本地验证的是「发布正确」。

### 新增（SSH 多路复用：一条 master 服务所有 ssh 调用）

- **每次 mint 都重新握手**：插件的两类 ssh 调用（常驻转发 `ssh -N -L` 与凭证铸造 `ssh -T <host> …`）各开各的连接，每次都要重新握手与认证。本机实测单次新连接 **759ms**（3 次：759/830/752），而复用一条已认证的 master 只需 **112ms**（164/112/107）。
- **做法**：新增 `lib/ssh-control.js`，把「一个 host 一个 socket」的口径收敛到一处——`controlPathFor(dir, host)`（确定性路径，别名清洗 + 截断 32 字符，避开 macOS `sun_path` 104 字节上限）、`controlArgs()`（`ControlMaster=auto` + `ControlPath=…` + **`ControlPersist=no`**）、`exitArgs()`（`-O exit`）、`ensureControlDir()`（0700）。转发进程即 master，铸造与脚本复用它的 socket；`ControlPersist=no` 保证 master 的生命周期不超过创建它的隧道进程，因此**不违反「退出后不留 ssh 残留」**。
- **接线**：新增配置 `sshControl`（布尔，默认 `true`）与 `controlDir`（默认 `/tmp/drh-ssh-<uid>`）；`mountRemote` 解析一次，向下传给 `sharedSshForward → superviseSshTunnel → attemptSshTunnel`（`deps.control = { enabled, dir }`），并同时传给三个 `makeRefresher` 调用点（`lib/credentials.js` 新增第三参数，把两个字段带进 mint）。低层 `resolveControl()` 是 **opt-in**（只有显式 `enabled: true` 才启用）：产品默认由 mount 解析，单元测试因此不会去 spawn 真 ssh。
- **清理**：`killTunnel(child, control)` 先发 `ssh -O exit`（独立短命子进程、1s 上限、失败只记日志），再走原有的 SIGTERM→250ms→SIGKILL 进程组升级；顺序与「不等待」都保持，转发端口仍在同一 tick 释放。
- **实测（真实 devbox，独立于被测代码的 bash/python 探针）**：`ssh -O check` 回 `Master running (pid=…)`；socket 权限 `srw-------`（目录 0700）；经 master 执行远端命令 0.09s；`ssh -O exit` → `Exit request sent.` → socket 消失、master 进程消失。
- **独立黑盒验证**：`test/ssh-control-integration.test.mjs` 用「假 ssh 放 PATH 首位」的方式黑盒跑真实链路，5/5 通过，并验证了**敏感性**（接线落地前同一 harness 观察到全红；把 `ControlPersist` 期望改成 `yes` 会失败）。记录到的 argv 恰好 3 条：转发（含 `-L`）、mint（同一 `ControlPath`）、`-O exit`；禁用时 2 条且零 control 选项、不建 socket。
- **断线重连也免认证（master 常驻）**：`ControlPersist` 不再固定为 `no`，改为可配置窗口 `controlPersistSec`（默认 **120s**）。实测（真实 devbox）：杀掉隧道客户端后 master 仍然存活（`Master running (pid=85331)`），经由它的重连 **122ms**（202/122/105）vs 全新握手 **832ms**（869/791/832）——**每次重连省 710ms**。
- **崩溃兜底（双保险）**：① 正常退出仍先发 `ssh -O exit`（已测：master 与 socket 一起消失）；② 宿主被 `SIGKILL` 之类无法优雅退出时，master 只在窗口内残留，实测 5s 窗口后自动消失、socket 一并清掉；③ 下次建 master 前先 sweep：socket 文件存在但 `ssh -O check` 不答（上次崩溃的遗骸）→ 先删除再由 ssh 接管，避免 "Control socket connect" 卡死。实测：`SIGKILL` 后 1s master 仍在（正是复用的前提），窗口过后 master 与 socket 均消失。
- **回归**：`npm run check` **210/210**；新增 4 个测试文件（`ssh-control` 10、`credential-control` 10、`tunnel-control` 10、`ssh-control-integration` 5），覆盖常驻窗口的取值口径、崩溃遗骸的清理顺序（必须在 spawn 之前）、以及"活着的 master 不被动"；既有 `ssh-mode`/`tunnel-retry`/`tunnel-forward` 口径不变。四个新测试文件运行后临时目录增量为 0。

### 修复（SSH 隧道：一条长连接，探测不再重建端口）

- **每条重连都换一个 upstream 端口**：`mountRemote` 每次被 Cordis 重新 apply 都新建一个 `superviseSshTunnel`（`localPort` 从 undefined 起、重新 `freePort()`）。日志里 2026-11-26T03:27:50.748Z 起 40 毫秒内 6 次 `apply: upstream=…60477/60483/60488/60491/60494`，而同一秒 `lib/routes.js` 的时间戳正是 11:27:50——即"改插件文件 → 条目重启 → 重建隧道"。于是任何一次改动/配置重载都会把已经指向旧端口的 mux、会话流、请求全部打断。
- **就绪判定是假的**：`attemptSshTunnel` 用 `probeLoopback`（裸 TCP accept）就算 up。`ssh -L` 在远端起可达之前就先绑本地端口，内核还能用 backlog 完成握手，于是发布了一条"什么都没穿过"的隧道，紧接着自己的健康探测两次 miss（1200ms 超时 / 1500ms 间隔）把它拆掉——探测反过来制造了它要治的抖动。
- **退避梯度在抖动时永远停在第一级**：`cycle()` 每次"成功"都 `failures = 0`，连上 1 秒就死也算成功，所以每次重建都从 500ms 起，可以无限热循环。
- **被替代的 supervisor 收不掉在飞的 attempt**：dispose 只关 `current`，还在 dial 的 `ssh` 子进程最多再活 12 秒并占着端口；6 次 apply 就有 6 个竞争的子进程与端口。
- **修法**：① 抽出 `sharedSshForward()`，按 `sshHost|remoteHost|remotePort` 复用**一条**转发：重新 apply 会重挂到运行中的隧道并立刻拿到同一个 base（端口不变），最后一个挂载 detach 后空闲 30 秒才停，所以"停插件"也不会留 ssh 在后台；② 就绪改为**真实往返**（`probeTunnel`，800ms 预算 / 12s 上限），裸 accept 只当候选；③ 新隧道先给 1 秒静默期再探测，且**只有存活 ≥30 秒的隧道失联才重置梯度**（`stableMs`），抖动期间梯度 500ms→1s→2s→4s→8s→15s→30s 递增；④ attempt 接受 `AbortSignal`，dispose 时立即杀掉子进程。
- **参考**：DSH 自己的 `packages/ssh/ssh` 就是这个模型——一条常驻 `ssh` + `ServerAliveInterval=10/CountMax=3`，再叠一条应用层心跳（`leaseMs/3`，不重入，超时 `leaseMs/2`），心跳失败是"判定这条连接死了"，不是"拆掉立刻重拨"。
- **回归**：新增 `test/tunnel-forward.test.mjs` 6 例（重挂复用同一 base 且不重拨、空闲才停、就绪需真实往返、取消 attempt 会回收子进程、抖动时梯度递增、稳定后梯度重置）；原有 `test/ssh-mode.test.mjs`、`test/tunnel-retry.test.mjs` 口径不变（阻塞拨号仍是 503、重建仍复用同一端口、卡死仍在 5 秒内重建）。`npm run check` 172/172。

### 修复（侧栏：连接抖动时标题文字一直闪）

- **「远端工作区 · <host>」这一行在不停闪**：`lib/client.js` 把连接状态（`open`/`connecting`/`error`）算进了结构签名与表头形状，于是每一次腿状态变化都被当成「结构变了」——整块列表连表头一起重建，标题的文字节点每次都被销毁重造。而 shim 在每次腿重连时都会发布 `connecting` → `open`（`src/shim/50-router.js` 的 `connect` 与 `open` 回调），本机 11-26 的插件日志里隧道每 30~49 秒重建一次、一次连发 6 次 `apply`，`renderer-trace.log` 里状态发布在突发时中位间隔 187ms，所以看起来是「一直在闪」。
- **修法**：连接状态不再进入 `signature` / `headerShape`，只参与新的 `paintPlan().dot`；表头在结构重绘时也只在自己的形状变化（搜索框展开、label 改变）时才替换，状态改由 `patchHeaderDot()` 原地改 `data-state` / `title`。状态变化时表头、标题文字与圆点三个节点都保持身份，连接中的 spinner 也不再每次刷新重启动画。
- **实测（真实 DOM：`/tmp` 隔离页 + headless Chrome 157，10 次状态翻转）**：修前容器级 childList 变更 **30** 次、表头与标题节点均被替换；修后 **0** 次、只有圆点属性变更 **20** 次，表头/标题/圆点身份不变。列表变更（改名 + running）仍按原路径生效，搜索展开仍按预期重建表头一次。
- **回归**：`test/client-paint.test.mjs` 8 例锁住 `paintPlan`（状态只喂 dot，搜索/label 才重建表头）；`scripts/patch-probe.mjs` 新增 3b 两例在真实页面上断言同一口径。`npm test` 166/166。

### 修复（模型目录补丁：客户端参数个数校验）

- **每次加载都留一条 `client api: session/modelCatalog expected 1 argument(s), got 0`**：补丁给宿主方法加了可选的 `sessionId`，而生成的客户端按声明的参数**个数**校验，于是「没有 Session」的读取（0 参）在客户端本地就被拒 —— 请求根本没发出去，只留下一条 rejection。补丁内三处 Session-less 调用改为显式传一个位置参数：`undefined` 在编码时被丢弃，线上仍是「无 `sessionId` 字段」，老宿主行为不变；对应的客户端 spec 断言同步改为 `(undefined)`。
- 覆盖范围由 2 个包 4 个文件扩到 **4 个包 6 个文件**（新增 `ui-settings-models` 与 `ui-settings-subagent` 的调用点）。
- 验证：`ui-model-selection/tests/catalog.client.spec.ts` 12/12 通过；`ui-settings-models` + `ui-settings-subagent` + `api/session-controller` 合计 **69 文件 / 1690 例**全部通过。

### 修复

- **`package-app.mjs` 在干净机器上跑不通**：第 2 步调了 `pnpm run prepare:desktop`。那是发布用的 `--prepare-only` 模式，读 `apps/desktop/.env.macos`（Git 忽略的本机发布配置）并在缺失时直接报错；而本机 unsigned 打包既没有也不需要这份配置——真正的打包步骤（`package:desktop:mac:arm64:unsigned`）自己会跑 `build --profile local`、pack、`prepare:runtime`、`prepare:packages`、`prepare:dsh`。移除这一冗余步骤。
- **已打过补丁的检出被误判成「有无关改动」**：`repoIsPatched()` 在 `packages/api/session-controller/src/index.ts` 里找补丁独有标记 `OwnerEntry`，但该标记实际落在 `packages/client/ui-model-selection/src/client/catalog.ts`（9 处）。结果是打完补丁后第二次运行必定失败，与「可重复跑」的口径矛盾。改为检查 `catalog.ts`。
- **dmg 明明打出来了，却被判成「没产出 dmg」**：`newestDmg()` 在仓库里按 `depth > 4` 递归找 `.dmg`，而产物实际在 `apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/` 下（第 7 层）——于是构建成功、第 4 步却以「no dmg was produced」退出 1，产物既不校验也不落 manifest。现在改为读 harness 自己打印的 `DMG: <path>` 行；`newestDmg()` 只作兜底，并收窄到构建输出目录、跳过 `.app` 与 store。

### 修复（deploy-remote）

- **远端 `~` 从不展开**：远端命令里路径用单引号包住，`~` 不展开 —— 备份写进字面量 `~/…` 目录（还被 `2>/dev/null || true` 吞掉失败），`scp` 目标变成相对路径直接失败。改为先经 `ssh 'printf %s "$HOME"'` 解析远端 home，再用绝对路径加引号。
- **补丁解压到包根目录而不是 `lib/`**：归档内容是 `lib/` 内的文件，却 `tar -C <包目录>` —— `lib/` 一个字节没变、补丁文件散落在包根，流程照样打印“已部署”。改为 `-C <包目录>/lib`，备份先 `mkdir -p` 子目录且失败即 `exit 1`。

### 变更（打包基线：0.2.3-alpha.2）

- **打包入口锁到上游 `dsh-v0.2.3-alpha.2` / `4b399c39`**：补丁文件改为 `scripts/patches/modelcatalog.patch`（4 个包共 6 个文件）。`node scripts/package-app.mjs --dry-run` 第一步就会打印 `base dsh-v0.2.3-alpha.2 (4b399c39…)`。
- 基线仍只在 `scripts/apply-upstream-model-catalog.mjs` 的 `BASE_TAG` / `BASE_COMMIT` 定义一次，`package-app.mjs` 读取它，不重复维护版本号。

### 新增（运维入口：凭证 / URL / 自检）

- **`scripts/remote-access.mjs`（`npm run remote:url` / `npm run remote:cookie`）**：读远端宿主启动横幅里的入口 URL → 到 `/connect` 换出 mux/API 需要的凭证 → 写入 `cookieFile` 并备份旧文件。新版宿主的入口 token 只授权页面，凭证过期会表现为 HTTP 401、WebSocket 停在 CONNECTING；这条命令把「换凭证」从手工救火变成一行。实测：刷新后 HTTP `200`、`/api/remote.mux` 升级 `101`。
- **`npm run remote:doctor`**：一行命令自检凭证链路（文件是否存在、字符数、远端 HTTP 状态），失败时直接打印「该跑哪条命令」。

### 修复（凭证模型：一条 `/connect` 凭证只够一条 WebSocket）

- **泵与代理不再共用一条凭证**：`/connect` 换出的凭证一条只授权一条 WebSocket，socket 关闭时它的 peer 被撤销、**HTTP 一起失效**。此前泵与代理读同一个 `cookieFile`，页面那条流一直开着就把代理要用的凭证花掉。现在泵拨号读独立的 `<cookieFile>.pump`（缺失时回退 `cookieFile`），代理继续用 `cookieFile`。
- **代理遇 401 重铸并重放一次**：请求体先缓冲；401 说明凭证已被上一条 socket 用掉，于是读远端启动横幅重新换凭证并原样重放一次，仍失败才回 401，页面无需重载。

### 新增（凭证自愈）

- **`lib/credential-mint.js`**：经 `ssh <host>` 读远端宿主启动横幅里的入口 URL → 到 `/connect` 换出 mux/API 凭证 → 写回 `cookieFile`（旧文件备份）。宿主侧仅在配置了 `credential: { sshHost, tmuxSession }` 时启用：泵的拨号被拒（HTTP 401，多半是凭证已被上一条 socket 用掉）会刷新凭证并自动重拨一次，页面无需重载。默认关闭，不改变现有行为。

### 修复（DSH 0.2.3-alpha：远端流改由宿主中继）

先更正一条此前的结论：**同一窗口挂载是可行的**。真正不通的只有 WebSocket 这一条传输，HTTP 一直是通的。

- **HTTP 本来就通**：桌面 shell 的 `dsh-app://app` 协议处理器把除静态资源以外的**全部路径**转发给本地宿主（`forwardWebRequest`），并把 `origin`/`sec-fetch-site`/`cookie` 剥掉、换成宿主自己的凭证。所以 shim 的相对路径请求（`/devbox/api/…`）走的是受信通道，来源栅栏不拦。
- **只有 WS 不通**：自定义 scheme 无法承载 WebSocket；直接连 `ws://127.0.0.1:<port>/devbox/api/remote.mux` 又带 `Origin: dsh-app://app`，被 `isTrustedApiRequest` 以 403 拒绝（实测），而直连远端 `/api/remote.mux` 带新凭证是 101。`auth: 'anonymous'` 绕不过它——栅栏在策略之前。
- **实现**：宿主新增 `POST <mount>/__dsh_remote_host__/mux-poll`（`lib/mux-poll.js`），由宿主持有到远端的真实 mux 连接并缓存帧；页面在自定义 scheme 下改用 `PollSocket`（`src/shim/30-streams.js`）以「cursor + uplink + 长等待」驱动同一套 mux 协议（`send` 会立即中止等待，所以上行帧不排队），浏览器里仍走原生 WS 字节中继。
- **仍未改变的一条**：网关独占了唯一的 `/api` 拦截器（第二次 `intercept('/api')` 直接抛错），所以远端会话仍不能并入原生 `session/list`，侧边栏远端段仍由插件自绘；这一条要上游支持「第二宿主」才能改。

### 验证

- **打包链路**：`node scripts/package-app.mjs` 跑通（退出码 0）：打补丁（4 个包共 6 个文件）→ `pnpm install --ignore-scripts` → `pnpm run build` → `package:desktop:mac:arm64:unsigned` → 挂载校验 → 落盘；`manifest.json` 只有在第 4 步校验通过后才写出。
- **产物**：`~/Workspace/dsh-app-build/deepseek-harness-0.2.3-alpha.2-mac-arm64-unsigned.dmg`，`279,016,992` 字节，`sha256 af9adf819242cef4f4dfac657c5ae813d723c01dc3000ff50945ebd1da7c7285`；补丁 `scripts/patches/modelcatalog.patch` 的 `sha256 feec2c9732a5f5f8c289c5c1f4c251bab3a722c8fef5dbb2787566ab9c5b69c9`；标记 `OwnerEntry 9` / `storeFor 23`（stock 17），`baseTag dsh-v0.2.3-alpha.2`、`baseCommit 4b399c39…`。
- **判据对照**：官方基线包 `OwnerEntry 0`（stock `storeFor 17`）不满足 `OwnerEntry > 0`，会被 `verify` 以退出码 1 拒绝；本地产物 `OwnerEntry 9` 通过（退出码 0）。
- `npm run check`：106/106 测试通过；`lib/shim.js` 与 `src/shim/*` 一致（10 个模块）；`verify-sensitive` 在 108 个 tracked 文件里 0 命中。
- **真机验收（重启 App 之后）**：
  - 宿主日志 `/tmp/dsh-remote-host-<pid>.log` 含 `stream mount: ok` 与 `host mux relay: ok`；开 `trace: true` 时另有 `mux-poll cursor=… uplink=…` 行；
  - `~/.dsh/dsh-remote-host/renderer-trace.log` 里 `host-relay-status` 走到 `{"state":"open"}`、`remote-open` 的 `streams` 为 2，`workspace-baseline` / `session-snapshot` 各有 `kind: remote` 条目；
  - 界面左侧「远端工作区 · devbox」列出远端工作区与会话，点进会话可见内容。
- 口径说明：打包耗时差别主要在下载 Electron / Node 运行时 / 依赖包；本机缓存已热时明显更快，真正的冷机器只需多算这部分下载时间。

## 1.14.10 — 2026-11-24

### 修复

- **`install-selfheal.mjs` 永远以退出码 1 结束**：收尾校验用了 `statSync` 却从未 import，`ReferenceError` 抛在写 plist 与 `launchctl bootstrap` **之后** —— 于是「实际装上了、命令却报失败」。反复重跑正是历史上出现两个同名 Label 自愈任务的来源之一。补上该 import。

### 新增

- `install-selfheal.mjs --dry-run`：只打印将写入的 plist 与将 bootstrap 的 Label，不落盘、不碰 launchd。
- `test/install-selfheal.test.mjs`：两个用例锁定「同名 Label 阻断安装」与「`--dry-run` 不写任何文件」，两者都不触碰真实 launchd。

### 验证

- 临时 `HOME` 实测：安装 → 退出码 0、agent 载入、plist 写入；紧接着卸载 → 退出码 0、agent 消失、目录 0 个残留；真实 `~/Library/LaunchAgents` 未被改写。

## 1.14.9 — 2026-11-24

### 新增

- **打包入口 `scripts/package-app.mjs`（`npm run package:app`）**：把「打上游模型目录补丁 → 构建 → 出 unsigned dmg → 校验产物」串成一条命令，任何一步不满足即非零退出。换机器或升级 DSH 版本时，不再依赖谁记得手动打补丁。
- **产物自证**：`verify` 子命令挂载 dmg 直接读 `app.asar`，用补丁独有标记 `OwnerEntry`（官方 0 处 / 补丁 9 处）判定；官方 stock 包会被以退出码 1 拒绝。通过后复制到输出目录并写 `manifest.json`（版本、上游基线 commit、补丁 sha256、标记计数、dmg sha256 与字节数）。
- **远端部署**：`deploy-remote --ssh <host>` 先把远端 runtime 里的两个包备份成 `modelcatalog-backup-*`，再解包覆盖，回滚命令随输出打印。
- `docs/packaging.md`：换机器 / 升级版本 / 复核 / 回滚的完整步骤。

### 修复

- **preflight 的模型补丁检查形同虚设**：原先数 `storeFor`，但官方 `app.asar` 里本来就有 17 处，即使装成官方原版也会显示 ok。现在改为数补丁独有标记 `OwnerEntry`（官方 0 处），装错版本会在启动前就被拦下。

### 变更

- 新增 `npm run verify:app -- <dmg>` 与 `npm run deploy:model-patch` 两个入口。

### 验证

- 现网 dmg 复核：`version 0.2.2-rc.5`、`OwnerEntry 9`、`storeFor 23` → OK（退出码 0）；
- 官方 0.2.2-rc.5 App 复核：`OwnerEntry 0`、`storeFor 17` → 按预期被拒（退出码 1）；
- `--dry-run` 打印完整命令序列且不产生任何写入。

## 1.14.8 — 2026-11-24

本版是「可以直接用」的稳定版：宿主与客户端两端语义一致，退出 App 重开即可正常加载远端工作区与会话。

### 修复

- **退出 App 重开后远端工作区/会话加载失败**（两端版本错配）：客户端自 1.14.7 起默认开启 `streamRelay`，把页面 mux URL 改写成 `<mount>/api/remote.mux`；而宿主侧中继当时只存在于分支上，`main` 没有它，于是该请求被当作普通挂载代理到远端、拿到 404，远端挂载永远建立不起来。现在宿主侧中继（`lib/remote-mux.js` + `lib/index.js` 的挂载 + `ws` 依赖）随 `main` 一起发布，`main` 本身即可运行。根因与逐条证据见 docs/regression.md 的 2026-11-24 条目。
- **`ws` 缺失会让整个插件加载失败**：profile 用 `link:` 指向本仓库，包管理器不安装被链接包的依赖，`ws` 必须来自仓库自己的 `node_modules`。修复动作为 `npm ci`；preflight 现在直接校验它能否解析。
- **修复远端短抖动导致的渲染进程崩溃**：mux 连接不再由插件自建，只重写 URL 交给官方连接层，连接与重连由其负责（config.streamRelay 默认开启，显式 false 可回退）。详见 docs/known-issue-short-flap-crash.md。

### 新增（守卫）

- `scripts/preflight.sh` 新增四项，把「文件是对的但跑的是旧代码」这类情况拦在启动前：
  - `shim build matches sources`：`lib/shim.js` 必须等于 `src/shim/*` 的拼接结果；
  - `plugin dependency ws resolves`：从仓库目录 `import('ws')` 必须成功；
  - `running host mounted the relay`：读**当前宿主 PID** 的 `/tmp/dsh-remote-host-<pid>.log`，必须含 `host mux relay: ok`；
  - `no second DSH host (dsh web)` / `no dsh web autostart`：`~/.dsh` 只允许一个宿主。

### 变更

- `main` 快进到同时包含客户端改写与宿主侧中继的合并提交；`docs/instance-layout.md` 改写为唯一口径，并明确禁止再检出到「客户端已开 relay、宿主没有 relay」的中间态。
- 移除历史遗留的 launchd 任务 `com.deepseek.dsh.web`（`dsh web`，与桌面 App 共用 `~/.dsh` 的第二个宿主）；plist 备份到 `~/Workspace/dsh-app-backup/`。

### 验证

- 真实 App 启动日志含 `host mux relay: ok`（该行是宿主侧中继已挂载的直接证据）；
- 同一份 renderer trace 中 `workspace-baseline` 本地/远端各 1 条、`session-snapshot` 本地与远端均出现、`failure` / `degrade-handoff` / `remote-unavailable` 均为 0；
- `npm run check` 全绿（含 `lib/shim.js` 重建一致、哨兵 0 命中）。

## 1.14.7 — 2026-11-23

### 修复

- **远端会话模型位显示「请选择模型」**：两个缺口一起补——(A) 远端会话行里的 `projections.modelSelection`（即「已保存的选择」）此前被整份丢弃；(B) 模型目录只来自本机，而两端模型 id 本来就不同（本机 `modelhub-deepseek-v4.1-flash`、远端 `deepseek-v4.1-flash`），于是「已保存的选择不在目录中」。现在 (A) 透传 `projections`（8 KiB 上限），(B) `session/modelCatalog` 按**会话所属宿主**取（远端焦点 → 持久化当前会话 → 本机兜底；冷启动等待首个远端快照落定；mount 侧 2.5 s 超时且失败降级本机），并且**不做并集**。
- **`session/create` 被误路由到远端**：判据从「payload 里出现任意远端 id」改为按工作区作用域判定，`drh:claim` 这类合成 id 去掉后交给本地宿主；fetch 与 rpc 两个载体同修。此前一个**本地工作区**的 create 会因为 payload 带远端 sessionId 被拽到 mount，进而报 `workspace/not-found`。
- **补丁渲染的 `written` 语义**：它原本表示「基线不同」，而基线只在重建分支刷新，导致每次状态补丁都被误判为重写并重新 `focus()` 搜索框（打字时光标被拉回）。焦点恢复与诊断标志改用真实的 `rewrote`。

### 新增

- **渲染进程 JS 错误取证**：`window.error`、`unhandledrejection`、`console.error` 进入面包屑并立即上报（绕过 1 次/秒限速，上限 20 条/次加载）。桌面崩溃日志一直写着「no error-level renderer console output was captured」，这条通道补上那份缺失证据。
- **`scripts/patch-probe.mjs` 行级补丁探针**：10 条断言，用「节点身份 + 容器级 childList 次数」区分补丁与重建。

### 已知限制（诚实记录）

- **同一次页面生命周期内切换宿主后，模型目录仍是上一次的，需重载页面**。根因在客户端：目录在页面启动时取一次并全程缓存，且该请求早于会话恢复，shim 无法强制其重取。根治需上游支持（`session/modelCatalog` 接受 sessionId 按会话返回，或切会话时失效缓存）。

### 验证

- **58 个数据面测试全绿**；`lib/shim.js` 重建一致；仓库哨兵 0 命中。
- 模型修复实测（真实 devbox，112 条远端会话中 60 条带 `modelSelection`）：重载后打开远端会话，模型位显示 `DeepSeek V4.1 Flash (CPA) Max`、占位消失；该次目录请求两次均走 mount；本地会话仍走本机目录；mount 被阻断时降级本机、无错误、请求不增长。

## 1.14.6 — 2026-11-23

### 新增

- **崩溃循环熔断（安全模式）**：渲染进程如果在 60 秒内被重启超过 4 次，本次加载就不挂载远端分区、也不做 session/list 合并，只保留本地功能——把「一直崩」降级成「远端暂时不可用」。记录写在 localStorage（要能熬过崩溃引起的 reload），超过一分钟的旧记录自动过期，安静一分钟后刷新即恢复；也可以用 localStorage.removeItem("drh:boots") 立即恢复。

### 验证

- 47 个数据面测试全绿；lib/shim.js 重建一致。
- 实测 6 次连续 reload：boot 1–4 正常挂载（safe:false），boot 5–6 自动进入安全模式（block:false, safe:true），清掉记录后立即恢复挂载。

## 1.14.5 — 2026-11-23

### 新增

- **行级补丁渲染**：重绘拆成「结构签名」与「状态签名」。只变状态时（running、时间戳与标题文本、选中行、打开的菜单、置顶按钮）走补丁路径，完全不碰 `innerHTML`——就地增删运行中 spinner、文本有差异才改写、切换选中/菜单 class、替换置顶 sprite；只有结构变化（组键与排序后的行 id、展开集合、分组/排序/筛选、查询、归档标记、连接状态、搜索态）才整块重建。强制重绘不再隐含重建，否则 announce 路径会把补丁路径抵消掉。
- **`scripts/patch-probe.mjs`**：在 lab 里量化补丁路径的探针（行节点身份、容器级 childList 变更数、顺序变化时是否重建）。
- **仓库脱敏与哨兵**：新增 `scripts/verify-sensitive.mjs`（接入 `npm run check` 与 CI）与 `docs/sensitive-data.md`；`CONTRIBUTING.md`/`README.md` 增加「不得提交内部信息」的硬性要求。

### 修复（远端不可达时不再崩、不卡、持续重连）

- **ssh 隧道失败会打死进程**：`spawn('ssh')` 没有 `error` 监听，ssh 无法启动时会被当成未捕获异常抛出；隧道起不来则直接 throw 且**永不重试**，整个会话期间都在拨一个不存在的跳板。现在改成「永不抛错的单次尝试 + 监管器」：失败按 500ms→30s 阶梯**无限重试**（单飞、定时器 unref），隧道建立后若 ssh 退出会再报一次并重建，期间挂载改走配置的 upstream 以便快速失败。
- **代理请求可能无限挂起**：通往远端的 unary 请求与 WebSocket 中继都没有超时，跳板被黑洞时浏览器请求一直挂着，表现为界面卡死。两者都加了 8s 上限，超时即以 502 快速失败。
- **诊断通道自己制造请求风暴**：面包屑攒够 10 条就发，快照式诊断每次 note() 都发一次，实测对不可达挂载产生 **4.5 次/秒** 请求。现在面包屑限速 1 次/秒（尾随补发，不丢数据）且失败按 2s→30s 退避；诊断快照合并为最多 1 次/秒，实测降到 **1.2 次/秒**。
- **崩溃取证无法进行**：宿主日志写死 `/tmp/dsh-remote-host.log`，被多实例共用并互相覆盖，崩溃那一轮的日志早已不在。现在优先写到实例自己的 DSH_HOME，否则按 pid 分文件。

### 修复（远端会话）

- **远端会话能看不能聊**：打开远端会话时为了让 `sessions.retain` 接受，先往客户端目录注入一行，`openSession` 成功后又把这一行删掉——而 composer 绑定的是目录条目，删掉即退化为「会话不可用」。现在只要该 id 已被 shim 归为远端就**保留**目录行（`group: none` 下由隐藏 claim workspace 认领，不会漏进「未分组」），未归类时才按旧行为删除。实测 composer `contenteditable` 由 `false` 变 `true`，消息经 `/devbox/api/session/prompt` 路由到挂载侧。

### 修复

- **分组行菜单打开时触发器不点亮**：补丁路径只遍历了会话行，组行的 menu-open class 从未被补丁，现在两条都走。
- **容器尚未绘制时补丁路径可能画空白**：补丁此前无条件相信签名，空 html 基线也会走补丁；现在空基线改走重建。
- **后到的图标 sprite 留下降级字形**：解析出的图标 id 纳入结构签名，sprite 晚到会触发一次重建。

### 验证

- 47 个数据面测试全绿（新增 4 个隧道重试用例）；`lib/shim.js` 重建一致。
- `scripts/verify-sensitive.mjs` 对 62 个受版本控制文件 0 命中。
- `docs/regression.md` 增加 B-30（状态变化只补丁、行节点身份不变）与 B-31（排序变化才重建）两条验收项。

## 1.14.4 — 2026-11-23

### 修复

- **点开会话后出现两行「远端工作区」标题**：分段重绘里，当新旧 header 形状**相同**时跳过了替换，但没有把新 header 从模板里摘掉，随后的「追加兄弟节点」循环又把它追加了一次 → 变成两行。现在相同形状时直接丢弃新副本。
- **远端连不上时界面卡死、随后崩溃**：`mergeSessionList` 的挂载侧请求**没有超时**。远端不可达时该 promise 永远 pending → 客户端 `session/list` 永不 resolve → 整个 UI 无法操作 → 最终渲染进程崩溃。现在挂载腿加了 **2.5 秒上限**（`AbortSignal.timeout`），超时即回退到本地应答，UI 不再被卡住。（这是继 1.14.0 修掉「重连同步递归」之后的第二个断线相关根因。）

### 验证

- 43 个数据面测试全绿；`lib/shim.js` 重建一致。
- 断线场景下 `session/list` 在 ≤2.5s 内返回本地结果（有界），界面保持可操作。

## 1.14.3 — 2026-11-20

### 修复

- **运行中 spinner 尺寸与本地不一致**：以**渲染后的实测值**为准（不是 CSS 声明值）。本地是槽位 **16×20**、内部 svg **14×14**、`viewBox 0 0 24 24`、圆 `r=9.5`；我们原来是槽位 14×14、`viewBox 0 0 20 20`、`r=9` —— 视觉上小约 17%。已全部对齐。
- **远端工作区标题每 4 秒闪一下**：状态自动刷新把每行 `updatedAt` 纳入重绘签名后，活跃会话的轮询会让整块 `innerHTML` 重建，标题也在其中。改为 **DOM 层分段重绘**：header 形状未变时只替换其后的列表节点，标题节点保持不变；另加 header 形状签名（状态/搜索态/label）保证只有 header 变化时也会更新。

### 验证（实测数据）

- 标题不再闪：标题区域 200ms 连拍 5 帧，SHA256 完全一致（`unique: 1`）；8 轮状态变化后标题 DOM 节点身份不变。
- 状态自动刷新（无点击）：`running` false→true **3980ms** 出现状态点，true→false **4064ms** 消失（上界 = 4000ms 轮询 + 渲染）。
- hidden 不轮询：可见 12s 内 2 次请求 → hidden 20s 内 **0 次** → 恢复后 12s 内 3 次。
- 持续变化 60s：12 次变化对应 12 次 announce，DOM 节点数 **Δ0**，heap 仅 GC 锯齿无单调上涨。
- 手动排序不被轮询改写：60s 后 69 个分组顺序与之前 `JSON.stringify` 完全相等。
- 43 个数据面测试全绿。

## 1.14.2 — 2026-11-20

### 修复

- **远端会话状态不再需要点击后才刷新**：两处叠加导致——(1) 区块的重绘签名不含每行状态，运行态与时间戳变化时签名不变、`renderBlock()` 提前 return；(2) shim 只在客户端主动请求 `session/list` 时才发布快照，远端会话开始/结束运行不会触发。
  修法：签名追加每行 `id:updatedAt:running`；shim 增加 **4 秒周期重读**（单飞、`document.hidden` 暂停、失败静默重试、digest 去重后仅内容变化时 announce，纯 interval 无递归）。

### 验证

- 不点击情况下：`running` false→true 后 **3.4s** 出现状态点，true→false 后 **2.4s** 消失；`updatedAt` 变化后 **4.2s** 行尾时间由 `1天` 变 `刚刚`。
- 60 秒空转采样：heap 变化 **−99KB**、DOM 节点 **2623 → 2623**、仅 **1 次** announce（digest 去重生效）。
- 测试增至 **43 个**（新增会话轮询 2 例：钩子存在/可停止、快照未变化不重复 announce），并把测试沙箱的 `dispose()` 补上以支持常驻定时器。

## 1.14.1 — 2026-11-20

### 修复

- **运行中会话的 spinner 不再每圈回跳**：shipped 的 `_dsh-state-dot-dash` 在 `100%` 是 `stroke-dashoffset: 0`（回到起点），我们误写成 `-24`；dash 周期为 `12 + 150 = 162`，`-24` 不是周期整数倍 → 每 1.5s 弧线跳变一次。同时删掉多余的 `transform-box: fill-box`，与 shipped 保持 `transform-origin: center center` 一致。
- **表头 label 颜色对齐原生**：原用 `--dsw-alias-label-tertiary`（`rgb(129,133,140)`），改为 `--dsw-alias-label-secondary`（`rgb(173,178,184)`，与原生一致）。

### 验证

- 连拍 3 帧（间隔 300ms）读 `getComputedStyle(transform)` 角度：`-76° → -4° → +72°`，每帧 +72°（=240°/s = 1.5s/圈），单调递增、无回放。
- `parity-snapshot` 复测：表头 3 控件 28×28、视图菜单 8 项/3 label/2 分隔线 176×0.5、行菜单 6 项/2 分隔线 120、目录菜单 3 项、三个菜单 `end` 对齐 `diffRight=0`、hover 卡 244/`rgb(44,44,46)`/圆角 16/延迟 800ms/锚点 +16、会话行按钮 `rightInset=7`、步进 29px、盒 24、svg 16/14/14。
- 41 个数据面测试全绿。

## 1.14.0 — 2026-11-20

### 修复（用户可见）

- **渲染进程崩溃（SIGTRAP）**：远端连不上、状态灯变红后会崩溃。根因是 `reconnectRemote()` 在 carrier 工厂**同步抛错**时**内联递归**调用自己（`connect → throw → reconnect → connect…`），且每次重试入口都同步发布状态并触发区块全量重绘。现在改为**单飞 + `setTimeout` 调度 + 封顶指数退避**（200ms→10s），状态**只在红绿切换时**广播；重试未关闭，断线仍可自动恢复。附带 `test/reconnect.test.mjs` 两条断言（退避序列、单飞去重）。
- **远端新会话点进去空白**：页面加载后在远端新建的会话不在客户端 catalog 里，只能靠注入的最小行打开，缺 `asOfSeq`/`formatStatus` 等元数据 → 空壳。现在打开前先让客户端刷新一次 `session/list`（我们的 shim 已带远端行），拿到完整行再打开；注入行降级为兜底，打开完成即移除。
- **新会话无法打开**（`sessions.retain: unknown session`）：改为从 `ctx.uiWorkspace.sessions.manager`（与 `openSession` 同 scope）注入，带降级；shim 补发 `blank` / `parentSessionId` / `formatStatus` / `asOfSeq`。
- **本地工作区多出一行「展开其余 N 个会话」**：远端行进入 `session/list` 后被归到本地桶且计数。现在用**静态 CSS**（`[data-row-key^='overflow:drh:']`）隐藏 claim 桶自己的溢出行；静态规则可扛住上游 remount（内联样式会被冲掉）。
- **空窗/白窗**：菜单、面板、toast 统一到 shipped 的三层浮层（透明 surface + 磨砂 material + darwin backing），移除 `--dsw-alias-bg-elevated` 之类的白色兜底；darwin backing 补 `border-radius: inherit` 与 `z-index: -2`，修掉方角与磨砂被不透明底盖住的问题。
- **点本地会话后远端行仍高亮**：`blockState.current` 只写不清，现改为点击原生会话行时清除。

### 与原生 UI 对齐

- 表头 3 控件（搜索 / 视图选项 / 新建工作区）28×28，label `14/400/20` `rgb(173,178,184)`。
- 会话行 hover 三按钮（`…` / 归档 / 置顶）24×24、svg 16/14/14、步进 29px、最右距行边缘 7px；目录行两按钮 212/241。
- 视图选项菜单 200×324（三段 8 项、label 11px、分隔线 0.5px、选中为尾部 check）；行菜单 144×225（6 项）；目录菜单 144×117（3 项）；菜单**右对齐触发器**。
- 长 hover 预览卡 244 宽、`rgb(44,44,46)`、圆角 16、`~/` 路径缩写、位置 = 区块右边界 + 16。
- 目录行静止显示文件夹、hover 换实心三角（与上游 `:hover` 换槽一致）。
- **会话状态呈现复用 shipped**：运行态是 `state-dot` spinner（`currentColor` 2px、1.5s 旋转 + 1.5s 虚线），位于前导槽；空闲行不渲染任何前导元素。
- 新建工作区改为**居中模态**，对齐 shipped dialog atom（380 宽、圆角 28、`--dsw-elevation-prominent`）；Esc 关闭、回车提交、空值/非绝对路径拦截并提示。

### 默认行为

- 排序与本地一致：组内按 `updatedAt` 倒序、**分组按组内最新活跃倒序**；手动拖拽顺序不被活跃度改写。
- 事件驱动的重绘改走**签名比对**（不再每次 announce 全量重建），3 秒保险 tick 降为 15 秒。
- boot 期 adopt 轮询收住：开机即有 carrier 时**零调度**；缺席时 100→250ms 退避，上限 24 次 / 6000ms。

### 工程

- 测试增至 **41 个**（数据面 5 个决策点 + 重连退避 + adopt 调度 + blank 透传），全离线，进 CI。
- 新增 `docs/ui-parity.md`（入口 / 测量姿势 / token 与原子 / 基线 / 陷阱 / checklist / **§7 状态一致性硬约束** / §8 基线不变量）、`docs/regression.md`（26 条回归项 + 工具状态）、`docs/crash-triage.md`（崩溃取证 playbook）、`docs/compatibility.md`。
- 新增工具：`scripts/parity-snapshot.mjs`（一条命令输出全部对齐指标，冷启动可用、0 null）、`scripts/lab-block.sh`、`scripts/debug-launch.sh`（带 `ELECTRON_ENABLE_LOGGING` 启动以捕获 fatal 文本）。
- 依赖范围收紧：`cordis` 由 `*` 改为 `^0.2.2-rc.3`。
