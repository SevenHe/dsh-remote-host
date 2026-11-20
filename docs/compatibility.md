# 兼容性矩阵（compatibility）

本包（`dsh-remote-host`）是 DSH 的**宿主插件 + 客户端 UI 插件**双面包，它直接依赖一批 **DSH 内部面**（不是稳定公开 API）。
因此"支持哪个 DSH 版本"必须写清楚，而不是 `*`。

## 1. 实测矩阵

| 组件 | 版本 | 状态 | 说明 |
|---|---|---|---|
| DSH（macOS 桌面 app） | **0.2.2-rc.5** | ✅ 已实测 | 本条所有对齐结论与回归项的来源环境 |
| DSH（`dsh web`, macOS） | 0.2.2-rc.5 | ⚠️ 可用但未系统验证 | host 半边同源；UI 未逐条回归 |
| DSH（`dsh web`, Linux） | 0.2.2-rc.5 | ⚠️ 未验证 | 非 darwin 路径没有 backing 层，磨砂表现未测 |
| DSH | 0.2.2-rc.3 ~ rc.4 | ⚠️ 预期可用、未逐个验证 | `peerDependencies` 范围覆盖；内部面若有差异请按第 3 节逐项核对 |
| DSH | 0.1.x | ❌ 未验证 | slot 名与 transport 字段在 0.2 期间变过，**不要假设可用** |
| Node（跑 `scripts/*.mjs`） | >= 22 | ✅ | 脚本用全局 `WebSocket`（22+ 内置）；18/20 需自行提供 |
| 平台 | macOS | ✅ | darwin-only 原子（backing 圆角/磨砂）已调 |
| 平台 | Windows / Linux | ⚠️ 未验证 | 非 darwin 时 `.drh-menuBacking` 为 `display:none`，浮层只剩 material 一层，视觉需复测 |

## 2. 为什么 `peerDependencies` 是 `^0.2.2-rc.3` 而不是 `*`

原先写 `"@deepseek-ai/cordis": "*"`：等于宣称"任何版本都行"，这在本包是**错的**——它按名字依赖 DSH 的 slot 契约、
`__DSH_TRANSPORT__` 字段、`webserver/index-inject` 行、`data-platform` 属性、以及 `~/.dsh/.credentials.yaml` 的记录格式。
这些都会随 DSH 版本漂。

现在的范围：

```json
"peerDependencies": {
  "@deepseek-ai/cordis": "^0.2.2-rc.3"
},
"peerDependenciesMeta": {
  "@deepseek-ai/cordis": { "optional": true }
}
```

semver 语义（按 node-semver 默认规则，`includePrerelease: false`）：

| 版本 | 是否满足 `^0.2.2-rc.3` | 原因 |
|---|---|---|
| `0.2.2-rc.3` / `0.2.2-rc.5` | ✅ | 同一 `[major,minor,patch]` 元组内的预发布，按序比较 |
| `0.2.3` | ✅ | 非预发布版本落在 `>=0.2.2-rc.3 <0.3.0` 内 |
| `0.2.3-rc.1` | ❌ | 不同元组的**预发布**默认不被范围接纳（需要 `includePrerelease`） |
| `0.3.0` / `1.x` | ❌ | 上界之外 |

> 结论：`^0.2.2-rc.3` 能覆盖"0.2.x 正式版 + 0.2.2 的 rc 系列"，但**不能**覆盖未来 0.2.3 的 rc。
> 如果 DSH 开始以 `0.2.3-rc.N` 发布并要支持，就把范围放宽成 `>=0.2.2-rc.3 <0.3.0` 或显式列出。
> 声明为 `optional`（`peerDependenciesMeta`）是保留的：本包在 `dsh` 之外也能被加载做开发调试，不强制安装 peer。

## 3. 我们依赖的"内部面"清单（升级 DSH 时逐项核对）

| # | 依赖 | 位置（本仓库） | 失效表现 | 怎么核对 |
|---|---|---|---|---|
| 1 | slot 名与种类（`sidebar.workspaces` 单槽、`sidebar.panellist` 等 list） | `lib/client.js:1995` | `slot "..." is not declared` / 覆盖不到 | 重新抽 `dsh-client-ui-sidebar` 产物里的槽名字符串 |
| 2 | 单槽"降优先级替换"语义（`priority: -1` + `children:{}`） | `lib/client.js:1995-2001` | 报 `already declared` 或渲染不出 | 真机启动看 Console |
| 3 | `__DSH_TRANSPORT__` 字段（`fetch`/`openStream`/`rpc`/`createWebSocket`/`streamBaseUrl`/`ownsHost`） | `src/shim/80-install.js`, `lib/client.js` | 远端数据全空、状态点常红 | `Object.keys(window.__DSH_TRANSPORT__)` |
| 4 | `webserver/index-inject` 行格式（`script`/`global` 等） | `lib/index.js:551` | shim 不注入、页面无 `__DSH_REMOTE_HOST__` | `curl /` 看 head 里有没有你的脚本 |
| 5 | `webServer.register` / `registerUpgrade` | `lib/index.js:424,518` | 路由 404 | `curl -i <mount>/...` |
| 6 | `data-platform` 为 `darwin` 时启用 darwin 规则 | `src/client/block/block.css:1167` | 磨砂/圆角在 mac 上不对 | Console 读 `document.documentElement.dataset.platform` |
| 7 | `~/.dsh/.credentials.yaml` 的 `records.client-connection/browser-session.payload.secret` | `scripts/parity-snapshot.mjs` | 脚本 401 | 手工按 `ui-parity.md` §2.2 生成 cookie，`curl` 应 200 |
| 8 | 前端资产路径 `dsh-web-frontend/dist/assets/index-*.css` | `ui-parity.md` §2.1 | 抽不到 CSS | 用 asar 脚本 `readdir` 确认 |

## 4. 升级 DSH 后的最小动作

1. 按 `ui-parity.md` §2.1 重新抽 CSS，确认 §3 的 token 仍在（尤其 `--dsw-menu-surface-fill`、`--dsw-menu-backdrop-filter`、`--dsw-radius-*`）。
2. 按上表第 1、3、4 项核对名字变化；名字变了要同步改本文与 `ui-parity.md` §1 的表。
3. 跑 `node scripts/parity-snapshot.mjs`，与 `ui-parity.md` §4 表 diff。
4. 过一遍 `docs/regression.md` 的 15 条。
5. 更新本文件的"实测矩阵"（把新版本标成 ✅，旧版本降级）。

## 5. 不知道的事（不要假装支持）

- **0.1.x 完全未验证**：不要因为"能加载"就标支持。
- **Windows/Linux 的浮层观感未验证**：没有 darwin backing 时，material 单独一层可能偏透明。
- **HMR 下改 `src/client/block/block.css` 是否即时生效未验证**：该文件由 host 半边按请求读盘（`lib/index.js:436-445`），
  理论上刷新页面即生效，但缓存行为取决于部署，保守做法是重启 lab。
