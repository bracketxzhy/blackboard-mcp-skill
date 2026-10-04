# Blackboard 

A reusable Codex skill with its own local TypeScript MCP server. Every user logs in to their own Blackboard account in a dedicated Edge window. No credentials, browser sessions, student submissions, grade CSVs, or real student identities are included.

适用于 SCUPI Blackboard，也可显式配置其他 Blackboard Learn HTTPS 站点。不同学校的认证和权限策略可能不同；没有承诺跨学校通用的网页登录 Cookie REST 权限。当前实现支持 Original 课程结构。

## 功能

- 手动登录、重启浏览器后验证 Session、`auth status`、`doctor`。
- 8 个只读 MCP tools：课程、内容、附件、PDF/DOCX 文本、作业、Asia/Shanghai 截止时间。


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
