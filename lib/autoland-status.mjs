/**
 * Honest auto-land status for the console.
 * Missing companion data stays unreported. Nothing here turns the machine on.
 */

const STATES = new Set([
  'IDLE',
  'ARMED_FOR_APPROACH',
  'APPROACH',
  'FINAL',
  'FLARE',
  'ROLLOUT',
  'ABORT',
]);

export function absentAutolandStatus() {
  return {
    ok: true,
    reported: false,
    enabled: false,
    shadow: null,
    disabled: true,
    labelHe: 'מושבת',
    state: null,
    stateHe: null,
    gates: null,
    commands: null,
    abortReason: null,
    abortReasonHe: null,
    fallbackHe: null,
    commandsSent: null,
    reasonHe: 'אין דיווח מהמחשב המלווה',
  };
}

function gateOrNull(raw) {
  if (!Array.isArray(raw)) return null;
  const gates = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.id !== 'string' || typeof item.ok !== 'boolean') continue;
    gates.push({
      id: item.id,
      ok: item.ok,
      reasonHe: typeof item.reasonHe === 'string' ? item.reasonHe : '',
    });
  }
  return gates;
}

function commandsOrNull(raw) {
  if (!Array.isArray(raw)) return null;
  const commands = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || typeof item.kind !== 'string') continue;
    if (typeof item.sent !== 'boolean') continue;
    commands.push({
      kind: item.kind,
      sent: item.sent,
      reason: typeof item.reason === 'string' ? item.reason : null,
      reasonHe: typeof item.reasonHe === 'string' ? item.reasonHe : '',
      fields: item.fields && typeof item.fields === 'object' ? item.fields : null,
    });
  }
  return commands;
}

export function normalizeAutolandStatus(raw) {
  if (!raw || typeof raw !== 'object' || raw.reported === false) {
    return absentAutolandStatus();
  }
  const enabled = raw.enabled === true;
  const state = typeof raw.state === 'string' && STATES.has(raw.state) ? raw.state : null;
  return {
    ok: true,
    reported: true,
    enabled,
    shadow: raw.shadow === true ? true : raw.shadow === false ? false : null,
    disabled: !enabled,
    labelHe: enabled ? 'פעיל' : 'מושבת',
    state,
    stateHe: state && typeof raw.stateHe === 'string' ? raw.stateHe : null,
    gates: gateOrNull(raw.gates),
    commands: commandsOrNull(raw.commands),
    abortReason: typeof raw.abortReason === 'string' ? raw.abortReason : null,
    abortReasonHe: typeof raw.abortReasonHe === 'string' ? raw.abortReasonHe : null,
    fallbackHe: typeof raw.fallbackHe === 'string' ? raw.fallbackHe : null,
    commandsSent: Number.isFinite(raw.commandsSent) ? raw.commandsSent : null,
    reasonHe: null,
  };
}
