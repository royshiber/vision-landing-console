import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createAssistService } from '../lib/assist/assist-service.mjs';
import { createAssistPersistence } from '../lib/assist/assist-store.mjs';
import { resolveAssistIntent } from '../lib/assist/assist-intent-resolver.mjs';
import { ASSIST_HE } from '../lib/assist/assist-hebrew.mjs';
import { ASSIST_ACTION_TYPES, ASSIST_PROHIBITED_ACTIONS } from '../lib/assist/assist-types.mjs';
import {
  ASK_VOICE_FLIGHT_CONFIRM_ALWAYS,
  isAskBlockedParamKey,
  isAskConfirmPhrase,
  askRequiresConfirmation,
} from '../lib/assist/ask-safety.mjs';
import { parseAskParamProposal, resolveAskFlightIntent } from '../lib/assist/ask-flight-intents.mjs';
import { suggestAskFromContext } from '../lib/assist/ask-suggestions.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

function makeAssist({ applyParamChange } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-ask-flight-'));
  const apply = applyParamChange || vi.fn(async ({ key, value }) => ({
    ok: true,
    applied: { key, value },
    method: 'offline',
    note: 'FC לא מחובר — הפרמטר לא נשלח למטוס',
  }));
  const service = createAssistService({
    repoRoot: root,
    persistence: createAssistPersistence(root),
    applyParamChange: apply,
  });
  return { root, service, apply };
}

describe('Ask early-flight safety lock', () => {
  it('keeps ask_voice_flight_confirm_always on', () => {
    expect(ASK_VOICE_FLIGHT_CONFIRM_ALWAYS).toBe(true);
    expect(askRequiresConfirmation('PROPOSE_PARAM_CHANGE', false)).toBe(true);
    expect(isAskConfirmPhrase('מאשר')).toBe(true);
    expect(isAskConfirmPhrase('confirm')).toBe(true);
    expect(isAskBlockedParamKey('GPS_TYPE')).toBe(true);
    expect(isAskBlockedParamKey('EK3_SRC1_POSXY')).toBe(true);
    expect(isAskBlockedParamKey('LAND_SPEED')).toBe(false);
  });

  it('never allows prohibited actions on the service allow-list', () => {
    const { root, service } = makeAssist();
    try {
      for (const a of ASSIST_PROHIBITED_ACTIONS) {
        expect(service._isActionAllowed(a)).toBe(false);
      }
      expect(ASSIST_ACTION_TYPES).toContain('PROPOSE_PARAM_CHANGE');
      expect(ASSIST_PROHIBITED_ACTIONS).toContain('PARAM_WRITE');
      expect(ASSIST_PROHIBITED_ACTIONS).toContain('ARM');
      expect(ASSIST_PROHIBITED_ACTIONS).toContain('LANDING_COMMAND');
      expect(service._isActionAllowed('PROPOSE_PARAM_CHANGE')).toBe(true);
      expect(service._isActionAllowed('PARAM_WRITE')).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Ask flight-intent detection', () => {
  it('parses Hebrew and English safe param sets', () => {
    expect(parseAskParamProposal('set LAND_SPEED to 80')).toEqual({ key: 'LAND_SPEED', value: 80 });
    expect(parseAskParamProposal('שנה LAND_SPEED ל-80')).toEqual({ key: 'LAND_SPEED', value: 80 });
    expect(parseAskParamProposal('Change param LAND_FLARE_ALT to 12')).toEqual({
      key: 'LAND_FLARE_ALT',
      value: 12,
    });
  });

  it('blocks ARM / LAND / RTL / auto-land / nav switch', () => {
    expect(resolveAskFlightIntent('Please arm the aircraft').blocked_kind).toBe('ARM');
    expect(resolveAskFlightIntent('חמש את המטוס').blocked_kind).toBe('ARM');
    expect(resolveAskFlightIntent('land now').blocked_kind).toBe('LANDING_COMMAND');
    expect(resolveAskFlightIntent('נחיתה אוטומטית').blocked_kind).toBe('LANDING_COMMAND');
    expect(resolveAskFlightIntent('RTL').blocked_kind).toBe('LANDING_COMMAND');
    expect(resolveAskFlightIntent('החלף מקור ניווט').blocked_kind).toBe('NAV_SOURCE_SWITCH');
    expect(resolveAssistIntent('set GPS_TYPE to 2').blocked).toBe(true);
    expect(resolveAssistIntent('set EK3_SRC1_POSXY to 5').blocked).toBe(true);
  });
});

describe('Ask propose + confirm', () => {
  let root;
  let service;
  let apply;

  beforeEach(() => {
    ({ root, service, apply } = makeAssist());
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('requires confirm before any param apply', async () => {
    const resp = await service.processInput({ text: 'set LAND_SPEED to 80' });
    expect(resp.intent).toBe('FLIGHT_PARAM');
    expect(resp.requires_confirmation).toBe(true);
    expect(resp.kind).toBe('ACTION_REQUIRING_CONFIRMATION');
    expect(resp.action_proposal.action).toBe('PROPOSE_PARAM_CHANGE');
    expect(resp.action_proposal.requires_confirmation).toBe(true);
    expect(resp.answer).toMatch(/אישור מפורש/);
    expect(resp.answer).toMatch(/מאשר/);
    expect(apply).not.toHaveBeenCalled();

    const cancelled = await service.confirmProposal({
      proposal_id: resp.action_proposal.id,
      confirm: false,
    });
    expect(cancelled.cancelled).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });

  it('applies a param proposal only after explicit confirm', async () => {
    const resp = await service.processInput({ text: 'שנה LAND_SPEED ל-80' });
    expect(apply).not.toHaveBeenCalled();
    const confirmed = await service.confirmProposal({
      proposal_id: resp.action_proposal.id,
      confirm: true,
    });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.action).toBe('PROPOSE_PARAM_CHANGE');
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0].key).toBe('LAND_SPEED');
    expect(apply.mock.calls[0][0].value).toBe(80);
    expect(confirmed.answer).toMatch(/לא נשלח למטוס|אושר/);
  });

  it('accepts the voice confirm phrase for the pending proposal', async () => {
    await service.processInput({ text: 'set LAND_SPEED to 80' });
    expect(apply).not.toHaveBeenCalled();
    const spoken = await service.processInput({ text: 'מאשר', channel: 'voice' });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(spoken.confirm_result.ok).toBe(true);
    expect(spoken.answer).toMatch(/אושר|לא נשלח/);
  });

  it('never calls apply for ARM or LAND intents', async () => {
    const arm = await service.processInput({ text: 'Please arm the aircraft' });
    expect(arm.blocked).toBe(true);
    expect(arm.action_proposal).toBe(null);
    expect(arm.answer).toBe(ASSIST_HE.blockedFlightCommandAnswer);
    expect(arm.answer).toMatch(/שער אדם/);
    expect(arm.answer).toMatch(/לא בטיסות ראשונות/);

    const land = await service.processInput({ text: 'auto land now' });
    expect(land.blocked).toBe(true);
    expect(land.action_proposal).toBe(null);
    expect(land.answer).toBe(ASSIST_HE.blockedFlightCommandAnswer);

    const rtl = await service.processInput({ text: 'RTL' });
    expect(rtl.blocked).toBe(true);

    const nav = await service.processInput({ text: 'החלף מקור ניווט' });
    expect(nav.blocked).toBe(true);
    expect(nav.answer).toBe(ASSIST_HE.blockedNavSwitchAnswer);

    expect(apply).not.toHaveBeenCalled();
    expect(service._pendingSize()).toBe(0);
  });
});

describe('Ask real-time suggestions', () => {
  it('stays quiet by default', () => {
    const suggestion = suggestAskFromContext({
      aircraft_state: { connected: false },
    }, { policyLevel: 'off', problemRaised: false });
    expect(suggestion).toBe(null);
  });

  it('offers one Hebrew suggestion when a problem is raised', () => {
    const suggestion = suggestAskFromContext({
      aircraft_state: { connected: false },
    }, { policyLevel: 'off', problemRaised: true });
    expect(suggestion.text_he).toMatch(/אינו מחובר/);
    expect(suggestion.action).toBe('UI_NAVIGATION');
    expect(suggestion.writes_fc).toBe(false);
    expect(suggestion.text_he).not.toMatch(/\d+\.\d+/);
  });

  it('surfaces missing alt / camera / recording / optical without inventing numbers', () => {
    expect(suggestAskFromContext({
      aircraft_state: { connected: true },
    }, { policyLevel: 'attention' }).text_he).toMatch(/אין גובה/);

    expect(suggestAskFromContext({
      aircraft_state: { connected: true, altitude_m: 12 },
      ops_signals: { camera_ok: false },
    }, { policyLevel: 'critical' }).text_he).toMatch(/מצלמה/);

    expect(suggestAskFromContext({
      aircraft_state: { connected: true, altitude_m: 12 },
      ops_signals: { recording_on: false },
    }, { policyLevel: 'attention' }).text_he).toMatch(/הקלטה/);

    expect(suggestAskFromContext({
      aircraft_state: { connected: true, altitude_m: 12 },
      ops_signals: { optical_missing: true },
    }, { policyLevel: 'attention' }).text_he).toMatch(/אופטי/);
  });
});

describe('Ask rail confirm chrome', () => {
  it('makes confirm versus cancel obvious and keeps the voice phrase', () => {
    expect(html).toContain('id="assistProposalKicker"');
    expect(html).toContain('שינוי דורש אישור');
    expect(html).toContain('id="assistProposalVoiceHint"');
    expect(html).toContain('אמרו מאשר או לחצו אישור.');
    expect(html).toContain('id="assistConfirmBtn"');
    expect(html).toContain('id="assistCancelBtn"');
    expect(html).toContain('id="assistSuggestionApproveBtn"');
    expect(html).toContain('id="assistSuggestionDismissBtn"');
    expect(js).toContain('function assistIsConfirmPhrase(');
    expect(js).toContain('ask_voice_flight_confirm_always');
  });
});
