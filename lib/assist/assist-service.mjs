import { randomUUID } from 'crypto';
import { buildAssistContext, summarizeContextForResponse } from './assist-context.mjs';
import { resolveAssistIntent } from './assist-intent-resolver.mjs';
import { getAssistRouteById, isKnownAssistRouteId } from './assist-routes.mjs';
import { ASSIST_ACTION_TYPES, ASSIST_PROHIBITED_ACTIONS, nowIso } from './assist-types.mjs';
import { createAssistPersistence } from './assist-store.mjs';
import {
  ASSIST_HE,
  hebrewUnavailableReason,
  hebrewAgentStateAnswer,
  isTerminalAgentState,
} from './assist-hebrew.mjs';

const PROPOSAL_TTL_MS = 15 * 60 * 1000;

function answerForQuestion(intentResult, ctx) {
  const topic = intentResult.slots?.topic || 'general';
  const ws = ctx.current_workspace;
  const cap = ctx.current_capability;
  const tab = ctx.current_ui_state?.tab;
  const ac = ctx.aircraft_state;

  if (topic === 'gps') {
    if (ac?.gps_ok === true) return 'GPS looks OK in the current aircraft snapshot.';
    if (ac?.gps_ok === false) return 'GPS is reported as not OK in the current aircraft snapshot.';
    return 'I do not have GPS status in the current Assist context. Open Diagnostics / Telemetry to inspect live GPS.';
  }
  if (topic === 'context' || /looking at/.test(String(intentResult.slots?.topic))) {
    return `You are in workspace ${ws}${cap ? ` / capability ${cap}` : ''}${tab ? ` (tab: ${tab})` : ''}.`;
  }
  if (topic === 'evolve') {
    const t = ctx.active_development_task;
    if (t) {
      return [
        'יש משימת פיתוח פעילה.',
        t.title || null,
        t.id,
        t.status || null,
        t.agent_state || null,
      ].filter(Boolean).join('\n');
    }
    return 'אין משימת פיתוח פעילה בהקשר הנוכחי.';
  }
  if (topic === 'vision' || cap === 'vision') {
    if (typeof ac?.vision_confidence === 'number') {
      return `Vision confidence in context: ${ac.vision_confidence}. Assist cannot change vision parameters.`;
    }
    return 'Vision capability is in focus. I do not have live vision metrics in context — open Vision / Diagnostics for live status.';
  }
  if (ac) {
    const bits = [
      ac.connected ? 'connected' : 'not connected',
      ac.flight_mode ? `mode ${ac.flight_mode}` : null,
      typeof ac.armed === 'boolean' ? (ac.armed ? 'armed' : 'disarmed') : null,
    ].filter(Boolean);
    return `Workspace ${ws}. Aircraft snapshot: ${bits.join(', ')}. Ask a more specific question or open Diagnostics.`;
  }
  return `Workspace ${ws}${cap ? `, capability ${cap}` : ''}. No aircraft snapshot was provided. Ask about GPS, vision, or active development for a more specific answer.`;
}

/**
 * In-process Assist service: resolve → propose → confirm → apply safe actions only.
 */
export function createAssistService({
  repoRoot,
  developmentTaskStore = null,
  persistence = null,
  codingAgentProvider = null,
  worktreeManager = null,
  developmentAgentService = null,
} = {}) {
  const store = persistence || createAssistPersistence(repoRoot);
  /** @type {Map<string, object>} */
  const pending = new Map();
  /** Session transcript (short-lived, process memory). */
  const session = { messages: [] };

  function purgeExpired() {
    const now = Date.now();
    for (const [id, p] of pending) {
      if (p.expires_at && Date.parse(p.expires_at) < now) pending.delete(id);
    }
  }

  function enrichFromServer() {
    let active = null;
    let recentReleases = [];
    if (developmentTaskStore) {
      try {
        const tasks = developmentTaskStore.list?.({}) || [];
        active = tasks.find((t) => ['QUEUED', 'IN_PROGRESS', 'WAITING_FOR_REVIEW', 'TESTING'].includes(t.status))
          || tasks.find((t) => t.status === 'DRAFT')
          || null;
        if (active) {
          active = {
            id: active.id,
            title: active.title,
            status: active.status,
            agent_state: active.agent?.state || null,
          };
        }
        recentReleases = tasks
          .filter((t) => t.release?.state && t.release.state !== 'NOT_STARTED')
          .slice(0, 5)
          .map((t) => ({ task_id: t.id, release_state: t.release.state }));
      } catch {
        /* ignore */
      }
    }
    return {
      recent_notes: store.listRecentNotes(5).map((n) => ({
        id: n.id,
        text: n.text?.slice(0, 120),
        created_at: n.created_at,
      })),
      active_development_task: active,
      recent_releases: recentReleases,
      recent_deployments: [],
      available_actions: [...ASSIST_ACTION_TYPES],
      policy_state: {
        flight_actions_allowed: false,
        param_writes_allowed: false,
        deploy_allowed: false,
        agent_autostart_allowed: false,
      },
    };
  }

  function makeProposal(actionType, payload, { requiresConfirmation = true } = {}) {
    if (!ASSIST_ACTION_TYPES.includes(actionType)) {
      throw new Error(`unsafe_action:${actionType}`);
    }
    if (ASSIST_PROHIBITED_ACTIONS.includes(actionType)) {
      throw new Error(`prohibited_action:${actionType}`);
    }
    purgeExpired();
    const id = randomUUID();
    const proposal = {
      id,
      action: actionType,
      payload,
      requires_confirmation: requiresConfirmation,
      created_at: nowIso(),
      expires_at: new Date(Date.now() + PROPOSAL_TTL_MS).toISOString(),
    };
    if (requiresConfirmation) pending.set(id, proposal);
    return proposal;
  }

  function buildResponse({
    answer,
    intent,
    confidence,
    context,
    action_proposal = null,
    requires_confirmation = false,
    next_step = null,
    kind = 'INFORMATION',
  }) {
    return {
      answer,
      intent,
      confidence,
      context_used: summarizeContextForResponse(context),
      action_proposal,
      requires_confirmation,
      next_step,
      kind, // INFORMATION | PROPOSAL | ACTION_REQUIRING_CONFIRMATION
      channel: context.channel || 'text',
      ts: nowIso(),
    };
  }

  async function processInput({ text, channel = 'text', context_snapshot = {} }) {
    const enrichment = enrichFromServer();
    const context = buildAssistContext(
      { ...context_snapshot, channel: channel === 'voice' ? 'voice' : 'text' },
      enrichment,
    );
    const resolved = resolveAssistIntent(text, context);

    session.messages.push({ role: 'user', text: String(text || ''), ts: nowIso(), channel: context.channel });

    if (resolved.prohibited) {
      const resp = buildResponse({
        answer: `That request maps to a prohibited action (${resolved.prohibited_action}). Assist will not propose flight commands, parameter writes, deploy, restart, shell, or agent start.`,
        intent: 'UNRESOLVED',
        confidence: resolved.confidence,
        context,
        next_step: 'Rephrase as a question, note, observation, UI navigation, or development request.',
        kind: 'INFORMATION',
      });
      session.messages.push({ role: 'assist', ...resp });
      return resp;
    }

    if (resolved.intent === 'UI_ACTION' && resolved.slots?.route_id) {
      const route = getAssistRouteById(resolved.slots.route_id);
      if (!route || !isKnownAssistRouteId(route.id)) {
        const resp = buildResponse({
          answer: 'That destination is not a known Assist route.',
          intent: 'UNRESOLVED',
          confidence: 0.2,
          context,
          kind: 'INFORMATION',
        });
        session.messages.push({ role: 'assist', ...resp });
        return resp;
      }
      const proposal = makeProposal('UI_NAVIGATION', {
        route_id: route.id,
        tab: route.tab,
        subtab: route.subtab || null,
        workspace: route.workspace,
        capability: route.capability,
      }, { requiresConfirmation: false });
      const resp = buildResponse({
        answer: `Opening ${route.description}.`,
        intent: 'UI_ACTION',
        confidence: resolved.confidence,
        context,
        action_proposal: proposal,
        requires_confirmation: false,
        next_step: 'Client applies known-route navigation only.',
        kind: 'PROPOSAL',
      });
      session.messages.push({ role: 'assist', ...resp });
      return resp;
    }

    if (resolved.intent === 'QUESTION') {
      const resp = buildResponse({
        answer: answerForQuestion(resolved, context),
        intent: 'QUESTION',
        confidence: resolved.confidence,
        context,
        next_step: null,
        kind: 'INFORMATION',
      });
      session.messages.push({ role: 'assist', ...resp });
      return resp;
    }

    if (resolved.intent === 'NOTE') {
      const proposal = makeProposal('CREATE_NOTE', {
        text: resolved.slots.body,
        context_snapshot: context,
      });
      const resp = buildResponse({
        answer: 'I can save that as a note. Create the note?',
        intent: 'NOTE',
        confidence: resolved.confidence,
        context,
        action_proposal: proposal,
        requires_confirmation: true,
        next_step: 'Confirm to persist the note.',
        kind: 'ACTION_REQUIRING_CONFIRMATION',
      });
      session.messages.push({ role: 'assist', ...resp });
      return resp;
    }

    if (resolved.intent === 'OBSERVATION') {
      const proposal = makeProposal('CREATE_OBSERVATION', {
        text: resolved.slots.body,
        context_snapshot: context,
      });
      const resp = buildResponse({
        answer: 'I captured an observation candidate from the current context. Save this observation?',
        intent: 'OBSERVATION',
        confidence: resolved.confidence,
        context,
        action_proposal: proposal,
        requires_confirmation: true,
        next_step: 'Confirm to persist the observation.',
        kind: 'ACTION_REQUIRING_CONFIRMATION',
      });
      session.messages.push({ role: 'assist', ...resp });
      return resp;
    }

    if (resolved.intent === 'DEVELOPMENT' || resolved.intent === 'REQUEST') {
      const proposal = makeProposal('CREATE_DEVELOPMENT_TASK', {
        title: resolved.slots.title,
        description: resolved.slots.description,
        taxonomy: resolved.slots.taxonomy || 'FEATURE',
        target_area: resolved.slots.target_area || 'OTHER',
        priority: 'NORMAL',
        navigate_after: true,
      });
      const resp = buildResponse({
        answer: ASSIST_HE.developmentProposalAnswer,
        intent: resolved.intent,
        confidence: resolved.confidence,
        context,
        action_proposal: proposal,
        requires_confirmation: true,
        next_step: ASSIST_HE.developmentProposalNextStep,
        kind: 'ACTION_REQUIRING_CONFIRMATION',
      });
      session.messages.push({ role: 'assist', ...resp });
      return resp;
    }

    const resp = buildResponse({
      answer: 'I could not resolve that into a controlled Assist intent. Try a question, note, observation, UI open command, or development request.',
      intent: 'UNRESOLVED',
      confidence: resolved.confidence,
      context,
      next_step: 'Rephrase using a clearer intent.',
      kind: 'INFORMATION',
    });
    session.messages.push({ role: 'assist', ...resp });
    return resp;
  }

  async function confirmProposal({ proposal_id, confirm }) {
    purgeExpired();
    const proposal = pending.get(proposal_id);
    if (!proposal) {
      return {
        ok: false,
        error: 'proposal_not_found_or_expired',
        answer: ASSIST_HE.proposalGone,
      };
    }
    if (!confirm) {
      pending.delete(proposal_id);
      return {
        ok: true,
        cancelled: true,
        answer: ASSIST_HE.cancelled,
        action_proposal: proposal,
      };
    }

    const action = proposal.action;
    if (!ASSIST_ACTION_TYPES.includes(action)) {
      pending.delete(proposal_id);
      return { ok: false, error: 'prohibited_action', answer: 'Action is not allowed.' };
    }

    let result = null;
    if (action === 'CREATE_NOTE') {
      result = { note: store.createNote(proposal.payload) };
    } else if (action === 'CREATE_OBSERVATION') {
      result = { observation: store.createObservation(proposal.payload) };
    } else if (action === 'CREATE_DEVELOPMENT_TASK') {
      if (!developmentTaskStore?.create) {
        return { ok: false, error: 'development_store_unavailable', answer: 'Development task store is unavailable.' };
      }
      const taxonomy = proposal.payload.taxonomy || 'FEATURE';
      const created = developmentTaskStore.create({
        title: proposal.payload.title,
        description: proposal.payload.description || proposal.payload.title,
        target_area: proposal.payload.target_area || 'OTHER',
        priority: proposal.payload.priority || 'NORMAL',
        notes: `Assist taxonomy: ${taxonomy}`,
      });
      result = await runConfirmedDevelopmentTask(created, proposal.payload);
    } else if (action === 'UI_NAVIGATION') {
      result = { navigation: proposal.payload };
    } else {
      pending.delete(proposal_id);
      return { ok: false, error: 'unsupported_action', answer: 'Unsupported action.' };
    }

    pending.delete(proposal_id);
    return {
      ok: true,
      confirmed: true,
      answer: action === 'CREATE_DEVELOPMENT_TASK'
        ? result.answer
        : action === 'CREATE_NOTE'
          ? 'Note saved.'
          : action === 'CREATE_OBSERVATION'
            ? 'Observation saved.'
            : 'Done.',
      result,
      action,
    };
  }

  async function readProviderRuntime() {
    if (!codingAgentProvider || typeof codingAgentProvider.getRuntimeStatus !== 'function') {
      return { ok: false, kind: 'unavailable', reason: 'Development agent unavailable' };
    }
    try {
      const runtime = await codingAgentProvider.getRuntimeStatus();
      if (runtime && typeof runtime === 'object') return runtime;
    } catch (err) {
      return { ok: false, kind: 'unavailable', reason: String(err?.message || 'Development agent unavailable') };
    }
    return { ok: false, kind: 'unavailable', reason: 'Development agent unavailable' };
  }

  function taskSnapshot(task, extra = {}) {
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      agent_state: task.agent?.state || extra.agent_state || 'NOT_STARTED',
      branch: task.agent?.branch || task.branch || task.worktree_meta?.branch || extra.branch || null,
      worktree: task.agent?.worktree || task.worktree || extra.worktree || null,
      last_message: task.agent?.last_message || extra.last_message || null,
      progress: task.agent?.progress ?? extra.progress ?? null,
      pr_url: extra.pr_url || task.agent?.pr_url || null,
    };
  }

  function ensureIsolatedWorktree(taskId) {
    if (!worktreeManager?.create || !worktreeManager?.status) {
      throw new Error('worktree manager required');
    }
    const current = worktreeManager.status(taskId);
    if (current?.exists) {
      if (!String(current.branch || '').startsWith('development/tasks/')) {
        throw new Error('unsafe agent branch target');
      }
      return current;
    }
    const created = worktreeManager.create(taskId);
    if (!String(created.branch || '').startsWith('development/tasks/')) {
      throw new Error('unsafe agent branch target');
    }
    if (typeof developmentTaskStore.setWorktree === 'function') {
      developmentTaskStore.setWorktree(taskId, created);
    }
    return created;
  }

  async function runConfirmedDevelopmentTask(created, payload) {
    const navigation = payload.navigate_after
      ? { route_id: 'evolve', tab: 'development', task_id: created.id }
      : null;
    const base = {
      navigation,
      release_created: false,
      deploy_started: false,
      merged_to_master: false,
      poll_path: `/api/assist/tasks/${encodeURIComponent(created.id)}`,
    };

    let worktree = null;
    try {
      worktree = ensureIsolatedWorktree(created.id);
    } catch (err) {
      const latest = developmentTaskStore.getById(created.id) || created;
      return {
        ...base,
        task: taskSnapshot(latest),
        worktree_created: false,
        agent_started: false,
        agent_runtime: 'UNAVAILABLE',
        agent_unavailable_reason: ASSIST_HE.taskCreatedWorktreeFailed.split('\n')[1] || hebrewUnavailableReason(err?.message),
        connect_available: true,
        worktree_error: String(err?.message || 'worktree create failed'),
        answer: ASSIST_HE.taskCreatedWorktreeFailed,
      };
    }

    const runtime = await readProviderRuntime();
    const ready = runtime?.ok === true;
    if (!ready) {
      const latest = developmentTaskStore.getById(created.id) || created;
      const reason = hebrewUnavailableReason(runtime?.reason || codingAgentProvider?.unavailableReason);
      return {
        ...base,
        task: taskSnapshot(latest, { branch: worktree.branch, worktree: worktree.worktree_id }),
        worktree_created: true,
        worktree: {
          branch: worktree.branch,
          worktree_id: worktree.worktree_id,
        },
        agent_started: false,
        agent_runtime: 'UNAVAILABLE',
        agent_unavailable_reason: reason,
        connect_available: true,
        answer: reason && reason !== ASSIST_HE.agentUnavailable
          ? `${ASSIST_HE.taskCreatedUnavailable}\n${reason}`
          : ASSIST_HE.taskCreatedUnavailable,
      };
    }

    if (!developmentAgentService?.startTaskAgent) {
      const latest = developmentTaskStore.getById(created.id) || created;
      return {
        ...base,
        task: taskSnapshot(latest, { branch: worktree.branch, worktree: worktree.worktree_id }),
        worktree_created: true,
        worktree: {
          branch: worktree.branch,
          worktree_id: worktree.worktree_id,
        },
        agent_started: false,
        agent_runtime: 'UNAVAILABLE',
        agent_unavailable_reason: hebrewUnavailableReason('Development agent unavailable'),
        connect_available: true,
        answer: ASSIST_HE.taskCreatedNoRuntime,
      };
    }

    try {
      const started = await developmentAgentService.startTaskAgent(created.id);
      const agent = started?.agent || started || {};
      const latest = developmentTaskStore.getById(created.id) || started || created;
      const agentState = agent.state || latest.agent?.state || 'RUNNING';
      return {
        ...base,
        task: taskSnapshot(latest, {
          agent_state: agentState,
          branch: agent.branch || worktree.branch,
          worktree: agent.worktree || worktree.worktree_id,
          last_message: agent.last_message,
          progress: agent.progress,
          pr_url: agent.pr_url || null,
        }),
        worktree_created: true,
        worktree: {
          branch: worktree.branch,
          worktree_id: worktree.worktree_id,
        },
        agent_started: true,
        agent_runtime: 'READY',
        agent_unavailable_reason: null,
        connect_available: false,
        answer: agentState === 'QUEUED' ? ASSIST_HE.taskCreatedAgentQueued : ASSIST_HE.taskCreatedAgentRunning,
      };
    } catch (err) {
      const latest = developmentTaskStore.getById(created.id) || created;
      return {
        ...base,
        task: taskSnapshot(latest, { branch: worktree.branch, worktree: worktree.worktree_id }),
        worktree_created: true,
        worktree: {
          branch: worktree.branch,
          worktree_id: worktree.worktree_id,
        },
        agent_started: false,
        agent_runtime: 'READY',
        agent_unavailable_reason: ASSIST_HE.taskCreatedStartFailed.split('\n')[1] || null,
        connect_available: false,
        agent_start_error: String(err?.message || 'agent start failed'),
        answer: ASSIST_HE.taskCreatedStartFailed,
      };
    }
  }

  async function getTaskRunStatus(taskId) {
    const id = String(taskId || '').trim();
    if (!id || !developmentTaskStore?.getById) {
      return { ok: false, error: 'task_not_found', answer: ASSIST_HE.proposalGone };
    }
    const task = developmentTaskStore.getById(id);
    if (!task) {
      return { ok: false, error: 'task_not_found', answer: ASSIST_HE.proposalGone };
    }
    let agent = task.agent || { state: 'NOT_STARTED' };
    let prUrl = agent.pr_url || null;
    if (developmentAgentService?.getTaskAgent && agent.session_id) {
      try {
        agent = await developmentAgentService.getTaskAgent(id);
        prUrl = agent?.pr_url || prUrl;
      } catch {
        /* keep stored snapshot */
      }
    }
    const state = agent.state || 'NOT_STARTED';
    const latest = developmentTaskStore.getById(id) || task;
    return {
      ok: true,
      task_id: latest.id,
      task_status: latest.status,
      agent_state: state,
      last_message: agent.last_message || null,
      progress: agent.progress ?? null,
      branch: agent.branch || latest.branch || latest.worktree_meta?.branch || null,
      worktree: agent.worktree || latest.worktree || null,
      pr_url: prUrl,
      summary: agent.output_excerpt || agent.last_message || null,
      terminal: isTerminalAgentState(state),
      answer: hebrewAgentStateAnswer(state),
    };
  }

  return {
    processInput,
    confirmProposal,
    getTaskRunStatus,
    getSession() {
      return { messages: session.messages.slice(-50) };
    },
    clearSession() {
      session.messages = [];
      return { ok: true };
    },
    /** Test / security helpers */
    _pendingSize: () => pending.size,
    _isActionAllowed: (action) => ASSIST_ACTION_TYPES.includes(action) && !ASSIST_PROHIBITED_ACTIONS.includes(action),
  };
}
