# agent-guard-mcp

MCP server that detects and prevents infinite agent loops — the #1 reliability problem in agentic systems.

Provides circuit breakers, pattern detection, stuck-agent analysis, and recovery recommendations via the Model Context Protocol.

## Install

```bash
npx agent-guard-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agent-guard": {
      "command": "npx",
      "args": ["agent-guard-mcp"]
    }
  }
}
```

### From source

```bash
git clone https://github.com/mdfifty50-boop/agent-guard-mcp.git
cd agent-guard-mcp
npm install
node src/index.js
```

## Tools

### register_agent

Register an agent for monitoring.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `agent_id` | string | required | Unique agent identifier |
| `max_iterations` | number | 100 | Max iterations before forced stop |
| `progress_threshold` | number | 0.3 | Min unique/total action ratio to be "making progress" |

### log_action

Log an agent action for loop detection. Maintains a rolling window of the last 50 actions.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `agent_id` | string | required | Agent identifier |
| `tool_name` | string | required | Tool being called |
| `args` | object | required | Arguments passed |
| `result_preview` | string | `""` | Brief result preview (max 200 chars) |

Returns early warnings when repeated patterns are detected.

### detect_loop

Check if an agent is stuck in an infinite loop.

| Param | Type | Description |
|-------|------|-------------|
| `agent_id` | string | Agent to check |

Returns:
- `is_stuck` — boolean
- `confidence` — 0.0 to 1.0
- `pattern` — `healthy`, `exact_repeat`, `low_diversity`, or `exact_repeat_and_low_diversity`
- `suggestion` — human-readable recovery advice
- `repeated_actions` — list of repeated signatures with counts

### set_circuit_breaker

Configure automatic intervention when action patterns repeat.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `agent_id` | string | required | Agent identifier |
| `max_repeats` | number | 3 | Trigger after N identical actions |
| `action` | string | `"warn"` | `"warn"`, `"block"`, or `"suggest_alternative"` |

### check_circuit_breaker

Pre-flight check before executing a tool. Call this BEFORE the actual tool call.

| Param | Type | Description |
|-------|------|-------------|
| `agent_id` | string | Agent identifier |
| `proposed_tool` | string | Tool about to be called |
| `proposed_args` | object | Arguments about to be passed |

Returns `proceed: false` when the circuit breaker fires (block mode only).

### get_stuck_report

Detailed analysis of why an agent is stuck.

| Param | Type | Description |
|-------|------|-------------|
| `agent_id` | string | Agent to analyze |

Returns: action history, pattern analysis, token waste estimate, diversity ratio, top repeated patterns, and recovery recommendations.

### get_health_dashboard

Overview of all monitored agents. No parameters.

Returns all agents sorted by risk score with their status (STUCK/HEALTHY), action counts, and circuit breaker config.

## Resources

| URI | Description |
|-----|-------------|
| `agent-guard://agents` | All monitored agents with current status |

## Usage Pattern

```
1. register_agent — at agent startup
2. Before each tool call:
   a. check_circuit_breaker — should this action proceed?
   b. Execute the tool
   c. log_action — record what happened
3. Periodically:
   - detect_loop — am I stuck?
   - get_health_dashboard — how are all agents doing?
4. On stuck detection:
   - get_stuck_report — what went wrong and how to recover
```

## Tests

```bash
npm test
```

## License

MIT
