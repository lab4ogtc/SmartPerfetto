# RFC-0025 八功能实现 Review Findings

- Review 日期：2026-07-07
- Review 对象：RFC-0025 八份实施方案对应的完整实现（工作区未提交改动：81 个修改文件 + 新增 services/routes/controllers/tests + perfetto 子模块插件改动 + frontend 预构建刷新）
- Review 方式：结合 8 份方案文档逐功能代码审查 + 实测验证。按 `.claude` 规则应做 Codex 独立只读 review，但 Codex MCP 通道连续两次超时（含最简 ping），按 CLAUDE.md 降级规则改为结构化自审，特此注明。
- 结论：**整体质量高**（校验、RBAC、fail-closed、测试覆盖都明显用心），但有 3 个建议修完再合的问题（P1）、6 个应修问题（P2）、若干改进项（P3）。

## 已实测通过的验证

| 验证 | 结果 |
| --- | --- |
| `cd backend && npm run typecheck` | 通过 |
| 新增 service/route/contract 测试（29 + 48 + 11 个用例） | 全部通过 |
| `npx tsx scripts/checkTypesSync.ts`（前端生成类型同步） | 通过 |
| `git diff --check` | 干净 |
| 新增 `.ts` 文件 AGPL SPDX header | 全部齐 |
| `frontend/index.html` → `v57.1-651867f25`，旧 bundle 已删，新 bundle 含新插件代码 | 一致 |
| AnalysisOptions whitelist（无新增 options 字段，不触发断链陷阱） | 无风险 |
| 中英文档（api/cli/configuration/features/multi-trace-result-comparison）已更新 | 已更新 |

尚未跑（建议实现方修完 P1/P2 后跑）：`npm run test:scene-trace-regression`、`npm run verify:pr`、dev 模式浏览器验证 + `./scripts/update-frontend.sh` 重新刷预构建。

---

## P1 — 建议修复后再合入

### P1-1 回执 `qualityGates.finalReportContract` 语义错误（Feature 1）

- 位置：`backend/src/services/analysisReceiptBuilder.ts:247-251`（`finalReportGate`）
- 问题：该 gate 只判断 `reportId/reportUrl` 是否存在就返回 `passed`。仓库里真正的 final report contract gate 是 `assessFinalReportContractCompleteness`（`backend/src/services/finalReportContractGate.ts:62`，已被 `claudeVerifier`、`openAiRuntime`、`finalResultQualityGate` 消费），回执完全没有接入它的结果。
- 触发场景：strategy frontmatter 声明的必需 section 缺失、contract gate 实际 fail，但 HTML 报告照常生成 → 回执与前端 chip 显示「报告 已通过」。审计面（回执的核心卖点）反而给出误导性结论。
- 修复方向（二选一）：
  1. 把 contract gate 的结果（或 `finalResultQualityGate` 产出的状态）传入 `buildAnalysisReceipt`，让 `finalReportContract` 反映真实契约完整性；
  2. 若第一版确实只想表达「报告是否生成」，把字段改名为 `reportGeneration`，避免占用 `finalReportContract` 这个已有明确语义的名字。

### P1-2 前端执行 UI Action 时不校验 traceId（Feature 3）

- 位置：`perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ui_action_proposals.ts`（`executeUiNavigationProposal`）、`ai_panel.ts:3823`（`handleUiActionProposal`）
- 问题：backend sanitizer 只在**生成时刻**用当时的 `currentTraceId` 校验 payload.traceId；前端点击执行时只做 trace bounds 校验，从不比对 `proposal.payload.traceId` 与当前已加载 trace。
- 触发场景：用户在同一面板切换 trace（或经 comparison / 历史会话恢复看到旧消息）后点击旧提案按钮，只要时间戳恰好落在新 trace 的时间范围内，就会静默导航到错误位置。方案 03 的风险清单明确要求 “validate trace id/session id before enabling execution”，当前实现只做了一半。
- 修复方向：`executeUiNavigationProposal` 增加 traceId 比对（proposal.payload.traceId / source 上下文 vs 当前 trace 标识），不匹配时走现有 `showUiActionError` 路径或渲染禁用态。

### P1-3 Batch API 同步阻塞整个 run，且无跨请求全局并发上限（Feature 7）

- 位置：`backend/src/controllers/batchTraceController.ts:114`（`await runBatchSkill(...)` 在 HTTP 请求内跑完全部 trace）、`backend/src/services/batchTrace/batchTraceLimits.ts`
- 问题 A：`POST /api/workspaces/:id/batch-traces` 同步等待整个 batch 完成才返回。100 traces × 每个 trace 加载 + skill 执行，请求可能挂几十分钟；无进度、无取消，中间断连则结果丢失（run 只在完成后才 saveRun）。`BatchTraceRunV1.status` 的 `queued`/`running` 两个值永远不会出现——契约与实现脱节。
- 问题 B：并发限制只在单个 run 内生效（API cap=2），没有任何跨请求的全局限制。并发发 N 个 create 请求 = N×2 个 trace processor 同时工作，直接违反方案 07 的全局约束 “Resource limits must protect the existing interactive UI/backend paths”。
- 修复方向：至少先做 B（进程内全局 batch 信号量 / in-flight run 数上限，超限 429）；A 可以第一版接受「小 batch 同步」，但应写明上限（比如 API 面 maxTraceCount 收紧到 ~20）并在文档标注，或落 store 后异步执行 + `GET /:runId` 轮询（store/status 契约已经具备）。

---

## P2 — 应修

### P2-1 新增用户可见 runtime 文案绕过 localize 规则（横切，违反 `.claude/rules/prompts.md`）

`SMARTPERFETTO_OUTPUT_LANGUAGE` 应控制 runtime 输出语言，`htmlReportGenerator` 的回执 section 也确实用了 `localize(...)`（`htmlReportGenerator.ts:4850`），但以下新增文案全部硬编码单语言，且都会流向用户可见面（SSE、报告、snapshot、CLI 产物）：

| 文件 | 位置 | 语言 |
| --- | --- | --- |
| `backend/src/services/uiActionProposalDeriver.ts` | 168-169, 197-198, 241-242, 257-258（proposal title/reason，会持久化进 snapshot/CLI 产物） | 仅中文 |
| `backend/src/services/traceConfigProposal.ts` | INTENT_RULES rationale、`buildWarnings`、DANGEROUS_OPTION_PATTERNS warning | 仅英文 |
| `backend/src/services/similarity/similarityService.ts` + `similarityMatcher.ts` | limitations 文案 | 仅英文 |
| `backend/src/services/queryReview/sqlReviewIntrospector.ts` | limitations 文案 | 仅英文 |

修复方向：统一走 `localize(...)`（`backend/src/agentv3/outputLanguage.ts`），或让这些 service 接受 outputLanguage 参数；至少 deriver（title/reason 进持久化面）必须处理。

### P2-2 `background_review_agent` 声明了但没有任何 enforcement（Feature 8）

- 位置：`backend/src/services/aiCapabilityPolicy.ts:65`
- 问题：blocked 列表包含 `background_review_agent`，但全仓库没有任何 `assertAiFeatureEnabled('background_review_agent')` 调用点。要么存在后台 LLM 任务路径没被堵上，要么这个 feature 值是死代码。
- 修复方向：确认后台评审/案例演化等路径是否全部经过 `runtimeSelection.createAgentOrchestrator`（那里有 `assertAiFeatureEnabled`，`runtimeSelection.ts:98`）兜底；若是，删掉该枚举值或加注释说明兜底点；若不是，在实际入口补 assert。

### P2-3 回执 `mode` 在 full 模式下恒为 `auto`（Feature 1）

- 位置：`backend/src/services/analysisReceiptBuilder.ts:69-70`
- 问题：`mode` 取自 `quickRun.requestedMode`，full 模式没有 quickRun → `mode` 恒为 `'auto'`、`resolvedMode` 恒为 `'full'`。用户明确请求 `full` 时回执记录失真。
- 修复方向：从 session/options 的 `analysisMode` 传入真实请求值；quickRun 只做 fallback。

### P2-4 Skill Pack manifest 无资产数量上限（Feature 6）

- 位置：`backend/src/services/skillPacks/skillPackManifest.ts`（`parseSkillPackManifest`）
- 问题：单资产有 20MB 上限，但 `assets` 数组长度无上限。数万条目的 manifest 会让 preview 全量 walk + 逐个 sha256，内存/CPU 放大。`runtime:manage` 权限缓解了恶意场景，但失控 pack 也会打挂后端。
- 修复方向：加 `MAX_SKILL_PACK_ASSETS`（如 512）+ 总字节数上限，超限 fail closed。

### P2-5 Skill Pack install 复制时不重新校验 hash（TOCTOU）（Feature 6）

- 位置：`backend/src/services/skillPacks/skillPackInstallService.ts:45-61`（`copyDeclaredAssets`）
- 问题：controller 在 install 时确实重新跑了 preview（服务端校验，客户端无法伪造，这点做得对），但 hash 校验和 `copyFileSync` 之间仍有窗口——preview 通过后、复制前，sourcePath 下的文件可被替换，最终 managed 目录里的内容与记录的 contentHash 不一致。
- 修复方向：复制时边读边算 sha256，不匹配即中止并清理目标目录。窗口小 + admin-only，故列 P2 而非 P1。

### P2-6 三份回执内容不一致且未声明（Feature 1）

- 位置：`backend/src/routes/agentRoutes.ts`（`ensureCompletedAnalysisFinalArtifacts` 内两次 + `ensureCompletedAnalysisResultPayload` 一次）
- 问题：嵌进 HTML 报告的回执没有 `resultSnapshotId`，嵌进 snapshot 的回执也没有自身 snapshot id，只有最终 SSE/status 回执三者齐全。这是先有鸡先有蛋的固有约束，但没有任何注释/文档声明，后续做回执比对或审计工具的人会踩坑。
- 修复方向：在构造点加注释说明差异；可选：报告渲染时对缺失的 outputs 字段标注「见最终回执」。

---

## P3 — 改进项

1. **伪 artifactId**（`uiActionProposalDeriver.ts:53-61`）：`artifactIdForEnvelope` 回退拼 `${source}:${stepId}`，该 id 不存在于 artifact store。前端 `open_evidence_table` 实际按 evidenceRefId 匹配消息所以无害，但 payload.artifactId 语义失真，报告/后续消费方可能误用。建议无真实 artifactId 时省略字段。
2. **capture 建议 durationSeconds 无上限**（`traceConfigProposal.ts:331-337`、`traceCaptureConfig.ts:398`）：`1e9` 秒会产出荒谬的 bufferSizeKb。proposal 虽无副作用，但会被复制执行。建议 clamp + warning（如 >600s）。
3. **英文关键词子串误匹配**（`traceConfigProposal.ts:343-356`）：`includes` 匹配导致 `'gc'` 命中 `'logcat'`、`'mem'` 命中 `'remember'`。英文关键词建议用词边界正则，中文保持子串。
4. **Query review 注入 MCP tool response 的 token 开销**（`claudeMcpServer.ts` 各 `compactQueryReviewForToolResponse` 调用点）：每次 `execute_sql`/`invoke_skill` 响应都携带 reads/filters/outputShape/guardrails/limitations。模型评审自己刚写的 SQL 收益存疑，而这与 token 优化方向（docs/architecture/token-optimization-plan.md）相逆。建议：仅存 artifact/报告面，或加 env 开关，或量化一次实际每轮增量后再定。
5. **Batch workspace traceId 所有权待确认**（`batchTraceRunner.ts:98-104`）：`workspace_trace` 输入直接 `getOrLoadTrace(traceId)`，lease 有 scope 但 load 本身没有 ownership 校验。若 trace id 空间是全局可枚举的，存在跨 workspace 读取；若现有约定就是「trace id 不做 per-workspace ownership」，请在方案 07 文档里明示。
6. **回执 `countConversationContext` 可能双计**（`analysisReceiptBuilder.ts:237-241`）：`quickRun.contextInjected.conversationTurns` 与 `session.conversationSteps.length` 相加，两者可能有重叠来源。确认语义后择一或注明。
7. **回执 claimAudit 混合口径**（`analysisReceiptBuilder.ts:194-209`）：`totalClaims` 用 `claimResults.length || checkedClaimCount` 兜底时，verified/uncertain 仍从空的 claimResults 计数，可能出现 total>0 而各分项全 0。建议同源计数。

---

## 各功能验收概评（给实现方定位用）

| Feature | 概评 | 主要 findings |
| --- | --- | --- |
| 1 Analysis Receipt | 接线全（SSE/report/snapshot/CLI turn/前端 chip），但 gate 语义错 | P1-1, P2-3, P2-6, P3-6, P3-7 |
| 2 Trace Config Proposal | 确定性分类 + 危险选项拦截 + textproto 转义正确；API/CLI/前端三面齐 | P2-1, P3-2, P3-3 |
| 3 UI Action Proposals | sanitizer 白名单严格、derived 优先于模型提案、前端 bounds 校验好 | P1-2, P2-1, P3-1 |
| 4 Similarity MVP | scope 全部服务端来源、db finally close、路径与权威一致、band/limitations 到位 | P2-1 |
| 5 Query Review | 确定性生成、introspector 保守不改写、契约有大小上限、compact 剥离 SQL | P2-1, P3-4 |
| 6 Skill Packs | 校验链最强（穿越/symlink/隐藏文件/可执行扩展/hash/冲突/隔离 registry 全挡）；install 服务端重跑 preview | P2-4, P2-5 |
| 7 Batch | lease 集成 + per-run 上限 + HTML 转义 + API 不收本地路径（CLI 才收）设计对 | P1-3, P3-5 |
| 8 AI Disable | fail-closed 解析、HTTP/CLI/runtime/skill-step/health/doctor/双面板覆盖面广 | P2-2 |

## 修复后的验证要求

按 `.claude/rules/testing.md`：

```bash
cd backend && npm run typecheck
npx jest src/services/__tests__/analysisReceiptBuilder.test.ts src/services/__tests__/uiActionProposal*.test.ts --runInBand
cd backend && npm run test:scene-trace-regression   # 触碰了 MCP/report/session 路径，必跑
```

前端（P1-2 修复涉及插件源码）：dev 模式浏览器验证 → 相关 vitest/typecheck → `./scripts/update-frontend.sh` 刷新预构建后一并提交。

合入前：`npm run verify:pr`。
