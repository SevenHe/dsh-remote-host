# Contributing

## Layout

```
lib/index.js      host half (mount, mux relay, cookie relay, ssh tunnel, orchestrator proxy)
lib/client.js     client half (two-section sidebar, super agent label)
src/shim/*.js     the browser shim's source, one concern per file
lib/shim.js       GENERATED from src/shim — do not edit by hand
scripts/          setup, ssh helper deployment, shim build, manifest/index checks
market/index.json the plugin index others subscribe to from Discover
```

## The loop

```sh
# 1. edit src/shim/*.js (or lib/index.js / lib/client.js)
# 2. regenerate the shim and run the same checks CI runs
node scripts/build-shim.mjs
node scripts/build-shim.mjs --check
node scripts/verify-manifest.mjs
node scripts/verify-index.mjs
node --check lib/index.js && node --check lib/client.js

# 3. verify against a real host before pushing (see "Verifying" below)
git commit -am "fix(scope): what changed"
git push
```

CI runs exactly those checks on every push and pull request, and fails when
`lib/shim.js` does not match `src/shim/*.js`.

## Verifying

There is no unit-test suite: the plugin relays a live protocol, so it is verified
against real hosts. A quick loop that catches most regressions:

1. start a second Harness with a throwaway `DSH_HOME` and a profile that mounts some
   remote host (see README's configuration table);
2. load its page and check `GET /devbox/__dsh_remote_host__/report`: the legs should
   report `open`, `list-merge` should count both sides, and `open-route` should show
   where session/workspace streams were sent;
3. open a remote session and confirm its history renders.

## Rules

* **Never edit `lib/shim.js`.** It is generated; CI rejects a stale build.
* **No credentials or host identities in commits.** No tokens, cookies, internal
  hostnames, real user names, or company addresses. Commit as yourself with a neutral
  address; examples use `devbox.example.com:3080` and `/home/user`.
* **A published index entry is immutable.** New builds get a new commit and a new
  `versions[]` entry; never rewrite an entry someone may already have installed.

## 提交前必做（硬性）

1. 必须跑 `npm run check` 并保持全绿；它包含 `scripts/verify-sensitive.mjs`，任何内网地址、内部产品名、真实用户名、凭据都会让它失败；
2. **文档/示例/测试夹具里禁止**出现真实内网地址、内部产品名、真实个人目录与真实邮箱，一律使用 `docs/sensitive-data.md` 里的占位符（`devbox.example.com:3080`、`/home/<user>`、`/Users/me`、`example.com`）；
3. 从内部系统复制内容前先抽象：不要直接粘贴工单标题、字段值或业务数据。
