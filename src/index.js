#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  registerAgent,
  logAction,
  detectLoop,
  setCircuitBreaker,
  checkCircuitBreaker,
  getStuckReport,
  getHealthDashboard,
  listAgents,
} from './storage.js';

const server = new McpServer({
  name: 'agent-guard-mcp',
  version: '0.1.0',
  description: 'Detects and prevents infinite agent loops — circuit breakers, pattern detection, and stuck-agent recovery',
});

// ═══════════════════════════════════════════
// AGENT REGISTRATION
// ═══════════════════════════════════════════

server.tool(
  'register_agent',
  'Register an agent for loop monitoring. Configure iteration limits and progress thresholds.',
  {
    agent_id: z.string().describe('Unique identifier for the agent'),
    max_iterations: z.number().int().min(1).default(100).describe('Maximum iterations before forced stop (default 100)'),
    progress_threshold: z.number().min(0).max(1).default(0.3).describe('Minimum ratio of unique/total actions to consider "making progress" (default 0.3)'),
  },
  async (params) => {
    const entry = registerAgent(params.agent_id, {
      max_iterations: params.max_iterations,
      progress_threshold: params.progress_threshold,
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          registered: true,
          agent_id: entry.agent_id,
          max_iterations: entry.max_iterations,
          progress_threshold: entry.progress_threshold,
          registered_at: entry.registered_at,
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// ACTION LOGGING
// ═══════════════════════════════════════════

server.tool(
  'log_action',
  'Log an agent action for loop detection. Maintains a rolling window of the last 50 actions and returns early warnings.',
  {
    agent_id: z.string().describe('Agent identifier'),
    tool_name: z.string().describe('Name of the tool being called'),
    args: z.record(z.any()).describe('Arguments passed to the tool'),
    result_preview: z.string().max(200).default('').describe('Brief preview of the result (max 200 chars)'),
  },
  async (params) => {
    const result = logAction(params.agent_id, {
      tool_name: params.tool_name,
      args: params.args,
      result_preview: params.result_preview,
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// LOOP DETECTION
// ═══════════════════════════════════════════

server.tool(
  'detect_loop',
  'Check if an agent is stuck in an infinite loop. Analyzes action patterns, uniqueness ratio, and repeated signatures.',
  {
    agent_id: z.string().describe('Agent identifier to check'),
  },
  async ({ agent_id }) => {
    const result = detectLoop(agent_id);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// CIRCUIT BREAKER CONFIGURATION
// ═══════════════════════════════════════════

server.tool(
  'set_circuit_breaker',
  'Configure a circuit breaker to auto-terminate or warn when an action pattern repeats too many times.',
  {
    agent_id: z.string().describe('Agent identifier'),
    max_repeats: z.number().int().min(1).default(3).describe('Maximum times an identical action can repeat before triggering (default 3)'),
    action: z.enum(['warn', 'block', 'suggest_alternative']).default('warn').describe('What to do when triggered: warn (allow but warn), block (prevent execution), suggest_alternative (allow but suggest different approach)'),
  },
  async (params) => {
    const entry = setCircuitBreaker(params.agent_id, {
      max_repeats: params.max_repeats,
      action: params.action,
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          circuit_breaker_set: true,
          agent_id: entry.agent_id,
          max_repeats: entry.max_repeats,
          action: entry.action,
          created_at: entry.created_at,
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// CIRCUIT BREAKER CHECK
// ═══════════════════════════════════════════

server.tool(
  'check_circuit_breaker',
  'Check if a proposed action should be allowed or blocked by the circuit breaker. Call this BEFORE executing a tool.',
  {
    agent_id: z.string().describe('Agent identifier'),
    proposed_tool: z.string().describe('Tool name the agent wants to call'),
    proposed_args: z.record(z.any()).describe('Arguments the agent wants to pass'),
  },
  async (params) => {
    const result = checkCircuitBreaker(params.agent_id, params.proposed_tool, params.proposed_args);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// STUCK REPORT
// ═══════════════════════════════════════════

server.tool(
  'get_stuck_report',
  'Get a detailed analysis of why an agent is stuck, including action history, patterns, token waste estimate, and recovery recommendations.',
  {
    agent_id: z.string().describe('Agent identifier to analyze'),
  },
  async ({ agent_id }) => {
    const report = getStuckReport(agent_id);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(report, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// HEALTH DASHBOARD
// ═══════════════════════════════════════════

server.tool(
  'get_health_dashboard',
  'Get an overview of all monitored agents with their current loop risk scores and status.',
  {},
  async () => {
    const dashboard = getHealthDashboard();

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(dashboard, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// RESOURCES
// ═══════════════════════════════════════════

server.resource(
  'agents',
  'agent-guard://agents',
  async () => {
    const allAgents = listAgents();
    const dashboard = getHealthDashboard();

    return {
      contents: [{
        uri: 'agent-guard://agents',
        mimeType: 'application/json',
        text: JSON.stringify({
          agents: dashboard.agents,
          summary: {
            total: dashboard.total_agents,
            stuck: dashboard.stuck_agents,
            healthy: dashboard.healthy_agents,
          },
          generated_at: dashboard.generated_at,
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Agent Guard MCP Server running on stdio');
}

main().catch(console.error);
