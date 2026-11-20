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
