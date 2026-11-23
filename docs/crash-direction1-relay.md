# 方向 1（只重写 URL、不承担连接）：实现完成，但本轮验证无效

## 结论（第一句）

实现已加好并有开关（默认 off、74/74 绿），但**本轮验证无效**：
两个实验实例重叠运行（我上一次失败调用里的 nohup 其实已启动一轮），数据互相污染；
更关键的是 **stream-relay 事件数为 0**，而 reconnect-enter / listener-attach 仍在出现 —— 
说明**新路径根本没被走到**，这一轮没有测到方向 1。

## 1. 实现要点

- 开关：config.streamRelay（默认 false，产品路径不变）；
- 位置：src/shim/60-runtime.js 的 routeCreateWebSocket；当命中 mux 且开关为真时，
  用 mountSocketUrl(target) 把 /api/remote.mux 改写成 /devbox/api/remote.mux，
  然后 openSocket(改写后的 URL) —— 原生 socket，不做多路复用、不做重连；
- 发出 stream-relay 关键事件（critical，立即落盘）；
- 现有 router 代码一行未删，仍为默认路径。

## 2. 本轮为何无效（原始证据）

    drops 出现两套：19:23:53/19:24:08 drop 2, drop 1 ... 19:26:03 drop 5
    RENDER_GONE: 11   timeup crashes=7
    trace: {announce:210, reconnect-enter:25, listener-attach:25}    <-- 没有 stream-relay
    usability: composer=1 rows=0 nodes=2485 block=1 boots=3
    host boot.log 里 remote.mux 相关计数：0

两条独立证据说明新路径没生效：
1. 渲染进程仍在跑我们的 router（reconnect-enter / listener-attach 出现 25 次）；
2. trace 里 stream-relay 为 0。

最可能原因（待下轮确认，任一即可）：
- 插件配置里 streamRelay 未真正传到 shim（配置层可能过滤未知键）；
- 页面加载的 shim 构建早于本次重编译（生效时序）；
- 或宿主未把 /devbox/api/remote.mux 的 upgrade 中继起来（boot.log 无相关记录）。

## 3. 下一步（很小，一次即可）

1. 先确认配置到达 shim：在 trace 里加一行启动打点 inst/config 摘要，或读 diag；
2. 单实例干净跑一次（这次重叠是硬伤）；
3. 看到 stream-relay 出现后，再判三件事：流式是否仍在、5 轮 RENDER_GONE、rows>0。

## 4. 代码状态

- 新增：config.streamRelay 开关 + routeCreateWebSocket 的 relay 分支 + stream-relay 打点；
- 未删：现有 mux router（默认路径）；
- 保留：死 socket 守卫、abandon CONNECTING socket、全部诊断打点；
- npm run check：74/74。
