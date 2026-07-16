---
name: smartperfetto-sync-upstream
description: Synchronize the SmartPerfetto fork workflow end to end. Use when asked to update the fork main branch from upstream, merge upstream main into the current work branch, update the perfetto submodule smartperfetto branch to the latest Perfetto release tag, rebuild/refresh frontend prebuilds, generate a versioned frontend/perfetto-smartperfetto-v*.patch, keep .gitmodules changes local-only, commit/tag, and push the root branch, tag, and submodule branch in the correct order.
---

# SmartPerfetto 上游同步

## 目标

按可重复的发布流程同步 SmartPerfetto：

- 根仓库 `main` 从上游 `Gracker/SmartPerfetto` 同步到 fork。
- 当前工作分支从最新 `main` 合入。
- `perfetto` 子模块的 `smartperfetto` 分支同步到最新 Perfetto release tag。
- 刷新 committed `frontend/` 预构建，并生成新的 `frontend/perfetto-smartperfetto-v*.patch`。
- `.gitmodules` 只作为本地修改保留，不提交入库。
- 先推子模块，再推根仓库分支和 tag。

## 必须遵守

- 先读项目根目录 `AGENTS.md`，再执行同步。
- 每一步改动前检查 `git status --short --branch` 和 `git -C perfetto status --short --branch`。
- 不要提交 `.gitmodules`。提交前后都要验证它没有进入 root commit。
- 不要把根仓库 gitlink 推到远端之前，留下不可达的子模块提交。
- 把 `engine_bundle.js`、`trace_processor*.wasm` 和 `manifest.json` 视为同一批构建产物；不要混用不同构建的文件。
- 不要对 `main` 做 `reset --hard` 或强推。`main` 只能 `--ff-only` 同步；失败就停下说明原因。
- rebase 后推 `perfetto/smartperfetto` 时，如果需要重写远端，只能使用 `--force-with-lease`，并先记录远端旧 hash。
- 除非用户明确要求，不执行 `git push`。如果用户要求“同步回远端”或“推送”，按本 skill 的推送顺序执行。

## 变量

先确定这些值，不要假设：

```powershell
$root = "V:\AI\mcps\SmartPerfetto"
$currentBranch = git -C $root branch --show-current
$upstreamRemote = "upstream"
$forkRemote = "origin"
$perfettoBranch = "smartperfetto"
```

确认远端：

```powershell
git -C $root remote -v
git -C "$root\perfetto" remote -v
```

如果根仓库没有上游远端：

```powershell
git -C $root remote add upstream git@github.com:Gracker/SmartPerfetto.git
```

## 1. 同步根仓库 main

```powershell
git -C $root fetch upstream --tags --prune
git -C $root fetch origin --tags --prune

git -C $root switch main
git -C $root status --short --branch
git -C $root merge --ff-only upstream/main
git -C $root push origin main
```

如果 `merge --ff-only` 失败，停止。不要自动改用 merge commit、rebase、reset 或 force push。

## 2. 同步 main 到当前分支

回到用户工作分支，例如 `mcp`：

```powershell
git -C $root switch $currentBranch
git -C $root merge main
```

如果冲突涉及 `.gitmodules`，按本地需要保留工作区内容，但不要暂存它。

## 3. 找到 Perfetto 最新 release tag

```powershell
git -C "$root\perfetto" fetch origin --tags --prune
git -C "$root\perfetto" tag --list "v[0-9]*" --sort=-v:refname | Select-Object -First 20
```

选择最新稳定 release tag，记为 `$newTag`，例如：

```powershell
$newTag = "v57.0"
git -C "$root\perfetto" rev-parse "$newTag^{commit}"
```

从当前已提交 patch 或上一次 release tag 确认旧基线，记为 `$oldTag`，例如：

```powershell
$oldTag = "v56.1"
git -C "$root\perfetto" rev-parse "$oldTag^{commit}"
```

不要凭记忆填写 `$oldTag`。优先从 `frontend/perfetto-smartperfetto-v*.patch`、上一个 `mcp-v*` tag、或 `git -C perfetto log --decorate` 交叉确认。

## 4. 更新 perfetto/smartperfetto

推荐保持 `smartperfetto` 为“上游 release tag + SmartPerfetto patch”的线性形态：

```powershell
git -C "$root\perfetto" switch smartperfetto
$oldRemote = git -C "$root\perfetto" ls-remote --heads origin smartperfetto | ForEach-Object { ($_ -split "\s+")[0] }
git -C "$root\perfetto" rebase --onto "$newTag^{commit}" "$oldTag^{commit}" smartperfetto
```

如果 rebase 冲突太大，改用临时分支重放 patch：

```powershell
git -C "$root\perfetto" switch -c "smartperfetto-$newTag" "$newTag^{commit}"
git -C "$root\perfetto" apply --3way "$root\frontend\perfetto-smartperfetto-$oldTag.patch"
# 解决冲突并测试后：
git -C "$root\perfetto" switch smartperfetto
git -C "$root\perfetto" reset --hard "smartperfetto-$newTag"
```

冲突解决重点保留：

- `ui/src/plugins/com.smartperfetto.AIAssistant/**`
- 插件注册入口和默认插件列表。
- trace 加载、backend upload、request context、HTTP RPC、topbar、timeline route 等 SmartPerfetto 接入点。
- generated frontend contract 类型；必要时从 backend 重新生成。

## 5. 构建并刷新 frontend

如果使用 WSL 构建工作区，先确保 WSL 下的 Perfetto 源码处于同一个 `smartperfetto` commit：

```bash
cd /mnt/wsl/dev/google/perfetto
git fetch /mnt/v/Google/perfetto/perfetto.git smartperfetto
git switch smartperfetto
git reset --hard FETCH_HEAD
```

然后按当前项目支持的 Perfetto UI 构建方式生成 UI 产物。回到根仓库刷新 committed frontend：

```powershell
.\scripts\update-frontend.sh
npm run check:frontend-prebuild
```

如果 `update-frontend.sh` 输出 `Restoring ... from previous build`，立即停止，不要暂存产物；改跑同时生成 classic 与 memory64 glue/WASM 的完整构建。恢复旧 bundle 再搭配新 WASM 会产生 ABI 混配，而 manifest 哈希无法发现它。

刷新后必须在 committed frontend 路径（`./start.sh`，不是 dev server）打开一份真实 trace，确认 timeline 出现，并确认浏览器实际请求 `trace_processor_memory64.wasm`。classic 路径也必须在提交前覆盖：优先用不支持 memory64 的运行时打开 trace；若环境无法提供该运行时，只能在本次没有 engine/native 变更且 `engine_bundle.js`、`trace_processor.wasm` 与同一份已验证预构建逐 blob 相同时，以哈希证据替代并记录。不得静默跳过任一路径。若页面持续加载但没有 timeline，先核对实际请求的 WASM 与 `engine_bundle.js` 构建来源；替换任何 WASM 时必须同步更新 `manifest.json` integrity，再重跑预构建检查。

## 6. 生成新的 patch 到 frontend

默认只保留当前版本 patch。生成新 patch 后，删除旧版本 patch，除非用户明确要求保留历史 patch。

```powershell
$patchPath = "$root\frontend\perfetto-smartperfetto-$newTag.patch"
git -C "$root\perfetto" diff --binary --full-index "$newTag^{commit}..HEAD" --output="$patchPath"
git -C "$root\perfetto" apply --reverse --check "$patchPath"
```

如果只保留最新 patch：

```powershell
Get-ChildItem "$root\frontend" -Filter "perfetto-smartperfetto-v*.patch" |
  Where-Object { $_.FullName -ne $patchPath } |
  Remove-Item
```

## 7. 验证

最小验证：

```powershell
git -C "$root\perfetto" diff --check
git -C $root diff --check
git -C $root diff --cached --check
npm run check:frontend-prebuild

cd "$root\backend"
npm run build
npx jest src/routes/__tests__/mcpWorkspaceAttachment.test.ts src/agentv3/__tests__/standaloneMcpServer.test.ts --runInBand
```

`frontend/v*/` 被 `.gitignore` 忽略。提交前必须显式暂存当前唯一版本目录，避免只提交 `index.html` 或少量手工修复文件：

```powershell
$frontendDirs = @(Get-ChildItem "$root\frontend" -Directory -Filter "v*")
if ($frontendDirs.Count -ne 1) { throw "Expected exactly one frontend/v* directory" }
$frontendDir = "frontend/$($frontendDirs[0].Name)"
git -C $root add -f -- $frontendDir
git -C $root add -A -- frontend
```

若完整 `git diff --check` 只命中预构建目录中的第三方生成文件，不要手改生成物；对其余文件重跑检查并记录例外，生成目录由 `check:frontend-prebuild` 和浏览器 trace smoke 负责验证。

如果同步影响 MCP、agent runtime、trace processor、Skills、Strategies 或分析输出合同，再跑：

```powershell
cd "$root\backend"
npm run test:scene-trace-regression
```

## 8. 提交

先提交子模块：

```powershell
git -C "$root\perfetto" status --short --branch
git -C "$root\perfetto" add <perfetto变更文件>
git -C "$root\perfetto" commit -m "feat: 同步 SmartPerfetto UI 到 $newTag"
```

如果 rebase 已经产生目标提交且没有工作区改动，不要制造空提交。

再提交根仓库，显式排除 `.gitmodules`：

```powershell
git -C $root add perfetto
git -C $root add frontend/index.html
git -C $root add "frontend/perfetto-smartperfetto-$newTag.patch"
git -C $root add -f -- $frontendDir
git -C $root add -A -- frontend
git -C $root restore --staged .gitmodules
git -C $root diff --cached --name-only | Select-String "^\.gitmodules$"
```

上面最后一条必须无输出。然后提交和打 tag：

```powershell
$mcpTag = "mcp-$newTag"
git -C $root commit -m "feat: 发布 $mcpTag 版本"
git -C $root tag -a $mcpTag -m "release: 发布 $mcpTag"
```

提交后继续验证 `.gitmodules` 没有进入提交：

```powershell
git -C $root diff HEAD^ HEAD -- .gitmodules
git -C $root status --short --branch
```

期望：提交 diff 为空；工作区可保留 ` M .gitmodules`。

## 9. 推送

先推子模块。若本次 rebase 重写了 `origin/smartperfetto`，使用带旧 hash 的 lease：

```powershell
if ($oldRemote) {
  git -C "$root\perfetto" push --force-with-lease=smartperfetto:$oldRemote origin smartperfetto
} else {
  git -C "$root\perfetto" push -u origin smartperfetto
}
```

确认子模块提交远端可达：

```powershell
git -C "$root\perfetto" ls-remote --heads origin smartperfetto
git -C "$root\perfetto" rev-parse HEAD
```

再推根仓库分支和 tag：

```powershell
git -C $root push origin $currentBranch
git -C $root push origin $mcpTag
```

最后核对：

```powershell
git -C $root status --short --branch
git -C "$root\perfetto" status --short --branch
git -C $root ls-remote --heads origin $currentBranch
git -C $root ls-remote --tags origin "$mcpTag*"
```

## 完成汇报

汇报必须包含：

- 根仓库分支、commit、tag 和远端 URL。
- `perfetto/smartperfetto` commit 和远端 URL。
- 最新 Perfetto release tag。
- 新 patch 路径，例如 `frontend/perfetto-smartperfetto-v57.0.patch`。
- 验证命令及结果。
- `.gitmodules` 是否只保留为本地未提交修改。
