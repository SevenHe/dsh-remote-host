# 崩溃取证：证据归属判定（renderer-trace.log 多实例共用）

## 结论（第一句）

**那批 `failure` 不能全部归属到用户的 App。** 至少 `session/modelCatalog expected 1 argument(s)` 这一条，
心跳指纹更像**我们自己的 e2e/lab 实例**；而 `conversation service unavailable` 那几条落在**桌面 App 形态**的心跳旁。
**在加实例标识之前，这份共享日志不足以支撑「用户崩溃的根因」结论** —— 这正是本轮先把归属做出来的原因。

## 1. 方法：用心跳指纹区分实例

`hb` 事件带 `nodes / body / groups / rows / renders`。同一实例这几项稳定，不同实例明显不同。
全量日志按指纹聚类（节选）：

| 指纹 (nodes, body, groups, rows, renders) | 条数 | 时间窗 | 判定 |
| --- | --- | --- | --- |
| (5689, 4, **1**, 0, 65) | 329 | 1795414375967–1795416015918 | **lab 假数据**（groups=1） |
| (1331, **5**, 0, 0, –) | – | 1795416596 附近 | **我们的探针页**（见 §2 的 PROBE 标记） |
| (7345, 4, **71**, 0, 68) | 327 | 1795418281643–1795420320865 | 桌面形态实例 |
| (7464, 4, **71**, 0, 69) | 327 | 1795419742643–1795421372636 | 桌面形态实例 |
| (2686, **5**, 71, 0, –) | – | 1795420815 前后 | **body=5 形态 = 我们的实例** |
| (1110, 4, 0, 0, 69/92) | 298+288 | 1795420938–1795422679 | 页面刚加载/无 block（groups=0） |

要点：**`body` 是区分「我们」与「桌面 App」最稳定的维度之一** —— 我们的探针/e2e 页是 body=5，
桌面 App 形态是 body=4。

## 2. 我们的实例确实写进同一份日志（硬证据）

```
t=1795416596369 failure {"kind":"console-error","n":1,"message":"DRH_PROBE_CONSOLE_ERROR marker"}
t=1795416596371 failure {"kind":"error","n":2,"message":"Uncaught Error: DRH_PROBE_UNCAUGHT marker","source":"http://127.0.0.1:19984/"}
t=1795416596371 failure {"kind":"rejection","n":3,"message":"DRH_PROBE_REJECTION marker"}
```

这三条是**我们自己注入的标记**，且 `source` 就是 lab 端口 `127.0.0.1:19984`。
证明：**同一个文件里混着 lab/e2e 与用户 App 的事件**，`failure` 不能直接当用户证据。

## 3. 逐条 failure 的就近心跳（原始数据）

| failure 内容 | t | 前一条 hb | 后一条 hb |
| --- | --- | --- | --- |
| DRH_PROBE_CONSOLE_ERROR marker | 1795416596369 | nodes=1331 **body=5** groups=0 | 同 |
| Uncaught Error: DRH_PROBE_UNCAUGHT | 1795416596371 | nodes=1331 **body=5** groups=0 | 同 |
| DRH_PROBE_REJECTION marker | 1795416596371 | nodes=1331 **body=5** groups=0 | 同 |
| [deepseek-account] account read failed | 1795418911160 | nodes=7345 body=4 groups=71 | nodes=2596 body=5 groups=71 |
| **client api: session/modelCatalog expected 1 argument(s), got** | 1795420815048/049 | **nodes=2686 body=5 groups=71** | nodes=7464 body=4 groups=71 |
| ui-conversation: conversation service unavailable | 1795420938036 | nodes=7464 body=4 groups=71 | nodes=1110 body=4 groups=0 |
| slot entry crashed in composer.bar (ui-conversation) | 1795420938036 | 同上 | 同上 |
| conversation.input: sessions service unavailable | 1795420938684 | 同上 | 同上 |
| slot entry crashed in composer.bar (conversation.input) | 1795420938684 | 同上 | 同上 |
| ui-conversation: conversation service unavailable | 1795421191839 | nodes=7596 body=4 groups=71 | nodes=7464 body=4 groups=71 |
| slot entry crashed (2nd occurrence) | 1795421191842 | 同上 | 同上 |
| [cordis-client-runner] syncing inspect providers failed | 1795421192509 | 同上 | 同上 |

**判定**：
- `session/modelCatalog expected 1 argument(s)`：**前一条心跳是 body=5（我们的形态）** → 高置信度属于 **lab/e2e**，
  与 lead 的判断一致（打过补丁的 alpha.2 客户端被无参调用）。**应从「用户崩溃证据」中剔除。**
- `conversation service unavailable` / `slot entry crashed`：**落在 body=4、groups=71 的桌面形态心跳之间** →
  更像**用户 App**，但**就近心跳归因有噪声**（两个实例每 5 s 交错写入，前后心跳可能来自另一实例）。
  因此：**倾向 App，但不能定论**。
- 时间上：modelCatalog(1795420815) 比 service-unavailable(1795420938) 早 **123 s**，两者之间没有直接因果证据链，
  **不能**据此说「arity 错误导致了 composer 崩溃」。

## 4. 已实施的修复：给取证加实例标识（本轮已提交）

`src/shim/05-trace.js`：

```js
var traceInstance
function traceInstanceId() {
  if (traceInstance !== undefined) return traceInstance
  var label = typeof config.label === 'string' && config.label.length > 0 ? config.label : 'remote'
  var inst = ''
  try {
    var element = document.getElementById('drh-remote-block')
    if (element !== null && element !== undefined) inst = element.getAttribute('data-drh-inst') || ''
  } catch (error) { inst = '' }
  traceInstance = inst.length > 0 ? label + '#' + inst : label + '#-'
  return traceInstance
}
// traceEvent 内：
entry.inst = traceInstanceId()
```

- 标识 = `config.label` + 远端区块的 `data-drh-inst`（每页面实例唯一），因此**同一份日志内可逐条归属**；
- 已 `npm run build:shim`（`lib/shim.js` 已更新，`--check` 通过）；
- `npm run check`：**58 tests / 58 pass / 0 fail**，且 `verify-sensitive` 干净（67 个跟踪文件）。

**下次取证**：`grep '"inst":"devbox#' ~/.dsh/dsh-remote-host/renderer-trace.log` 即可只看某一实例；
建议先记下用户 App 的 inst 值，再看 lab 的，二者不会再混。

## 5. 复现（面向用户 App 的「断连重连」）—— 未完成

**没做**。原因与计划如实记录：

- 本轮先按 lead 的要求完成「归属判定 + 加实例标识」，之后没有剩余预算做完一组 8–10 分钟的断连/恢复实验。
- 计划（下一轮可直接执行）：lab 的 `upstream` 指向**本地可切换代理**（例如一个 30 行 node 脚本：`/devbox` 转发到真实 devbox，
  收到信号就立刻返回 502/断 socket），用 `/tmp/dsh-elec-run` 的 Electron 44.7.0 + `/tmp/dsh-elec-app` harness 加载，
  每 20 s 切换一次「通/断」，观察：
  1. `conversation service unavailable` 与 `slot entry crashed in 'conversation.composer.bar'` 是否出现；
  2. `render-process-gone` 是否出现（harness 会记录 details）；
  3. stderr 是否出现 `Fatal error in …` / `brk`。
- 注意 harness 是共享资产：若需改 main.js，复制一份（`/tmp/dsh-elec-app-<mine>`），不要动原目录。

## 6. 对「ssh 断开」触发条件的重新表述（附证据边界）

用户说「ssh 一断开重连就崩」，但已确认的事实是：**桌面 profile 没有 `sshHost`**，upstream 是直连
`http://devbox.example.com:3080`。所以用户口语里的「ssh 断开」更可能指**远端连接不可达/中断**（devbox 侧或网络），
而不是我们插件的 ssh 隧道。**这一点需要用户的确认**（他很可能是通过 ssh 登录 devbox 使用，主观上把「连接断了」说成「ssh 断开」）。

在复现之前，**不能**把「断连」写成已确证的崩溃触发条件。
