/**
 * Auto-Config Recipe Engine — Recommendation-only.
 *
 * Architecture:
 *   1. A static "hints" catalog maps component types → relevant params,
 *      common failure modes, and diagnostic checks.
 *   2. The hints + live params + user symptoms are fed to Gemini as a
 *      structured context block.
 *   3. Gemini returns a JSON recipe (param_changes + checks + warnings).
 *   4. We validate the JSON shape and normalise it before returning.
 *   5. NOTHING is written to the FC here — Apply is always manual.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { getGeminiModelChain } from './gemini-model.mjs';
import { logger } from './logger.mjs';
import { getParamInfo, searchOfficialDb } from './docs-param-kb.mjs';

// ---------------------------------------------------------------------------
// Component hints catalog
// Each entry defines:
//   params   – param prefixes or full keys to include in LLM context
//   checks   – deterministic pre-checks we can always suggest
//   queries  – English search terms for the official DB
// ---------------------------------------------------------------------------

/** @type {Record<string, { labelHe: string, params: string[], checks: CheckHint[], queries: string[] }>} */
const COMPONENT_HINTS = {
  GPS: {
    labelHe: 'GPS / GNSS',
    params: [
      'GPS_TYPE', 'GPS_TYPE2', 'GPS_GNSS_MODE', 'GPS_GNSS_MODE2',
      'GPS_NAVFILTER', 'GPS_MIN_ELEV', 'GPS_INJECT_TO',
      'GPS_AUTO_SWITCH', 'GPS_BLEND_MASK', 'GPS_BLEND_TC',
      'GPS_DRV_OPTIONS', 'GPS_COM_PORT', 'GPS_COM_PORT2',
      'GPS_SAVE_CFG', 'GPS_RATE_MS', 'GPS_RATE_MS2',
      'EK3_GPS_TYPE', 'EK3_SRC1_POSXY', 'EK3_SRC1_VELXY', 'EK3_SRC1_VELZ',
      'SERIAL3_PROTOCOL', 'SERIAL4_PROTOCOL',
      'SERIAL3_BAUD', 'SERIAL4_BAUD',
    ],
    queries: ['gps type gnss navigation fix', 'serial protocol baud gps'],
    checks: [
      {
        id: 'gps-serial-proto',
        title: 'פרוטוקול SERIAL לGPS',
        description: 'ודא שהפורט SERIAL שאליו חיברת את ה-GPS מוגדר עם PROTOCOL=5 (GPS) ו-BAUD מתאים (לרוב 38400 או 115200).',
        expected: 'SERIALx_PROTOCOL=5, SERIALx_BAUD=57 (57600) או 115 (115200)',
      },
      {
        id: 'gps-type',
        title: 'סוג GPS',
        description: 'ודא ש-GPS_TYPE מוגדר לסוג הנכון עבור הדגם שלך (1=AUTO, 2=uBlox, 5=NMEA, 16=uBlox-MovingBase).',
        expected: 'GPS_TYPE ≠ 0 (0 = מושבת)',
      },
      {
        id: 'gps-fix',
        title: 'Fix Status במיישן פלאנר',
        description: 'פתח Mission Planner → Flight Data → Quick tab, בדוק GPS Fix Type. צריך להיות ≥ 3 (3D Fix) לפני טיסה.',
        expected: 'GPS Fix Type = 3 לפחות, satellites ≥ 6',
      },
      {
        id: 'gps-power',
        title: 'חיבור חשמל ו-Wiring',
        description: 'ודא שה-GPS מקבל 5V יציב, GND מחובר, ו-TX→RX / RX→TX (חיבור הפוך בין GPS לFC).',
        expected: 'LED ה-GPS מהבהב (fix acquiring) ואז קבוע (3D fix)',
      },
    ],
  },

  Receiver: {
    labelHe: 'מקלט RC',
    params: [
      'RCMAP_ROLL', 'RCMAP_PITCH', 'RCMAP_THROTTLE', 'RCMAP_YAW',
      'RC_PROTOCOLS', 'RC_OPTIONS',
      'SERIAL7_PROTOCOL', 'BRD_ALT_CONFIG',
      'RC1_MIN', 'RC1_MAX', 'RC1_TRIM', 'RC1_DZ', 'RC1_REVERSED',
      'RC2_MIN', 'RC2_MAX', 'RC2_TRIM', 'RC2_DZ', 'RC2_REVERSED',
      'RC3_MIN', 'RC3_MAX', 'RC3_TRIM', 'RC3_DZ', 'RC3_REVERSED',
      'RC4_MIN', 'RC4_MAX', 'RC4_TRIM', 'RC4_DZ', 'RC4_REVERSED',
      'FLTMODE_CH', 'THR_FS_VALUE', 'FS_SHORT_ACTN', 'FS_LONG_ACTN',
    ],
    queries: ['RC input receiver protocol SBUS CRSF ELRS PWM failsafe', 'radio calibration trim'],
    checks: [
      {
        id: 'rc-input-visible',
        title: 'RC Input גלוי?',
        description: 'פתח Mission Planner → Radio Calibration. ודא שכשמזיזים Stick ה-Bars זזים.',
        expected: 'כל 4 ערוצים ראשיים זזים בתגובה לשלט',
      },
      {
        id: 'rc-protocol',
        title: 'פרוטוקול RC',
        description: 'ודא ש-RC_PROTOCOLS מכסה את הפרוטוקול שלך. SBUS=32, CRSF=512, ELRS=512, PPM=1.',
        expected: 'RC_PROTOCOLS=0 (All auto) או הערך המדויק לפרוטוקול',
      },
      {
        id: 'rc-binding',
        title: 'Binding',
        description: 'ודא שהמשדר ב-Bind Mode ל-Receiver ושהם על אותה תדר/פרוטוקול. אם Receiver מצביע LED אדום קבוע — לא מחובר.',
        expected: 'LED ירוק/כחול קבוע ב-Receiver (Bound)',
      },
      {
        id: 'rc-failsafe',
        title: 'Failsafe הגדרה',
        description: 'כבה את השלט ובדוק שערוץ 3 (Throttle) יורד מתחת ל-THR_FS_VALUE. כך ArduPilot מזהה Failsafe.',
        expected: 'FS_SHORT_ACTN / FS_LONG_ACTN מוגדרים (לא 0=Disabled)',
      },
    ],
  },

  Compass: {
    labelHe: 'מצפן (Compass)',
    params: [
      'COMPASS_USE', 'COMPASS_USE2', 'COMPASS_USE3',
      'COMPASS_AUTODEC', 'COMPASS_DEC',
      'COMPASS_ORIENT', 'COMPASS_EXTERN',
      'COMPASS_OFS_X', 'COMPASS_OFS_Y', 'COMPASS_OFS_Z',
      'COMPASS_DEV_ID', 'COMPASS_DEV_ID2',
      'COMPASS_CAL_FIT', 'COMPASS_MOT_X', 'COMPASS_MOT_Y', 'COMPASS_MOT_Z',
    ],
    queries: ['compass calibration declination orientation external'],
    checks: [
      {
        id: 'compass-calib',
        title: 'כיול מצפן',
        description: 'Mission Planner → Mandatory Hardware → Compass → Start. סובב את המטוס בכל הצירים עד קבלת ירוק.',
        expected: 'Calibration Successful, COMPASS_OFS_* בטווח ±150',
      },
      {
        id: 'compass-orient',
        title: 'כיוון מצפן',
        description: 'אם המצפן הוא חיצוני (GPS עם מצפן) ו-COMPASS_EXTERN=1, ודא ש-COMPASS_ORIENT תואם לכיווּן הרכיב על הגוף.',
        expected: 'COMPASS_ORIENT=0 אם מכוּון קדימה, ערך אחר אם מסובב',
      },
      {
        id: 'compass-interference',
        title: 'הפרעות אלקטרומגנטיות',
        description: 'ודא שה-GPS/Compass נמצא כמה שיותר רחוק מכבלי חשמל, ESC ומנועים.',
        expected: 'Mission Planner → HUD מציג Heading הגיוני ויציב',
      },
    ],
  },

  Airspeed: {
    labelHe: 'חיישן מהירות אוויר (Airspeed)',
    params: [
      'ARSPD_TYPE', 'ARSPD_USE', 'ARSPD_AUTOCAL', 'ARSPD_RATIO',
      'ARSPD_PIN', 'ARSPD_TUBE_ORDER', 'ARSPD_SKIP_CAL',
      'ARSPD_WIND_MAX', 'ARSPD_STALL_SPD', 'ARSPD_BUS',
      'ARSPD2_TYPE', 'ARSPD2_USE',
      'SERIAL2_PROTOCOL',
    ],
    queries: ['airspeed sensor pitot tube calibration analog digital'],
    checks: [
      {
        id: 'arspd-type',
        title: 'סוג חיישן מהירות',
        description: 'הגדר ARSPD_TYPE לסוג הנכון: 0=ללא, 1=אנלוגי (3DR Airspeed), 2=I2C MS4525, 3=SDP3x, 4=DLVR-L10D.',
        expected: 'ARSPD_TYPE ≠ 0, ARSPD_USE=1',
      },
      {
        id: 'arspd-calib',
        title: 'כיול (Offset)',
        description: 'לפני המראה עם הנחיר פנוי (אין לחץ דיפרנציאלי) — Mission Planner → Preflight Calibration → Calibrate Airspeed.',
        expected: 'Airspeed מציג ~0 כשהמטוס נייח ב-GCS',
      },
    ],
  },

  Baro: {
    labelHe: 'ברומטר (Barometer)',
    params: [
      'BARO_PRIMARY', 'BARO_EXT_BUS', 'BARO1_GND_PRESS',
      'BARO2_GND_PRESS', 'BARO_TEMP_COMP', 'GND_ALT_OFFSET',
    ],
    queries: ['barometer altitude pressure external bus'],
    checks: [
      {
        id: 'baro-cover',
        title: 'כיסוי ברומטר',
        description: 'ודא שהברומטר מוגן מרוח ישירה (foam cover) אך לא סגור לחלוטין. חשיפה לרוח גורמת לטעויות גובה.',
        expected: 'גובה QNH תואם לגובה מקום הטיסה בסובלנות 5–10 מטר',
      },
      {
        id: 'baro-drift',
        title: 'דריפט טמפרטורה',
        description: 'אפשר ל-FC להתחמם 5–10 דקות לפני טיסה. BARO_TEMP_COMP=1 מפחית Drift טמפרטורה.',
        expected: 'גובה יציב תוך דקה לאחר Arm',
      },
    ],
  },

  ESC: {
    labelHe: 'ESC',
    params: [
      'MOT_PWM_MIN', 'MOT_PWM_MAX', 'MOT_THST_EXPO',
      'SERVO_BLH_AUTO', 'SERVO_BLH_MASK', 'SERVO_BLH_OTYPE',
      'SERVO_BLH_TRATE', 'SERVO_DSHOT_ESC', 'SERVO_DSHOT_RATE',
    ],
    queries: ['ESC DShot BLHeli PWM calibration motor output'],
    checks: [
      {
        id: 'esc-calib',
        title: 'כיול ESC',
        description: 'ESCs אנלוגיים PWM מצריכים כיול תחילה. DShot לא מצריך. ב-Mission Planner: ESC Calibration Wizard.',
        expected: 'כל המנועים מגיבים בצורה אחידה לפקודת Gas',
      },
      {
        id: 'esc-protocol',
        title: 'פרוטוקול (DShot / PWM)',
        description: 'ודא ש-SERVO_DSHOT_ESC ו-SERVO_BLH_OTYPE תואמים לתמיכה ב-ESC שלך.',
        expected: 'ESC מגיב, ללא Beep-Error בהפעלה',
      },
    ],
  },

  Custom: {
    labelHe: 'רכיב מותאם אישית',
    params: [],
    queries: [],
    checks: [
      {
        id: 'custom-serial',
        title: 'בדוק פרוטוקול SERIAL',
        description: 'ודא ש-SERIALx_PROTOCOL מוגדר לפרוטוקול הנכון עבור הרכיב שחיברת.',
        expected: 'הרכיב מופיע ב-Messages ב-GCS ללא שגיאות',
      },
      {
        id: 'custom-power',
        title: 'בדוק חיבורי חשמל',
        description: 'ודא מתח תקין (3.3V/5V לפי מפרט), GND משותף, וכיווניות TX↔RX.',
        expected: 'ללא LED שגיאה על הרכיב',
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Gather official param info for a list of keys, returns compact text for LLM. */
function buildParamContextBlock(paramKeys, liveParams) {
  const lines = [];
  for (const key of paramKeys) {
    const info = getParamInfo(key);
    const liveVal = liveParams?.[key];
    if (!info && liveVal == null) continue;
    const parts = [`${key}`];
    if (info?.display_name && info.display_name !== key) parts.push(`(${info.display_name})`);
    if (liveVal != null) parts.push(`ערך נוכחי=${liveVal}`);
    if (info?.values) {
      const opts = Object.entries(info.values).slice(0, 6).map(([v, l]) => `${v}=${l}`).join(', ');
      parts.push(`אפשרויות: ${opts}`);
    } else if (info?.range) {
      parts.push(`טווח: ${info.range.low}–${info.range.high}`);
    }
    if (info?.description) parts.push(`— ${info.description.slice(0, 120)}`);
    lines.push(parts.join(' '));
  }
  return lines.join('\n');
}

/** Validate and sanitise the recipe JSON returned by Gemini. */
function validateRecipe(raw) {
  const out = {
    summary: '',
    checks: [],
    param_changes: [],
    warnings: [],
  };

  if (typeof raw.summary === 'string') out.summary = raw.summary.slice(0, 500);

  if (Array.isArray(raw.checks)) {
    out.checks = raw.checks.slice(0, 8).map((c) => ({
      id: String(c.id || `chk-${Math.random().toString(36).slice(2, 7)}`),
      title: String(c.title || '').slice(0, 80),
      description: String(c.description || '').slice(0, 400),
      expected: String(c.expected || '').slice(0, 200),
    }));
  }

  if (Array.isArray(raw.param_changes)) {
    out.param_changes = raw.param_changes.slice(0, 12).map((p) => ({
      param_key: String(p.param_key || '').toUpperCase().slice(0, 32),
      current_value: p.current_value != null ? String(p.current_value) : null,
      recommended_value: p.recommended_value != null ? String(p.recommended_value) : null,
      reason: String(p.reason || '').slice(0, 300),
      risk: ['low', 'medium', 'high'].includes(p.risk) ? p.risk : 'low',
      success_condition: String(p.success_condition || '').slice(0, 200),
    })).filter((p) => p.param_key && p.recommended_value != null);
  }

  if (Array.isArray(raw.warnings)) {
    out.warnings = raw.warnings.slice(0, 5).map((w) => String(w).slice(0, 200));
  }

  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a configuration recipe (recommendation-only).
 *
 * @param {{
 *   componentType: string,
 *   port?: string|null,
 *   symptoms: string,
 *   liveParams?: Record<string,string|number>|null,
 *   telemetrySnapshot?: object|null,
 * }} input
 * @returns {Promise<{
 *   ok: boolean,
 *   recipe?: import('./auto-config-recipes.d').Recipe,
 *   error?: string,
 * }>}
 */
export async function buildAutoConfigRecipe({
  componentType,
  port = null,
  symptoms,
  liveParams = null,
  telemetrySnapshot = null,
}) {
  const hints = COMPONENT_HINTS[componentType] ?? COMPONENT_HINTS.Custom;

  // Collect extra params from the official DB via keyword search.
  const extraParams = [];
  for (const q of hints.queries) {
    const hits = searchOfficialDb(q, { limit: 8 });
    for (const h of hits) {
      if (!hints.params.includes(h.param_key)) extraParams.push(h.param_key);
    }
  }
  const allParamKeys = [...new Set([...hints.params, ...extraParams.slice(0, 20)])];
  const paramContextBlock = buildParamContextBlock(allParamKeys, liveParams);

  // Build live-params summary.
  let liveBlock = '';
  if (liveParams && Object.keys(liveParams).length > 0) {
    const relevant = allParamKeys
      .filter((k) => liveParams[k] != null)
      .map((k) => `${k}=${liveParams[k]}`);
    liveBlock = relevant.length
      ? `### פרמטרים חיים מה-FC:\n${relevant.join(', ')}`
      : '### FC מחובר אך לא קיבלנו ערכים עבור פרמטרים אלו.';
  } else {
    liveBlock = '### FC לא מחובר — ערכים נוכחיים אינם זמינים.';
  }

  // Telemetry snapshot (optional).
  let telemetryBlock = '';
  if (telemetrySnapshot && Object.keys(telemetrySnapshot).length > 0) {
    const lines = Object.entries(telemetrySnapshot).slice(0, 10)
      .map(([k, v]) => `  ${k}: ${v}`);
    telemetryBlock = `### Telemetry Snapshot:\n${lines.join('\n')}`;
  }

  // Port hint.
  const portBlock = port ? `### פורט/חיבור שהמשתמש ציין: ${port}` : '';

  const prompt = `אתה מהנדס תצורה ArduPilot מומחה. המשתמש מדווח על בעיה עם רכיב.
משימתך: להחזיר **המלצות בלבד** — JSON מדויק בפורמט שמוגדר למטה.
אל תכתוב שום דבר מחוץ ל-JSON.

## קלט

### סוג רכיב: ${hints.labelHe} (${componentType})
${portBlock}

### תסמינים שתיאר המשתמש:
${symptoms}

${liveBlock}
${telemetryBlock}

### פרמטרים רלוונטיים (מידע רשמי):
${paramContextBlock || '(מסד הנתונים הרשמי לא נטען)'}

## פורמט JSON נדרש (ענה עם JSON בלבד, ללא קוד-בלוק):
{
  "summary": "תמצית מה הבעיה ומה הגישה",
  "checks": [
    {
      "id": "check-id",
      "title": "כותרת בדיקה (עברית, קצרה)",
      "description": "מה לבדוק, איך, בדיוק",
      "expected": "מה לצפות לראות אם תקין"
    }
  ],
  "param_changes": [
    {
      "param_key": "PARAM_NAME",
      "current_value": null,
      "recommended_value": "ערך",
      "reason": "למה זה קשור לבעיה שתוארה",
      "risk": "low",
      "success_condition": "כיצד לדעת שהשינוי עבד"
    }
  ],
  "warnings": ["אזהרה חשובה אם יש"]
}

הנחיות חשובות:
- param_key חייב להיות שם פרמטר ArduPilot תקני (UPPER_SNAKE_CASE).
- recommended_value חייב להיות מחרוזת (גם אם מספר).
- risk: "low" = אין סיכון לטיסה, "medium" = דורש בדיקה קרקעית, "high" = פוטנציאל לכשל קריטי.
- הגבל ל-6 param_changes ו-5 checks מרביים.
- אם אין המלצת פרמטר — השאר param_changes כמערך ריק.
- ענה ONLY JSON, ללא markdown code block, ללא הסברים.`;

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY לא מוגדר');

    const genAI = new GoogleGenerativeAI(apiKey);
    const modelChain = getGeminiModelChain();

    // Try each model in chain; skip to next on 503 / model-unavailable errors.
    let text = null;
    let lastErr = null;
    for (const modelId of modelChain) {
      try {
        const model = genAI.getGenerativeModel({ model: modelId });
        const result = await model.generateContent(prompt);
        text = result.response.text().trim();
        logger.info({ modelId }, '[auto-config] Gemini responded');
        break;
      } catch (modelErr) {
        const msg = modelErr?.message ?? '';
        const isTransient = msg.includes('503') || msg.includes('Service Unavailable')
          || msg.includes('currently') || msg.includes('overloaded') || msg.includes('404');
        logger.warn({ modelId, err: msg }, '[auto-config] model attempt failed');
        lastErr = modelErr;
        if (!isTransient) throw modelErr; // hard error — stop retrying
      }
    }
    if (text === null) throw lastErr;

    // Strip markdown code fences if present.
    const jsonStr = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    let raw;
    try {
      raw = JSON.parse(jsonStr);
    } catch {
      logger.warn({ text: text.slice(0, 300) }, '[auto-config] Gemini returned non-JSON');
      // Fallback: static checks only.
      raw = {
        summary: 'לא הצלחתי לנתח תגובה מ-AI. מוצגות בדיקות סטטיות בלבד.',
        checks: hints.checks,
        param_changes: [],
        warnings: ['תגובת ה-AI לא הייתה בפורמט תקין. נסה שוב עם תיאור ממוקד יותר.'],
      };
    }

    // Merge static checks (from hints) into the LLM checks if not already present.
    const llmCheckIds = new Set((raw.checks || []).map((c) => c.id));
    const missingStaticChecks = hints.checks.filter((c) => !llmCheckIds.has(c.id));
    raw.checks = [...(raw.checks || []), ...missingStaticChecks];

    // Enrich param_changes with live values.
    if (Array.isArray(raw.param_changes) && liveParams) {
      raw.param_changes = raw.param_changes.map((p) => ({
        ...p,
        current_value: p.current_value ?? (liveParams[p.param_key] != null
          ? String(liveParams[p.param_key])
          : null),
      }));
    }

    const recipe = validateRecipe(raw);
    logger.info({ componentType, paramCount: recipe.param_changes.length }, '[auto-config] recipe built');
    return { ok: true, recipe };

  } catch (err) {
    logger.error({ err }, '[auto-config] buildAutoConfigRecipe failed');

    // Map raw error to a clean Hebrew message (no URLs or stack traces).
    const raw = err?.message ?? '';
    let friendlyMsg;
    if (!process.env.GEMINI_API_KEY || raw.includes('API_KEY') || raw.includes('לא מוגדר')) {
      friendlyMsg = 'מפתח GEMINI_API_KEY לא מוגדר — הגדר אותו בקובץ .env ואתחל את השרת.';
    } else if (raw.includes('503') || raw.includes('Service Unavailable') || raw.includes('overloaded')) {
      friendlyMsg = 'שירות ה-AI עמוס כרגע — נסה שוב בעוד מספר שניות.';
    } else if (raw.includes('404') || raw.includes('not found') || raw.includes('currently')) {
      friendlyMsg = 'מודל ה-AI לא זמין כרגע — המערכת תנסה מודל חלופי בבקשה הבאה.';
    } else if (raw.includes('quota') || raw.includes('RESOURCE_EXHAUSTED')) {
      friendlyMsg = 'מכסת ה-API הגיעה לסיום — בדוק את מכסת Gemini שלך.';
    } else {
      friendlyMsg = 'שירות ה-AI לא זמין כרגע. מוצגות בדיקות ידניות בלבד.';
    }

    // Graceful fallback: return static checks without param_changes.
    return {
      ok: true,
      recipe: validateRecipe({
        summary: `בדיקות ידניות עבור ${hints.labelHe} (AI לא זמין).`,
        checks: hints.checks,
        param_changes: [],
        warnings: [friendlyMsg],
      }),
    };
  }
}

/**
 * Return the list of supported component types with labels.
 * @returns {Array<{ id: string, labelHe: string }>}
 */
export function listComponentTypes() {
  return Object.entries(COMPONENT_HINTS).map(([id, h]) => ({ id, labelHe: h.labelHe }));
}
