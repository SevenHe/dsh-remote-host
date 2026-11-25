# 打包（换机器 / 升级 DSH 版本）

本机的 App 不是"官方原版"：它带一个**上游还没有的模型目录补丁**（远端会话要按会话所属宿主取模型目录，否则远端会话永远显示「请选择模型」）。所以打包不能用官方命令直接出包，必须走本仓库的入口，并且**产物必须自证补丁在里面**。

## 1. 一条命令

```bash
cd ~/Workspace/dsh-remote-host
node scripts/package-app.mjs          # 等价 npm run package:app
```

它按顺序做四件事，任何一步不满足就**以非零码退出**，不会产出"看起来能装"的包：

| 步 | 动作 | 失败条件 |
|---|---|---|
| 1/4 | 把 harness 检出到**锁定的上游版本**并打补丁（复用 `scripts/apply-upstream-model-catalog.mjs`） | 检出脏、HEAD 不是锁定 commit、补丁打不上 |
| 2/4 | `pnpm install --ignore-scripts` → `pnpm run build`（运行时准备由第 3 步自己完成：`prepare:runtime` / `prepare:packages` / `prepare:dsh`） | 任一命令非零 |
| 3/4 | `pnpm run package:desktop:mac:arm64:unsigned` 出 dmg | 没产出 dmg |
| 4/4 | **挂载 dmg 校验 `app.asar` 里的补丁标记**，通过后复制到输出目录并写 `manifest.json` | 标记缺失 |

先看它会执行什么、但不产生任何副作用：

```bash
node scripts/package-app.mjs --dry-run
```

已有产物、只想复核（可传 `.dmg` / `.app` / `app.asar`）：

```bash
node scripts/package-app.mjs verify --dmg "<dmg 路径>"
npm run verify:app -- "<dmg 路径>"
```

## 2. 判据（为什么不能只看 `storeFor`）

| 标记 | 官方原版 `app.asar` | 打过补丁 |
|---|---|---|
| `OwnerEntry`（补丁独有） | **0** | **9** |
| `storeFor`（上游本来就有） | 17 | 23 |

`storeFor` 在官方包里也存在，所以它**不能**证明补丁在；只有 `OwnerEntry` 能。校验逻辑要求 `OwnerEntry > 0`（并且 `storeFor > 17` 作为加分证据），因此官方包会被拒绝：

```
$ node scripts/package-app.mjs verify --dmg "<官方 0.2.2-rc.5 App>"
  OwnerEntry 0 (MISSING — stock build)
  storeFor   17 (stock has 17)
package-app: this artifact does NOT carry the model-catalogue patch: ...
# exit 1
```

`scripts/preflight.sh` 的 `client model patch` 一项用的也是 `OwnerEntry`，所以启动前也会拦住"装成官方版"这件事。

## 3. 输出

- dmg：`~/Workspace/dsh-app-build/deepseek-harness-<version>-mac-arm64-unsigned.dmg`
- `manifest.json`：版本、上游基线 tag/commit、补丁文件 sha256、两个标记的计数、dmg 的 sha256 与字节数、构建时间

unsigned 包首次打开需要：`xattr -dr com.apple.quarantine "<app>"`，再在「系统设置 → 隐私与安全性」里允许。

## 4. 远端宿主也要同一个补丁

App 修好只解决"本机怎么取目录"；远端 Host 若还是官方包，它会用旧签名回答，远端会话照样问「请选择模型」。所以换宿主机 / 新建 devbox 后，把同一份构建产物里的两个包装上去：

```bash
node scripts/package-app.mjs deploy-remote --ssh <host> --dry-run   # 先看要做什么
node scripts/package-app.mjs deploy-remote --ssh <host>
```

它会：先备份远端 runtime 里的 `dsh-api-session-controller` 与 `dsh-client-ui-model-selection`（带时间戳的 `modelcatalog-backup-*`），再从本地构建产物解包覆盖，最后打印重启命令。回滚就是 `cp -a <backup>/. <runtime>/ && 重启宿主`。

## 5. 升级 DSH 版本时

1. 改 `scripts/apply-upstream-model-catalog.mjs` 里的 `BASE_TAG` / `BASE_COMMIT`，并把 `scripts/patches/modelcatalog.patch` 重新对峙到新版本；
2. `package-app.mjs` **从那个脚本读取锁定版本**，不需要改第二处（避免两处漂移）；
3. `node scripts/package-app.mjs --dry-run` 确认命令序列；
4. 正式打包；
5. `npm run verify:app -- "<新 dmg>"` 复核标记与版本。

## 6. 注意事项

- 构建耗时较长（首次会安装依赖并全量构建）；`--skip-install` 可跳过安装；
- 打包用的 harness 检出会被切到 detached HEAD（锁定 commit），这是故意的：packaging 不接受"随手一个分支"；
- 不要用官方 `pnpm run package:desktop:mac:arm64:unsigned` 直接出包——那条路没有补丁，也没有校验。
