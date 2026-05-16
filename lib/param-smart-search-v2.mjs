import { GoogleGenerativeAI } from '@google/generative-ai';
import { resolveGeminiModelName } from './gemini-model.mjs';
import { logger } from './logger.mjs';
import { buildArduPlaneSearchKb } from './param-kb.mjs';
import { semanticSearch, isSemanticSearchAvailable } from './param-semantic-search.mjs';

function normalizeQuery(q) {
  return String(q || '').replace(/[\u200B-\u200D\uFEFF]/g, '').normalize('NFC').trim();
}

function tokenize(q) {
  return normalizeQuery(q).toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
}

/**
 * Hebrew aviation term → English equivalents.
 * Checked against the token output of tokenize() — all keys are lowercase, no spaces.
 * Multi-word Hebrew phrases are broken into their component tokens; both tokens are mapped.
 */
const HE_EN = {
  // Axes / motion
  'סיסה': ['yaw'],
  'גלגול': ['roll'],
  'אף': ['pitch'],
  'קצב': ['rate'],
  'זווית': ['angle'],
  'הטיה': ['bank', 'roll'],
  // Nose wheel / ground steering
  'ניהוג': ['steer', 'steering'],
  'היגוי': ['steer', 'steering'],
  'הגה': ['steering', 'rudder'],
  'גלגל': ['wheel'],
  'גלגלים': ['wheel', 'gear'],
  'קרקע': ['ground'],
  'מדרך': ['ground', 'taxi'],
  'הנדלה': ['taxi', 'ground'],
  'הסעה': ['taxi'],
  'שדה': ['ground', 'field'],
  // Speed / altitude
  'מהירות': ['speed', 'airspeed'],
  'גובה': ['altitude', 'height', 'alt'],
  'שקיעה': ['sink', 'descent'],
  'עלייה': ['climb'],
  // Controllers / gains
  'בקר': ['controller', 'control'],
  'בקרת': ['controller', 'control'],
  'רגולטור': ['controller'],
  'גאין': ['gain'],
  'הגבר': ['gain'],
  'מקדם': ['gain', 'coefficient'],
  'שיכוך': ['damping'],
  'חיכוך': ['damping'],
  'אינטגרל': ['integral', 'integrator'],
  'קבוע': ['constant', 'time'],
  'מסנן': ['filter'],
  // Calibration / tuning
  'כיול': ['calibration', 'tune', 'autotune'],
  'כיוון': ['heading', 'calibration'],
  'אוטוטיון': ['autotune'],
  // Limits
  'מגבלה': ['limit', 'max'],
  'מגבלת': ['limit', 'max'],
  'מקסימלי': ['maximum', 'max'],
  'מינימלי': ['minimum', 'min'],
  'מרבי': ['maximum', 'max'],
  'מזערי': ['minimum', 'min'],
  // Servos / outputs
  'סרוו': ['servo'],
  'סרו': ['servo'],
  'פלט': ['output'],
  'יציאה': ['output'],
  'יציאת': ['output'],
  'ערוץ': ['channel'],
  'קלט': ['input'],
  'כניסה': ['input'],
  // Sensors / navigation
  'חיישן': ['sensor'],
  'ניווט': ['navigation', 'nav'],
  'מצב': ['mode'],
  'כיוון': ['heading', 'direction'],
  // Systems
  'קלמן': ['kalman', 'ekf'],
  'בטיחות': ['failsafe', 'safety'],
  'כשל': ['failsafe', 'failure'],
  'חימוש': ['arming'],
  // Flight phases
  'נחיתה': ['landing', 'land'],
  'המראה': ['takeoff'],
  'גישה': ['approach'],
  'ריחוף': ['loiter', 'hover'],
  // General
  'מצערת': ['throttle'],
  'מנוע': ['throttle', 'motor', 'engine'],
  'מטוס': ['aircraft', 'plane'],
  'טיסה': ['flight'],
  'אינרציה': ['inertia', 'imu'],
  'מד': ['sensor', 'meter'],
  'הפעלה': ['enable'],
  'כיבוי': ['disable'],
  'חיצוני': ['external'],
  'פנימי': ['internal'],
  'אנכי': ['vertical'],
  'אופקי': ['horizontal'],
  'מדדים': ['sensors'],
};

function tokenVariants(tok) {
  const t = String(tok || '').toLowerCase();
  const out = new Set([t]);
  // Hebrew single-letter prefixes common in natural phrasing: ל/ב/כ/ו/ה/ש
  if (/^[\u0590-\u05FF]/.test(t) && t.length >= 4) {
    const stripped = t.replace(/^[לבכוהש]/, '');
    out.add(stripped);
    // Also translate the stripped form
    const enStripped = HE_EN[stripped];
    if (enStripped) enStripped.forEach((e) => out.add(e));
  }
  // Translate Hebrew token to English equivalents
  const en = HE_EN[t];
  if (en) en.forEach((e) => out.add(e));
  return [...out].filter(Boolean);
}

function scoreDeterministic(query, row) {
  const t = tokenize(query);
  const tv = [...new Set(t.flatMap((x) => tokenVariants(x)))];
  const key = String(row.param_key || '').toLowerCase();
  // Include official display_name in the scored blob for richer English matching.
  const blob = [row.display_name, row.description_en, row.description_he, ...(row.synonyms || [])].join(' ').toLowerCase();
  let tokenScore = 0;
  for (const tok of tv) {
    if (tok.length < 2) continue;
    if (key.includes(tok)) tokenScore += 7;
    if (blob.includes(tok)) tokenScore += 4;
  }
  const qLow = normalizeQuery(query).toLowerCase();
  if ((qLow.includes('autotune') || qLow.includes('אוטוטיון') || qLow.includes('אוטו טיון')) && /^AUTOTUNE_/.test(row.param_key)) {
    tokenScore += 12;
  }
  // Match N in "servo N" / "סרוו 2" / "מספר 2" (single digit; token "2" is length 1 in tokenizer — handle whole query)
  const m = qLow.match(/(?:^|[^0-9])(1[0-6]|[1-8])(?:[^0-9]|$)/);
  if (m && (/\bservo\b|סרו|סרוו|סרווה|pwm/.test(qLow) || /יציא[הת]\s*סרו/.test(qLow))) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 16 && new RegExp(`^servo${n}_`, 'i').test(row.param_key)) {
      tokenScore += 30;
    }
  }
  // Never rank unrelated params: editable/FC are tie-breakers only when something actually matched
  if (tokenScore <= 0) return 0;
  let score = tokenScore;
  if (row.available_on_fc) score += 1.5;
  if (row.editable_here) score += 1.2;
  return score;
}

function heuristicReasons(query, row) {
  const t = tokenize(query);
  const key = row.param_key;
  const reasonHe = row.available_on_fc
    ? `התוצאה קשורה לשאילתה וגם קיימת כעת ב-FC המחובר (${key}).`
    : `התוצאה התאימה לפי שם/תיאור פרמטר (${key}).`;
  const reasonEn = `Matched by key/description terms (${t.slice(0, 4).join(', ') || 'intent'})`;
  return { reason_he: reasonHe, reason_en: reasonEn };
}

const INTENT_GROUPS = [
  {
    id: 'nose-wheel-steering',
    source: 'intent-nose-wheel-steering',
    keys: [
      'GROUND_STEER_ALT',
      'STEER2SRV_P',
      'STEER2SRV_TCONST',
      'STEER2SRV_D',
      'STEER2SRV_I',
      'GROUND_STEER_DPS',
    ],
    matches: (qLow, terms) => {
      const hasSteer = /(ניהוג|היגוי|הגה|steer|steering)/i.test(qLow) || terms.includes('steer') || terms.includes('steering');
      const hasNoseWheel = /(גלגל\s*אף|גלגל.*אף|nose\s*wheel|גלגל|קרקע|ground|taxi)/i.test(qLow)
        || terms.includes('wheel')
        || terms.includes('ground')
        || terms.includes('taxi');
      return hasSteer && hasNoseWheel;
    },
    reason_he: 'זוהתה כוונה של בקרת ניהוג גלגל אף / ניהוג קרקע. אלו פרמטרי STEER2SRV הרלוונטיים.',
    reason_en: 'Detected nose-wheel / ground steering controller intent.',
  },
  {
    id: 'autotune',
    source: 'intent-autotune',
    keys: ['AUTOTUNE_LEVEL', 'AUTOTUNE_AXES', 'AUTOTUNE_AGGR', 'AUTOTUNE_OPTIONS'],
    matches: (qLow) => qLow.includes('autotune') || qLow.includes('אוטוטיון') || qLow.includes('אוטו טיון'),
    reason_he: 'זוהתה כוונת AUTOTUNE. אלו פרמטרי הכיול האוטומטי המרכזיים.',
    reason_en: 'Detected AUTOTUNE intent.',
  },
];

function expandedTerms(query) {
  return [...new Set(tokenize(query).flatMap((x) => tokenVariants(x)))];
}

function buildIntentRows(query, kb, maxResults) {
  const qLow = normalizeQuery(query).toLowerCase();
  const terms = expandedTerms(query);
  const kbMap = new Map(kb.map((r) => [r.param_key, r]));
  const matches = INTENT_GROUPS.filter((g) => g.matches(qLow, terms));
  if (!matches.length) return null;
  const group = matches[0];
  let keys = group.keys;
  if (group.id === 'nose-wheel-steering') {
    const liveSteerServoKeys = kb
      .filter((r) => /^SERVO\d+_FUNCTION$/.test(r.param_key) && Number(r.live_value) === 26)
      .map((r) => r.param_key);
    keys = [
      'GROUND_STEER_ALT',
      ...liveSteerServoKeys,
      ...group.keys.filter((key) => !liveSteerServoKeys.includes(key) && key !== 'GROUND_STEER_ALT'),
    ];
  }
  const rows = keys
    .map((key, idx) => {
      const row = kbMap.get(key);
      if (!row) return null;
      return toResultRow(
        row,
        80 - idx,
        {
          reason_he: group.reason_he,
          reason_en: group.reason_en,
          confidence: 0.97,
        },
        group.source,
      );
    })
    .filter(Boolean)
    .slice(0, maxResults);
  return rows.length ? rows : null;
}

async function mergeSemanticScores(query, kb, scored) {
  if (!isSemanticSearchAvailable()) return scored;
  try {
    const semHits = await semanticSearch(query, { limit: 40 });
    if (!semHits?.length) return scored;
    const kbMap = new Map(kb.map((r) => [r.param_key, r]));
    const byKey = new Map(scored.map((s) => [s.row.param_key, { ...s }]));
    for (const hit of semHits) {
      const row = kbMap.get(hit.param_key);
      if (!row) continue;
      const semScore = 3 + Number(hit.similarity || 0) * 28;
      const existing = byKey.get(row.param_key);
      if (existing) {
        existing.score = Math.max(existing.score, semScore) + Number(hit.similarity || 0) * 4;
        existing.semantic_similarity = hit.similarity;
      } else {
        byKey.set(row.param_key, {
          row,
          score: semScore,
          semantic_similarity: hit.similarity,
        });
      }
    }
    return [...byKey.values()].sort((a, b) => b.score - a.score);
  } catch (err) {
    logger.warn({ err: err?.message }, 'semantic search merge failed');
    return scored;
  }
}

function buildResponse({ source, ranked, maxResults }) {
  const top = ranked.slice(0, Math.max(1, Math.min(10, maxResults)));
  const editable_matches = top.filter((r) => r.editable_here).slice(0, maxResults);
  const outside_matches = top.filter((r) => !r.editable_here).slice(0, maxResults);
  const mergedTop = [...editable_matches, ...outside_matches].slice(0, maxResults);
  const keys = mergedTop.filter((r) => r.editable_here).map((r) => r.param_key);
  return {
    ok: true,
    source,
    max_results: maxResults,
    vehicle_scope: 'ArduPlane',
    results: mergedTop,
    editable_matches,
    outside_matches,
    keys,
    matches: mergedTop.filter((r) => r.editable_here).map((r) => ({ param_key: r.param_key, label_he: r.label_he, label_en: r.label_en })),
    outside_legacy: outside_matches.map((r) => ({ param_key: r.param_key, label_he: r.label_he, label_en: r.label_en })),
    outside_matches_legacy: outside_matches.map((r) => ({ param_key: r.param_key, label_he: r.label_he, label_en: r.label_en })),
  };
}

async function rerankWithGemini(query, candidates) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || candidates.length === 0) return null;
  try {
    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: resolveGeminiModelName(),
      generationConfig: { responseMimeType: 'application/json', temperature: 0.12, maxOutputTokens: 1300 },
    });
    const prompt = `Return JSON only:
{"results":[{"param_key":"NAME","reason_he":"...","reason_en":"...","confidence":0.0}]}

Task:
- Re-rank candidates for ArduPlane parameter search.
- Keep only best 1..5 items.
- param_key MUST be from candidate list.
- confidence must be between 0 and 1.

Candidate list:
${JSON.stringify(candidates.map((c) => ({
  param_key: c.param_key,
  description_en: c.description_en,
  description_he: c.description_he,
  synonyms: c.synonyms,
  editable_here: c.editable_here,
  available_on_fc: c.available_on_fc,
})))} 

User query:
${JSON.stringify(query)}`;
    const out = await model.generateContent(prompt);
    const raw = String(out.response.text() || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed.results) ? parsed.results : [];
    const allowed = new Set(candidates.map((c) => c.param_key));
    const used = new Set();
    const cleaned = [];
    for (const r of rows) {
      const key = String(r?.param_key || '').trim().toUpperCase();
      if (!allowed.has(key) || used.has(key)) continue;
      used.add(key);
      cleaned.push({
        param_key: key,
        reason_he: String(r.reason_he || '').trim(),
        reason_en: String(r.reason_en || '').trim(),
        confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0)),
      });
      if (cleaned.length >= 5) break;
    }
    return cleaned;
  } catch (err) {
    logger.warn({ err: err?.message || String(err) }, 'smart-search-v2 rerank failed');
    return null;
  }
}

function toResultRow(base, score, reasoning, source) {
  return {
    param_key: base.param_key,
    label_he: base.description_he,
    label_en: `${base.param_key} — ${base.description_en}`,
    reason_he: reasoning.reason_he,
    reason_en: reasoning.reason_en,
    score: Number(score.toFixed(3)),
    confidence: Math.max(0, Math.min(1, Number(reasoning.confidence ?? 0.55))),
    editable_here: base.editable_here === true,
    available_on_fc: base.available_on_fc === true,
    live_value: base.live_value ?? null,
    default_value: base.default_value ?? null,
    range: base.range ?? null,
    enum_values: base.enum_values ?? null,
    simple_he: base.simple_he ?? null,
    source,
  };
}

/**
 * Smart Search V2:
 * 1) deterministic candidate generation from unified KB
 * 2) optional LLM rerank/explanation
 * 3) policy gate + explicit editable/outside buckets
 */
export async function runParamSmartSearchV2(q, { liveParams = null, maxResults = 5 } = {}) {
  const query = normalizeQuery(q);
  if (!query) return { ok: false, message: 'empty_query', max_results: maxResults };

  const kb = buildArduPlaneSearchKb({ liveParams });
  const qLow = query.toLowerCase();
  const intentRows = buildIntentRows(query, kb, maxResults);
  if (intentRows?.length) {
    return buildResponse({ source: intentRows[0].source || 'intent', ranked: intentRows, maxResults });
  }
  const autotuneIntent = qLow.includes('autotune') || qLow.includes('אוטוטיון') || qLow.includes('אוטו טיון');
  const servoWords = /סרו|סרוו|סרווה|servo|יציא[הת]\s*סר|פלט\s*סר|ערוץ\s*סר/i.test(qLow);
  const servoNumM = qLow.match(/(?:מספר|#|ch\s*)\s*([1-9]|1[0-6])\b|(?:^|\s)([1-9]|1[0-6])(?:\s*|$|[^\d\n])/i);
  const servoN = servoNumM ? Number(servoNumM[1] || servoNumM[2]) : null;
  const servoIntent = Boolean(servoWords && servoN != null && servoN >= 1 && servoN <= 16);
  let scored = kb
    .map((row) => ({ row, score: scoreDeterministic(query, row) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 24);
  scored = (await mergeSemanticScores(query, kb, scored)).slice(0, 40);

  if (!scored.length) {
    // Deterministic found nothing → try semantic (embedding-based) search.
    // This handles: rare Hebrew terms, unusual phrasing, typos, mixed-language.
    if (isSemanticSearchAvailable()) {
      try {
        const semHits = await semanticSearch(query, { limit: 24 });
        if (semHits && semHits.length) {
          const kbMap = new Map(kb.map((r) => [r.param_key, r]));
          const semRows = semHits
            .map(({ param_key, similarity }) => {
              const row = kbMap.get(param_key);
              if (!row) return null;
              return toResultRow(
                row,
                similarity * 20,          // normalise similarity → comparable score
                {
                  reason_he: `נמצא על ידי חיפוש סמנטי (Gemini embeddings) — דמיון: ${Math.round(similarity * 100)}%.`,
                  reason_en: `Semantic match via Gemini embeddings (similarity ${Math.round(similarity * 100)}%).`,
                  confidence: Math.min(0.92, similarity),
                },
                'semantic',
              );
            })
            .filter(Boolean)
            .slice(0, maxResults);

          if (semRows.length) {
            return buildResponse({ source: 'semantic', ranked: semRows, maxResults });
          }
        }
      } catch (err) {
        logger.warn({ err: err?.message }, 'semantic search fallback failed');
      }
    }
    return {
      ok: true,
      source: 'none',
      max_results: maxResults,
      results: [],
      editable_matches: [],
      outside_matches: [],
      keys: [],
      matches: [],
      clarification: 'לא נמצאו התאמות ברורות. נסח מחדש את הבעיה או ציין תסמין/ציר (Pitch/Roll/Land).',
    };
  }

  const candidateRows = scored.map((s) => s.row);
  if (servoIntent) {
    const sp = `SERVO${servoN}_FUNCTION`;
    const wantKeys = [sp, `SERVO${servoN}_MIN`, `SERVO${servoN}_MAX`, `SERVO${servoN}_REVERSED`];
    const byScored = new Map(scored.map((s) => [s.row.param_key, s]));
    let forced = wantKeys
      .map((pk) => byScored.get(pk))
      .filter(Boolean)
      .map((s) =>
        toResultRow(
          s.row,
          s.score + 25,
          {
            reason_he: `נשלפת כוונת "סרוו ${servoN}" – הפרמטר העיקרי הוא ${sp} (תפקיד היציאה).`,
            reason_en: `Hard servo output intent: channel ${servoN}`,
            confidence: 0.96,
          },
          'hard-intent-servo',
        ),
      );
    if (!forced.length) {
      const row = kb.find((r) => r.param_key === sp);
      if (row) {
        forced = [
          toResultRow(
            row,
            50,
            {
              reason_he: `כוונת סרוו ${servoN}: ${sp} מגדיר מה מחובר ליציאה (פלפד/מאוורר/מצלמה וכו').`,
              reason_en: `Servo channel ${servoN} — ${sp}`,
              confidence: 0.96,
            },
            'hard-intent-servo-fallback',
          ),
        ];
      }
    }
    if (forced.length) {
      const used = new Set(forced.map((f) => f.param_key));
      const rest = scored
        .filter((s) => !used.has(s.row.param_key) && !/^EK\d|AHRS_EKF|EK3_/i.test(s.row.param_key))
        .map((s) => toResultRow(s.row, s.score, { ...heuristicReasons(query, s.row), confidence: 0.45 }, 'deterministic'))
        .slice(0, Math.max(0, maxResults - forced.length));
      const topForced = [...forced, ...rest].slice(0, maxResults);
      return buildResponse({ source: 'hard-intent-servo', ranked: topForced, maxResults });
    }
  }

  if (autotuneIntent) {
    const forced = scored
      .filter((s) => /^AUTOTUNE_/.test(s.row.param_key))
      .map((s) =>
        toResultRow(
          s.row,
          s.score + 20,
          { reason_he: 'זוהתה כוונת AUTOTUNE באופן קשיח.', reason_en: 'Hard autotune intent detected', confidence: 0.95 },
          'hard-intent-v2',
        ),
      )
      .slice(0, 2);
    if (forced.length) {
      const rest = scored
        .filter((s) => !/^AUTOTUNE_/.test(s.row.param_key))
        .map((s) => toResultRow(s.row, s.score, { ...heuristicReasons(query, s.row), confidence: 0.55 }, 'deterministic'))
        .slice(0, Math.max(0, maxResults - forced.length));
      const topForced = [...forced, ...rest].slice(0, maxResults);
      return buildResponse({ source: 'hard-intent-v2', ranked: topForced, maxResults });
    }
  }
  const reranked = await rerankWithGemini(query, candidateRows);
  /** @type {Array<any>} */
  let ranked;
  let source = 'deterministic';
  if (reranked && reranked.length) {
    source = 'gemini-rerank';
    const byKey = new Map(scored.map((s) => [s.row.param_key, s]));
    ranked = reranked
      .map((r) => {
        const hit = byKey.get(r.param_key);
        if (!hit) return null;
        return toResultRow(hit.row, hit.score + r.confidence, r, source);
      })
      .filter(Boolean);
  } else {
    ranked = scored.map((s) => toResultRow(s.row, s.score, { ...heuristicReasons(query, s.row), confidence: 0.55 }, source));
  }

  return buildResponse({ source, ranked, maxResults });
}

