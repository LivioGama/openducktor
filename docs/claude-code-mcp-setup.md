# Claude Code MCP Configuration

## Project-Level MCP Configuration

OpenDucktor includes project-level MCP configuration for Claude Code in `.mcp.json` at the project root.

## Configuration File

The `.mcp.json` file configures the OpenDucktor MCP server for Claude Code:

```json
{
  "mcpServers": {
    "openducktor": {
      "command": "bunx",
      "args": [
        "@openducktor/mcp"
      ]
    }
  }
}
```

## How It Works

1. **Project Scope**: The configuration is project-scoped, meaning it only applies when working in this repository
2. **Auto-Discovery**: The MCP server automatically discovers the running OpenDucktor host bridge from `~/.openducktor/runtime/mcp-bridge-ports.json`
3. **Health Checks**: The MCP server performs health checks on discovered host bridges before connecting
4. **No Workspace Required**: The MCP server can start without a default workspace; workspace-scoped tools require explicit `workspaceId` in tool calls

## MCP Scopes in Claude Code

Claude Code supports multiple MCP configuration scopes:

1. **Local Scope** (`~/.claude.json`): User's local configuration
2. **Project Scope** (`.mcp.json`): Project-specific configuration (current setup)
3. **User Scope** (`~/.claude.json`): User-level configuration shared across projects

Project scope takes precedence over user scope but is overridden by local scope.

## Available MCP Tools

### Public Tools
- `odt_get_workspaces`: List workspaces known to the OpenDucktor host
- `odt_create_task`: Create new tasks, features, or bugs
- `odt_search_tasks`: Search active tasks with filters
- `odt_read_task`: Read task summary and state
- `odt_read_task_documents`: Read spec, plan, and QA report documents

### Internal Workflow Tools
- `odt_set_spec`: Set task specification
- `odt_set_plan`: Set implementation plan
- `odt_build_blocked`: Mark build as blocked
- `odt_build_resumed`: Resume build
- `odt_build_completed`: Mark build as completed
- `odt_set_pull_request`: Set pull request information
- `odt_qa_approved`: Approve QA
- `odt_qa_rejected`: Reject QA

## Usage

When Claude Code is opened in this repository, it will automatically load the OpenDucktor MCP server and provide access to the task management tools.

For more details on MCP usage, see [external-mcp.md](external-mcp.md).
