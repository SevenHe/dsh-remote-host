# Changelog

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
