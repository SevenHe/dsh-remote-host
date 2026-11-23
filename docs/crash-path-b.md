# 路径 B：复现成功、两次修复尝试均无效，最终定位到一个更底层缺陷

## 结论（第一句）

**路径 B 稳定复现**（极短断开 0.6 s，5/5 轮，全部 ```exitCode:5```）；
**我的两次修复都无效**（延迟 open 期工作仍 5/5 崩）；
关键发现：**整轮运行里 ```remote-open``` / ```replay-*``` 一次都没出现**，只有 ```status-open-enter/exit```。
这指向 ```connect('remote')``` 的缺陷：**它直接把 ```upstreams``` 里的旧 socket 返回，不检查 ```readyState```** → 重连拿到的是**已关闭的 socket** → 其 ```'open'``` 监听器永远不会触发 → 恢复流程（replay/重订阅）根本没跑 → 页面卡在「半恢复」状态直至 trap。

## 1. 路径 B 复现（极短断开，修前）

序列：warmup pass 12 s → 5 轮 ×（blackhole **0.6 s** → pass 35 s）。

| 轮 | 崩溃 | 相对丢弃时刻 |
| --- | --- | --- |
| 1 | ```RENDER_GONE #1``` ```exitCode:5``` | ~17 s |
| 2 | #2 | ~17 s |
| 3 | #3 | ~17 s |
| 4 | #4 | ~17 s |
| 5 | #5 | ~17 s |

即：**每次「短断开→重连」后必崩**，与真实 App 的模式一致（真实 App 是 ```remote-open``` 后冻结、~16 s 后重启）。

## 2. 首次打点（修前）揭示的现场

```%
remote-unavailable {"reason":"close","ms":0}
reconnect-begin {"attempt":1,"depth":1}
reconnect-end   {"depth":0}
remote-unavailable {"reason":"error","ms":211}
remote-unavailable {"reason":"close","ms":211}
reconnect-begin {"attempt":2,"depth":1}
reconnect-end   {"depth":0}
（~17 s 后）
status-open-enter {}
status-open-exit  {}
（此后无任何事件 → 崩溃）
```%

**注意**：```remote-open``` / ```open-handled``` / ```replay-enter``` / ```replay-send``` / ```replay-done``` **全都没有**，
而它们的前置 ```status-open-*``` 有。按代码顺序，```status-open-*``` 来自 ```connect()``` 里创建**新** socket 时挂的监听器；
```remote-open``` 来自 ```attempt``` 里为「重连用 socket」挂的监听器。二者都不出现 ⇒ **重连用的 socket 与真正打开的不是同一个对象**。

## 3. 第二次尝试（延迟 open 期工作）与结果

把 ```attempt``` 的 ```onOpen```（```remote-open```/```open-handled```/replay```）与
```publishStatus('remote','open')``` 都用 ```setTimeout(…, 0)``` 挪出 open 派发链，期望打断同步链。

**实测（同一序列）：仍然 5/5 崩**，且面包屑形态不变——只有 ```status-open-enter/exit```，**没有 ```remote-open```**。

## 4. 定位：```connect()``` 返回陈旧 socket（新发现的真实缺陷）

```src/shim/50-router.js``` 的 ```connect(kind)```：

```%
if (existing !== undefined) return existing          // ← 不检查 readyState！
var socket = openSocket(target) … upstreams.set(kind, socket) …
```%

- 远端腿 close 之后，```upstreams``` 里仍留着**已关闭**的 socket；
- ```reconnectRemote()``` → ```attempt()``` → ```connect('remote')``` 拿回这个**死 socket**；
- ```attempt``` 判断 ```socket.readyState === 1 ```（不是）→ 挂 ```'open'``` 监听器到**死 socket** 上 → **永不触发**；
- 于是 ```remote-open``` / replay / 重订阅**全部不执行**；
- 而 ```status-open-*``` 只在**新建** socket 时出现（另一次 ```connect``` 调用，因为 ```upstreams``` 被别处清过），所以看起来「腿开了」，实际恢复流程没跑。

这解释了三件事：①为何 ```remote-open``` 一次都没有；②为何延迟派发无效（监听器挂错了对象）；③为何真实 App 在 ```remote-open``` 之后冻结——那一次是真连上了，随后客户端重订阅与旧 socket 的残留状态冲突。

## 5. 修复方向（下一步，一次改动）

在 ```connect()``` 里**丢弃不可用的缓存 socket**：

```%
var existing = upstreams.get(kind)
if (existing !== undefined) {
  if (existing.readyState === 0 || existing.readyState === 1) return existing
  upstreams.delete(kind)          // CLOSING / CLOSED：不能复用
}
```%

再加一条兜底：```attempt``` 里若拿到的 socket ```readyState``` 既不是 0 也不是 1，视为失败（```noteRemoteUnavailable('stale-socket')```），避免把监听器挂到死对象上。

**验证方法不变**：极短断开 5 轮要求 ```RENDER_GONE``` = 0 且每轮都出现完整的 ```remote-open → replay-enter → replay-send → replay-done``` 链；
另外长断开路径 A（blackhole 5 s ×3）仍须 0 崩、```degrade-handoff``` 仍触发。

## 6. 交付状态（诚实）

| 项 | 状态 |
| --- | --- |
| 路径 B 复现（极短断开 5 轮） | ✅ **5/5 崩**（```exitCode:5```） |
| 细分打点 | ✅ 已加 ```open-handled```/```replay-enter```/```replay-send```/```replay-done```/```status-open-enter/exit```（全部 critical） |
| 冻结点 | ✅ **在 ```status-open-exit``` 之后、```remote-open``` 之前**；但根因不是那里，而是**重连 socket 挂错对象**（无 ```remote-open``` 说明恢复流程从未执行） |
| 第一次修复（延迟派发） | ❌ **无效**，仍 5/5 崩 |
| 新发现的真实缺陷（```connect``` 复用死 socket） | ✅ **已定位到代码行**，**未修**（下一次改动，见 §5） |
| 回归 | ```npm run check``` = **71/71 通过**（含 main 的 71 条） |
