/**
 * In-memory storage for agent loop detection and circuit breaking.
 * All data structures use Maps for O(1) lookups.
 */

import { createHash } from 'node:crypto';

// Agent configs: agent_id -> { max_iterations, progress_threshold, registered_at }
const agents = new Map();

// Action logs: agent_id -> [{ signature, tool_name, args_hash, result_preview, timestamp }]
const actionLogs = new Map();

// Circuit breaker configs: agent_id -> { max_repeats, action, created_at }
const circuitBreakers = new Map();

const ROLLING_WINDOW = 50;

/**
 * Hash an object deterministically for signature generation.
 */
function hashArgs(args) {
  const sorted = JSON.stringify(args, Object.keys(args || {}).sort());
  return createHash('sha256').update(sorted).digest('hex').slice(0, 12);
}

// ═══════════════════════════════════════════
// AGENT REGISTRATION
// ═══════════════════════════════════════════

export function registerAgent(agentId, config) {
  const entry = {
    agent_id: agentId,
    max_iterations: config.max_iterations ?? 100,
    progress_threshold: config.progress_threshold ?? 0.3,
    registered_at: new Date().toISOString(),
  };
  agents.set(agentId, entry);
  if (!actionLogs.has(agentId)) {
    actionLogs.set(agentId, []);
  }
  return entry;
}

export function getAgent(agentId) {
  return agents.get(agentId) || null;
}

export function listAgents() {
  return [...agents.values()];
}

// ═══════════════════════════════════════════
// ACTION LOGGING
// ═══════════════════════════════════════════

export function logAction(agentId, action) {
  if (!agents.has(agentId)) {
    // Auto-register with defaults
    registerAgent(agentId, {});
  }

  const argsHash = hashArgs(action.args);
  const signature = `${action.tool_name}:${argsHash}`;
  const resultPreview = (action.result_preview || '').slice(0, 200);

  const entry = {
    signature,
    tool_name: action.tool_name,
    args_hash: argsHash,
    result_preview: resultPreview,
    timestamp: new Date().toISOString(),
  };

  const log = actionLogs.get(agentId);
  log.push(entry);

  // Maintain rolling window
  if (log.length > ROLLING_WINDOW) {
    log.splice(0, log.length - ROLLING_WINDOW);
  }

  // Quick warning check on last 10 actions
  const recent = log.slice(-10);
  const sigCounts = {};
  for (const a of recent) {
    sigCounts[a.signature] = (sigCounts[a.signature] || 0) + 1;
  }
  const maxRepeat = Math.max(...Object.values(sigCounts));
  let warning = null;
  if (maxRepeat >= 3) {
    const repeatedSig = Object.entries(sigCounts).find(([, c]) => c >= 3)?.[0];
    warning = `Action "${repeatedSig}" repeated ${maxRepeat} times in last 10 actions — possible loop`;
  }

  return {
    action_logged: true,
    actions_count: log.length,
    warning,
  };
}

// ═══════════════════════════════════════════
// LOOP DETECTION
// ═══════════════════════════════════════════

export function detectLoop(agentId) {
  const config = agents.get(agentId);
  if (!config) {
    return {
      is_stuck: false,
      confidence: 0,
      pattern: 'unknown_agent',
      suggestion: 'Register agent first with register_agent',
      repeated_actions: [],
    };
  }

  const log = actionLogs.get(agentId) || [];
  if (log.length < 3) {
    return {
      is_stuck: false,
      confidence: 0,
      pattern: 'insufficient_data',
      suggestion: 'Not enough actions logged yet (minimum 3)',
      repeated_actions: [],
    };
  }

  // Check last 10 actions for exact repeats
  const recent10 = log.slice(-10);
  const sigCounts10 = {};
  for (const a of recent10) {
    sigCounts10[a.signature] = (sigCounts10[a.signature] || 0) + 1;
  }

  // Check overall uniqueness ratio
  const allSignatures = log.map(a => a.signature);
  const uniqueSignatures = new Set(allSignatures);
  const uniqueRatio = uniqueSignatures.size / allSignatures.length;

  // Find repeated actions (3+)
  const repeated = Object.entries(sigCounts10)
    .filter(([, count]) => count >= 2)
    .map(([signature, count]) => ({ signature, count }))
    .sort((a, b) => b.count - a.count);

  // Determine if stuck
  const maxRepeatIn10 = Math.max(...Object.values(sigCounts10), 0);
  const isStuckHard = maxRepeatIn10 >= 3; // Same action 3+ times in last 10
  const isStuckSoft = uniqueRatio < config.progress_threshold; // Low diversity

  const is_stuck = isStuckHard || isStuckSoft;

  // Confidence score
  let confidence = 0;
  if (isStuckHard) {
    confidence = Math.min(0.5 + (maxRepeatIn10 - 3) * 0.15, 1.0);
  }
  if (isStuckSoft) {
    confidence = Math.max(confidence, 1.0 - uniqueRatio);
  }
  confidence = parseFloat(confidence.toFixed(3));

  // Pattern description
  let pattern;
  if (isStuckHard && isStuckSoft) {
    pattern = 'exact_repeat_and_low_diversity';
  } else if (isStuckHard) {
    pattern = 'exact_repeat';
  } else if (isStuckSoft) {
    pattern = 'low_diversity';
  } else {
    pattern = 'healthy';
  }

  // Suggestion
  let suggestion;
  if (is_stuck) {
    const topRepeated = repeated[0]?.signature || 'unknown';
    const toolName = topRepeated.split(':')[0];
    suggestion = `Agent is repeating "${toolName}" with the same arguments. Try: (1) use different parameters, (2) try an alternative tool, (3) break the task into sub-steps, or (4) abort and report the blocker.`;
  } else {
    suggestion = 'Agent is making progress. No intervention needed.';
  }

  return {
    is_stuck,
    confidence,
    pattern,
    suggestion,
    repeated_actions: repeated,
  };
}

// ═══════════════════════════════════════════
// CIRCUIT BREAKER
// ═══════════════════════════════════════════

export function setCircuitBreaker(agentId, config) {
  const entry = {
    agent_id: agentId,
    max_repeats: config.max_repeats ?? 3,
    action: config.action || 'warn',
    created_at: new Date().toISOString(),
  };
  circuitBreakers.set(agentId, entry);
  return entry;
}

export function checkCircuitBreaker(agentId, proposedTool, proposedArgs) {
  const breaker = circuitBreakers.get(agentId);
  if (!breaker) {
    return {
      proceed: true,
      reason: 'No circuit breaker configured for this agent',
      times_repeated: 0,
      alternative_suggestion: null,
    };
  }

  const log = actionLogs.get(agentId) || [];
  const proposedHash = hashArgs(proposedArgs);
  const proposedSig = `${proposedTool}:${proposedHash}`;

  // Count how many times this exact action has been done
  const timesRepeated = log.filter(a => a.signature === proposedSig).length;

  if (timesRepeated < breaker.max_repeats) {
    return {
      proceed: true,
      reason: `Action seen ${timesRepeated}/${breaker.max_repeats} times — within limit`,
      times_repeated: timesRepeated,
      alternative_suggestion: null,
    };
  }

  // Circuit breaker triggered
  const toolName = proposedTool;
  let reason;
  let alternativeSuggestion;

  switch (breaker.action) {
    case 'block':
      reason = `BLOCKED: "${toolName}" has been called ${timesRepeated} times with identical arguments (limit: ${breaker.max_repeats})`;
      alternativeSuggestion = `Do NOT call ${toolName} again with these arguments. Try a different approach: modify the arguments, use a different tool, or report a blocker.`;
      break;
    case 'suggest_alternative':
      reason = `SUGGEST_ALTERNATIVE: "${toolName}" repeated ${timesRepeated} times — an alternative approach is recommended`;
      alternativeSuggestion = `Consider: (1) changing the input arguments, (2) using a different tool to achieve the same goal, (3) breaking the problem into smaller parts, (4) asking the user for clarification.`;
      break;
    case 'warn':
    default:
      reason = `WARNING: "${toolName}" has been called ${timesRepeated} times with the same arguments — possible infinite loop`;
      alternativeSuggestion = `This action is becoming repetitive. Consider whether you're making progress or stuck in a loop.`;
      break;
  }

  return {
    proceed: breaker.action !== 'block',
    reason,
    times_repeated: timesRepeated,
    alternative_suggestion: alternativeSuggestion,
  };
}

// ═══════════════════════════════════════════
// STUCK REPORT
// ═══════════════════════════════════════════

export function getStuckReport(agentId) {
  const config = agents.get(agentId);
  if (!config) {
    return {
      agent_id: agentId,
      error: 'Agent not registered. Call register_agent first.',
    };
  }

  const log = actionLogs.get(agentId) || [];
  const loopResult = detectLoop(agentId);

  // Compute full signature frequency
  const sigFrequency = {};
  for (const a of log) {
    sigFrequency[a.signature] = (sigFrequency[a.signature] || 0) + 1;
  }

  const uniqueSignatures = Object.keys(sigFrequency).length;
  const totalActions = log.length;
  const diversityRatio = totalActions > 0 ? parseFloat((uniqueSignatures / totalActions).toFixed(3)) : 1;

  // Token waste estimate: assume ~500 tokens per redundant action (conservative)
  const redundantActions = totalActions - uniqueSignatures;
  const estimatedTokenWaste = redundantActions * 500;
  const estimatedCostWaste = parseFloat((estimatedTokenWaste * 0.000003).toFixed(4)); // ~$3/M tokens avg

  // Top repeated patterns
  const topPatterns = Object.entries(sigFrequency)
    .filter(([, count]) => count >= 2)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([signature, count]) => ({ signature, count }));

  // Recommendations
  const recommendations = [];
  if (loopResult.is_stuck) {
    recommendations.push('IMMEDIATE: Agent is stuck. Intervene now.');
  }
  if (diversityRatio < 0.3) {
    recommendations.push('LOW DIVERSITY: Agent is cycling through a small set of actions. Likely needs a fundamentally different approach.');
  }
  if (redundantActions > 10) {
    recommendations.push(`TOKEN WASTE: ~${estimatedTokenWaste.toLocaleString()} tokens wasted on ${redundantActions} redundant actions. Consider adding a circuit breaker.`);
  }
  if (topPatterns.length > 0 && topPatterns[0].count >= 5) {
    const toolName = topPatterns[0].signature.split(':')[0];
    recommendations.push(`HOT LOOP: "${toolName}" called ${topPatterns[0].count} times with same args. This is the primary loop target.`);
  }
  if (recommendations.length === 0) {
    recommendations.push('Agent appears healthy. No intervention needed.');
  }

  // Action timeline (last 20)
  const recentTimeline = log.slice(-20).map(a => ({
    tool: a.tool_name,
    signature: a.signature,
    timestamp: a.timestamp,
    preview: a.result_preview || null,
  }));

  return {
    agent_id: agentId,
    config: {
      max_iterations: config.max_iterations,
      progress_threshold: config.progress_threshold,
    },
    loop_detection: loopResult,
    statistics: {
      total_actions: totalActions,
      unique_signatures: uniqueSignatures,
      diversity_ratio: diversityRatio,
      redundant_actions: redundantActions,
      estimated_token_waste: estimatedTokenWaste,
      estimated_cost_waste_usd: estimatedCostWaste,
    },
    top_repeated_patterns: topPatterns,
    recommendations,
    recent_timeline: recentTimeline,
    circuit_breaker: circuitBreakers.get(agentId) || null,
    generated_at: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════
// HEALTH DASHBOARD
// ═══════════════════════════════════════════

export function getHealthDashboard() {
  const agentList = [];

  for (const [agentId, config] of agents) {
    const log = actionLogs.get(agentId) || [];
    const loopResult = detectLoop(agentId);

    // Risk score: 0 (healthy) to 1 (definitely stuck)
    let riskScore = loopResult.confidence;

    // Boost risk if circuit breaker has been triggered recently
    const breaker = circuitBreakers.get(agentId);

    agentList.push({
      agent_id: agentId,
      status: loopResult.is_stuck ? 'STUCK' : 'HEALTHY',
      risk_score: parseFloat(riskScore.toFixed(3)),
      total_actions: log.length,
      pattern: loopResult.pattern,
      circuit_breaker: breaker ? breaker.action : 'none',
      registered_at: config.registered_at,
      last_action: log.length > 0 ? log[log.length - 1].timestamp : null,
    });
  }

  // Sort by risk score descending
  agentList.sort((a, b) => b.risk_score - a.risk_score);

  const stuckCount = agentList.filter(a => a.status === 'STUCK').length;

  return {
    total_agents: agentList.length,
    stuck_agents: stuckCount,
    healthy_agents: agentList.length - stuckCount,
    agents: agentList,
    generated_at: new Date().toISOString(),
  };
}
