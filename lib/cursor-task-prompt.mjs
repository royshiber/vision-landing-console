const CONSTRAINTS = Object.freeze([
  'Work only inside the assigned development worktree directory.',
  'Do not modify master, main, or any branch outside development/tasks/*.',
  'Do not access /etc, system directories, or paths outside the worktree.',
  'Do not modify flight-controller firmware, UART, MAVLink hardware, or FC configuration.',
  'Do not change network configuration, firewall rules, or SSH settings.',
  'Do not deploy releases, restart Jetson services, or invoke systemd.',
  'Do not read, write, or use secrets, API keys, or credential files.',
  'Do not run maintenance deploy, rollback, or production operations.',
  'Limit actions to approved development coding within this repository worktree.',
]);

export function buildCursorTaskPrompt(task, worktreeCtx) {
  const lines = [
    '# Vision Landing Console — Development Task',
    '',
    '## Task metadata',
    `- Task ID: ${String(task?.id || 'unknown')}`,
    `- Title: ${String(task?.title || '').trim() || '(untitled)'}`,
    `- Description: ${String(task?.description || '').trim() || '(none)'}`,
    `- Notes: ${String(task?.notes || '').trim() || '(none)'}`,
    `- Taxonomy: ${String(task?.taxonomy || 'FEATURE')}`,
    `- Target area: ${String(task?.target_area || 'OTHER')}`,
    `- Priority: ${String(task?.priority || 'NORMAL')}`,
    '',
    '## Repository context',
    `- Branch: ${worktreeCtx.branch}`,
    `- Worktree: ${worktreeCtx.worktree_id}`,
    `- Base commit: ${worktreeCtx.base_commit || '(unknown)'}`,
    '',
    '## Mandatory constraints',
    ...CONSTRAINTS.map((c) => `- ${c}`),
    '',
    '## Objective',
    'Implement the development task described above. Make focused, reviewable changes.',
    'When finished, summarize what changed and any follow-up testing the operator should run.',
  ];
  return lines.join('\n');
}

export { CONSTRAINTS as CURSOR_TASK_PROMPT_CONSTRAINTS };
