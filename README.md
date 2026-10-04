# Blackboard Course Workflow

A reusable Codex skill with its own local TypeScript MCP server. Every user logs in to their own Blackboard account in a dedicated Edge window. No credentials, browser sessions, student submissions, grade CSVs, or real student identities are included.

适用于 SCUPI Blackboard，也可显式配置其他 Blackboard Learn HTTPS 站点。不同学校的认证和权限策略可能不同；没有承诺跨学校通用的网页登录 Cookie REST 权限。当前实现支持 Original 课程结构。

## 功能

- 手动登录、重启浏览器后验证 Session、`auth status`、`doctor`。
- 8 个只读 MCP tools：课程、内容、附件、PDF/DOCX 文本、作业、Asia/Shanghai 截止时间。
- 经授权的教师/TA 下载：每位学生每份作业只保留最后一次已提交结果。
- 单文件：`HW1-姓名-学号后四位.pdf`；多个文件才建立个人目录。图片保留原始扩展名，附件保留原始字节，并校验 SHA-256。
- 评分能力测试：只用 GET 检查权限，**没有实际写入成绩、上传成绩 CSV 或发布成绩的功能**。

## 安装 skill

```sh
npx skills add https://github.com/bracketxzhy/blackboard-course-workflow --skill blackboard-course-workflow --agent codex
```

可以添加 `--global` 安装到用户级 skills；具体位置由 Skills CLI 显示。也可以 clone 本仓库并把完整目录放到 Codex 的 skills 目录中。

安装后进入 skill 目录，运行：

```sh
npm --prefix assets/server ci
npm --prefix assets/server run typecheck
npm --prefix assets/server run build
npm --prefix assets/server test
node --test scripts/workflow.test.mjs
```

需要 Node.js 22.13+ 和 Microsoft Edge。构建独立于类型检查；生产代码和测试类型分离，strict 模式，无 `skipLibCheck`。

## 用自己的账号登录

PowerShell：

```powershell
$env:BLACKBOARD_BASE_URL = 'https://pibb.scu.edu.cn'
$env:BLACKBOARD_PROFILE_DIR = Join-Path $env:LOCALAPPDATA 'blackboard-course-workflow/pibb.scu.edu.cn/browser-profile'
node assets/server/dist/cli/bb-mcp.js auth login
node assets/server/dist/cli/bb-mcp.js auth status
node assets/server/dist/cli/bb-mcp.js doctor
node scripts/workflow.mjs courses
```

SSO、密码、MFA 和 CAPTCHA 由本人操作。每个人使用自己的本地 profile；不要共享或上传它。默认 profile 与原开发项目的 profile 分开。环境变量需要在每个新终端中设置，或放在 MCP 的 env 配置中。

其他操作系统、MCP client 配置和 8 个 tools 详见 [references/setup.md](references/setup.md)。

## 下载最新提交

从 `courses` 中选择自己的课程 internal ID。下面 `_123_1` 是示例 ID，输出目录必须是新的：

```sh
node scripts/workflow.mjs export-latest --course _123_1 --out ./downloads/export-1
```

父目录会自动创建，目标导出目录必须不存在。若学校明确使用登录账号作为学号，显式添加 `--student-id-source username`，不自动猜测。默认从 `studentId` 读取。姓名顺序可配置 `--name-order family-given` 或 `given-family`。

姓名/学号末四位仅为文件命名所需；不读取完整 roster、联系方式或已得分数。只读取所选最新提交学生的最小身份字段。空的最新提交不会回退到旧提交；文本提交保存为 HTML；损坏的原上传文件原样保留并标注。个人 group submission 布局不支持分组提交，会明确报错。

详见 [references/submissions.md](references/submissions.md)。导出的目录和 manifest 属于学生数据，请保留在本地，不要推送到此仓库。

## 测试评分权限

```sh
node scripts/workflow.mjs grading-check --course _123_1
```

成功只说明文档要求评分权限的只读端点可访问；输出明确包含 `actualGradeWriteVerified: false`。不填写、保存、发布成绩。详见 [references/grading-check.md](references/grading-check.md)。现有只读 MCP 不因这项测试获得写权限。

## 结构

```text
SKILL.md
agents/openai.yaml
references/{setup,submissions,grading-check}.md
scripts/{workflow,workflow.test}.mjs
assets/server/
  src/ cli/ tests/
  package.json package-lock.json
  tsconfig*.json vitest.config.ts
.github/workflows/ci.yml
```

MCP SDK 为官方 `@modelcontextprotocol/server`；stdio 输出不混入日志。API 只提供 GET，课程访问受 membership scope 限制。PDF 文本抽取不包含 OCR。测试全部使用合成 fixtures，不在 CI 中登录 Blackboard。
