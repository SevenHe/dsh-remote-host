# 已验收行为的回归清单（regression）

> 这些行为是用户**已逐条验收**的。任何改动（尤其 `src/client/block/block.css`、`lib/client.js` 的 DOM 结构、
> 任何"顺手重构成 React"的尝试）都必须过一遍本表。规范见 [`ui-parity.md`](./ui-parity.md)。

## 0. 三种验证等级

| 等级 | 手段 | 适用 |
|---|---|---|
| **A 自动** | `node scripts/parity-snapshot.mjs --port <lab> --cdp <cdp>` 输出 JSON，与 `ui-parity.md` §4 表 diff | 尺寸/字体/颜色/位置 |
| **B 半自动** | CDP 片段（下文 `[B-n]` 可直接粘到 Console 或 `Runtime.evaluate`） | 结构/数量/状态类 |
| **C 人工** | 严格步骤，一次 30 秒 | 闪烁、切换、往返这类时序行为 |

启动环境：

```sh
./scripts/lab-block.sh                                  # 打印 "dsh web: http://127.0.0.1:19949/?token=…"
"/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" --remote-debugging-port=9222 &
node scripts/parity-snapshot.mjs --port 19949 --cdp 9222 --out /tmp/parity.json
```

> 前置：页面必须是 **darwin**（`document.documentElement.dataset.platform = 'darwin'`）且**鼠标是真实移动**（`Input.dispatchMouseEvent`）。
> 用 `dispatchEvent` 测出的结果不算数（`ui-parity.md` §2.3）。

## 1. 清单

| # | 已验收行为 | 期望 | 一键验证 |
|---|---|---|---|
| 1 | 表头 3 个控件 | 3 个 28×28 图标：`search-outline-regular` / `sliders-two-outline-regular` / `project-add-outline-regular` | **A**：`header.controls.length===3`，每项 `28`；图标 id 见 `header.controls[].icon` |
| 2 | 目录行静止=文件夹，hover=实心三角 | 静止 `.drh-folder` 可见、`.drh-chevron` 隐藏；hover 反过来 | **B**：`[B-2]` |
| 3 | 目录行 hover 出两按钮 | ellipsis（`…`）/ new-chat，24×24，x=212/241 | **A**：`projectRow.actions[]`；**B**：`[B-3]` |
| 4 | 会话行 hover 出三按钮 | ellipsis / archive / pin，24×24，x=183/212/241，svg 16/14/14 | **A**：`sessionRow.actions[]`；**B**：`[B-4]` |
| 5 | 行菜单 | 6 项、宽 144、item 高 34、pad 6px 8px | **A**：`rowMenu`（`box/items`）|
| 6 | 视图菜单 | 8 项、分三段、宽 200、dense 行高 30、尾 check 14×14 | **A**：`viewMenu`（`items/label/separator/check`）|
| 7 | 悬停卡 | 宽 244、`rgb(44,44,46)`、r16、pad 12/16、标题 14/20；位置=区块右边界+16；约 800ms 出现 | **A**：`hoverCard.*`（含 `anchor`、`delayMs`）；**B**：`[B-7]` |
| 8 | 菜单**右对齐**触发控件 | 菜单右边缘 = 触发控件右边缘（不是左对齐） | **A**：`menu.alignment`（`end`）；**B**：`[B-8]` |
| 9 | 菜单圆角 + 磨砂 | 卡片 r16；material `rgba(48,49,54,0.64)` + `blur(40px) saturate(1.5)`；darwin backing `z=-2`、`border-radius`=16、`display:block` | **A**：`menuMaterial.*` / `menuBacking.*` |
| 10 | 点远端会话能切换 | 点一行 → 主区切到该远端会话（不是本地会话） | **C**：`[C-10]` |
| 11 | add-panel 不清空 | 展开"新建工作区"面板后，已有列表**仍在**（不被清空） | **C**：`[C-11]` |
| 12 | 不闪烁 | 列表刷新/切换分组时不出现整块白闪或重建 | **C**：`[C-12]` |
| 13 | 远端会话不出现在原生"未分组" | 原生列表的未分组桶里**没有** `drh:` 前缀的会话 | **B**：`[B-13]` |
| 14 | 置顶/归档往返 | 置顶 → 出现置顶区；取消 → 回原位；归档 → 进归档；取消归档 → 回列表 | **C**：`[C-14]` |
| 15 | 目录菜单 3 项 | 重命名 / 在 Finder 中显示 / 删除，宽 144、高 117 | **A**：`groupMenu`（`box/count`）；**B**：`[B-15]` |

## 2. B 级片段（粘到 CDP `Runtime.evaluate`，或 DevTools Console）

> 前提：鼠标已用 `Input.dispatchMouseEvent` 悬停在目标行上，且 `dataset.platform='darwin'`。

```js
// [B-2] 目录行 hover 换槽
(() => {
  const row = document.querySelector('#drh-remote-block [data-drh-group]')
  const folder = row.querySelector('.drh-folder')
  const chevron = row.querySelector('.drh-chevron')
  return { folder: getComputedStyle(folder).display, chevron: getComputedStyle(chevron).display }
})()   // 期望：hover 时 folder=none, chevron=inline-flex

// [B-3] / [B-4] 行内按钮：数量 + 盒子 + 相对 x
(() => {
  const sel = '#drh-remote-block [data-drh-row]'      // 或 [data-drh-session]
  const row = document.querySelector(sel)
  const base = row.getBoundingClientRect().left
  return [...row.querySelectorAll('[data-drh-rowmenu],[data-drh-rowarchive],[data-drh-rowpin]')].map((el) => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left - base), w: Math.round(r.width), h: Math.round(r.height) }
  })
})()   // 会话行期望 x=183/212/241，w=h=24；目录行 x=212/241

// [B-7] 悬停卡：尺寸 / 位置 / 字体 / 出现延迟
(() => {
  const card = document.querySelector('.drh-hoverCard')
  if (card === null) return { missing: true, hint: '真实鼠标悬停后约 800ms 再读' }
  const r = card.getBoundingClientRect()
  const root = document.getElementById('drh-remote-block').getBoundingClientRect()
  const title = card.querySelector('.drh-hoverTitle')
  const cs = title === null ? null : getComputedStyle(title)
  return {
    w: Math.round(r.width), bg: getComputedStyle(card).backgroundColor,
    radius: getComputedStyle(card).borderTopLeftRadius,
    anchorGap: Math.round(r.left - root.right),
    titleFont: cs === null ? null : cs.fontSize + '/' + cs.lineHeight,
  }
})()   // 期望 w=244, anchorGap=16, titleFont=14px/20px

// [B-8] 菜单右对齐：菜单右边缘 == 触发控件右边缘（±1px）
(() => {
  const menu = document.querySelector('.drh-menuSurface')
  const trigger = document.querySelector('#drh-remote-block [data-drh-groupmenu]')  // 或视图菜单触发控件
  if (menu === null || trigger === null) return { missing: true }
  return { diff: Math.round(menu.getBoundingClientRect().right - trigger.getBoundingClientRect().right) }
})()   // 期望 |diff| <= 1

// [B-15] 目录菜单项数与文案
(() => {
  const menu = document.querySelector('.drh-menuSurface')
  return [...menu.querySelectorAll('.drh-menuItem')].map((el) => el.textContent.trim())
})()   // 期望 3 项：重命名工作区 / 在 Finder 中显示 / 删除

// [B-13] 原生"未分组"里不能出现远端会话
(() => {
  const remote = globalThis.__DSH_REMOTE_HOST_STATE__
  const ids = new Set(remote !== undefined && Array.isArray(remote.ids) ? remote.ids : [])
  const leaked = [...document.querySelectorAll('[data-drh-session]')]
    .filter((el) => ids.has(el.getAttribute('data-drh-session')) === false)
  return { remoteIds: ids.size, blockRows: document.querySelectorAll('[data-drh-session]').length }
})()
```

## 3. C 级步骤（人工，按顺序做）

**[C-10] 点远端会话能切换**
1. 真实鼠标点击一个远端会话行（`[data-drh-session]`）。
2. 主区标题/内容变成该会话；**不能**跳回本地会话，也不能空白。
3. 再点第二个远端会话 → 能再次切换（连续切换 2 次，证明不是首次初始化碰巧成功）。

**[C-11] add-panel 不清空**
1. 点表头的 `project-add-outline-regular`（新建工作区）。
2. 面板打开时，下面的工作区/会话列表**仍然在**。
3. 关掉面板 → 列表未重排、未丢失滚动位置。

**[C-12] 不闪烁**
1. 开 Performance 面板录制，重复"hover 行 → 移开"10 次。
2. 期望：没有整块白闪；`#drh-remote-block` 节点**不重建**（`data-drh-inst` 不变）。
3. 若 `data-drh-inst` 变化 → 说明走了"整块重建"路径（见 `ui-parity.md` §5 第 7 条）。

**[C-14] 置顶/归档往返**
1. 会话行 hover → pin → 该行出现在置顶区；unpin → 回到原分组原位置。
2. archive → 从列表消失、进入归档；unarchive → 回到列表。
3. 往返 2 次，状态不能"粘住"，也不能产生重复行。

## 4. 回归失败怎么定位

| 现象 | 先查 |
|---|---|
| 尺寸/位置整体偏移 | `ui-parity.md` §3.3 原子（24 盒 / −4 margin / gap 13） |
| 只有 darwin 下不对 | 忘了 `dataset.platform='darwin'`（§2.4） |
| hover 类行为"测不出来" | 用了 `dispatchEvent` 而不是 `Input.dispatchMouseEvent`（§2.3） |
| 磨砂消失 / 变实心 | material 与 backing 的 z-index 关系（§3.2、§5 第 3 条） |
| 白窗 | 背景 token 带了白色兜底（§3.1） |
| 菜单飘到另一侧 | `align` 传成了 `start`（§4.5、§2 的 `showMenu`） |


## 5. 2026-11 新增回归项（每一轮都真的踩过）

| # | 行为 | 怎么验（一条命令/动作） | 失败长什么样 |
|---|---|---|---|
| B-16 | 打开远端会话后，再点**本地**会话，远端那行的选中高亮必须消失 | 点远端行 → 点本地行 → 读 `.drh-sessionRow.selected` 数量，应为 0 | 两行同时发灰（`blockState.current` 从未清除） |
| B-17 | 本地工作区只有**一行**「展开其余 N 个会话」 | 展开本地工作区，读所有含「展开其余」的叶子节点，**可见**的必须只有 1 个 | claim 桶的溢出行漏出来（key 以 `overflow:drh:` 开头） |
| B-18 | **新出现**（刚在远端创建）的会话也能打开，不只是老会话 | 让远端产生一条新会话 → 点它 → 主区域标题切过去、无 toast | `sessions.retain: unknown session <id>`（catalog 里没有它） |
| B-19 | 空闲时不应有「每次事件全量重建」 | 跑 60s 心跳，`renders` 增量应很小（个位数）；`nodes` 不应随渲染线性增长 | 每秒 1 次重建、nodes 随渲染 +4~5 增长 |
| B-20 | 隐藏原生行时，被隐藏行不能仍被计数 | 见 B-17；另外确认 claim 行 `display:none` 且高度 0、不可 focus | 桶内「展开其余 N」把隐藏行算进 N |
| B-21 | 新建工作区是**居中模态**（遮罩 + 380 宽 + 圆角 28） | 点远端表头 `+`，读面板 rect 与 backdrop/radius | 贴在按钮旁的小浮层 |
| B-22 | ~~运行中的远端会话行在静止态就能看出来，空闲时不可见~~ **已被 B-24 取代**（空闲改为常显灰点） | 见 B-24 | 见 B-24 |
| B-23 | 默认排序与本地一致：**刚更新的远端会话在其组内第一行**，且**它的工作区组排到区块最上**（默认 orderBy=updated） | 取 `__DSH_REMOTE_HOST_SESSIONS__` 里 `updatedAt` 最大的会话，在区块里读：①该组内前 3 行的会话 id（它应为第 1 行）；②区块前 2 个组的标题（含它的组应为第 1 个）。再切「手动排序」读一次组顺序，应回到保存的手动顺序 | 新会话被追加到组末尾；或它的工作区组沉在区块最底；或切手动后组顺序仍被活跃度改写 |
| B-24 | 状态指示与本地一致：**仅在 running 时**、在标题**左侧**显示 6px 绿点 `#2ea043`；空闲行**没有任何点** | 取一条 `running:true` 与一条 `running:false` 的远端会话行：前者的首个子元素是 `.drh-runDot`（computed `background` = `rgb(46, 160, 67)`、6×6）；后者行内**查不到** `.drh-runDot`；时间仍只在右侧 resting 槽 | 空闲行仍有点（黑点/灰点）；点夹在标题与时间之间；running 行没有点 |
| B-25 | 远端运行中会话行的状态呈现与本地**完全一致**（同一 leading 槽、同一 sprite/组件、同一动画）；空闲行无任何前导状态 | 找一条本地 running 会话与一条远端 running 会话，比对 leading 槽的 `data-icon` 与尺寸，要求相等 | 远端自绘圆点/灰点/位置不同/空闲也显示 |
| B-32 | 连接状态抖动**只补丁圆点**，不重建区块：表头、标题文字、圆点三个节点身份保持不变 | `node scripts/patch-probe.mjs --cdp <cdp>` 的 `flap -> dot patched, header and label kept` / `recovery -> …` 两例；或手动翻转 `__DSH_REMOTE_HOST_STATUS__.remote` 后 dispatch `drh:state`，读 `#drh-remote-block` 的容器级 childList 变更数应为 0 | 每次状态变化整块重绘：标题文字和 3 个图标一起闪，`data-drh-inst` 不变但节点全换（腿每次重连都发 `connecting` → `open`，所以看起来是「一直闪」） |

**通用教训**：验证一个「隐藏/抵消」类修复时，不能只验「可见行数没变」，还要验**文案/计数行**（`展开其余 N`）、`aria`/可 focus 性、以及**操作一次之后**的状态（重挂载会冲掉内联样式）。

## 6. 工具状态（诚实标注）

- `scripts/parity-snapshot.mjs`：**可用**（2026-11-20 在 lab 19972 + headless Chrome 157 上实测：输出所有字段非 null，`meta.notes` 为空）。此前"全 null"有两个真因，均已在脚本内修掉：

  1. **页面停在哪一屏**：默认 headless 视口约 800×600，远端块顶边在 y≈614，整块落在折叠线以下，所有指针探测都落空；且新建 profile 可能停首次引导屏。脚本现在会「固定视口 1440×900 → 循环点掉引导（继续/Continue/…）→ 等 `[data-slot="sidebar.workspaces"]` → 必要时点 `打开侧边栏`」，并在失败时把 `location.href / body.innerText 前 200 字 / [data-slot] 列表 / 是否有继续按钮` 打进 `meta.notes`（不再只报一句 no #drh-remote-block）。
  2. **没有会话行**：块只在分组展开时渲染会话行，此前脚本从不展开分组，于是 `sessionRow / hoverCard / rowMenu` 恒为 null。脚本现在会展开第一个工作区分组，并在每次指针探测前 `scrollIntoView` 后重新读取坐标（此前用的是几步之前的旧坐标，分组菜单因此点不到）。

  实测输出（lab 19972，viewport 1440×900，darwin）：

  | 字段 | 实测值 | 与基线 |
  |---|---|---|
  | `header.controls` | 3 个控件，均 28×28 | 一致 |
  | `sessionRow.rowHeight` | 32 | 一致 |
  | `sessionRow.actions` | 3 个按钮 24×24，行内相对 x=175/204/233 | 步进 29px、盒 24px 一致；绝对位置差 8px（见下） |
  | `sessionRow.rowWidth / actionsRightInset` | 264 / 7 | 基线隐含 272 / 7 |
  | `projectRow` | 32 高，1 个按钮 24×24 | 一致 |
  | `viewMenu.box` | 200×324，8 项，三段 | 一致 |
  | `rowMenu.box` | 144×225，6 项 | 一致 |
  | `groupMenu.box` | 144×117，3 项 | 新增基线 |
  | `hoverCard` | w=244，bg=rgb(44,44,46)，anchorGap=16，title 14px/20px | 一致 |
  | `swap`（悬停换槽） | folder=none，chevron=flex | 一致 |

  **已知偏差（不是回归）**：`sessionRow.actions[].x` 实测 175/204/233，文档基线 183/212/241，差 8px。原因是行宽 264（基线隐含 272）：分组多到溢出时经典滚动条占去 8px，而按钮是右对齐的。判定请用三个不变量：**步进 29px、盒 24px、rightInset 7px**；`rowWidth` 也在快照里，可直接解释这一平移。

  **适用条件**：需要能连到该 lab 的 CDP 页面（`--port <lab> --cdp <cdp>`），需要 profile 上 `remoteBlock: true`，且 lab 已挂载远端（启动日志有 `mounted ... at /devbox`）。菜单/悬停类字段需要真实鼠标事件，headless 下同样成立。
- `scripts/lab-block.sh`：可用；但它只起 `dsh web` 服务 + 复制 profile，浏览器侧要自己起（见脚本注释）。

| B-26 | 会话行动作按钮用**不变量**判定：步进 29px、盒 24×24、最右按钮距行右边缘 7px（绝对 x 会随滚动条平移） | 读 parity-snapshot 的 sessionRow.actions + actionsRightInset | 按绝对 x 判定导致的假阳性/假阴性 |
| B-26 | 远端会话状态**自动刷新**（不点击），≤5 秒 | 让一条远端会话 running false→true 且不做任何点击：8 秒内该行应出现 `.drh-stateDot`；true→false 应消失；改 `updatedAt` 后行尾时间文本应变化 | 必须点一下才更新；状态一直不变 |
| B-27 | 页面 hidden 时**不轮询** | CDP `Page.setWebLifecycleState` 置 frozen 后统计 Network 中 `devbox/api/session/list` 请求数不再增长，恢复后恢复增长 | hidden 期间仍每 4 秒发请求 |
| B-28 | 数据持续变化时**不抖动** | 每 5 秒改一次某会话 running/updatedAt，采 60 秒：announce 随变化增长，但 DOM 节点数与 heap 平稳 | 每次 tick 整块重绘，节点数/内存持续上涨 |
| B-29 | 手动排序**不被周期刷新改写** | 切「手动排序」并拖拽（或写 `localStorage["drh:order"]`），让轮询跑 60 秒，前后组顺序数组应完全相同 | 刷新后组顺序被活跃度重排 |
| B-30 | **状态变化只补丁、不重建**（行节点身份不变） | 给某行节点打 expando，只改它的 running（不要改 updatedAt，否则会重排）：断言该节点仍是同一对象、行内 `.drh-stateDot` 被就地增删、且容器的**直接子节点** childList 变更数为 **0**（用 MutationObserver，把 target===container 与嵌套变更分开计数） | 行被销毁重建；容器直接子节点被替换；hover/menu 状态在刷新时丢失 |
| B-31 | **排序变化才重建** | 把某行 updatedAt 改大到会改变其位置：断言发生一次结构重建且行顺序正确（原路径） | 顺序变了却仍走补丁路径（行序错乱）；或顺序没变也重建 |

### B-26..B-29 实测基线（2026-11-20，lab 19980，headless Chrome 157，viewport 1440×900）

远端 Host 为 devbox.example.com:3080（108 条会话）。注入方式：在页面内包装 `fetch`，只改写挂载侧 `devbox/api/session/list` 的应答；digest → publish → `drh:sessions` → 重绘 的生产链路完全不变。

**B-26（自动刷新 ≤5s，全程无点击）**：

| 事件 | t (ms, performance.now) | 差值 |
|---|---|---|
| 翻转 false→true | t0 = 24226 | — |
| `.drh-stateDot` 出现 | t1 = 28205.5 | **rise 3980 ms** |
| 翻转 true→false | t2 = 28205.5 | — |
| `.drh-stateDot` 消失 | t3 = 32269.7 | **fall 4064 ms** |

触发重绘的 announce：t=28196（DOM 前 9.6 ms）、t=32265。上游轮询周期 `POLL_INTERVAL_MS = 4000`，所以延迟上界就是 4s + 渲染。**结论：≤5s 成立。**

**B-27（hidden 不轮询）**：用「激活另一个标签页」把页面真正置为 hidden（`Page.setWebLifecycleState` 只接受 frozen/active，不接受 hidden）。

| 阶段 | 时间窗 | `devbox/api/session/list` 请求数 |
|---|---|---|
| A 可见基线 | 12000 ms | **2** |
| B hidden（`document.visibilityState === "hidden"`） | 20000 ms | **0** |
| C 恢复可见 | 12000 ms | **3** |

请求相对 A 起点的偏移（ms）：`5022, 9023, [28s 空窗], 37024, 41024, 45024`。空窗正好覆盖 hidden 段。**结论：hidden 期间 0 请求，恢复后立即恢复 4s 节奏。**

**B-28（持续变化不抖动，60s，每 5s 改一条会话的 running/updatedAt）**：

| 指标 | 空转 60s | 持续变化 60s |
|---|---|---|
| announce 次数 | 0（起点重置后）；文档旧基线为 1 | **12**（= 12 次变化） |
| DOM 节点 `querySelectorAll("*")` | 2584 → 2584（Δ0） | 2584 → 2584（Δ**0**） |
| Performance `Nodes` | 4379 → 4379（Δ0，20s 后稳定） | 4379 → 4379（Δ**0**） |
| JSHeapUsedSize | ~28150 KB 平稳（首样本 58216 → 28151 是启动垃圾被回收） | 28287 → 28867 KB（Δ**+580**，锯齿：28312/28837/28327/28342/28342/28866） |

**结论：announce 随变化线性增长（12 次变化 → 12 次 announce），但节点数完全不动、heap 只是 GC 锯齿（无单调上涨）。**

**B-29（手动排序不被改写）**：写入 `localStorage["drh:order"]` = 前 5 组的逆序，切「手动排序」后跑 60s。

- dragOrder = `[w:23a53601…, w:e6e6c101…, w:2f27655b…, w:42572e0a…, w:71ee0e97…]`
- 切换后 orderBy = `manual`；before = `[w:23a53601…, w:e6e6c101…, w:2f27655b…, w:42572e0a…, w:71ee0e97…, w:70aa236c…]`
- 60s 后 after = 与 before **逐项相同**（`JSON.stringify` 相等，69 组全量比较）
- 与活跃度顺序不同（activeOrder 前 5 为 `w:71ee0e97…, w:42572e0a…, …`）；窗口内 announce 仅 1 次

**结论：手动排序在 60s 轮询后不被活跃度改写。**

**#5 shipped spinner 实测（关键差异，未改代码）**：用一次**真实本地 turn**（`session/create` + `session/prompt`，同一 lab）让 shipped 运行态出现，再量其 DOM：

| 项 | shipped（本地 running 行，实测） | 我们远端行（实测） | 文档旧记录 |
|---|---|---|---|
| svg viewBox | `0 0 24 24` | `0 0 24 24` | `0 0 24 24` ✅ |
| svg 属性 / 渲染尺寸 | 14 / 14×14 | 14 / 14×14 | 14 ✅ |
| **circle r** | **9.5** | **9** | 9 ❌ |
| circle cx/cy | 12 / 12 | 12 / 12 | ✅ |
| **槽位 rect** | **16×20**（`.JoiKIa_slot`） | **14×14**（`.drh-stateDot`） | 14×14 ❌ |
| stroke | rgb(129,133,140)，2px | 同 | ✅ |
| arc dasharray | 动画采样值 `14.5328px, 150px`（随动画变化，非声明值） | `12, 150` | `12,150` ⚠️ |

**两处真实差异：circle r 9.5（非 9）、槽位 16×20（非 14×14）。** dasharray 是动画中途采样，不能当声明值用。按任务要求只报数值、未改代码。

**#6 左右并排截图：未交付（卡点）。** 两次尝试都拿到右侧（远端）与左侧（本地）的 clip，但在页面内用 `<img>` 合成后整幅截图是空白（疑与 `Emulation.setDeviceMetricsOverride` 和 `Page.captureScreenshot` 的 clip+scale 叠加有关）；第三次尝试单次 clip 同时覆盖两行时 CDP 报错退出。`/tmp/spinner-side-by-side.png` 存在但内容无效（1740×260 几乎全白），**不要当成证据使用**。下一步建议：分别用 `Page.captureScreenshot` 取两张 clip 后，用外部工具（如 `sips`/ImageMagick）离线拼接，避免页内合成。

## 远端会话「只能看、不能继续聊天」的根因与实测（2026-11-23）

**现象**：点开「远端工作区」里的远端会话，主区域能渲染完整内容，但 composer 变成不可用态（本机 build 显示「会话不可用」/`contenteditable=false`，另一处文案为「选择一个工作区开始」），无法发送、无法继续对话。

**根因**：`lib/client.js` 的 `openRemoteSession()` 为了让 `sessions.retain` 接受一个客户端目录里还没有的远端会话，会先用 `manager.handleSessionAdded(row)` 注入一行，`openSession` 之后再在 `.then`/同步路径里调用 `drop()` → `manager.handleSessionRemoved(sessionId)`，把这一行删掉。composer 是否可用取决于该会话是否仍在客户端 catalog 里，删掉后 composer 立刻退化为不可用态——**transcript 能看，是因为渲染走的是已打开的主视图；不能发，是因为 catalog 里已经没有这条会话**。

**修法**：新增 `settle()`，打开成功后**保留** catalog 行（仅当 shim 已把该 id 归为远端——`remoteState().ids` 命中）；否则仍按旧行为删除。保留不会让远端行泄漏进原生列表，因为 `group: none` 下 shim 发布的隐藏 claim Workspace（`workspace:drh:claim`）已经认领了所有已发布的远端 id，其行被 block 样式表隐藏。

**实测（lab 19963 插件指向本分支，upstream 为私有 19965 实例，headless Chrome + CDP，真实远端会话）**：

| 项目 | 修前 | 修后 |
|---|---|---|
| 打开远端会话后 composer 文本 | `会话不可用` | `发消息或创建任务, / 调用指令, @ 文件或对话` |
| `contenteditable` | `false` | **`true`** |
| 页面出现「会话不可用」 | `true` | **`false`** |

**发送链路实测**（修后在 composer 输入 `probe ping from drh-chat` 并点「发送消息」），Network 抓到的请求：

```text
/devbox/api/session/prompt    method: "session/prompt"    mounted: true
/devbox/api/session/attachment method: "session/attachment" mounted: true
```

即 prompt 被 shim 路由到了 mount（`mounted: true`），不是发到本地 host。

**不回归实测**：

- 远端行不泄漏到原生列表：shipped 树里 remote id 的 2 行 `getBoundingClientRect()` 宽高为 0 且 `offsetParent === null`（不可见），可见泄漏计数 `visibleRemoteLeaks = 0`；隐藏 claim 行 `display: none` 符合设计。
- 切回本地会话高亮清除：点可见的本地区会话行后，块内 `selected` 行数 `1 → 0`，composer 保持可用（`contenteditable=true`，无「会话不可用」）。

**注意（lab 配方坑）**：profile 的 `node_modules` 若整体软链到 `~/.dsh/profiles/desktop/node_modules`，其中 `dsh-remote-host` 指向主 checkout，改 profile `package.json` 的 `link:` 依赖不生效。必须逐项软链后单独把 `dsh-remote-host` 指向 worktree，并用 `readlink -f <profile>/node_modules/dsh-remote-host/lib/client.js` 确认，否则测的是旧代码。

<a id="patch-probe"></a>

## B-30 / B-31 怎么跑：行级补丁探针 `scripts/patch-probe.mjs`

B-30（状态变化只补丁、不重建）、B-31（排序变化才重建）与 B-32（连接状态抖动只补丁圆点）由 `scripts/patch-probe.mjs` 自动判定，无需真远端：探针锁定 `__DSH_REMOTE_HOST_STATE__` / `__DSH_REMOTE_HOST_SESSIONS__` / `__DSH_REMOTE_HOST_MARKS__` / `__DSH_REMOTE_HOST_STATUS__` 四个全局，再 dispatch `drh:state`/`drh:sessions`/`drh:marks`，走的仍是生产链路（globals → 事件 → 重绘）。

```bash
# 1) lab：profile 的 node_modules 必须是**实体副本**，再单独把插件软链到被测分支
ln -sfn /path/to/dsh-remote-host-branch <profile>/node_modules/dsh-remote-host
readlink -f <profile>/node_modules/dsh-remote-host/lib/client.js   # 必须指向被测分支
# 2) 渲染器：任意带 CDP 的 Chromium（headless Chrome 亦可），加载 lab 页面
# 3) 跑探针（--url 用于在多标签里挑对页面）
node scripts/patch-probe.mjs --cdp 9223 --url 19961
```

探针开头会 `Page.reload`：展开态与排序偏好会跨运行残留，不重载会读到上一轮的状态。

两条证据通道：**节点身份**（改动前给行打的 expando 能否复用）与**按层级拆分的 childList 变更**（`direct` = `target === container`，即整段重写；`nested` = 就地补丁）。

### 实测（2026-11-23，lab 19961，headless Chrome 157，`lib/client.js` 指向被测分支）

8 条断言全部通过，`PATCH-PROBE RESULT {"total":10,"passed":10,"failed":[]}`：

```
ok baseline: three rows after expanding the group  {"order":["p-a","p-b","p-c"]}
ok hover reveals the 3 row actions  {"before":{"display":"none","opacity":"1","width":0},"after":{"display":"flex","opacity":"1","width":74},"actionCount":3}
ok running -> spinner added in place  {"same":true,"hasDot":true,"dotR":"9.5","written":true,"mutations":0,"nested":1}
ok idle -> spinner removed in place  {"same":true,"hasDot":false,"written":false,"mutations":0}
ok title text patched in place  {"same":true,"title":"Bravo renamed","written":true,"mutations":0}
ok row menu opens and closes in place  {"open":true,"closed":false,"same":true,"anchor":{"surfaceRight":207,"triggerRight":207},"openDirect":0,"closeDirect":0}
ok group menu open class patched in place  {"open":true,"closed":false,"openDirect":0,"closeDirect":0}
ok pin glyph patched in place  {"same":true,"pinLabel":"取消置顶","pinHref":"#dsw-icon-pin-fill-regular","written":true,"mutations":0,"order":["p-a","p-b","p-c"]}
ok manual order: time text patched in place  {"before":["p-a","p-b","p-c"],"after":["p-a","p-b","p-c"],"same":true,"time":"2分钟","written":true,"mutations":0}
ok order change rebuilds the list  {"order":["p-c","p-a","p-b"],"same":false,"written":true,"mutations":2}
```

读法：`same` 是行节点是否被复用；`mutations` 是容器级 childList 变更数（`0` = 没有重建、只补丁）；`nested` 是行内就地变更。B-30 要求 `same:true` 且 `mutations:0`；B-31 要求 `same:false` 且 `mutations>0`。

> **B-32 是后加的用例。** 上面那份 2026-11-23 的 10 条断言记录早于它，所以 total 不含这 2 条；现在跑同一脚本会多出 `flap -> dot patched, header and label kept` 与 `recovery -> dot patched back, header and label kept`。它锁的是「连接状态不进结构签名」：状态翻转期间容器级 childList 必须是 0，表头/标题/圆点三个节点身份不变，只有 `data-state` 与 `title` 变。

> **`written` 不是「容器被重写」的信号。** `lib/client.js:1297` 把它算成「重新生成的 html 串与已存串不同」，而已存串只在重建分支里更新，所以补丁路径下它会一直是 `true`（甚至出现「先 true 后 false」的陈旧基线）。判断是否重建只看 `mutations` 与 `same`；探针因此不再断言 `written`，只把它留在 JSON 里供参考。若希望 `written` 能当重建指标，需要产品侧在重建分支里单独置位——那是 `lib/client.js` 的改动，不在探针范围内。

### 探针曾经的两个坑（已修）

- **分组行点不开**：按行中心点击会落在尾部动作按钮的 SVG 上（`elementFromPoint` 可证），行的点击处理器不执行。改为点标题区域（`.drh-title`），并把命中的元素打进日志——布局再变时会显示「点到了哪个元素」，而不是干等超时。
- **B-31 用例被前置状态污染**：B-31 前面刚把排序切成「手动排序」，此时 `updatedAt` 不会移动任何行，于是「不重建」是正确的；但那样就测不到 B-31。现在先切回「最近更新」再改时间。

## boot 期 workspace/not-found（drh:claim）的根因与实测（2026-11-23）

**现象**：页面刚加载、每次启动，控制台出现：

```text
initial Session restoration failed: SessionCreateError: session create failed:
workspace/not-found: workspace "drh:claim" not found
```

**根因**：`src/shim/10-state.js` 的 `refersRemote()` 把整个 payload 转成 JSON 字符串后**搜任何已知远端 id** 来决定路由。启动时「恢复上次会话」会发 `session/create`，payload 里带着要恢复的**远端 sessionId**（当记住的工作区是合成 claim 时还带 `workspaceId: drh:claim`），于是命中 → create 被转发到 mount；而 mount 的 Host 并不拥有该 workspace，于是回 `workspace/not-found`。修前抓到的真实请求：

```text
POST /devbox/api/session/create
{"request":{"workspaceId":"82a961b4-…<本地工作区>","sessionId":"session-bc72f3ac-…"}}
```

即一个**本地工作区**的 create，被按 payload 里的远端 sessionId 误路由到了 mount。

**修法**（`src/shim/10-state.js` + `src/shim/20-transport.js`）：

1. `createTarget()`：create 是**工作区作用域**操作，只按 `workspaceId` 判定——仅当它是远端 Host 真正拥有的工作区（`drh:<raw>` 且 `raw` 属于 `remoteWorkspaceIds`）才去 mount，其余一律本地。
2. `isClaimCreate()` + `dropWorkspaceId()`：合成 claim 工作区只存在于合并后的客户端视图，**任何 Host 都无法解析** `drh:claim`；因此对这一个 id 去掉 `workspaceId` 后交给本地 Host，恢复链正常完成。
3. `wouldRoute()` 把 claim 也算作「需要处理」，否则会直通 `localFetch` 而跳过上面的改写。

**实测 before / after（同一组断言）**：

| 断言 | 修前 shim (5268140) | 修后 shim |
|---|---|---|
| 本地工作区 + 远端 sessionId 的 create 不得到达 mount | **FAIL**（must not reach the mount: it does not own local-ws） | **PASS** |
| drh:claim 的 create 本地化并去掉 workspaceId | **FAIL**（workspaceId 仍在） | **PASS** |

命令：`DRH_SHIM=/tmp/old-shim.js node --test test/create-routing.test.mjs`（旧 shim → 2 fail）对比 `node --test test/create-routing.test.mjs`（2 pass）。

**lab 实测**（19967，插件指向本分支；upstream 为本机私有 DSH 实例，真实远端会话 9 条）：把 `localStorage[dsh.sessions.current]` 指向一条**远端** sessionId 后重载，Network 抓到的 `session/create`：**mount 0 / local 0**；`workspace/not-found` 类日志 **0 条**；composer `contenteditable=true`、无「会话不可用」。

**不回归**：claim 行仍 `display: none`（远端行不可见、不泄漏进原生列表）；composer 可用；`npm run check` 49/49。

### 补充：rpc 载体同修 + 路由判据审计（2026-11-23）

**为什么必须补**：桌面壳发布 `__DSH_TRANSPORT__` 且可能带 `rpc`；shim 在 `diag.hasRpc === true && typeof base.rpc.call === 'function'` 时用 rpc 覆盖 fetch 包装（`src/shim/80-install.js` 的 rpc 分支）。只修 fetch 分支的话，**在最关键的那个部署上等于没修**。

**改动**：`80-install.js` 的 rpc 分支（原第 149 行）对 `session/create` 也走 `createTarget()`；claim 用新helper `withoutWorkspaceId()`（`10-state.js`）改写——rpc 载体拿到的是 payload **对象**而非 JSON body，所以需要对象级重写（`dropWorkspaceId` 仍是 fetch 的 body 字符串变体），且不修改调用方的 payload。

**rpc 用例 before / after**（同一组断言）：

| 断言 | 修前 shim (5268140) | 修后 shim |
|---|---|---|
| rpc carrier：本地工作区的 create 不得到达 mount | **FAIL**（the mount must not receive a create for a local workspace） | **PASS** |
| rpc carrier：claim 的 create 到达本地载体且无 workspaceId | **FAIL**（the claim workspaceId is dropped before the local carrier sees it） | **PASS** |

命令：`DRH_SHIM=/tmp/old-shim.js node --test test/create-routing.test.mjs` → 4 fail；`node --test test/create-routing.test.mjs` → 4 pass。测试助手 `test/helpers/page.mjs` 新增 `options.rpc` 可种一个解码后的 rpc 载体并记录调用（`rpcCalls` / `rpcCallsFor`）。

**路由判据审计**（登记在 `src/shim/20-transport.js` 决策点注释里，本次只改 session/create）：

| 类别 | 端点 | 判定 |
|---|---|---|
| 工作区作用域 | `session/create` | **已修**：按 `workspaceId` 判定 |
| 工作区作用域（待收） | `workspace/{rename,delete,insertBefore,insertSessionBefore}` | 仍是子串命中。今天成立只因远端工作区发布为 `drh:<raw>` 且 `<raw> ∈ remoteWorkspaceIds`，文本里天然含 raw id；本地工作区 id 不可能包含它。与 create 同型脆弱，下一版按 `workspaceId` 收 |
| 路径作用域 | `directoryPicker/*` | payload 无 id，不会被路由，安全 |
| 会话作用域 | `session/{follow,events,state,page,projections,prompt,cancel,rename,fork,updateQueue,wait,attachment,selectModel}` | 子串判定**正确**：被点名的 id 就是主体（含 `address.sessionId` 形式） |
| 特例 | `session/list`、`$events`、`$events/result` | 走合并 / 事件结果改写，不走该判据 |
| 宿主全局（风险） | `settings/*`、`pluginManager/*`、`pluginInventory/*`、`agentPresets/list`、`permissionPresets/catalog`、`skills/list`、`schedule/*`、`speech/*`、`messageFeedback/*`、`workspaceFiles/*` | 无会话/工作区主体，只有「路径或标题里恰好出现某个 id」才会误路由；保持现状，`workspaceFiles` 的路径含 id 是最现实的一条 |

`npm run check`：58/58（2026-11-23 复核，见 `docs/verification-1.14.7.md`）。

## 远端会话模型位显示「请选择模型」的根因与实测（2026-11-23）

**现象**：打开远端会话后模型位显示「请选择模型」，会话其实有已保存的选择（`cpa/deepseek-v4.1-flash`）。

**根因（两处，都在 shim）**：

1. **选择不可见**：`publishRemoteSessions`（`src/shim/10-state.js`）构造客户端注入 catalog 用的 summary 时只保留 `id/title/updatedAt/running/cwd/blank/parentSessionId/formatStatus/asOfSeq`，把远端 `session/list` 行的 `projections` 整个丢了 → 注入行没有 `projections.values.modelSelection` → 模型位无值。
2. **目录没有归属**：客户端真正调的是 `session/modelCatalog`（无参数），而旧实现猜的是 `llm/listProviders|llm/listConfigurableProviders|llm/discoverModels`（已删）。且客户端**每次页面加载只取一次目录，并且早于会话恢复**，所以请求里没有任何 session id 可用来路由 → 目录永远来自本机，远端选择（远端独有 id）解析不到。

**修法**：

- A：entry 增加 `projections` 透传（`projectionsForPublish`，上限 **8 KiB**；超限只保留 `modelSelection/agentPreset/title`）。合并后的 `session/list` 远端行本来经 `labelRemoteItem` 保留 projections。
- B：**不做并集**（两端模型 list 允许不同，并集会让本地会话看到远端独有模型、反之亦然，选中即报错）。`session/modelCatalog` 按「当前会话所属宿主」决定来源：① 远端焦点（已有请求带远端 id）→ mount；② 冷启动用持久化线索 `localStorage["dsh.sessions.current"]`（兼容 `{sessionId}` JSON 与裸串两种形态）配合 `remoteSessions` 判定 → 远端则 mount；③ 否则本机。冷启动时目录请求早于首个远端快照，shim 会**等首个快照落定（有界）**再判定。mount 侧读取 `AbortSignal.timeout(2500)`，**拒绝或非 2xx 都降级本机**。rpc 载体同判。

### 已知限制（重要）

**同一次页面生命周期内切换宿主（本地 ↔ 远端）后，模型目录仍是上一次的，必须重载页面才会切换。** 原因是客户端「启动取一次目录并全程缓存，且早于会话恢复」，shim 无法强制它重取。验收请以「重载后正确」为准。

### 实测（lab 19987，插件指向本分支，upstream 为真实 devbox，headless Chrome + CDP）

| 断言 | 原始数据 |
|---|---|
| ① 重载后打开远端会话：占位消失、模型位可用 | `composerCard = "发消息或创建任务, / 调用指令, @ 文件或对话 完全权限 DeepSeek V4.1 Flash (CPA) Max"`，`placeholderInCard = false`；mount 目录里 cpa 组**只有** `deepseek-v4.1-flash`，故无占位即证明按远端条目解析成功 |
| ② 该次目录走 MOUNT | 冷启动 `catalogHits = ["MOUNT","MOUNT"]`（持久化当前会话为远端 worker 时） |
| ③ 本地会话行为不变 | 冷启动 `catalogHits = ["LOCAL","LOCAL"]`，目录 default `cpa/modelhub-deepseek-v4.1-flash`（5 个模型），本地会话模型位 `DeepSeek V4.1 Flash (CPA) Max` |
| ④ mount 不可达：降级 + 无风暴 + 无 unhandled rejection | 用 CDP 阻断 `*/devbox/api/session/modelCatalog*` 后重载：目录返回本机（default `modelhub-deepseek-v4.1-flash`，5 模型）；请求序列 `MOUNT,LOCAL,MOUNT,LOCAL,LOCAL`（尝试+降级），4 秒后**不再增长**；`Runtime.exceptionThrown` 与 console error 均为 **0** |

远端行透传实测：112 条远端会话中 **60 条**带 `projections.values.modelSelection`（例 `{"lastUsed":{"provider":"cpa","model":"deepseek-v4.1-flash","reasoningEffort":"max"}}`）。

## 模型补丁引发的 arity rejection（2026-11-23）

**症状**（真实 App trace，`inst=devbox#-`）：

```
{"name":"failure","detail":{"kind":"rejection","message":"client api: session/modelCatalog expected 1 argument(s), got 0"}}
```

**根因（已定位到具体代码）**：`@deepseek-ai/dsh-api-gateway` 的客户端在发请求前做严格的**位置参数个数**校验（`lib/client.node.js`，`prepareInvocation`）：

```js
const expected = descriptor.parameters.length - (projection?.parameterIndex === void 0 ? 0 : 1)
if (values.length !== expected && !hasCallerSignal) {
  throw new Error(`client api: ${endpoint} expected ${contract}, got ${values.length}`)
}
```

关键点：**它只数 `descriptor.parameters.length`，完全不看 `acceptsUndefined`**。

- 我们把远端 `session/modelCatalog` 改成 `modelCatalog(sessionId?: SessionId)` 后，typert 描述符变成**1 个参数**（并正确带上了 `acceptsUndefined: true`）；
- 官方客户端在页面启动时的 **Host 级预热**调用仍是 **0 参数**；
- 于是该校验抛出 `expected 1 argument(s), got 0`；该异常在调用点未被捕获 → **unhandled rejection**，正是「服务不可用 → 组件级联崩」的燃料。

**结论（上游必须修的点）**：服务端本身没问题 —— 描述符里 `acceptsUndefined: true`，gateway 服务端接受 0 参数。问题在**客户端 gateway 的 arity 校验没有尊重 `acceptsUndefined`**。正确做法是把 `expected` 从「固定个数」改成「必填个数到 `parameters.length` 的区间」，即尾部可选参数允许省略。在此之前，任何「给现有无参方法新增可选参数」的改法都会让**未升级的客户端**在调用点抛错。

**本插件的缓解（不依赖上游）**：`session/modelCatalog` 只有在请求 **args 里确实带 `sessionId`** 时才可能被路由到 mount；**0 参数的 Host 级预热一律留在本机**（本机未打补丁，描述符 0 参数，正好匹配），并记 `catalog-prewarm-local`。同时该路由逻辑整体包了 try/catch —— 判定失败也降级为本机目录，绝不冒泡成未处理异常。

单测固定了该契约：`routing: the Session-less warm-up never reaches a Host that wants an argument` —— 即使焦点在远端会话上，0 参数读取的 mount 调用次数必须为 0，且返回本机目录。

## 客户端默认开 relay 而宿主没有 relay：重开 App 后远端挂载加载失败（2026-11-24）

**症状**：退出并从「应用程序」重开 App 后，远端工作区/会话加载不出来（远端会话打不开）；同一台机器此前一直可用，网络与凭据都没变。

**根因（两端错配，不是网络问题）**：

| 环节 | 事实 | 证据 |
|---|---|---|
| 客户端默认开 relay | `var STREAM_RELAY = config.streamRelay !== false`，不配置即为开 | `git show e546f2b:src/shim/00-config.js` |
| 客户端据此改写 mux URL | 页面 mux 改为 `<mount>/api/remote.mux` | `git show e546f2b:src/shim/20-transport.js` |
| 当时的宿主不提供该路径 | `lib/index.js` 里 `host mux relay` 命中 **0** 次；`lib/remote-mux.js` 不存在；`package.json` 无 `ws` | `git show e546f2b:lib/index.js \| grep -c`、`git cat-file -e` |
| 远端也没有该路径 | `GET <devbox>/api/remote.mux` → **404**（同 cookie 下 `/` 为 200） | `curl -o /dev/null -w '%{http_code}'` |
| ⇒ 页面 mux 打不开 | 宿主不处理 → 按普通挂载代理到远端 → 404 → 远端挂载无法建立 | 上两行 |

**为什么会踩到**：把「统一到 main」当成目标时，`main` 恰好停在「客户端已默认开 relay、宿主侧中继还没有」的中间态；按 main 检出即等于加载这个不可运行的组合。日志能区分这两种启动：

| 启动 | 日志序列 |
|---|---|
| 错配（远端挂载加载失败） | `apply: … streams=true` → `stream mount: ok` → `shim injection: ok`（**没有** relay 行） |
| 正确 | `apply: …` → `http mount: ok` → `orchestrator api proxy: ok` → `orchestrator stream proxy: ok` → `stream mount: ok` → **`host mux relay: ok`** → `shim injection: ok` |

**修复**：

1. 宿主侧中继（`lib/remote-mux.js` + `lib/index.js` 的挂载 + `ws` 依赖）与客户端改写同时存在于运行分支，`main` 快进到同时包含两端的合并提交；
2. `scripts/preflight.sh` 增加四项守卫：`shim build matches sources`、`plugin dependency ws resolves`、`running host mounted the relay`（读**当前 PID** 的启动日志，而不是只看源码字符串）、`no second DSH host`；
3. `docs/instance-layout.md` 明确禁止再检出到该中间态。

**教训**：「统一路径/版本」的正确目标不是「所有引用都指向 main」，而是「指向一个**自身可运行**的提交」。preflight 里任何把缺陷写成 OK 条件的检查项，都会把事故变成绿灯放行。

**顺带纠正一条排查陷阱**：`/tmp/dsh-remote-host-<pid>.log` 里带 `Error: spawn failed` 的行不是应用启动，而是 `npm test`（该字符串只在 `test/tunnel-retry.test.mjs` 的桩里）。排查启动问题先按有没有 `apply:` 行区分「应用启动」与「测试进程」。
