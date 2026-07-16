# Android Internals 外部知识库

[English](android-internals-knowledge.en.md) | [中文](android-internals-knowledge.md)

SmartPerfetto 可以把本机 `android-internals-wiki` checkout 作为可选、版本化的外部知识源。仓库正文不会被复制进 SmartPerfetto、npm 包、Docker 镜像或公开 Skill；只有管理员显式注册并建立本地索引后，当前请求才可按需检索。

这条链路用于解释 Android 系统背景，不改变证据规则：Wiki 命中不能证明当前 trace 的根因。诊断仍要引用 `execute_sql`、`invoke_skill` 或其他当前 trace 证据。

## 安全与许可边界

- 路径默认拒绝。只有 `SMARTPERFETTO_KNOWLEDGE_ROOTS` 内的 Markdown 可预览和索引。
- `rightsAcknowledged` 是操作者对“有权使用该仓库”的独立确认；它不是许可证授予。当前连接器记录源许可证为 `CC-BY-NC-SA-4.0`，商业使用需要自行取得适用授权。
- `sendToProvider` 是另一个可撤销的隐私同意。设为 `false` 后，新的索引和检索立即 fail closed。
- 每次分析必须在 `options.knowledgeSourceIds` 中显式选择 source id；注册表还会再次检查 tenant/workspace/user scope、权利确认、同意和 active generation。
- 模型只接收经过预算和 secret redaction 的命中片段。SSE 和日志只投影 chunk id、哈希、长度、许可、出处和可信度元数据；普通 `/chunks/:id` 与 `/search` 管理接口完全不返回私有 Wiki chunk。
- 只有严格解析且状态为 `finalized` 或遗留 `verified` 的文章进入检索。`ready-for-review`、draft、废弃、重复和元数据错误文章仍出现在审计中，但不会作为正常解释来源。

## 1. 允许本机路径

源码运行时，在 `backend/.env` 中配置绝对路径：

```bash
SMARTPERFETTO_KNOWLEDGE_ROOTS=/absolute/path/to/android-internals-wiki
```

Docker 需要先只读挂载，再配置容器内路径，例如：

```yaml
services:
  smartperfetto:
    volumes:
      - /host/android-internals-wiki:/knowledge/android-internals-wiki:ro
    environment:
      SMARTPERFETTO_KNOWLEDGE_ROOTS: /knowledge/android-internals-wiki
```

多根目录使用当前平台的 path delimiter（macOS/Linux 为 `:`，Windows 为 `;`）。修改环境变量后重启后端。

## 2. 预览、注册和索引

下列接口位于 `/api/rag`，共享环境要携带 Bearer token，并需要相应的 codebase read/manage 权限。

```bash
# 预览只返回文件/状态计数、revision 和 fingerprint，不返回正文
curl -X POST http://localhost:3000/api/rag/android-internals/preview \
  -H 'Content-Type: application/json' \
  -d '{"rootPath":"/absolute/path/to/android-internals-wiki"}'

# 权利确认和 provider 同意必须分别、显式提供
curl -X POST http://localhost:3000/api/rag/android-internals/sources \
  -H 'Content-Type: application/json' \
  -d '{
    "rootPath":"/absolute/path/to/android-internals-wiki",
    "displayName":"Android Internals Wiki",
    "rightsAcknowledged":true,
    "sendToProvider":true
  }'

# 使用注册响应中的 sourceId
curl -X POST http://localhost:3000/api/rag/android-internals/sources/<sourceId>/reindex
```

重建采用 staging generation：所有 chunk 写入并核对数量后，注册表才原子切换 active generation，再清除同一 source 的旧代际和失败 staging chunk。清理失败不会回滚已经可用的新代次，但响应会把 `cleanup.status` 标成 `failed` 供运维重试。源身份同时记录 Git revision、被接纳正文的 content fingerprint 和 dirty 状态，避免把本地修改伪装成干净 commit。

## 3. 在一次分析中启用

`knowledgeSourceIds` 是逐请求 capability，不会隐式启用所有已注册仓库：

```bash
curl -X POST http://localhost:3000/api/agent/v1/analyze \
  -H 'Content-Type: application/json' \
  -d '{
    "traceId":"trace-id",
    "query":"解释这个 Handler 回调与 MessageQueue 的关系，并区分背景知识和 trace 证据",
    "options":{
      "analysisMode":"full",
      "knowledgeSourceIds":["<sourceId>"]
    }
  }'
```

Full mode 中，agent 通过现有 `lookup_blog_knowledge` 工具选择 `source=android_internals_wiki` 和同一个 `knowledge_source_id`。未提供白名单、scope 不匹配、同意已撤销或没有 active generation 时，工具返回不可用原因，不会退回到未授权内容。

## 4. 审计、撤销与清理

```bash
# 当前 scope 的安全摘要列表
curl http://localhost:3000/api/rag/android-internals/sources

# 每篇文章一行的 disposition；不含正文
curl http://localhost:3000/api/rag/android-internals/sources/<sourceId>/audit

# 立即撤销 provider 发送权限
curl -X PATCH http://localhost:3000/api/rag/android-internals/sources/<sourceId>/consent \
  -H 'Content-Type: application/json' \
  -d '{"sendToProvider":false}'

# 清除该 source 的 active generation 和全部 staged/旧代际 chunk；保留注册项
curl -X DELETE http://localhost:3000/api/rag/android-internals/sources/<sourceId>/index
```

本地 JSON 模式下，索引和注册表位于 SmartPerfetto 后端 data/log 状态目录；enterprise 模式沿用 tenant/workspace scoped knowledge store。两种模式都不会把缓存写进 Git。

## 5. 全库 Skill 覆盖审计

维护者可在不注册、不索引正文的情况下运行离线审计：

```bash
cd backend
npm run knowledge:android-internals:audit -- \
  --repo /absolute/path/to/android-internals-wiki \
  --output /tmp/android-internals-audit.json
```

审计按 `src/**/*.md` 的正式文章规则逐篇计数，并输出以下 disposition：

- `validated_trace_skill`：文章路径、可观察 claim、Skill id 和真实 fixture assertion 全部匹配。
- `candidate_skill_match`：主题与 live Skill metadata 匹配，但还没有真实语义断言。
- `explanation_only` / `non_perfetto`：仅作背景解释或不适合 Perfetto。
- `deferred_missing_schema_or_fixture`：缺少可移植 schema 或 fixture，明确延期。
- `metadata_error` / `duplicate_or_superseded`：不可进入正常检索。

命令行只打印汇总；完整逐篇报告只写到操作者指定的外部路径，不应提交到 SmartPerfetto。
