# 与原生 UI 对齐规范（ui-parity）

> 面向"在 DSH 原生界面里加一个新功能/新面板"的作者。回答两个问题：**入口在哪里找**、**样式和尺寸怎么对齐**。
> 本文只描述**可复现的方法**和**已实测的基线**；每条都写了「为什么」和「怎么验证」。

适用版本：DSH **0.2.2-rc.5**（桌面 app / `dsh web`）。兼容性见 [`compatibility.md`](./compatibility.md)。
回归清单见 [`regression.md`](./regression.md)。一条命令取全部指标：`node scripts/parity-snapshot.mjs --port <lab端口> --cdp <调试端口>`。

## 0. 先读这一页：三层事实来源

对齐结论只能来自三个地方，优先级从高到低：

| 层 | 是什么 | 怎么拿 | 可信度 |
|---|---|---|---|
| A. 编译产物 | app.asar 里的 CSS/JS（真正的上游规则） | §2.1 抽 `dsh-web-frontend/dist/assets/index-*.css` | 最高，但类名是 hash |
| B. 运行时计算值 | 真实浏览器里 `getComputedStyle` / `getBoundingClientRect` | §2.2 CDP + §2.3 真实鼠标 | 高，受页面状态影响 |
| C. 肉眼/截图 | 像素对比 | §2.5 `Page.captureScreenshot` | 只能证伪，不能定量 |

**永远不要**用"我觉得应该是 8px"这类直觉补数值。查不到就留 `TODO(parity)` 并在 §4 记一行，别编。

---

## §1 入口在哪里找

一个功能在 DSH 里落地，只有下面 6 个入口。**先判断用哪个，再动手**——入口选错，后面所有样式工作都白做。

### 1.1 cordis 插件行（config row）——一切的起点

**为什么**：DSH 用 cordis 的 entry list 组装 profile。你的插件必须在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里有一行，
否则 host 半边的 `apply()` 根本不会执行，client 半边也不会被扫描（client 模块表是按 Loader 行扫描 `dsh.client` 的）。

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: dsh-remote-host          # 行的稳定身份；后面所有 patch 都按 id 覆盖它
  name: dsh-remote-host        # 包名（或 ./ 相对 patch 文件的路径）
  config:                      # 传给 apply(ctx, config) 的对象，schema 由插件自己声明
    mount: /devbox
    sections: true
```

**怎么验证**：`dsh --profile <p> --dump-config | grep -A3 <id>` 能看到这一行，说明 patch 生效；
改 `config` 后重启（或等 HMR）再看 `ctx` 里读到的值。

### 1.2 host 半边：`apply(ctx, config)`

**为什么**：凡是"服务端才做得到"的事——反向代理、WebSocket 中继、给页面注入脚本、读写文件——都必须在这里。
我们用它做三件事（`lib/index.js`）：

| 用途 | API | 代码位置 |
|---|---|---|
| HTTP 反代/资源路由 | `ctx.webServer.register({ kind, path, resource })` | `lib/index.js:424, 436` |
| WebSocket 中继 | `ctx.webServer.registerUpgrade({ path, handler })` | `lib/index.js:518, 530` |
| 往页面 `<head>` 注入脚本 | `ctx.on('webserver/index-inject', (table) => table.push(row))` | `lib/index.js:551` |

```js
export const name = 'dsh-remote-host'
export const inject = ['webServer']   // 没有 webServer 服务就别激活，否则 register 拿不到

export function apply (ctx, config) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: config.mount,
    resource: async (request) => new Response('...'),
  }), 'remote mount')
}
```

**怎么验证**：`curl -i http://127.0.0.1:<port><mount>/…` 返回你的响应；注入的脚本在 DevTools 的 Elements 里出现在 `</head>` 前。

### 1.3 client 半边：`window.__ModuleLoader__.load({ id, factory })`

**为什么**：DSH 的客户端不是 ES module 图，而是一张**冻结的模块表**。插件必须以 classic script 形式自注册，
`factory` 只会被执行一次，返回值就是"这个包的 exports"（被当成一个 cordis 插件）。见 `lib/client.js:14-16`：

```js
window.__ModuleLoader__.load({
  id: 'dsh-remote-host',      // 必须等于包名
  factory: (require) => {
    const React = require('react')      // 只能 require 平台种子词或已到达的图节点
    ...
    return { apply, inject: ['slots', 'connection', 'uiWorkspace', 'workspaces'] }
  },
})
```

**关键限制（踩过坑）：`require()` 拿不到组件。** 上游 `@deepseek-ai/dsh-client-ui-*` 这些包导出的是**cordis 插件对象**
（`apply`/`inject`），不是 React 组件；`require('.../client')` 只会让你把同一个插件再注册一遍，拿不到任何 `Button`/`Row`。
所以：**想复用原生组件的"样子"，只能 port 它的 CSS 规则自己画**（见 §3），不能 import 组件。

可 `require` 的只有平台种子词（`react`、`react-dom`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、
`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives` 等）以及**已经到达模块表的同图包**；
拼错的 specifier 会抛 `require("…") missed the module table`。

**怎么验证**：DevTools Console 里 `window.__DSH_BOOT__.entries.map(e => e.id)` 能找到你的包名；
`document.getElementById('drh-block-css')` 之类你自己的注入点存在。

### 1.4 sidebar slot 契约：为什么"多 host 同屏并列"必须自绘

**为什么**：sidebar 是若干**槽位（slot）**拼出来的，而槽位的**种类**决定了你能不能"再塞一个"。
从 shipping 包 `@deepseek-ai/dsh-client-ui-sidebar` 与 `dsh-client-ui-workspace` 的产物里可以直接读出全部名字：

| 槽位 | 种类 | 能不能并列 | 归属 |
|---|---|---|---|
| `sidebar.workspaces` | **single（单占）** | ❌ 一个位置只能有一个主人 | ui-sidebar |
| `sidebar.panellist` | list | ✅ 可以加行 | ui-sidebar |
| `sidebar.panellist.actions` | list | ✅ | ui-sidebar |
| `sidebar.footer.action` | list | ✅ | ui-sidebar |
| `sidebar.session.action` | hoc | ✅（嵌套包装） | ui-sidebar |
| `sidebar.settings` / `sidebar.brand.mark` / `sidebar.brand.name` / `sidebar.toggle.badge` | single | ❌ | ui-sidebar |
| `sidebar.session.row.leading` / `.trailing` / `.hover` | 行内 | ✅ | ui-workspace |
| `sidebar.workspaces.session.row.action` | 行内 | ✅ | ui-workspace |
| `sidebar.workspaces.session.menu.item` / `sidebar.workspaces.directoryFlow` | 行内 | ✅ | ui-workspace |
| `sidebar.right.*`（tab/guide 一族） | list/keyed | ✅ | ui-sidebar-right |

> 更正：**没有** `sidebar.panellist.trailing` 这个名字（早期笔记里写错过）。实际是 `sidebar.panellist.actions` + `sidebar.footer.action`。
> 上表名字来自 0.2.2-rc.5 的 shipping 产物；升级 DSH 后请重新核对（§2.1 的抽包方法即可）。

**结论（我们为什么自绘）**：需求是"本地工作区 + 远端工作区 **同屏并列**、各自成组"。
`sidebar.workspaces` 是 single 槽且**不可参数化**（它不接收"多一份列表"的参数），list 一族又没有"第二个 workspaces 区"。
所以没有"再挂一个原生列表"的位置——**只能接管这个单槽、自己画两份列表**，或者完全不进槽、直接往 DOM 里挂（我们现在 block 模式的做法）。

接管单槽的正确姿势（`lib/client.js:1995-2001`，注释是踩坑记录）：

```js
ctx.effect(() => ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
  name: 'sidebar.workspaces',
  children: {},        // 必须留空！
  priority: -1,        // 必须换优先级！
}, (props) => h(SectionsSidebar, { ...props, __ctx: ctx }))))
```

两条硬约束，违反就抛错：

1. **不能同优先级替换**——"单槽占位者不能在相同 priority 上被替换"，用更小的 `priority` 让它渲染你（数值越小越前）。
2. **不能重新声明它的子槽**——上游占位者已经声明了 `sidebar.workspaces.directoryFlow`，你再声明就报
   `slot "sidebar.workspaces.directoryFlow" is already declared`。所以 `children: {}`，让那些既有注入继续挂在上游浏览器上
   （它们在我们的行不渲染时只是渲染不出东西，不会报错）。

**怎么验证**：换掉后 `document.querySelector` 里出现你的根节点；且 Console 没有 `already declared` 报错；
把 `priority` 改回 0 应该**立刻报错**（这是契约在保护你，不是 bug）。

### 1.5 `__DSH_TRANSPORT__`：页面出网/出流的公开钩子

**为什么**：桌面 app 的页面跑在 `dsh-app://` 自定义协议下，`fetch`/`WebSocket` 并不是普通 http 语义；
shell 把"怎么出网"抽象成一个 carrier 对象挂在 `globalThis.__DSH_TRANSPORT__` 上，`dsh-client-connection` 激活时**读取它**并采用。
我们正是靠它把远端数据接进原生渲染管线（把 carrier 包一层再挂回去）。

从 `dsh-client-connection/lib/client.browser.js` 实际读到的字段（我们已核对）：

| 字段 | 作用 |
|---|---|
| `fetch(input, init)` | fetch 形状，用来构造默认 RPC carrier |
| `openStream` | 流式变体（与 fetch 一起交给 `createWebConnectionRpc`） |
| `rpc` | 完整的 RPC 实现，**优先级高于 fetch** |
| `createWebSocket(url, protocols)` | WebSocket 工厂，给 `ctx.connection.openWebSocket(path)` 用 |
| `streamBaseUrl` | 流式端点的基址 |
| `ownsHost` | 声明"carrier 自己拥有 host"，影响 loopback 判定 |

真正被消费的方式（产物原文）：`const rpc = transport?.rpc ?? createWebConnectionRpc(transport?.fetch, transport?.openStream)`、
`openWebSocket: (path) => openConnectionWebSocket(path, transport?.createWebSocket, transport?.streamBaseUrl)`。

页面侧读 carrier 的推荐写法（`lib/client.js` 里就是这么做的，且带兜底）：

```js
const transport = globalThis.__DSH_TRANSPORT__
if (transport !== undefined && typeof transport.fetch === 'function') {
  const res = await transport.fetch('/api/session/list', { method: 'POST', ... })
} else {
  await ctx.connection.rpc.call('/api', 'session/list', payload)   // fetch-only carrier 没有 rpc 时
}
```

**怎么验证**：Console 里 `Object.keys(window.__DSH_TRANSPORT__ ?? {})`；
注意它是"先挂载者赢"——你必须在 `dsh-client-connection` 激活**之前**写好（我们的 shim 是在 `<head>` 注入的，所以够早）。

### 1.6 `tapIndex`：结构化注入表达不了时的最后手段

**为什么**：`webserver/index-inject` 的 row 必须是可 JSON 序列化的数据（同一张表还要喂给静态 worker 渲染）；
要插"任意标记"就只能用 `tapIndex` 字符串变换。shipping 代码里的定义原文：

> Structured index injections: the typed rows plugins contribute to the boot HTML instead of raw `tapIndex` string transforms. ...
> Anything not expressible as a row stays on `tapIndex`, which runs after row rendering.

**优先级**：能用 `index-inject` row（`script` / `script-src` / `script-preload` / `global`）就别用 `tapIndex`；
`tapIndex` 是字符串级改写，最容易在升级时静默失效。我们当前用 row + 自己拼 shim 文本（`lib/index.js:547-560`），没走 `tapIndex`。

**怎么验证**：`curl -s http://127.0.0.1:<port>/ | grep <你的标记>`；若改了 row 没生效，先确认是"注入表没刷新"还是"被 `tapIndex` 覆盖"。
---

## §2 找原生样式/尺寸的标准姿势

### 2.1 从 `app.asar` 抽 CSS：拿"真正的上游规则"

**为什么**：唯一的权威是 app 里那份编译后的 CSS。凭肉眼抄容易抄成"看起来像"，一遇到 hover/暗色/darwin 就露馅。
asar 是归档文件，普通 `grep` 搜不到，但 **Electron 的 node 自带 asar 支持**——用 app 自己的二进制当 node 跑一段脚本即可（已实测可用）：

```sh
# 列出前端 CSS/JS 资产名（hash 随版本变化，不要写死）
cat > /tmp/ls-assets.mjs <<'EOF'
import { readdirSync } from 'node:fs'
const dir = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
  + '/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets'
console.log(readdirSync(dir).filter((n) => n.endsWith('.css') || n.endsWith('.js')).join('\n'))
EOF
ELECTRON_RUN_AS_NODE=1 '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' /tmp/ls-assets.mjs
# 实测输出（0.2.2-rc.5）：index-CSAdOBx6.css  vendor-DV2921Zo.css
```

拿到文件名后，**按"属性/令牌"grep，而不是按类名**——类名是构建期 hash（`l6gf9`、`_surface`），每个 release 都变：

```sh
# 把 CSS 落到本地再搜（体积大，别反复读 asar）
cat > /tmp/dump-css.mjs <<'EOF'
import { writeFileSync } from 'node:fs'
const base = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
  + '/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets'
for (const name of [process.argv[2]]) writeFileSync('/tmp/' + name, require('node:fs').readFileSync(base + '/' + name))
EOF
ELECTRON_RUN_AS_NODE=1 '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' /tmp/dump-css.mjs index-CSAdOBx6.css

# 找浮层：令牌名是稳定的
grep -o '[^}]*--dsw-menu-surface-fill[^}]*}' /tmp/index-CSAdOBx6.css | head
grep -o '[^}]*--dsw-menu-backdrop-filter[^}]*}' /tmp/index-CSAdOBx6.css | head
# 找圆角+磨砂的三层结构（`._backing` 是 darwin 那层不透明底）
grep -o '[^}]*_backing{[^}]*}' /tmp/index-CSAdOBx6.css | head
# 找行内动作按钮的真实尺寸
grep -o '[^}]{0,120}border-radius:var(--dsw-radius-xs)[^}]*}' /tmp/index-CSAdOBx6.css | head
```

同样方法可查**任意** `--dsw-*` 令牌的解析值（`:root{--dsw-radius-lg:16px;…}`）——这是判断"这个 token 到底有没有值"的唯一可靠办法，
也是 §3.1 白兜底事故的根因排查手段。

**怎么验证**：把 grep 到的规则贴进 CDP，比对 `getComputedStyle` 是否一致；不一致说明你抄的是另一个变体（dark/darwin/rail）。

### 2.2 CDP 连 lab：在真实渲染树里取计算值

**为什么**：静态 CSS 只给"规则"，实际生效值还要乘上层叠、继承、容器查询和平台属性。只有在真渲染树里读 `getComputedStyle` 才是事实。

lab 是一个独立 profile 的 host（`scripts/lab-block.sh`，默认端口 19949），页面要用一个**开了调试端口的 Chromium/Electron** 打开：

```sh
./scripts/lab-block.sh                       # 起 lab，末行打印 "dsh web: http://127.0.0.1:19949/?token=…"
# 用调试端口打开它（打包 app 或 Chrome 都可以）：
"/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" --remote-debugging-port=9222 &
# 或: /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 http://127.0.0.1:19949/
curl -s http://127.0.0.1:9222/json/list | head -40     # 找到 type=page 且 url 命中 lab 的 target
```

**登录 cookie（关键，否则你拿到的是 401 的登录页）**。lab 的 URL 里带一次性 `?token=`，用它换一次持久 cookie；
也可以直接用 `~/.dsh/.credentials.yaml` 里的签名 secret 离线生成。**生成规则（已从 shipping 产物核对，并实测 200/401）**：

| 项 | 规则 |
|---|---|
| secret 位置 | `records:` → `client-connection/browser-session:` → `payload.secret`（base64url，32 字节） |
| cookie 名 | `dsh-auth-` + base64url(sha256(**authority**))，authority 对 http 是 `host:port`（如 `127.0.0.1:19949`） |
| cookie 值 | `v1.` + base64url(JSON`{version:1,authority,issuedAt,expiresAt}`) + `.` + base64url(HMAC-SHA256(secret, body)) |
| 属性 | `Path=/; HttpOnly; SameSite=Strict`（https 再加 `Secure`） |

`scripts/parity-snapshot.mjs` 内置了这个生成器（`--home` / `--secret-file` 可覆盖）；手写一遍也就二十行。**为什么不用 `?token=`**：
那是每次进程启动随机生成的，重启即失效，没法写进回归脚本。

**怎么验证**：`curl -s -o /dev/null -w '%{http_code}' -H "Cookie: <name>=<value>" http://127.0.0.1:19949/`
→ `200`；不带 cookie → `401`。（我实测过：200 / 401。）

### 2.3 必须用真实鼠标事件：`Input.dispatchMouseEvent`

**为什么**：`element.dispatchEvent(new MouseEvent('mouseover'))` **不会**触发 CSS `:hover`，也不会走命中测试、指针捕获、
事件顺序（pointerover→mouseover→mousemove）。我们的关键交互（行悬停出三按钮、文件夹换实心三角、悬停卡延迟出现）**全靠 `:hover`**，
用 `dispatchEvent` 测出来的结论一定是错的——这就是"测量方法不对导致结论错误"的来源。

```js
// 真实移动鼠标到元素中心（CDP），随后 :hover 才是真的
const { x, y } = await evaluate(`(() => { const r = document.querySelector(sel).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
```

**怎么验证（自检）**：移动前后各读一次 `getComputedStyle(row).backgroundColor`；真实 hover 会变（`--dsw-alias-interactive-bg-hover`），
`dispatchEvent` 不会。用 `dispatchEvent` 能"变"的，说明你的实现是 JS 监听而不是 CSS，那它已经和原生不一致了。

### 2.4 必须设 `data-platform='darwin'`，否则 darwin-only 规则全不生效

**为什么**：上游大量规则是 `html[data-platform='darwin'] …` 限定的（磨砂底、圆角补偿、滚动条等）。
shipping 前端里判定就是 `document.documentElement.dataset.platform === "darwin"`（我们自己抽产物核对过）。
在普通浏览器里这个属性**不存在**，于是 darwin 规则整段不生效——你会得出"上游没有这条规则/圆角是 0"的错误结论。
我们的 `.drh-menuBacking` 就是 darwin-only：

```css
html[data-platform='darwin'] .drh-menuBacking {
  display: block;
  position: fixed;
  position-anchor: --drh-menu-anchor;
  z-index: -2;                       /* 必须低于 material 的 -1 */
  background: var(--dsw-alias-bg-base);
  border-radius: inherit;            /* 不写就是方角盖住圆角 */
}
```

```js
// 测量前先固定平台（等价于在 macOS app 里）
await evaluate("document.documentElement.dataset.platform = 'darwin'")
// 反向验证：删掉属性后 display 应该变回 none
```

**怎么验证**：设/删 `data-platform` 各读一次 `.drh-menuBacking` 的 `display`——应当是 `block` / `none`。
若不是，说明你的规则选择器写错了（别用 `.drh-menuBacking` 单独命中，它默认 `display:none`）。

### 2.5 像素对比：`Page.captureScreenshot` + 页内 canvas 求均值

**为什么**：有些差异（磨砂是否被不透明底盖住、阴影层次）`getComputedStyle` 看不出来，只能比像素。
但"人眼看截图"不可复现，所以要在**页内**把图转成数值：把截图 base64 塞回页面，用 `createImageBitmap` + canvas 求均值/采样点。

```js
const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x, y, width, height, scale: 1 } })
const mean = await evaluate(`(async () => {
  const blob = await (await fetch("data:image/png;base64," + ${JSON.stringify(data)})).blob()
  const bitmap = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext("2d"); ctx.drawImage(bitmap, 0, 0)
  const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
  let r = 0, g = 0, b = 0; const n = px.length / 4
  for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i+1]; b += px[i+2] }
  return { r: r / n, g: g / n, b: b / n, w: bitmap.width, h: bitmap.height }
})()`)
```

**判据**：同一元素改前/改后均值差 **> 2/255** 才算"看得见的差异"；布局差 **±1px** 内算对齐（亚像素舍入）。
磨砂被盖住时均值会明显变亮/变实（我们踩过一次，白窗 + 不透明深底两种都出现过）。

**怎么验证**：`scripts/parity-snapshot.mjs` 里的 `materialMean` / `backingMean` 两个 key 就是这条的自动化版本。

---

## §3 token 与原子：只许用这几块积木

### 3.1 禁止"带白色兜底"的 token 写法（白窗的根因）

**为什么**：桌面主题里有一部分 token **在当前作用域没有值**（或为空字符串）。`var(--x, #fff)` 在 token 为空时会**静默取白**，
于是浮层变成一块白板——我们真的踩过：`background: var(--dsw-alias-bg-elevated, #fff)` 在 dark 主题下渲染成纯白窗。
更糟的是它不报错、不警告，只能靠肉眼发现。

**规则（硬性）**：

| 场景 | 允许 | 禁止 |
|---|---|---|
| 浮层/卡片/行的**背景** | 只写 token（`var(--dsw-menu-surface-fill)`）；token 确实无值时，写**实测字面值 + 注释写明实测来源** | `var(--dsw-alias-bg-elevated, #fff)` 这类"可能变白"的兜底 |
| 文字/图标颜色 | 可以带兜底（对比色不同，白字在亮底上也只是难看，不会"白窗"） | — |
| 圆角/间距 | 用 `--dsw-radius-*`；无值时用常量并注释 | 随手写 `8px` 而不查 |

判断某个 token 到底有没有值：§2.1 抽 CSS 后 `grep -- "--dsw-alias-bg-elevated"`，`：root` 里没有就是没有。
正确写法（我们的 `.drh-hoverDot`，token 无值 → 用实测字面值 + 注释）：

```css
.drh-hoverDot {
  /* Measured: --dsw-alias-state-idle-primary resolves to nothing in this page scope, so
   * the shipped idle core colour is used literally (native idle dot = rgb(84, 85, 87)). */
  color: rgb(84, 85, 87);
}
```

**怎么验证**：在 dark 主题下打开浮层，`getComputedStyle(el).backgroundColor` 不应是 `rgb(255,255,255)`；
再 grep 一遍 `block.css`：`grep -n "elevated, #fff\|, #fff)" src/client/block/block.css` 必须为空。

### 3.2 浮层（menu/popover）必须是三层结构

**为什么**：原生浮层 = **透明卡片 + 磨砂层 + darwin 不透明底**。三者缺一就会出现我们踩过的两种事故：
- 只写一层不透明背景 → 没有磨砂，变成"实心深色矩形"；
- 磨砂层与不透明底**同 z-index 且后者后插入** → 后者盖住前者，模糊整体消失。

结构（DOM 顺序必须一致：material → backing → viewport）：

```js
function menuSurface (width, dense) {
  const surface = document.createElement('div')
  surface.className = 'drh-menuSurface' + (dense === true ? ' drh-menuDense' : '')
  surface.setAttribute('role', 'menu')
  if (width > 0) surface.style.width = width + 'px'
  const material = document.createElement('div'); material.className = 'drh-menuMaterial'; surface.appendChild(material)
  const backing = document.createElement('div'); backing.className = 'drh-menuBacking'; surface.appendChild(backing)
  const viewport = document.createElement('div'); viewport.className = 'drh-menuViewport'; surface.appendChild(viewport)
  surface.__viewport = viewport       // 之后所有 item/label 都 append 到这里
  return surface
}
```

对应的 CSS（`src/client/block/block.css` 原文，可直接抄）：

```css
/* 卡片本体：透明，只负责定位、圆角、阴影、锚点 */
.drh-menuSurface {
  position: fixed;
  isolation: isolate;            /* 关键：把负 z-index 的子层关在卡片自己的层叠上下文里 */
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: 4px;
  border: 0;
  border-radius: var(--dsw-radius-lg);   /* 16px */
  /* 上游 elevation：语义令牌是 var(--dsw-elevation-prominent)；见下方"偏差记录" */
  box-shadow: 0 0 0 0.5px #ffffff29, 0 3px 8px 0 #0000000a, 0 0 20px 0 #0000000d;
  anchor-name: --drh-menu-anchor;        /* darwin backing 靠这个对齐 */
  z-index: 1100;
  background: transparent;               /* 卡片自己不画底！ */
}

/* 磨砂层：绝对定位铺满，z-index -1 */
.drh-menuMaterial {
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  background: var(--dsw-menu-surface-fill);        /* 实测 rgba(48,49,54,0.64) */
  backdrop-filter: var(--dsw-menu-backdrop-filter);/* 实测 blur(40px) saturate(1.5) */
  pointer-events: none;
}

/* darwin 专用不透明底：Chromium 需要一个不透明面才能把页面内容模糊上来 */
.drh-menuBacking { display: none; }
html[data-platform='darwin'] .drh-menuBacking {
  display: block;
  position: fixed;
  position-anchor: --drh-menu-anchor;
  top: anchor(top);
  left: anchor(left);
  width: anchor-size(width, 0px);
  height: anchor-size(height, 0px);
  z-index: -2;                    /* 必须低于 material(-1)，否则盖掉模糊 */
  background: var(--dsw-alias-bg-base);
  border-radius: inherit;         /* 必须继承，否则方角盖住 16px 圆角 */
  pointer-events: none;
}
```

> **偏差记录（必须知道）**：上游 `._surface, ._backing` 是 `border-radius: var(--dsw-radius-lg)`；
> 我们这里用 `border-radius: inherit`，因为卡片本身已经是 `--dsw-radius-lg`，继承比重复写更不容易漂。两者等价。
> 另外 `box-shadow` 目前是**字面值**而不是 `var(--dsw-elevation-prominent)`：该 token 在 shipping menu 里解析成这三个图层，
> 但出了那个作用域解析结果不同（`block.css` 的注释已记录）。**新代码请优先写 `var(--dsw-elevation-prominent)`**，
> 只有当你实测到 token 在本作用域解析异常时，才照抄这段字面值并把理由写进注释。

**怎么验证**：打开任一带磨砂的浮层 → `getComputedStyle` 读 `.drh-menuMaterial` 的 `backdropFilter` 非 `none`；
再截图求均值（§2.5），磨砂层生效时与"关掉 material"相比均值应明显不同；
darwin 下读 `.drh-menuBacking` 的 `zIndex` 必须是 `-2`、`borderRadius` 必须等于卡片半径。

### 3.3 行与图标原子：`rowAction` / `iconButton` / 精灵图标

**为什么**：行内动作按钮有精确的"盒子 24、图标 14、负 margin 4"三件套，任何一个错了都会让按钮**看起来**歪 1–2px，
而这类 1–2px 的累积正是"感觉不像原生"的主因。所有尺寸都是实测来的，别再猜。

| 原子 | 盒子 | 图标 | 圆角 | margin | 用在哪 |
|---|---|---|---|---|---|
| `.drh-iconButton` | 28×28 | 16 | `--dsw-radius-sm` | 0 | 表头控件（search / sliders-two / project-add） |
| `.drh-rowAction` | 24×24 | 16（行首）/14（行尾组） | `--dsw-radius-xs`(4px) | **-4px** | 行内 hover 才出现的动作 |
| `.drh-menuIcon` | 14×14 | 14 | — | — | 菜单项图标 |
| `.drh-hoverDot` | 10×10 | 6（`::after` inset 20%） | 50% | — | 悬停卡状态点 |

```css
/* 行内动作：24 盒子 + 14 图标 + -4 补偿 margin，hover 只换色不换尺寸 */
.drh-rowAction {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin: -4px;
  border: none;
  border-radius: var(--dsw-radius-xs);
  padding: 0;
  background: transparent;
  cursor: pointer;
  color: var(--dsw-alias-label-tertiary);
}
@media (hover: hover) {
  .drh-rowAction:hover { color: var(--dsw-alias-label-primary); }
}

/* 动作组：上游每个控件净进 29px（24 盒 + -4 补偿 margin）。用默认 12px gap 会落在 28px，
 * 行首控件整体右偏 2px，所以显式restate 成 13px。 */
#drh-remote-block .drh-rowActions { gap: 13px; }
```

**图标不要自己塞 SVG path**：从 shim 派生的页面里有上游的 symbol 精灵，用 `<use href="#id">` 引用，
并且**用候选列表兜住版本漂移**（`lib/client.js` 的 `pickIcon`）：

```js
function pickIcon (candidates) {
  for (let i = 0; i < candidates.length; i += 1) {
    if (document.getElementById(candidates[i]) !== null) return candidates[i]   // 精灵里存在就用它
  }
  return candidates[candidates.length - 1]    // 都不存在时用最后一个，至少不会空白
}
// 用法：pickIcon(['dsw-icon-folder-close-regular', 'dsw-icon-folder-regular'])
// 渲染：<svg width="16" height="16"><use href="#dsw-icon-folder-close-regular"></use></svg>
```

**hover 换槽用 CSS，不要用内联 style**（`block.css` 原文）：

```css
/* 目录行前导槽：静止=文件夹，hover=实心三角 */
.drh-projectRow .drh-chevron { display: none; }
@media (hover: hover) {
  .drh-projectRow:hover .drh-chevron { display: inline-flex; }
  .drh-projectRow:hover .drh-folder  { display: none; }
}
```

**为什么必须 CSS 而不是 JS**：内联 `style="display:none"` 的优先级高于 `:hover` 规则，会**永久压掉**换槽；
而且 JS 版不响应"指针离开窗口"这类浏览器自身状态。**怎么验证**：真实鼠标移入/移出（§2.3），
读两个元素的 `display` 应互换；用 `dispatchEvent` 测得"不变"是正常的，那不代表实现坏了。

### 3.4 菜单项/标签/分隔线/快捷键（可直接抄）

```css
.drh-menuItem {
  display: flex; align-items: center; gap: 6px;
  width: 100%; min-height: 34px; padding: 6px 8px;
  border: none; border-radius: var(--dsw-radius-md);   /* 12px */
  background: transparent; cursor: pointer;
  font-size: 13px; line-height: 20px;
  color: var(--dsw-alias-label-primary); text-align: left;
}
/* 视图菜单是 dense 变体：30px 行高、4px 上下内边距 */
.drh-menuDense .drh-menuItem { min-height: 30px; padding-block: 4px; }
.drh-menuDense .drh-menuLabel { padding-block: 3px; }

@media (hover: hover) {
  .drh-menuItem:hover:not(:disabled):not([aria-disabled='true']) {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
.drh-menuItem:disabled, .drh-menuItem[aria-disabled='true'] { opacity: 0.4; cursor: not-allowed; }

.drh-menuLabel { padding: 6px 8px; font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary); }
.drh-menuSeparator { height: 0.5px; margin: 3px 8px; background: var(--dsw-alias-border-l2); }
.drh-menuShortcut {
  flex: none; margin-inline-start: auto;
  color: var(--dsw-alias-label-caption); font-size: 11px; line-height: 16px;
}
/* 选中态 = 尾部 check 图标，不是填色 */
.drh-menuCheck { flex: none; display: inline-flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-primary); }
.drh-menuCheck { width: 14px; height: 14px; }
```

**怎么验证**：`node scripts/parity-snapshot.mjs` 输出的 `viewMenu.items[0].height` 必须是 30、`rowMenu.items[0].height` 必须是 34；
与 §4 表逐项 diff（脚本 key 与表一一对应）。

---

## §4 已实测基线数值表（回归基准）

**怎么用**：`node scripts/parity-snapshot.mjs --port <lab端口> --cdp <调试端口>` 输出的 JSON，key 与下表 **`key` 列一一对应**，
可直接 diff。**判据**：盒子/位置差 ≤1px、颜色差 ≤2/255 视为对齐；超出即回归。

**来源说明（重要）**：`native` 列是**已验收的原生值**，由需求方在 macOS app 上逐条实测提供；本次固化文档**没有重新测量**，
只做了"与仓库代码互证"（`src/client/block/block.css` 里已编码的常量/注释一致）。凡未互证的行都标了 `仅引用`。

### 4.1 表头（section header）

| key | 指标 | native | 备注 / 互证 |
|---|---|---|---|
| `header.controls[]` | 3 个控件，每个 **28×28** | `28` | `block.css` `.drh-iconButton{width:28px;height:28px}` ✅互证 |
| `header.controls[].icon` | `search-outline-regular` / `sliders-two-outline-regular` / `project-add-outline-regular` | 三个 id | 精灵 id，用 `pickIcon` 兜底 ⚠️仅引用 |
| `header.label.fontSize` / `.lineHeight` / `.fontWeight` | **14px / 20px / 400** | `14px,20px,400` | `.drh-title` 14/20 同源；weight 400 仅引用 |
| `header.label.color` | `rgb(173, 178, 184)` | 同 | ⚠️仅引用（secondary label） |

### 4.2 会话行（session row）hover 三按钮

| key | 指标 | native | 备注 / 互证 |
|---|---|---|---|
| `sessionRow.actions[].x` | 相对行左边界 **183 / 212 / 241** | `183,212,241` | 步进 29px = 24 盒 + (−4)×2 补偿；`block.css` 用 `gap:13px` 复现 ✅互证（步进） |
| `sessionRow.actions[].box` | 每个 **24×24** | `24` | `.drh-rowAction` 24×24 ✅互证 |
| `sessionRow.actions[].svg` | ellipsis **16** / archive **14** / pin **14** | `16,14,14` | ⚠️仅引用（svg 尺寸随图标而定） |
| `sessionRow.actions[].margin` | **-4px** | `-4` | `.drh-rowAction{margin:-4px}` ✅互证 |
| `sessionRow.actions[].radius` | **4px** | `4` | `--dsw-radius-xs` = 4 ✅互证 |

### 4.3 目录行（project/workspace row）hover 两按钮

| key | 指标 | native | 备注 |
|---|---|---|---|
| `projectRow.actions[].x` | **212 / 241**（ellipsis / new-chat） | `212,241` | 与 4.2 同一原子，位置差由行内容决定 ⚠️仅引用 |
| `projectRow.actions[].box` | **24×24** | `24` | 同上 ✅互证 |

### 4.4 视图菜单（view options，dense 变体）

| key | 指标 | native | 备注 / 互证 |
|---|---|---|---|
| `viewMenu.box` | **200 × 324** | `200,324` | `block.css` 里 `menuSurface(200, true)` ✅互证宽度；高度仅引用 |
| `viewMenu.items[].h` | **30** | `30` | `.drh-menuDense .drh-menuItem{min-height:30px}` ✅互证 |
| `viewMenu.items[].pad` | **4px 8px** | `4,8` | `.drh-menuDense …{padding-block:4px}` ✅互证 |
| `viewMenu.items[].font` | **13px** | `13` | `.drh-menuItem{font-size:13px}` ✅互证 |
| `viewMenu.items[].radius` | **12px** | `12` | `--dsw-radius-md` = 12 ✅互证 |
| `viewMenu.items[].gap` | **6px** | `6` | `.drh-menuItem{gap:6px}` ✅互证 |
| `viewMenu.label` | 11px，pad **3px 8px** | `11,3,8` | `.drh-menuDense .drh-menuLabel{padding-block:3px}` ✅互证 |
| `viewMenu.separators[]` | **176 × 0.5px**，`rgba(255,255,255,0.12)`，margin **3px 8px** | 同 | 176 = 200 − 2×(4+8) ✅可推导；颜色仅引用 |
| `viewMenu.check` | 尾部 check **14×14** | `14` | `.drh-menuCheck{width:14px;height:14px}` ✅互证 |

### 4.5 行菜单（row/context menu）

| key | 指标 | native | 备注 / 互证 |
|---|---|---|---|
| `rowMenu.box` | **144 × 225** | `144,225` | `menuSurface(144, false)` ✅互证宽度；高度仅引用 |
| `rowMenu.items[].h` | **34** | `34` | `.drh-menuItem{min-height:34px}` ✅互证 |
| `rowMenu.items[].pad` | **6px 8px** | `6,8` | `.drh-menuItem{padding:6px 8px}` ✅互证 |
| `rowMenu.shortcuts[]` | 11px `rgb(129,133,140)` | 同 | `.drh-menuShortcut{font-size:11px}` ✅互证字号；颜色仅引用 |
| `rowMenu.separators[]` | 宽 **120** | `120` | 144 − 2×(4+8) ✅可推导 |

### 4.6 目录菜单（group menu，3 项）

| key | 指标 | native | 备注 |
|---|---|---|---|
| `groupMenu.box` | **144 × 117** | `144,117` | 与行菜单同宽；高度随 3 项 ⚠️仅引用 |
| `groupMenu.count` | **3** 项：重命名 / Finder / 删除 | `3` | 删除项是 destructive（`--dsw-alias-state-error-primary`）✅互证风格 |

### 4.7 悬停卡（hover card）

| key | 指标 | native | 备注 / 互证 |
|---|---|---|---|
| `hoverCard.w` | **244** | `244` | `.drh-hoverCard{width:244px}` ✅互证 |
| `hoverCard.bg` | `rgb(44, 44, 46)` | 同 | `--dsw-alias-hovercard-bg` ✅token 互证 |
| `hoverCard.radius` | **16** | `16` | `--dsw-radius-lg` ✅互证 |
| `hoverCard.pad` | **12px 16px** | `12,16` | `.drh-hoverCard{padding:12px 16px}` ✅互证 |
| `hoverCard.title` | **14/20，白** | `14,20` | ⚠️仅引用 |
| `hoverCard.meta` | path/time **12/16** `rgb(207,211,214)` | 同 | ⚠️仅引用 |
| `hoverCard.status` | **12/20** `rgb(173,178,184)` | 同 | ⚠️仅引用 |
| `hoverCard.dot` | **10×10** | `10` | `.drh-hoverDot{width:10px;height:10px}` ✅互证 |
| `hoverCard.anchorGap` | 位置 = **区块右边界 + 16**（不是行的右边界） | `+16` | `lib/client.js` 用 `#drh-remote-block` 的 `right + 16` ✅互证 |
| `hoverCard.delayMs` | 出现阈值 **~800ms** | `800` | `lib/client.js` `setTimeout(…, 800)` ✅互证 |

### 4.8 菜单材质（material / backing）

| key | 指标 | native | 备注 / 互证 |
|---|---|---|---|
| `menuMaterial.fill` | `rgba(48, 49, 54, 0.64)` | 同 | `--dsw-menu-surface-fill` ✅token 互证 |
| `menuMaterial.backdropFilter` | `blur(40px) saturate(1.5)` | 同 | `--dsw-menu-backdrop-filter` ✅token 互证 |
| `menuMaterial.zIndex` | **-1** | `-1` | `.drh-menuMaterial` ✅互证 |
| `menuBacking.zIndex` | **-2**（必须低于 material） | `-2` | ✅互证（本次修复点） |
| `menuBacking.borderRadius` | 等于卡片半径（**16px**） | `16` | `border-radius:inherit` ✅互证（本次修复点） |
| `menuBacking.display` | darwin 下 **block**，非 darwin **none** | 同 | ✅互证 |

> JSON 里每个菜单对象都自带 `material` / `backing`（例如 `viewMenu.material.fill`），另有**顶层别名** `menuMaterial` / `menuBacking`
> （取自本次实际测到的那一份菜单），因此 §4.8 的 key 可以直接 diff。

> 这些数值的**唯一**权威仍是 §2 的实测方法。上表用来"发现漂移"，不是用来"推导实现"——实现永远去抄 §2.1 抽出来的规则。

---

## §5 陷阱清单（每条都真实发生过）

| # | 陷阱 | 后果 | 正确做法 |
|---|---|---|---|
| 1 | **CSS Modules 类名被 hash**（`l6gf9`、`_surface`） | 想复用上游类名 → 写死的 hash 下个版本就失效 | 按**令牌/属性** grep（§2.1），把规则 port 到自己前缀的类名（`drh-`） |
| 2 | **`:global()` 在纯 CSS 里非法** | 整条逗号选择器**全部失效**（不是只失效一个分支），表现为"样式完全没生效" | 纯 CSS 不用 `:global()`；用 `html[data-platform='darwin'] .drh-x` 这类真实选择器 |
| 3 | **同 z-index 叠加**（material 与 backing 都 -1，backing 后插入） | 不透明底盖住模糊 → 磨砂"消失"、卡片变成实心深色块 | material `-1`、backing `-2`，且卡片 `isolation:isolate` |
| 4 | **内联 `display` 压掉 `:hover` 换槽** | 文件夹/三角永不切换，或永远只有一个图标 | 换槽只写在 CSS 里（§3.3），JS 不碰 `style.display` |
| 5 | **依赖上游 `aria-label` 文案** | 上游改文案/本地化 → 你的选择器命中不到，功能静默失效 | 用 `data-drh-*` 自己的钩子取元素，`aria-label` 只用于无障碍 |
| 6 | **`!important` 禁止** | 短期能盖住，长期把层叠打乱，后续谁都不敢改 | 提高选择器特异性或用 CSS 变量覆盖；只在"必须盖第三方内联样式"时用，并写注释 |
| 7 | **`innerHTML` 全量重建** | 每次刷新都重建 DOM → 闪烁、丢焦点、丢输入法状态、hover 中断 | 用"签名比对 + 只在变化时重绘"（见 `lib/client.js` 的 `signature`/`html` 缓存）；局部更新优先 |
| 8 | **`location.reload()`** | 在 `dsh-app://` 渲染进程下**会崩**（不是刷新） | 用 shell 自己的重载入口，或只重挂你的子树；永远别整页 reload |
| 9 | **序列化字段上限**（只保留 6 个 key） | 跨进程/跨页传递的状态被静默截断 → 字段"偶发丢失" | 传状态前显式挑字段并写测试断言 key 集合；别把整个对象丢过去 |

**怎么验证**：1–2 用"改完立刻看 Console + `getComputedStyle`"；3–4 用真实鼠标 + 截图均值（§2.3/§2.5）；
5 用 `document.querySelectorAll('[data-drh-…]').length`；7 用 Performance 面板看 Layout/Recalc 次数与焦点是否丢失；
8 在桌面 app 里点一次"刷新"按钮试；9 用一个字段多的对象跑一遍往返并断言 key 数。

---

## §6 新功能 checklist（开工前逐条打勾）

- [ ] **1. 先查 §1 的 6 个入口**：cordis 行 / host `apply` / client factory / slot / `__DSH_TRANSPORT__` / `tapIndex` —— 能不进 DOM 就不进。
- [ ] **2. 确认槽位够用**：目标槽是 list/hoc 就直接用；遇到 **single 槽**（如 `sidebar.workspaces`）先问"能不能不改"，必须接管时用 `priority:-1` + `children:{}`（§1.4）。
- [ ] **3. 只有"没有槽可用/需要并列"时才自绘**，并在 PR 说明里写清为什么（引用 §1.4 的结论）。
- [ ] **4. 样式从 asar 抽规则**（§2.1），不靠肉眼抄；新令牌先 grep 确认存在。
- [ ] **5. 只用 §3 的原子**（`rowAction` / `iconButton` / `menuSurface` 三层 / `menuItem` 家族）；不新造浮层。
- [ ] **6. 背景类 token 不带白色兜底**（§3.1），`grep -n ", #fff)"` 必须为空。
- [ ] **7. 在 `data-platform='darwin'` 下验证**（§2.4），并至少跑一次非 darwin 对比。
- [ ] **8. 用真实鼠标验证 hover/click**（§2.3），并确认 hover 换槽是 CSS 生效而不是 JS。
- [ ] **9. 跑 `node scripts/parity-snapshot.mjs`，与 §4 表 diff**，差异 ≤1px / ≤2 色阶。
- [ ] **10. 在 `docs/regression.md` 增加/更新一条回归项，并跑一次 `npm run check`（CI 绿的同一套）。**

---

## 附录 A：本文各结论的来源与可信度

| 结论 | 来源 | 可信度 |
|---|---|---|
| client `require()` 拿不到组件，只能拿到插件对象 | 本仓库 `lib/client.js` 实测 + 上游包导出形态 | 高（本次核对） |
| sidebar 槽位名单（含 `sidebar.panellist.actions`、无 `.trailing`） | 从 shipping 产物 `dsh-client-ui-sidebar` / `dsh-client-ui-workspace` 的字符串常量提取 | 高（本次核对 0.2.2-rc.5） |
| 单槽不可同优先级替换、不能重复声明子槽 | 本仓库 `lib/client.js:1995-2001` 的踩坑注释 + 报错文案 | 高（实测报错过） |
| `__DSH_TRANSPORT__` 字段（fetch/openStream/rpc/createWebSocket/streamBaseUrl/ownsHost） | 从 shipping 产物 `dsh-client-connection/lib/client.browser.js` 提取 | 高（本次核对） |
| `tapIndex` 是 row 之后的字符串兜底 | shipping `dsh-host-webserver` 的注释原文 | 高（本次核对） |
| asar 抽取法可用 | 实测：`ELECTRON_RUN_AS_NODE=1` 读到 `@deepseek-ai` 下 340 个包 | 高（本次实测） |
| `data-platform='darwin'` 是上游开关 | shipping 前端产物里 `document.documentElement.dataset.platform === "darwin"` | 高（本次核对） |
| `dsh-auth` cookie 生成规则 | shipping `dsh-client-connection/lib/index.js` 的 browser-auth 模块 | 高（本次核对 + 实测 200/401） |
| §4 全部 native 数值 | **需求方实测提供** | 中（本次未复测；仅与仓库常量互证） |
| 三处磨砂/圆角/右对齐修法 | 仓库既有提交（`fix(block): round the darwin backing…`） | 高（已在代码里） |

## 附录 B：速查命令

```sh
# 1) 起 lab + 调试浏览器
./scripts/lab-block.sh                          # → 打印 "dsh web: http://127.0.0.1:19949/?token=…"
"/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" --remote-debugging-port=9222 &

# 2) 一条命令取全部指标（JSON，可直接与 §4 diff）
node scripts/parity-snapshot.mjs --port 19949 --cdp 9222
node scripts/parity-snapshot.mjs --port 19949 --cdp 9222 --out /tmp/parity.json

# 3) 抽原生 CSS（hash 名以实际为准）
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" /tmp/ls-assets.mjs

# 4) 自检：不允许出现白色兜底
grep -n ", #fff)\|elevated, #fff" src/client/block/block.css || echo "ok: no white fallbacks"
```



## §5 补充：2026-11 又踩到的 5 个坑

1. **选中态与 hover 态共用同一个 token** → 两行会同时发灰。`--dsw-alias-interactive-bg-hover` 同时被 `:hover` 和我们自维护的 `.selected` 使用；而远端会话不会让宿主的 `mainReference` 移动，所以我们只能自己记当前行——**记住就必须负责清除**（离开远端会话的所有路径：点本地行 / 新会话 / 快捷键）。
2. **内联样式隐藏会被上游重挂载冲掉**。给原生行 `element.style.display='none'` 在 React remount 后就没了，表现为「修好了，操作一次又回来」。正解：**静态 CSS + 前缀 key**（如 `[data-row-key^='overflow:drh:']`），前缀保证只命中我们自己的桶。
3. **不要向 root 的 `sessions.manager` 注入目录行**。`openSession → replaceMain → sessions.retain` 用的是某个具体 scope 的 manager，注入 root 不生效（实测报 `unknown session`）。另外 `SessionSummary` **没有** `workspaceId` 字段，分桶靠 `workspace.sessionIds` 的成员关系——想「按字段归桶」这条路不存在。
4. **诊断序列化有字段上限**。我们的 trace detail 只保留前 6 个键，心跳有 7 个计数时第 7 个被静默丢弃（表现为「明明加了计数，日志里只有前几个」）。写埋点时用**扁平标量**并核对上限。
5. **「数值相同」不等于「观感相同」**。菜单材质、阴影、字号全部逐项相等，但菜单左对齐 vs 右对齐会让它落在不同背景上，用户看到的是「颜色不一样」。定位这类问题要**成对看 rect**（`menu.right` vs `trigger.right`），而不是只比 computed style。
