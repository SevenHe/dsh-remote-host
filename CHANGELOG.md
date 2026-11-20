# Changelog

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
