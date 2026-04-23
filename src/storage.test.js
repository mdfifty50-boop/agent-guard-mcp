import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerAgent,
  logAction,
  detectLoop,
  setCircuitBreaker,
  checkCircuitBreaker,
  getStuckReport,
  getHealthDashboard,
  getAgent,
  listAgents,
} from './storage.js';

// ═══════════════════════════════════════════
// Note: Because storage uses module-level Maps,
// tests share state. We use unique agent IDs per test.
// ═══════════════════════════════════════════

describe('register_agent', () => {
  it('registers an agent with defaults', () => {
    const result = registerAgent('test-reg-1', {});
    assert.equal(result.agent_id, 'test-reg-1');
    assert.equal(result.max_iterations, 100);
    assert.equal(result.progress_threshold, 0.3);
    assert.ok(result.registered_at);
  });

  it('registers an agent with custom config', () => {
    const result = registerAgent('test-reg-2', {
      max_iterations: 50,
      progress_threshold: 0.5,
    });
    assert.equal(result.max_iterations, 50);
    assert.equal(result.progress_threshold, 0.5);
  });

  it('overwrites existing agent config on re-register', () => {
    registerAgent('test-reg-3', { max_iterations: 10 });
    const result = registerAgent('test-reg-3', { max_iterations: 200 });
    assert.equal(result.max_iterations, 200);
  });
});

describe('log_action', () => {
  it('logs an action and returns count', () => {
    registerAgent('test-log-1', {});
    const result = logAction('test-log-1', {
      tool_name: 'read_file',
      args: { path: '/foo/bar.js' },
      result_preview: 'file contents...',
    });
    assert.equal(result.action_logged, true);
    assert.equal(result.actions_count, 1);
    assert.equal(result.warning, null);
  });

  it('auto-registers agent if not registered', () => {
    const result = logAction('test-log-auto', {
      tool_name: 'search',
      args: { query: 'test' },
    });
    assert.equal(result.action_logged, true);
    const agent = getAgent('test-log-auto');
    assert.ok(agent);
  });

  it('warns when same action repeated 3+ times in 10 actions', () => {
    const agentId = 'test-log-warn';
    registerAgent(agentId, {});

    // Log the same action 3 times
    for (let i = 0; i < 3; i++) {
      logAction(agentId, {
        tool_name: 'bash',
        args: { command: 'npm test' },
      });
    }

    const result = logAction(agentId, {
      tool_name: 'bash',
      args: { command: 'npm test' },
    });
    // The 4th call — the warning should have fired by the 3rd
    assert.ok(result.warning);
    assert.ok(result.warning.includes('bash'));
  });

  it('truncates result_preview to 200 chars', () => {
    registerAgent('test-log-trunc', {});
    const longPreview = 'x'.repeat(500);
    // Should not throw — truncation happens internally
    const result = logAction('test-log-trunc', {
      tool_name: 'read',
      args: {},
      result_preview: longPreview,
    });
    assert.equal(result.action_logged, true);
  });
});

describe('detect_loop', () => {
  it('returns not stuck for healthy agent', () => {
    const agentId = 'test-detect-healthy';
    registerAgent(agentId, {});

    // Log diverse actions
    for (let i = 0; i < 5; i++) {
      logAction(agentId, {
        tool_name: `tool_${i}`,
        args: { id: i },
      });
    }

    const result = detectLoop(agentId);
    assert.equal(result.is_stuck, false);
    assert.equal(result.pattern, 'healthy');
  });

  it('detects exact repeat loop', () => {
    const agentId = 'test-detect-stuck';
    registerAgent(agentId, {});

    // Log the same action 5 times
    for (let i = 0; i < 5; i++) {
      logAction(agentId, {
        tool_name: 'bash',
        args: { command: 'ls /nonexistent' },
      });
    }

    const result = detectLoop(agentId);
    assert.equal(result.is_stuck, true);
    assert.ok(result.confidence > 0.4);
    assert.ok(result.pattern.includes('exact_repeat'));
    assert.ok(result.suggestion.includes('bash'));
    assert.ok(result.repeated_actions.length > 0);
  });

  it('returns insufficient_data for new agent', () => {
    registerAgent('test-detect-new', {});
    const result = detectLoop('test-detect-new');
    assert.equal(result.is_stuck, false);
    assert.equal(result.pattern, 'insufficient_data');
  });

  it('returns unknown_agent for unregistered agent', () => {
    const result = detectLoop('nonexistent-agent-xyz');
    assert.equal(result.is_stuck, false);
    assert.equal(result.pattern, 'unknown_agent');
  });

  it('detects low diversity pattern', () => {
    const agentId = 'test-detect-lowdiv';
    registerAgent(agentId, { progress_threshold: 0.5 });

    // 10 actions but only 2 unique signatures
    for (let i = 0; i < 10; i++) {
      logAction(agentId, {
        tool_name: i % 2 === 0 ? 'read' : 'write',
        args: { file: 'same.txt' },
      });
    }

    const result = detectLoop(agentId);
    // 2/10 = 0.2 which is < 0.5 threshold
    assert.equal(result.is_stuck, true);
    assert.ok(result.pattern.includes('low_diversity'));
  });
});

describe('circuit_breaker', () => {
  it('allows action within repeat limit', () => {
    const agentId = 'test-cb-allow';
    registerAgent(agentId, {});
    setCircuitBreaker(agentId, { max_repeats: 3, action: 'block' });

    // Log 2 identical actions
    logAction(agentId, { tool_name: 'search', args: { q: 'foo' } });
    logAction(agentId, { tool_name: 'search', args: { q: 'foo' } });

    const result = checkCircuitBreaker(agentId, 'search', { q: 'foo' });
    assert.equal(result.proceed, true);
    assert.equal(result.times_repeated, 2);
  });

  it('blocks action exceeding repeat limit', () => {
    const agentId = 'test-cb-block';
    registerAgent(agentId, {});
    setCircuitBreaker(agentId, { max_repeats: 3, action: 'block' });

    // Log 3 identical actions (meets max_repeats)
    for (let i = 0; i < 3; i++) {
      logAction(agentId, { tool_name: 'bash', args: { cmd: 'fail' } });
    }

    const result = checkCircuitBreaker(agentId, 'bash', { cmd: 'fail' });
    assert.equal(result.proceed, false);
    assert.ok(result.reason.includes('BLOCKED'));
    assert.equal(result.times_repeated, 3);
    assert.ok(result.alternative_suggestion);
  });

  it('warns but allows on warn mode', () => {
    const agentId = 'test-cb-warn';
    registerAgent(agentId, {});
    setCircuitBreaker(agentId, { max_repeats: 2, action: 'warn' });

    logAction(agentId, { tool_name: 'fetch', args: { url: 'http://x' } });
    logAction(agentId, { tool_name: 'fetch', args: { url: 'http://x' } });

    const result = checkCircuitBreaker(agentId, 'fetch', { url: 'http://x' });
    assert.equal(result.proceed, true);
    assert.ok(result.reason.includes('WARNING'));
  });

  it('returns proceed=true when no breaker configured', () => {
    const result = checkCircuitBreaker('no-breaker-agent', 'tool', {});
    assert.equal(result.proceed, true);
  });
});

describe('get_stuck_report', () => {
  it('returns error for unregistered agent', () => {
    const report = getStuckReport('totally-unknown');
    assert.ok(report.error);
  });

  it('returns full report for registered agent with actions', () => {
    const agentId = 'test-report-1';
    registerAgent(agentId, { max_iterations: 50 });

    for (let i = 0; i < 8; i++) {
      logAction(agentId, {
        tool_name: 'read_file',
        args: { path: '/same/file.txt' },
        result_preview: 'same content',
      });
    }
    logAction(agentId, {
      tool_name: 'write_file',
      args: { path: '/out.txt', content: 'hello' },
    });

    const report = getStuckReport(agentId);
    assert.equal(report.agent_id, agentId);
    assert.ok(report.config);
    assert.ok(report.loop_detection);
    assert.ok(report.statistics);
    assert.ok(report.statistics.total_actions >= 9);
    assert.ok(report.statistics.redundant_actions > 0);
    assert.ok(report.statistics.estimated_token_waste > 0);
    assert.ok(report.top_repeated_patterns.length > 0);
    assert.ok(report.recommendations.length > 0);
    assert.ok(report.recent_timeline.length > 0);
    assert.ok(report.generated_at);
  });
});

describe('get_health_dashboard', () => {
  it('returns dashboard with all registered agents', () => {
    const dashboard = getHealthDashboard();
    assert.ok(dashboard.total_agents > 0);
    assert.ok(typeof dashboard.stuck_agents === 'number');
    assert.ok(typeof dashboard.healthy_agents === 'number');
    assert.ok(Array.isArray(dashboard.agents));
    assert.ok(dashboard.generated_at);

    // Check agent structure
    const agent = dashboard.agents[0];
    assert.ok(agent.agent_id);
    assert.ok(['STUCK', 'HEALTHY'].includes(agent.status));
    assert.ok(typeof agent.risk_score === 'number');
    assert.ok(typeof agent.total_actions === 'number');
  });

  it('sorts agents by risk score descending', () => {
    const dashboard = getHealthDashboard();
    for (let i = 1; i < dashboard.agents.length; i++) {
      assert.ok(dashboard.agents[i - 1].risk_score >= dashboard.agents[i].risk_score);
    }
  });
});
