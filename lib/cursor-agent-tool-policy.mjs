/**
 * Explicit Cursor SDK tool policy for VLC development agents.
 *
 * Shell is NOT globally disallowed because approved repository development
 * requires sandbox-constrained shell for:
 *   - npm / npx scripts within the worktree (e.g. npm test, npm run lint)
 *   - git CLI operations not covered by read-only tools
 *   - node one-off verification commands scoped to the worktree
 *
 * Unrestricted shell is never enabled. sandboxOptions.enabled constrains every
 * shell invocation through the SDK's platform sandbox helper. Only the Linux
 * platform package supports sandboxing, so real agents run inside WSL through
 * the bridge in lib/wsl-cursor-agent-runtime.mjs (established in C9.9-W).
 *
 * `tools` belongs to the top-level agent options, not to `local`: the SDK reads
 * AgentOptions.tools, so nesting it under `local` would silently widen the
 * toolset back to the model default.
 *
 * Names must come from the SDK's tool vocabulary, which rejects unknown names
 * at Agent.create. There is no `write` tool: `edit` covers creating and
 * modifying files, and `shell` is a capability group that also carries shell
 * stdin writes.
 */
export const CURSOR_AGENT_ALLOWED_TOOLS = Object.freeze([
  'read',
  'grep',
  'glob',
  'ls',
  'edit',
  'shell',
]);

export const CURSOR_AGENT_SHELL_REQUIRED_OPERATIONS = Object.freeze([
  'npm test / npm run <script> within worktree',
  'git status / git diff / git add / git commit within worktree branch',
  'node scripts/*.mjs verification commands',
]);

export function buildCursorAgentLocalOptions(absWorktree) {
  return {
    cwd: absWorktree,
    settingSources: [],
    sandboxOptions: { enabled: true },
  };
}

export function buildCursorAgentOptions({ cwd, model, apiKey }) {
  return {
    apiKey,
    model: { id: model },
    tools: [...CURSOR_AGENT_ALLOWED_TOOLS],
    local: buildCursorAgentLocalOptions(cwd),
  };
}

export function describeCursorAgentToolPolicy() {
  return {
    sandboxEnabled: true,
    shellPolicy: 'sandbox-constrained (not unrestricted, not globally disallowed)',
    allowedTools: [...CURSOR_AGENT_ALLOWED_TOOLS],
    shellRequiredFor: [...CURSOR_AGENT_SHELL_REQUIRED_OPERATIONS],
  };
}
