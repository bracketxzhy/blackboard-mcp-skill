# Setup and own-account authentication

Run from the installed skill directory. The server is bundled under `assets/server`; no separate repository or developer profile is needed.

```sh
npm --prefix assets/server ci
npm --prefix assets/server run typecheck
npm --prefix assets/server run build
npm --prefix assets/server test
node --test scripts/workflow.test.mjs
```

Use Node.js >=22.13 and Microsoft Edge. The browser channel is `msedge`; install Edge from Microsoft's official distribution if it is absent. Do not use a daily browser profile. The default site is the public SCUPI Blackboard origin `https://pibb.scu.edu.cn`; another institution must explicitly configure its own HTTPS origin.

PowerShell:

```powershell
$env:BLACKBOARD_BASE_URL = 'https://pibb.scu.edu.cn'
$env:BLACKBOARD_PROFILE_DIR = Join-Path $env:LOCALAPPDATA 'blackboard-course-workflow/pibb.scu.edu.cn/browser-profile'
node assets/server/dist/cli/bb-mcp.js auth login
node assets/server/dist/cli/bb-mcp.js auth status
node assets/server/dist/cli/bb-mcp.js doctor
node scripts/workflow.mjs courses
```

POSIX shell:

```sh
export BLACKBOARD_BASE_URL='https://pibb.scu.edu.cn'
export BLACKBOARD_PROFILE_DIR="$HOME/.local/share/blackboard-course-workflow/pibb.scu.edu.cn/browser-profile"
node assets/server/dist/cli/bb-mcp.js auth login
node assets/server/dist/cli/bb-mcp.js auth status
node assets/server/dist/cli/bb-mcp.js doctor
node scripts/workflow.mjs courses
```

Each person uses their own profile and credentials. A profile may contain session cookies; never upload it. Manual login closes the window and checks REST access again after a headless restart with the same browser user agent. Do not concurrently run login, export, or serve against one profile. `auth status`/`doctor` stop if authentication is lost; `serve` can expose tools whose calls return `AuthenticationRequired` until login is completed.

## MCP stdio setup

Use absolute paths from the actual installation. Replace the path fields below with those paths; do not send passwords or tokens through MCP configuration.

```toml
[mcp_servers.blackboard]
command = "node"
args = ["/absolute/path/blackboard-course-workflow/assets/server/dist/cli/bb-mcp.js", "serve"]

[mcp_servers.blackboard.env]
BLACKBOARD_BASE_URL = "https://pibb.scu.edu.cn"
BLACKBOARD_PROFILE_DIR = "/absolute/path/to/your/dedicated/browser-profile"
```

On Windows, use forward slashes or TOML literal strings for paths. `node assets/server/dist/cli/bb-mcp.js serve` is the manual command. stdout is reserved for MCP; logs go to stderr.

Exactly eight tools: `get_my_courses`, `get_course`, `get_course_contents`, `get_course_files`, `read_course_file`, `get_assignments`, `get_assignment`, `get_upcoming_deadlines`. They read course materials, definitions and deadlines; they do not read student grades, roster lists or submissions. Deadlines are UTC plus `Asia/Shanghai` local time. Original-course assignments are supported; Ultra-specific assignment structures are not claimed to be supported.

The extra staff CLI modes are separate from MCP. Select the internal course ID shown by `courses`; permission checks decide whether the account can use them. The same code can be configured for another Blackboard HTTPS origin, but availability depends on that institution's REST and cookie-auth policies. A TA role name alone does not prove permissions.
