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
  ASK_VOICE_SAFETY_LOCK,
  isAskBlockedParamKey,
  isAskConfirmPhrase,
  isAskGoEnablePhrase,
  isAskGoDisablePhrase,
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
  it('pins APP_VERSION at 1.02.307', () => {
    const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(version).toContain("export const APP_VERSION = '1.02.307'");
    expect(pkg.version).toBe('1.02.307');
  });

  it('locks voice_direct_after_go and gates confirm on session GO', () => {
    expect(ASK_VOICE_SAFETY_LOCK).toBe('voice_direct_after_go');
    expect(askRequiresConfirmation('PROPOSE_PARAM_CHANGE', false, false)).toBe(true);
    expect(askRequiresConfirmation('PROPOSE_PARAM_CHANGE', false, true)).toBe(false);
    expect(askRequiresConfirmation('CREATE_NOTE', true, true)).toBe(true);
    expect(isAskConfirmPhrase('מאשר')).toBe(true);
    expect(isAskConfirmPhrase('confirm')).toBe(true);
    expect(isAskGoEnablePhrase('GO')).toBe(true);
    expect(isAskGoEnablePhrase('יאללה')).toBe(true);
    expect(isAskGoEnablePhrase('אשר GO')).toBe(true);
    expect(isAskGoDisablePhrase('סיום GO')).toBe(true);
    expect(isAskGoDisablePhrase('בטל GO')).toBe(true);
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

  it('requires confirm before any param apply when GO is off', async () => {
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

  it('applies a safe param without confirm after session GO', async () => {
    expect(service.isAskVoiceGoActive()).toBe(false);
    service.setAskVoiceGo(true);
    expect(service.isAskVoiceGoActive()).toBe(true);
    const resp = await service.processInput({ text: 'set LAND_SPEED to 80' });
    expect(resp.intent).toBe('FLIGHT_PARAM');
    expect(resp.requires_confirmation).toBe(false);
    expect(resp.applied_direct).toBe(true);
    expect(resp.action_proposal).toBe(null);
    expect(resp.ask_voice_go_active).toBe(true);
    expect(resp.ask_voice_safety_lock).toBe('voice_direct_after_go');
    expect(resp.answer).toMatch(/הוחל|לא נשלח/);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0].key).toBe('LAND_SPEED');
    expect(apply.mock.calls[0][0].value).toBe(80);
    expect(service._pendingSize()).toBe(0);
  });

  it('returns to confirm-required after ending GO', async () => {
    service.setAskVoiceGo(true);
    service.setAskVoiceGo(false);
    const resp = await service.processInput({ text: 'set LAND_SPEED to 80' });
    expect(resp.requires_confirmation).toBe(true);
    expect(resp.kind).toBe('ACTION_REQUIRING_CONFIRMATION');
    expect(apply).not.toHaveBeenCalled();
  });

  it('enables and ends GO from spoken phrases', async () => {
    const on = await service.processInput({ text: 'יאללה', channel: 'voice' });
    expect(on.ask_voice_go_active).toBe(true);
    expect(on.voice_go.active).toBe(true);
    expect(on.answer).toMatch(/הופעל/);
    expect(service.isAskVoiceGoActive()).toBe(true);

    const off = await service.processInput({ text: 'סיום GO', channel: 'voice' });
    expect(off.ask_voice_go_active).toBe(false);
    expect(off.voice_go.active).toBe(false);
    expect(off.answer).toMatch(/כבוי/);
  });

  it('does not honor a client snapshot that claims GO is on', async () => {
    const resp = await service.processInput({
      text: 'set LAND_SPEED to 80',
      context_snapshot: { askVoiceGoActive: true, ask_voice_go_active: true },
    });
    expect(resp.requires_confirmation).toBe(true);
    expect(apply).not.toHaveBeenCalled();
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

  it('never applies ARM / LAND / nav-blocked params even after GO', async () => {
    service.setAskVoiceGo(true);
    const arm = await service.processInput({ text: 'Please arm the aircraft' });
    expect(arm.blocked).toBe(true);
    expect(arm.answer).toBe(ASSIST_HE.blockedFlightCommandAnswer);

    const land = await service.processInput({ text: 'auto land now' });
    expect(land.blocked).toBe(true);
    expect(land.answer).toBe(ASSIST_HE.blockedFlightCommandAnswer);

    const nav = await service.processInput({ text: 'set GPS_TYPE to 2' });
    expect(nav.blocked).toBe(true);
    expect(nav.answer).toBe(ASSIST_HE.blockedNavSwitchAnswer);

    const ekf = await service.processInput({ text: 'set EK3_SRC1_POSXY to 5' });
    expect(ekf.blocked).toBe(true);

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
  it('makes confirm versus cancel obvious and shows session GO controls', () => {
    expect(html).toContain('id="assistProposalKicker"');
    expect(html).toContain('שינוי דורש אישור');
    expect(html).toContain('id="assistProposalVoiceHint"');
    expect(html).toContain('אמרו מאשר או לחצו אישור.');
    expect(html).toContain('id="assistConfirmBtn"');
    expect(html).toContain('id="assistCancelBtn"');
    expect(html).toContain('id="assistSuggestionApproveBtn"');
    expect(html).toContain('id="assistSuggestionDismissBtn"');
    expect(html).toContain('id="assistVoiceGo"');
    expect(html).toContain('id="assistVoiceGoBtn"');
    expect(html).toContain('id="assistVoiceGoEndBtn"');
    expect(html).toContain('סיום GO');
    expect(html).toContain('הפעלה מאפשרת החלת פרמטר בלי אישור לכל פעולה');
    expect(js).toContain('function assistIsConfirmPhrase(');
    expect(js).toContain('voice_direct_after_go');
    expect(js).toContain('function assistSetVoiceGo(');
    expect(js).toContain('/api/assist/voice-go');
  });
});
