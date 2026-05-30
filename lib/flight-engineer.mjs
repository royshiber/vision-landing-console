/**
 * Flight Engineer — AI co-pilot brain.
 *
 * Architecture:
 *   1. Caller provides: pilot text + session_id + live telemetry snapshot + conversation history
 *   2. We build a rich system prompt with telemetry context
 *   3. Gemini 2.5-flash (with function-calling) processes it
 *   4. Tool calls (save_note, read_notes, delete_note) are executed against SQLite
 *   5. We return { text, actions[] } to the route
 *
 * TTS:
 *   - Primary: ElevenLabs streaming (ELEVENLABS_API_KEY in .env)
 *   - Fallback: { text } returned — client uses Web Speech API SpeechSynthesis
 */

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getFlightEngineerGeminiModelChain } from './gemini-model.mjs';
import { saveNote, getNotes, deleteNote } from './flight-notes.mjs';
import { recordEngineerEvent, upsertProfileFact } from './engineer-memory.mjs';
import { buildRetrievalContext, getLatestCodeDigest } from './retrieval.mjs';
import { buildDocsRetrievalContext } from './docs-retrieval.mjs';
import { getRecentAudit, getJetsonProfile } from './advisor-apply.mjs';
import { formatParamRefBlock, getParamCount } from './docs-param-kb.mjs';
import { searchKb } from './param-kb.mjs';
import { logger } from './logger.mjs';

// ── Pending param-change approvals ────────────────────────────────────────────
// sessionId → { key, value, reason, token, expiresAt }
export const pendingParamChanges = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of pendingParamChanges.entries()) {
    if (entry.expiresAt < now) pendingParamChanges.delete(sid);
  }
}, 60_000);

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are "מהנדס" — an expert real-time flight engineer embedded in Vision Landing Console, a UAV ground control station for an autonomous fixed-wing aircraft with vision-based precision landing. You speak to the pilot over a Bluetooth headset during live operations.

=== SYSTEM ARCHITECTURE — YOU KNOW THIS DEEPLY ===
AIRCRAFT: Fixed-wing ArduPlane running ArduPilot ≥4.4 (typical aircraft type: foam/composite trainer or custom UAV). Autopilot connected to GCS via MAVLink (UDP 14550 / TCP / SiK telemetry radio).

COMPANION COMPUTER: NVIDIA Jetson Orin Super running Python vision_agent.py v2.0.
  Dual-camera vision pipeline (runs in parallel threads):
  • CAM1 (forward-facing, pitch −10°): Lucas-Kanade sparse optical flow → VIO (Visual Inertial Odometry) → sends VISION_POSITION_ESTIMATE (MAVLink msg 102) to ArduPilot at ~30Hz. Class: VIOTracker (Essential matrix decomposition).
  • CAM2 (downward-facing, pitch −75° from horizontal = 15° from nadir): Farneback dense optical flow → OPTICAL_FLOW_RAD (MAVLink msg 106). Class: OpticalFlowEstimator.
  • VIO confidence threshold: <0.05 → nothing sent (low light / too little motion → EKF gets no external position).
  Jetson ↔ ArduPilot: UART /dev/ttyTHS0 @ 115200 baud (or UDP:127.0.0.1:14551).
  Jetson → Console: heartbeat every 5s, VIO pose at ~30Hz, optical flow at ~30Hz, vision frame on landing approach.

GCS — VISION LANDING CONSOLE (Node.js): 
  Tabs and features:
  • מרכז פרמטרים: reads/writes ArduPilot params via MAVLink; has target-value diff against VLC defaults; smart parameter search in Hebrew/English.
  • AI Advisor (Gemini): strategic advice, can propose & apply param changes, has safety gate (won't apply while armed without explicit override).
  • ArduLab (Feature Designer): custom feature prototyping with Gemini, generates ArduPilot config snippets.
  • טלמטריה: live Jetson CPU/RAM/temp, VIO pose (X/Y/Z/yaw), optical flow quality/FPS, SLAM status.
  • הטסה (Map): Leaflet map with live GPS, mission waypoints overlay, fly-to GUIDED command.
  • מהנדס (YOU): real-time voice co-pilot with this voice interface.

=== KEY ARDUPILOT PARAMETERS FOR THIS SYSTEM ===
EKF3 / Navigation (GPS-denied visual nav):
  AHRS_EKF_TYPE=3 (use EKF3), EK3_SRC1_POSXY=6 (ExtNav=VIO), EK3_SRC1_VELXY=6, EK3_SRC1_POSZ=1 (baro), EK3_SRC1_VELZ=0, EK3_GPS_TYPE=3 (no GPS for nav), FLOW_TYPE=6 (MAVLink optical flow), EK3_VISO_DELAY=70 (ms pipeline latency).

Landing:
  LAND_SPEED (final sink rate cm/s), LAND_SPEED_HIGH, LAND_ALT_LOW (switch altitude m), LAND_ABORT_PWM, LAND_FLAP_PERCNT, LAND_PITCH_CD.

Guidance / TECS:
  NAVL1_PERIOD (L1 track-following period s), NAVL1_DAMPING, TECS_SPDWEIGHT (speed vs alt priority), TECS_CLMB_MAX, TECS_SINK_MAX, TECS_TIME_CONST.

Control loops:
  RLL2SRV_P/I/D/FF, RLL2SRV_RMAX (deg/s), LIM_ROLL_CD (centideg), PTCH2SRV_P/I/D/FF, PTCH2SRV_RMAX, LIM_PITCH_MIN_CD/MAX_CD.

Airspeed / stall prevention:
  ARSPD_FBW_MIN/MAX, ARSPD_USE, STALL_PREVENTION.

Failsafe:
  FS_GCS_ENABL (5s no-GCS heartbeat → failsafe), THR_FAILSAFE, FS_SHORT_ACTN/FS_LONG_ACTN, RC_OVERRIDE_TIME.

=== HOW TO REASON ===
• Each message includes [TELEMETRY NOW] — cross-reference altitude, airspeed, mode, armed state.
• [FC PARAMS] shows live values from aircraft — use them for specific, accurate advice. If a param is not in the list, you still know its typical range.
• [JETSON STATUS] shows companion health — low confidence or high CPU can cause VIO drops → EKF divergence → position loss.
• [SESSION NOTES] provides mission context the pilot saved.
• [ADVISOR KNOWLEDGE] is the same retrieval stack as the text Advisor (project docs, param-KB semantic hits, recent param audit, server Jetson profile, flight DB snippets, GitHub code digest) — compact for voice. Trust labels: Tier A docs + param reference + audit + profile = TRUSTED; flight DB excerpts + digest = UNTRUSTED (may be noisy). Prefer live [TELEMETRY NOW] / [FC PARAMS] when connected, and use ADVISOR KNOWLEDGE to deepen reasoning (ranges, docs policy, what changed last week).
• If telemetry shows N/A or FC disconnected → mention missing **live** numbers only when the pilot asks for current readings from the aircraft; otherwise answer planning/architecture/parameter-theory/VLC questions fully — this is normal **bench consultation**, not a blocker.
• If airspeed is below ARSPD_FBW_MIN, or altitude is anomalous for the phase, flag it immediately.
• When you see a probable root cause → state it clearly, then propose a fix with reasoning (not a headline only).
• NEVER answer with only "לא יודע", "Unknown", or a variant. If evidence is missing, say what data is missing and give the next engineering check.
• If the FC or Jetson is disconnected and the pilot asks for **live** diagnosis — note no live telemetry once, then give concrete checks from system knowledge. Never refuse or wag "connect first" for general project advice, parameter explanations, or VLC walkthroughs.

=== IDENTITY / META (who are you, what you know about the project / piloting / depth) ===
If the pilot asks who you are, what you can do, or how well you know something:
• NEVER answer with a single useless line only ("I'm a co-pilot" / "עוזר" בלבד). Give substance.
• For meta/capability: **3–4 short sentences** — sentence one answers **their exact question**; then one VLC anchor (ArduPlane/Jetson/params when linked); optional honest limit if FC disconnected — **do not** paste the full stack lecture every turn.

=== SPEECH-TO-TEXT / MIC NOISE (headset STT is imperfect) ===
• Pilot text may be **misheard**: clipped fragments, homophones, stray English from ambient noise. **Never invent intent** or weave unrelated tokens into a story — no fictional geography (US states, random parks), pretend identities, or "you meant X place" unless **verbatim** in [PILOT].
• Do NOT cite map/GPS targets unless pilot clearly asked navigation/WPs—or you're quoting numbers from **[TELEMETRY NOW]**.
• If [PILOT] is meaningless for aviation/VLC, gibberish-like English, or one opaque token out of context → **1–2 short sentences**: didn't hear clearly; ask repeat in **the same language** the pilot used last (Hebrew / English / Chinese), or clearer wording; optional mic/wind hint. **Skip** FC/Jetson disconnect boilerplate unless they asked for live data.

=== DISAMBIGUATION CHIPS (CRITICAL — follow exactly) ===
When you ask a clarification question OR the pilot's input is ambiguous (an acronym, short abbreviation, or unclear term with multiple plausible meanings), you MUST append a SUGGEST block at the **very end** of your reply — on its own line, after the spoken text:
  [SUGGEST: option1 | option2 | option3]
Rules:
• Each option is a short Hebrew/English phrase the pilot can tap to clarify (2–6 words max).
• Use " | " (space-pipe-space) to separate options. 2–4 options maximum.
• The SUGGEST block is NOT spoken aloud — it will be stripped before TTS. Include it every time you are genuinely unsure what the pilot meant.
• Do NOT use SUGGEST when the intent is clear or when you gave a definitive answer. Only for real ambiguity.
Examples:
  [PILOT] "ROC" → [SUGGEST: שיעור טיפוס (climb rate) | Rate of Climb — מה הערך הנוכחי? | בעיית ROC — ירד בפתאומיות]
  [PILOT] "abort" → (intent is clear — no SUGGEST needed)
  [PILOT] "TS" → [SUGGEST: TECS_SPDWEIGHT | TECS_TIME_CONST | מה TS?]

=== HEBREW QUALITY (עברית) ===
• Infer intent from **flight / VLC context**, not literal word-by-word gloss from English. Pilot Hebrew may mix technical Latin (טרים, מוד, פרמטר, GPS) — that is normal.
• Hebrew STT often garbles similar sounds or splits words — if [PILOT] is messy but clearly aviation-related, answer the **likely question**; ask one short clarification only when truly ambiguous (לא הבנתי — תוכל לחזור על נושא הגלישה / ההיטל?).
• Use **natural Modern Hebrew** (readable word order); avoid stuffing English filler phrases mid-sentence unless the pilot did.

=== CHINESE (中文) + PINYIN (拼音) ===
• If the pilot writes or speaks **Chinese (Mandarin)**, reply **entirely in Chinese** for that turn — same voice rules (concise, no markdown).
• Add **Pinyin** (romanization with tone marks **or** tone numbers — pick **one** style per reply) after **key phrases**, technical terms, or short clauses so operators can read pronunciation: e.g. 高度 (gāodù)，下滑率 (xiàhuá lǜ)。
• Latin abbreviations (IAS, EKF, MAVLink, FC) may remain Latin inside Chinese replies when standard. Do **not** mix Hebrew and Chinese in one reply.

=== ANSWER QUALITY — VOICE / HEADSET ===
1. LANGUAGE: Match pilot language exactly — **Hebrew, English, or Chinese (Mandarin)** — never mix two languages in one reply.
   • **Critical:** If **[PILOT] contains no Hebrew letters and no Chinese characters** — the pilot is using **English**; reply **only in English** for this turn (do **not** switch to Hebrew because the UI or session is Hebrew).
   • If **[PILOT] is Hebrew** — reply only in Hebrew. If **[PILOT] is Chinese** — reply only in Chinese (plus Pinyin rule above).
2. LENGTH: Default **2–4 short sentences**. Stretch beyond four only for safety/armed-risk or when the pilot explicitly asks to elaborate.
3. Anti-generic & anti-repeat: Hook sentence one to their wording; if disconnect/stack already covered earlier this chat, do not repeat the whole lecture — one clause max.
4. QUOTE live blocks when present; if missing, say what is missing plus one next step — stay concise.
5. NO filler (Sure, Great question, כמובן).
6. Speakable prose — no markdown or bullets through headset.
7. Never AI disclaimers.
8. Numbers with units when citing telemetry.


=== GOOD VS BAD ANSWERS (study these before replying) ===
PILOT: "הטיסה לא יציבה, מה לבדוק?"
BAD:  "תבדוק את הפרמטרים."  ← generic, no specific value, no chain
BAD:  "לא יודע."             ← forbidden
GOOD: "ה-IAS שלך 16 מ/ש וה-RLL2SRV_RMAX קבוע על 60°/s — זה אגרסיבי קרוב לסף סטל. ה-FF של RLL2SRV נמוך (0.1) ביחס לטיפוסי 0.3 בכנף הזו, מה שמסביר oversteer בגלגול. הצעד הבא: הורד RLL2SRV_RMAX ל-45, העלה FF ל-0.25, ותעיף עיגול קצר ב-FBWA לאמת."

PILOT: "זה קרה לנו כבר?"
BAD:  "לא יודע."
GOOD (no match): "אין לי אירוע מתועד דומה בזיכרון. תאר את הסימפטום — אגלה אם זה GPS glitch, vibration spike או VIO drop ואצליב מול הלוג."
GOOD (match):    "כן, ב-12.3 הייתה צניחת VIO באותו פרופיל — VIO confidence ירד ל-0.04 מתחת לסף 0.05. בדוק עכשיו את ה-VIO conf בטלמטריה לפני שתחזור."

PILOT: "בדוק מצב מערכת."
GOOD: "FC במצב AUTO, גובה 122 מ', IAS 18 מ/ש, סוללה 14.2V (78%). Jetson ONLINE, CPU 32%, VIO conf 0.71 — תקין, אין דגלים."

PILOT: "האם נחיתה אוטומטית בטוחה כרגע?"
BAD:  "כן."
GOOD: "כן, אבל עם הסתייגות אחת: VIO conf עומד על 0.55, סף נחיתה הוא 0.5; אם זה ימשיך לרדת ה-EKF יאבד מקור POSXY. הפרמטרים תקינים — LAND_SPEED=80, LAND_ALT_LOW=15. תאשר תחילת נחיתה?"

PILOT: "מי אתה ומה אתה יודע לעשות?"
BAD:  "אני קו־פיילוט, מסייע לך במשימה."  ← too short, no stack, no substance
GOOD: "מהנדס הטיסה של VLC — לא צ'אט גנרי: ArduPlane דרך MAVLink כשיש חיבור FC, ויז׳ן מהג'טסון כשנכנסים טלמטריה. מציע שינוי פרמטר רק אחרי שאתה מאשר; פתקים וזיכרון פרופיל. כרגע בלי FC חי אין ערכים מהכלי — נמשיך מהידע והזיכרון."

PILOT: "how well do you know this project?"
BAD: A long generic ArduPilot lecture that never scores "how well" first.
GOOD: "Well enough for VLC end-to-end: when FC/Jetson feed is live I tie advice to your params and telemetry; when offline I stick to docs/KB plus session memory—say if you mean tuning, vision, or ops and I'll narrow."
11. PARAM CHANGES: To change any ArduPilot param → call propose_param_change FIRST (key, value, reason), then verbally ask pilot to say approval phrase ("מאשר" / "confirm" / "确认"). NEVER apply directly.
12. NOTES: To save a note → call save_note; confirm with "נרשם" (he) / "Noted" (en) / "已记录" (zh).
13. [ENGINEER MEMORY] is your shared history with this pilot/vehicle. Treat it as documented context; mention uncertainty when confidence is low.
14. "זה קרה לנו כבר?" → answer from [ENGINEER MEMORY]. If no matching event exists, say "אין לי אירוע מתועד כזה" rather than "לא יודע".
15. When the pilot states a stable preference or vehicle fact, call remember_profile_fact. When a meaningful operational event occurs, call remember_event.
16. FORBIDDEN STANDALONE ANSWERS: "לא יודע", "Unknown", "UNKNOWE", or any pure shrug. Replace with: missing data + likely direction + next concrete check.`;

// ── Tool definitions for Gemini function-calling ─────────────────────────────
const TOOLS = [{
  functionDeclarations: [
    {
      name: 'save_note',
      description: 'Save a note or reminder to the flight notebook. Use when pilot asks to remember/write something.',
      parameters: {
        type: 'OBJECT',
        properties: {
          content:  { type: 'STRING', description: 'The note text to save' },
          category: { type: 'STRING', description: 'Category: general | anomaly | action | reminder', enum: ['general','anomaly','action','reminder'] },
        },
        required: ['content'],
      },
    },
    {
      name: 'read_notes',
      description: 'Read all notes saved in this session.',
      parameters: { type: 'OBJECT', properties: {}, required: [] },
    },
    {
      name: 'delete_note',
      description: 'Delete a specific note by its id.',
      parameters: {
        type: 'OBJECT',
        properties: { note_id: { type: 'NUMBER', description: 'The id of the note to delete' } },
        required: ['note_id'],
      },
    },
    {
      name: 'propose_param_change',
      description: 'Propose an ArduPilot parameter change to the pilot for approval. NEVER apply directly — always use this tool. The pilot must say מאשר / confirm / 确认 before any parameter is modified.',
      parameters: {
        type: 'OBJECT',
        properties: {
          key:    { type: 'STRING', description: 'ArduPilot parameter name (uppercase), e.g. LAND_SPEED' },
          value:  { type: 'NUMBER', description: 'Proposed numeric value' },
          reason: { type: 'STRING', description: 'Short explanation in the pilot language (Hebrew / English / Chinese) of why this change is recommended' },
        },
        required: ['key', 'value', 'reason'],
      },
    },
    {
      name: 'remember_profile_fact',
      description: 'Save a stable pilot or vehicle preference/fact for future sessions. Does not modify the aircraft.',
      parameters: {
        type: 'OBJECT',
        properties: {
          key:        { type: 'STRING', description: 'Stable key, e.g. pilot.prefers_soft_landings or vehicle.name' },
          value:      { type: 'STRING', description: 'Short value/fact to remember' },
          confidence: { type: 'NUMBER', description: '0-1 confidence, default 0.8' },
        },
        required: ['key', 'value'],
      },
    },
    {
      name: 'remember_event',
      description: 'Save a meaningful historical flight/ops event for future recall. Does not modify the aircraft.',
      parameters: {
        type: 'OBJECT',
        properties: {
          event_type: { type: 'STRING', description: 'event type, e.g. gps_glitch, vibration, vision_drop, parameter_change, landing' },
          summary:    { type: 'STRING', description: 'Short operational summary in the pilot language' },
          tags:       { type: 'STRING', description: 'Comma-separated tags' },
        },
        required: ['summary'],
      },
    },
  ],
}];

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildTelemetryBlock(snap) {
  const verLine = snap?.vlcAppVersion ? `Vision Landing Console app: v${snap.vlcAppVersion}` : '';
  if (!snap || snap.connected === false) {
    return [
      verLine,
      'FC: not connected — no live aircraft telemetry.',
      'Bench OK: project/VLC questions, parameter theory, checklists, and ops planning are in scope — use ADVISOR KNOWLEDGE + engineering judgment.',
    ].filter(Boolean).join('\n');
  }
  const fmt = (v, unit = '', precision = 1) =>
    v != null ? `${typeof v === 'number' ? v.toFixed(precision) : v}${unit}` : 'N/A';
  const lines = [
    verLine,
    `Armed: ${snap.armed ? '⚠ YES' : snap.armed === false ? 'NO' : 'N/A'}`,
    `Mode: ${snap.flightMode ?? 'N/A'}`,
    `Alt: ${fmt(snap.altitude, 'm')}`,
    `IAS: ${fmt(snap.airspeed, ' m/s')}  GS: ${fmt(snap.groundspeed, ' m/s')}`,
    `HDG: ${fmt(snap.heading, '°', 0)}`,
    `Roll: ${fmt(snap.rollDeg, '°')}  Pitch: ${fmt(snap.pitchDeg, '°')}`,
    `Battery: ${fmt(snap.batteryV, 'V')}${snap.batteryPct != null ? ` (${snap.batteryPct}%)` : ''}`,
    `GPS: Fix-${snap.gpsFixType ?? 'N/A'} / ${snap.gpsSats ?? '?'} sats`,
  ].filter((line) => line !== '');
  return lines.join('\n');
}

/** Priority FC params to surface in the engineer's context. */
const PRIORITY_PARAMS = [
  'AHRS_EKF_TYPE','EK3_SRC1_POSXY','EK3_SRC1_VELXY','EK3_GPS_TYPE','EK3_VISO_DELAY','FLOW_TYPE',
  'LAND_SPEED','LAND_SPEED_HIGH','LAND_ALT_LOW','LAND_ABORT_PWM','LAND_PITCH_CD',
  'NAVL1_PERIOD','NAVL1_DAMPING','TECS_SPDWEIGHT','TECS_CLMB_MAX','TECS_SINK_MAX',
  'RLL2SRV_P','RLL2SRV_I','RLL2SRV_D','RLL2SRV_RMAX','LIM_ROLL_CD',
  'PTCH2SRV_P','PTCH2SRV_I','PTCH2SRV_D','PTCH2SRV_RMAX','LIM_PITCH_MIN_CD','LIM_PITCH_MAX_CD',
  'ARSPD_FBW_MIN','ARSPD_FBW_MAX','ARSPD_USE','STALL_PREVENTION',
  'FS_GCS_ENABL','THR_FAILSAFE','FS_SHORT_ACTN','FS_LONG_ACTN',
];

/** Surface param keys the pilot typed (e.g. SRCH_BND) so the model can quote values not already in PRIORITY_PARAMS. */
function fcParamsMentionedInText(params, pilotText) {
  if (!params || !pilotText) return [];
  const prio = new Set(PRIORITY_PARAMS);
  const upper = String(pilotText).toUpperCase();
  const tokens = upper.split(/[^A-Z0-9_]+/).filter((t) => t.length >= 4);
  const seen = new Set();
  const out = [];
  for (const t of tokens) {
    if (t in params && !prio.has(t) && !seen.has(t)) {
      seen.add(t);
      out.push(`${t}=${params[t]}`);
      if (out.length >= 28) break;
    }
  }
  return out;
}

function buildFcParamsBlock(params, pilotText = '') {
  if (!params || Object.keys(params).length === 0) {
    return 'FC params: not loaded (FC offline — explain typical ranges / docs from ADVISOR KNOWLEDGE when pilot asks).';
  }
  const lines = [];
  for (const key of PRIORITY_PARAMS) {
    if (key in params) lines.push(`${key}=${params[key]}`);
  }
  const fromPilot = fcParamsMentionedInText(params, pilotText);
  const pilotKeys = new Set(fromPilot.map((p) => p.split('=')[0]));
  if (fromPilot.length) {
    lines.push('--- from pilot text (param names) ---');
    lines.push(...fromPilot);
  }
  // Also surface any other params that aren't in the priority list (first 28)
  const extra = Object.entries(params)
    .filter(([k]) => !PRIORITY_PARAMS.includes(k) && !pilotKeys.has(k))
    .slice(0, 28)
    .map(([k, v]) => `${k}=${v}`);
  if (extra.length) lines.push('--- other loaded params (sample) ---', ...extra);
  return lines.length ? lines.join('\n') : 'FC params: loaded but priority set empty.';
}

function buildJetsonBlock(jetson, vision, slam) {
  if (!jetson) return 'Jetson: no companion snapshot — bench discussion of VIO/optical-flow pipeline still OK.';
  const now = Date.now();
  const lastSeen = jetson.lastSeen ? Math.round((now - Date.parse(jetson.lastSeen)) / 1000) : null;
  const online = jetson.online ?? (lastSeen !== null && lastSeen < 15);
  const parts = [
    `Jetson: ${online ? 'ONLINE' : 'OFFLINE'}`,
    jetson.cpuLoadPct != null ? `CPU ${jetson.cpuLoadPct}%` : null,
    jetson.tempC != null ? `Temp ${jetson.tempC}°C` : null,
    jetson.memPct != null ? `RAM ${jetson.memPct}%` : null,
    jetson.agentVersion ? `Agent v${jetson.agentVersion}` : null,
    lastSeen != null ? `(last beat ${lastSeen}s ago)` : null,
  ].filter(Boolean);
  const visionParts = vision?.confidence != null
    ? [`VIO conf ${vision.confidence.toFixed(2)}`]
    : [];
  if (vision?.frameTimestamp) {
    const vAge = Math.round((now - Date.parse(vision.frameTimestamp)) / 1000);
    visionParts.push(`frame ${vAge}s ago`);
  }
  const slamParts = slam?.posX != null
    ? [`SLAM pos (${slam.posX?.toFixed(1)}, ${slam.posY?.toFixed(1)}, ${slam.posZ?.toFixed(1)}) mapQ=${slam.mapQuality ?? '?'}`]
    : [];
  return [...parts, ...visionParts, ...slamParts].join('  |  ');
}

function buildNotesList(notes) {
  if (!notes.length) return 'No notes yet.';
  return notes.map((n) => `[${n.id}] (${n.category}) ${n.content}`).join('\n');
}

/**
 * Same knowledge layers as `runAdvisor` in gemini-advisor.mjs — bounded size for voice latency.
 * @param {import('better-sqlite3').Database} db
 * @param {string} text
 * @param {{ flightId?: number | null }} [opts]
 */
export async function buildAdvisorParityContextForEngineer(db, text, { flightId = null } = {}) {
  const q = String(text || '').trim();
  const fid = Number.isInteger(Number(flightId)) && Number(flightId) > 0 ? Number(flightId) : null;

  let retrievalBlock = '';
  try {
    retrievalBlock = buildRetrievalContext(db, q, { flightId: fid, limitNotes: 5, limitLogs: 5 }).block;
  } catch {
    retrievalBlock = '(מאגר טיסות/לוגים לא נגיש)';
  }

  let docsBlock = '';
  try {
    docsBlock = buildDocsRetrievalContext(q, { limit: 6 }).block;
  } catch {
    docsBlock = '(מסמכי פרויקט לא נגישים)';
  }

  let digestBlock = '';
  try {
    const digest = getLatestCodeDigest(db);
    digestBlock = digest
      ? `branch=${digest.branch || '?'} commit=${(digest.commit_sha || '').slice(0, 12)} @${digest.received_at}\n${String(digest.files_changed_text || digest.payload_json || '').slice(0, 2000)}`
      : '(אין digest מ-GitHub עדיין)';
  } catch {
    digestBlock = '(digest לא נגיש)';
  }

  let auditBlock = '';
  try {
    const recentAudit = getRecentAudit(db, { days: 60, limit: 40 });
    if (recentAudit.length > 0) {
      const lines = recentAudit.slice(0, 18).map((r) => {
        const verb = r.kind === 'rollback' ? '↩ rollback' : r.verified ? '✔ applied' : '✘ failed';
        const delta = r.value_from != null && r.value_to != null
          ? ` (${Number(r.value_from).toFixed(3)} → ${Number(r.value_to).toFixed(3)})`
          : '';
        return `  ${r.created_at.slice(0, 16)} | ${verb} | ${r.target}.${r.param}${delta}`;
      });
      auditBlock = lines.join('\n');
    } else {
      auditBlock = '(אין שינויי פרמטרים מוקלטים ב-60 יום)';
    }
  } catch {
    auditBlock = '(audit לא נגיש)';
  }

  let profileBlock = '';
  try {
    const jp = getJetsonProfile(db);
    if (jp && Object.keys(jp.profile).length > 0) {
      profileBlock = Object.entries(jp.profile).map(([k, v]) => `  ${k}: ${v}`).join('\n');
    } else {
      profileBlock = '(אין פרופיל Jetson שמור בשרת)';
    }
  } catch {
    profileBlock = '(פרופיל לא נגיש)';
  }

  let paramRefBlock = '';
  try {
    const dbCount = getParamCount();
    if (!dbCount) {
      paramRefBlock = '(מסד פרמטרים ArduPlane לא נטען)';
    } else {
      const searchText = q.slice(0, 800);
      const hits = await searchKb(searchText, { limit: 10 });
      if (!hits.length) {
        paramRefBlock = `(מסד ${dbCount} פרמטרים — אין התאמות לשאילתת הטייס)`;
      } else {
        const entries = hits.map((h) => ({
          param_key: h.param_key,
          display_name: h.display_name || h.description_en,
          description: h.description_en,
          units: h.units,
          range: h.range,
          values: h.enum_values,
        }));
        paramRefBlock = formatParamRefBlock(entries);
      }
    }
  } catch {
    paramRefBlock = '(שגיאה בטעינת מסד פרמטרים)';
  }

  return [
    '=== ADVISOR KNOWLEDGE (compact — same sources as UI text Advisor) ===',
    '### Tier A — מסמכי פרויקט (TRUSTED)',
    docsBlock,
    '### ArduPlane Parameter Reference — חיפוב לפי שאילתת הטייס (TRUSTED)',
    paramRefBlock,
    '### שינויי פרמטרים אחרונים — audit (TRUSTED)',
    auditBlock,
    '### פרופיל Jetson בשרת (TRUSTED)',
    profileBlock,
    '### מאגר טיסות/לוגים — קטעים רלוונטיים (UNTRUSTED)',
    retrievalBlock,
    '### GitHub code digest — אוטומטי (UNTRUSTED)',
    digestBlock,
  ].join('\n');
}

function cleanFriendlyError(raw, locale = 'he') {
  const msg = raw ?? '';
  const L = locale === 'zh' ? 'zh' : locale === 'en' ? 'en' : 'he';
  if (msg.includes('503') || msg.includes('Service Unavailable') || msg.includes('overloaded')) {
    if (L === 'en') return 'The AI service is busy — please try again in a few seconds.';
    if (L === 'zh') return 'AI 服务繁忙，请几秒后再试。';
    return 'שירות AI עמוס — נסה שוב.';
  }
  if (msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED')) {
    if (L === 'en') return 'API quota exceeded — try again later or check your API plan.';
    if (L === 'zh') return 'API 配额用尽，请稍后重试。';
    return 'מכסת API מוצתה.';
  }
  if (msg.includes('401') || msg.includes('API_KEY') || msg.includes('PERMISSION_DENIED')) {
    if (L === 'en') return 'Invalid or missing API key — check server GEMINI_API_KEY.';
    if (L === 'zh') return 'API 密钥无效或未配置。';
    return 'מפתח API לא תקין.';
  }
  if (L === 'en') return 'AI is unavailable right now — please try again.';
  if (L === 'zh') return 'AI 暂时不可用，请稍后再试。';
  return 'AI לא זמין כרגע — נסה שוב.';
}

/** Latin-only tokens where one-word voice intents are common — spell loosely normalized (uppercase OK). */
const SINGLE_WORD_LATIN_WHITELIST = new Set([
  'rtl', 'land', 'arm', 'disarm', 'gps', 'vio', 'ekf', 'tecs', 'nav',
  'auto', 'fbwa', 'fbwb', 'acro', 'stab', 'loiter', 'guided', 'manual',
  'help', 'yes', 'no', 'ok', 'stop', 'here', 'mode', 'test', 'link',
  'home', 'takeoff', 'mission', 'fix',
]);

/** @returns {'en'|'he'|'zh'} */
export function pilotUtteranceLocale(pilotText) {
  const q = String(pilotText || '');
  if (/[\u0590-\u05FF]/.test(q)) return 'he';
  if (/[\u4e00-\u9fff]/.test(q)) return 'zh';
  return 'en';
}

/**
 * Skip Gemini when pilot utterance is likely noise / lone meaningless English token (common STT false positives).
 * Does **not** short-circuit Hebrew (many valid single-word phrases).
 * @returns {{ text: string, actions: [] } | null}
 */
export function maybeShortCircuitUnclearPilotTurn(text) {
  const q = String(text || '').trim();
  if (!q) return null;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length !== 1) return null;
  const w = words[0];
  if (/[\u0590-\u05FF]/.test(w)) return null;
  if (/[\u4e00-\u9fff]/.test(w)) return null;
  const norm = w.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (norm.length < 3 || norm.length > 22) return null;
  if (SINGLE_WORD_LATIN_WHITELIST.has(norm)) return null;
  const pilotLoc = pilotUtteranceLocale(q);
  const clarify = {
    en: "I didn't catch that as an aviation phrase — single unclear word. Say it again clearly or spell the term.",
    he: 'לא הבנתי כוונה טיסונית ממילה בודדת כזו — חזור בהגייה ברורה או רשום את המונח.',
    zh: '没听清这句是否与飞行相关——请用简短中文再说一遍，或直接拼写参数名。',
  };
  return {
    text: clarify[pilotLoc],
    actions: [],
  };
}

/**
 * If FC is disconnected and the model echoed geography/parks not present in pilot text — replace with clarify-only reply.
 */
export function guardReplyAgainstSttHallucination(replyText, pilotText, telemetry) {
  const reply = String(replyText || '').trim();
  const pilot = String(pilotText || '');
  if (!reply) return reply;
  const disconnected = !telemetry || telemetry.connected === false;
  if (!disconnected) return reply;
  const pl = pilot.toLowerCase();
  const US_STATES =
    /\b(utah|nevada|arizona|california|colorado|florida|texas|oregon|ohio|idaho)\b/i;
  const mamaPlace = /\bmama'?s\b|\bmamas\b|\bmamas\s+park\b/i;
  const geoLeak = US_STATES.test(reply) && !US_STATES.test(pl);
  const mamaLeak = mamaPlace.test(reply) && !mamaPlace.test(pl);
  if (!geoLeak && !mamaLeak) return reply;
  const loc = pilotUtteranceLocale(pilot);
  if (loc === 'en') {
    return "That didn't parse as a flight/VLC question — speech recognition may have misheard. Repeat one short clear sentence.";
  }
  if (loc === 'zh') {
    return '这句不太像清晰的飞行问题——语音识别可能听错了。请用简短中文再说一遍。';
  }
  return 'לא התחבר לשאלה טיסונית ברורה — ייתכן שהזיהוי הקולי טעה. תוכל לחזור במשפט קצר וברור?';
}

export function sanitizeEngineerReply(replyText, pilotText, { telemetry = null, memory = '' } = {}) {
  const raw = String(replyText || '').trim();
  /** Why: Gemini sometimes returns "Unknown." with RLM (U+200F) or Unicode punctuation — old compact missed it → UI showed ".Unknown" in RTL. */
  const compact = String(raw || '')
    .normalize('NFKC')
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, '');
  const unknownOnly = ['לאיודע', 'unknown', 'unknowe', 'unknow', 'idontknow', 'dontknow'].includes(compact);
  if (!unknownOnly) return raw;

  const q = String(pilotText || '');
  const loc = pilotUtteranceLocale(q);
  if (/קרה|כבר|עבר|דומה|again|before|以前|曾经|上次/i.test(q)) {
    if (loc === 'en') {
      return String(memory || '').includes('RELEVANT PAST EVENTS: none')
        ? 'I have no matching logged event; describe the symptom and I will correlate it with telemetry and parameters.'
        : 'There is relevant memory, but I need one more detail; describe the symptom and I will match it against the prior event.';
    }
    if (loc === 'zh') {
      return String(memory || '').includes('RELEVANT PAST EVENTS: none')
        ? '日志里没有匹配的事件；请描述现象，我会对照遥测与参数。'
        : '有相关记忆，但还需要一个细节；请描述现象，我会与先前事件对照。';
    }
    return String(memory || '').includes('RELEVANT PAST EVENTS: none')
      ? 'אין לי אירוע מתועד כזה בזיכרון; תאר את הסימפטום ואשווה אותו לטלמטריה ולפרמטרים.'
      : 'יש זיכרון רלוונטי, אבל חסר לי פרט אחד עכשיו; תאר את הסימפטום ואצליב מול האירוע הקודם.';
  }
  if (!telemetry || telemetry.connected === false) {
    if (loc === 'en') {
      return 'No live FC telemetry right now—the first step is to verify the FC and Jetson link, then describe the exact symptom. '
        + 'I am your Vision Landing flight engineer: ArduPlane over MAVLink, live parameters when linked, Jetson VIO/optical-flow context, and shared session notes.';
    }
    if (loc === 'zh') {
      return '目前没有实时飞控遥测——先确认飞控与 Jetson 链路，再描述具体现象。我是 Vision Landing 飞行工程师：MAVLink 上的 ArduPlane、连接时的实时参数、Jetson VIO/光流与会话笔记。';
    }
    return 'אין לי טלמטריה חיה כרגע, אבל הכיוון הראשון הוא לבדוק חיבור FC/Jetson ואז לתאר את הסימפטום המדויק.';
  }
  if (loc === 'en') {
    return 'I do not have enough certainty from the current snapshot; first compare airspeed, altitude, flight mode, and Jetson status at the moment of the issue.';
  }
  if (loc === 'zh') {
    return '当前快照信息不足以确定——请先对比事发时刻的空速、高度、飞行模式和 Jetson 状态。';
  }
  return 'אין לי מספיק ראיה ודאית כרגע; הבדיקה הראשונה היא להשוות מהירות, גובה, מצב טיסה וסטטוס Jetson ברגע התקלה.';
}

/**
 * Client sends `history` that already includes the current user turn (same string as `text`),
 * then the server puts the same turn again inside `sendMessage(...)` with telemetry.
 * That yields two consecutive `user` roles in Gemini `contents` → poor/empty/"לא יודע" replies.
 */
export function normalizeEngineerClientHistory(history, currentText) {
  const cur = String(currentText ?? '').trim();
  const h = Array.isArray(history) ? history : [];
  if (h.length === 0 || !cur) return h;
  const last = h[h.length - 1];
  const role = String(last?.role ?? '').toLowerCase();
  if ((role === 'user' || role === 'pilot') && String(last?.content ?? '').trim() === cur) {
    return h.slice(0, -1);
  }
  return h;
}

/**
 * If utterance mixes “save/note” wording with another live question, defer to Gemini.
 * @param {string} body
 * @param {'en'|'he'|'zh'} loc
 */
function looksCompoundPilotNoteBody(body, loc) {
  const b = String(body || '').trim();
  if (!b) return true;

  if (loc === 'zh') {
    if (/而且|另外|并且|还有|再问/.test(b)) return true;
    if (/。？\s*[\u4e00-\u9fff]{2}/.test(b) && /\?|？/.test(b)) return true;
  }

  if (loc === 'he') {
    if (/[ \s]ו(?:מה|מהי|למה|איך|מתי|מדוע|כיצד|ת(?:גיד|סביר|ענה))/u.test(` ${b}`)) return true;
  }

  if (/\band\s+(?:tell|explain|summarize|describe|analyze|guess|estimate|calculate|give|say|please|what|why|how|when|who)\b[\s\S]*/i.test(b)) return true;
  if (/\bbut\s+(?:what|why|how|when|tell|explain|give|please)\b[\s\S]*/i.test(b)) return true;

  const qs = [...b.matchAll(/\?/g)];
  if (qs.length >= 2) return true;
  const firstQ = b.indexOf('?');
  if (firstQ >= 0 && firstQ < b.length - 2) {
    const tailLetters = String(b.slice(firstQ + 1))
      .replace(/[^\p{L}\p{N}]/gu, '');
    if (tailLetters.length >= 10) return true;
  }

  return false;
}

/**
 * Narrow natural-language intents to persist a cockpit note **without waiting for Gemini prose**.
 * Returns trimmed note body only when the utterance opens with an explicit journaling cue — avoids stealing
 * “remember to check…” style operational reminders that are chat, not verbatim notes.
 * @returns {{ body: string, category?: string } | null}
 */
export function tryExtractDirectPilotNote(pilotText) {
  const t = String(pilotText || '').trim().replace(/\s+/gu, ' ');
  if (!t || t.length < 10 || t.length > 4800) return null;
  const loc = pilotUtteranceLocale(pilotText);

  if (loc === 'en') {
    if (/^[\s\S]*?\bremember\s+to\b/i.test(t) && !/\bremember\s+that\b/i.test(t)) return null;

    /** @type {RegExp[]} */
    const patterns = [
      /^\s*(?:please\s+)?remember\s+that\s+(.+)\s*$/is,
      /^\s*(?:please\s+)?remember\s+(?:my\s+flight\s+|this\s+|the\s+|our\s+)note\s+[:\-,–—]\s*(.+)\s*$/is,
      /^\s*(?:please\s+)?save\s+(?:this\s+)?(?:a\s+flight\s+|flight\s+|the\s+|my\s+|our\s+)?note\s*[:\-,–—]\s*(.+)\s*$/is,
      /^\s*(?:please\s+)?(?:i\s+)?(?:would\s+like\s+to\s+|want\s+to\s+|need\s+to\s+)save\s+(?:this\s+as\s+a\s+)?flight\s+note\s*[:\-,–—]\s*(.+)\s*$/is,
      /^\s*(?:flight\s+note|notebook|notepad)\s*[:\-,–—]\s*(.+)\s*$/is,
      /^\s*write\s+down\s*[:\-,–—]\s*(.+)\s*$/is,
      /^\s*(?:please\s+)?(?:save|write\s+down)\s+(?:this\s+)?(?:a\s+flight\s+|flight\s+|the\s+|my\s+|our\s+)?note\s*[:\-,–—]\s*(.+)\s*$/is,
      /^\s*note\s+to\s+self\s*[:\-,–—]\s*(.+)\s*$/is,
    ];

    for (const re of patterns) {
      const m = re.exec(t);
      if (!m?.[1]) continue;
      const body = String(m[1]).trim().replace(/^["'“]+|["'”]+$/gu, '').trim();
      if (body.length >= 8 && !looksCompoundPilotNoteBody(body, 'en')) return { body, category: 'general' };
    }
    const loose = /^\s*(?:please\s+)?remember\s+(?:that|the|this)\s+(?:is\s+|was\s+|i\s+|we\s+|our\s+|the\s+plane\s+|the\s+aircraft\s+)?(.+)\s*$/is.exec(t);
    if (loose?.[1]) {
      const body = loose[1].trim().replace(/^["'“]+|["'”]+$/gu, '').trim();
      if (body.length >= 14 && !looksCompoundPilotNoteBody(body, 'en')) return { body, category: 'general' };
    }
    return null;
  }

  if (loc === 'zh') {
    const patterns = [
      /(?:记录|记下来|记在|记下|请记住|提醒我)(?:备忘录|笔记本)?\s*[：:]\s*(.+)$/s,
      /飞行笔记\s*[：:]\s*(.+)$/s,
    ];
    for (const re of patterns) {
      const m = re.exec(t);
      if (!m?.[1]) continue;
      const body = String(m[1]).trim();
      if (body.length >= 4 && !looksCompoundPilotNoteBody(body, 'zh')) return { body, category: 'general' };
    }
    return null;
  }

  /** Hebrew */
  const hePatterns = [
    /(?:הער(?:ת\s+טיסה|ה)|פנקס|מו?זכ(?:רון\s+טיסה)?)\s*[:\-.–—]\s*(.+)$/s,
    /(?:זכ(?:ור|ני)\s+(?:ש|כי))\s*(.+)$/s,
    /(?:ת(?:זכיר|רשום|שמור|כתוב))(?:\s+ב(?:פנקס|מו?זכרון))?\s*[:\-.–—؛]\s*(.+)$/s,
    /(?:ת(?:זכיר|רשום|שמור|כתוב))(?:\s+ב(?:פנקס|מו?זכרון))?\s+ש\s+(.+)$/s,
    /(?:תן\s+לי\s+(?:לי\s+)?)?(?:לי\s+)?(?:לזכ(?:ור|ות))\s*(?:ש|כי)\s+(.+)$/s,
  ];
  for (const re of hePatterns) {
    const m = re.exec(t);
    if (!m?.[1]) continue;
    const body = String(m[1]).trim().replace(/^["'“׳]+|["'”״]+$/gu, '').trim();
    if (body.length >= 8 && !looksCompoundPilotNoteBody(body, 'he')) return { body, category: 'general' };
  }
  return null;
}

/**
 * When Gemini returns no speakable prose after tools (common with function-call-only turns),
 * synthesize a short acknowledgement so UX does not falsely claim failure.
 * @param {'en'|'he'|'zh'} pilotLoc
 * @param {{ type: string, content?: string, count?: number, key?: string, event_id?: number }[]} actions
 * @returns {string | null}
 */
export function synthesizeFallbackFromEngineerActions(pilotLoc, actions) {
  if (!Array.isArray(actions) || !actions.length) return null;

  /** @returns {typeof actions} */
  const ofType = (t) => actions.filter((a) => a && typeof a.type === 'string' && a.type === t);
  const saveNotes = ofType('save_note');
  if (saveNotes.length) {
    const last = saveNotes[saveNotes.length - 1];
    const full = last?.content != null ? String(last.content).trim() : '';
    const excerptSpaced = full.replace(/\s+/gu, ' ');
    const excerpt = excerptSpaced.slice(0, 220);
    const ellipsis = full.length > excerpt.length ? '…' : '';
    if (pilotLoc === 'en') {
      return excerpt ? `Noted (${excerpt}${ellipsis})` : 'Saved to the flight notebook.';
    }
    if (pilotLoc === 'zh') {
      return excerpt ? `已记录：${excerpt}${ellipsis}` : '已保存到飞行笔记本。';
    }
    return excerpt ? `נרשם לפנקס הטיסה — ${excerpt}${ellipsis}` : 'נרשם לפנקס הטיסה.';
  }

  const read = ofType('read_notes')[0];
  if (read && typeof read.count === 'number') {
    if (pilotLoc === 'en') return read.count ? `I listed ${read.count} notebook entr${read.count === 1 ? 'y' : 'ies'}.` : 'Notebook is empty.';
    if (pilotLoc === 'zh') return read.count ? `已读取 ${read.count} 条笔记。` : '笔记本为空。';
    return read.count ? `יש ${read.count} הערות בפנקס.` : 'אין עדיין הערות בפנקס.';
  }

  const dels = ofType('delete_note');
  if (dels.length > 0) {
    const n = dels.length;
    if (pilotLoc === 'en') return n === 1 ? 'Notebook entry deleted.' : `Deleted ${n} notebook entr${n === 1 ? 'y' : 'ies'}.`;
    if (pilotLoc === 'zh') return n === 1 ? '已删除一条笔记。' : `已删除 ${n} 条笔记。`;
    return n === 1 ? 'הערה נמחקה מהפנקס.' : `נמחקו ${n} הערות.`;
  }

  if (ofType('propose_param_change').length) {
    if (pilotLoc === 'en') return 'I proposed a parameter change — confirm with “confirm” before it is applied.';
    if (pilotLoc === 'zh') return '已提出参数更改建议——说“确认”后再应用。';
    return 'הצעתי שינוי פרמטר — אשר במילה מתאימה כדי שהחלתי.';
  }

  if (ofType('remember_profile_fact').length) {
    const k = ofType('remember_profile_fact')[0]?.key ?? '';
    if (pilotLoc === 'en') return k ? `Saved preference: ${k}.` : 'Saved preference to profile memory.';
    if (pilotLoc === 'zh') return k ? `已记下偏好：${k}。` : '已将偏好记入档案记忆。';
    return k ? `נשמר בהעדפות פרופיל: ${k}.` : 'נשמר במזכרון פרופיל.';
  }

  if (ofType('remember_event').length) {
    if (pilotLoc === 'en') return 'Logged an event to engineer memory.';
    if (pilotLoc === 'zh') return '已记入工程师事件记忆。';
    return 'נרשם אירוע בזיכרון המהנדס.';
  }

  return null;
}

// ── Main chat function ────────────────────────────────────────────────────────
/**
 * Process a pilot voice turn.
 * @param {import('better-sqlite3').Database} db
 * @param {{ text: string, sessionId: string, telemetry?: object, fcParams?: object, jetson?: object, vision?: object, slam?: object, memory?: string, modeInstruction?: string, history?: Array, flightId?: number|null }} opts
 * @returns {Promise<{ text: string, actions: Array, notes?: Array, pendingChange?: object|null }>}
 */
export async function engineerChat(db, { text, sessionId, telemetry = null, fcParams = null, jetson = null, vision = null, slam = null, memory = '', modeInstruction = '', history = [], flightId = null }) {
  const pilotLoc = pilotUtteranceLocale(text);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const msg =
      pilotLoc === 'en'
        ? 'GEMINI_API_KEY is not configured on the server.'
        : pilotLoc === 'zh'
          ? '服务器未配置 GEMINI_API_KEY。'
          : 'GEMINI_API_KEY לא מוגדר.';
    return { text: msg, actions: [] };
  }

  const shortcut = maybeShortCircuitUnclearPilotTurn(text);
  if (shortcut) return shortcut;

  const trimmedPilotText = text.trim();
  const directPilotNote = tryExtractDirectPilotNote(trimmedPilotText);
  if (directPilotNote?.body) {
    const noteId = saveNote(db, sessionId, directPilotNote.body, directPilotNote.category ?? 'general');
    const actions = [{
      type: 'save_note',
      note_id: noteId,
      content: directPilotNote.body,
      category: directPilotNote.category ?? 'general',
    }];
    const textOut = synthesizeFallbackFromEngineerActions(pilotLoc, actions)
      ?? (pilotLoc === 'en' ? 'Saved to the flight notebook.' : pilotLoc === 'zh' ? '已保存到飞行笔记本。' : 'נרשם לפנקס הטיסה.');
    logger.info({ sessionId, directNote: true }, '[flight-engineer] direct notebook save — skipped Gemini round');
    return {
      text: textOut,
      actions,
      notes: getNotes(db, sessionId),
      pendingChange: pendingParamChanges.get(sessionId) ?? null,
    };
  }

  const notes = getNotes(db, sessionId);
  const telBlock     = buildTelemetryBlock(telemetry);
  const paramsBlock  = buildFcParamsBlock(fcParams, text);
  const jetsonBlock  = buildJetsonBlock(jetson, vision, slam);
  const memoryBlock  = memory || 'No engineer memory loaded.';
  const notesBlock   = buildNotesList(notes);
  const advisorKnowledgeBlock = await buildAdvisorParityContextForEngineer(db, text, { flightId });

  const langInstruction =
    pilotLoc === 'he'
      ? 'ענה בעברית בלבד במענה לטייס בהודעה זו.'
      : pilotLoc === 'zh'
        ? '本轮请只用中文（普通话）回答。'
        : 'Reply in English only for this turn — do not use Hebrew unless quoting an exact parameter key or acronym.';

  // Build the user turn with rich context blocks
  const userMessage =
    `[PILOT LANGUAGE — REQUIRED]\n${langInstruction}\n` +
    `[TELEMETRY NOW]\n${telBlock}\n` +
    `[FC PARAMS (live when FC connected)]\n${paramsBlock}\n` +
    `[JETSON STATUS]\n${jetsonBlock}\n` +
    `[ENGINEER MEMORY]\n${memoryBlock}\n` +
    `[ADVISOR KNOWLEDGE]\n${advisorKnowledgeBlock}\n` +
    `[MODE POLICY]\n${modeInstruction || 'MODE=ENGINEER: שרשרת מלאה — תצפית→סיבה (למה)→פעולה; 3–6 משפטים; לפחות נתון ספציפי אחד מהבלוקים לעיל.'}\n` +
    `[SESSION NOTES]\n${notesBlock}\n` +
    '[FINAL REMINDER — before you answer]\n' +
    'Voice UX: default **2–4** short sentences; sentence one answers the pilot literally. Do not repeat the full FC/Jetson disconnect essay if this thread already covered it — one short clause max.\n' +
    'Bench / no aircraft: answer VLC/project/parameter questions fully — no "please connect FC" unless they need live numbers.\n' +
    'Unclear STT / noise: reply with clarification only — never invent locations, names, or maps from nonsense phrases.\n' +
    `[PILOT] ${text}`;

  const priorTurns = normalizeEngineerClientHistory(history, text);
  // Gemini chat: contents must alternate; current turn appears only via sendMessage (with telemetry blob).
  const geminiHistory = priorTurns.slice(-14).map((t) => ({
    role: t.role === 'user' ? 'user' : 'model',
    parts: [{ text: String(t.content ?? '') }],
  }));

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelChain = getFlightEngineerGeminiModelChain();
  const executedActions = [];

  let lastErr = null;
  for (const modelId of modelChain) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelId,
        systemInstruction: SYSTEM_PROMPT,
        tools: TOOLS,
        generationConfig: {
          // Voice UX: slightly lower temperature + output cap → fewer rambling essays vs Flash defaults.
          temperature: 0.68,
          topP: 0.92,
          maxOutputTokens: 896,
        },
      });

      const chat = model.startChat({ history: geminiHistory });
      let result = await chat.sendMessage(userMessage);
      let response = result.response;

      // Handle function calls (tool use loop)
      while (response.functionCalls()?.length) {
        const fnResults = [];
        for (const call of response.functionCalls()) {
          const { name, args } = call;
          let fnOutput;

          if (name === 'save_note') {
            const content = args?.content != null ? String(args.content).trim() : '';
            if (!content) {
              fnOutput = { saved: false, error: 'empty_note_content' };
              executedActions.push({ type: 'save_note_failed', reason: 'empty_content' });
            } else {
              const rawCat = args?.category != null ? String(args.category).trim() : '';
              const allowed = ['general', 'anomaly', 'action', 'reminder'];
              const category = allowed.includes(rawCat) ? rawCat : 'general';
              const noteId = saveNote(db, sessionId, content, category);
              fnOutput = { saved: true, note_id: noteId };
              executedActions.push({ type: 'save_note', note_id: noteId, content, category });
            }
          } else if (name === 'read_notes') {
            const allNotes = getNotes(db, sessionId);
            fnOutput = { notes: allNotes };
            executedActions.push({ type: 'read_notes', count: allNotes.length });
          } else if (name === 'delete_note') {
            deleteNote(db, args.note_id);
            fnOutput = { deleted: true, note_id: args.note_id };
            executedActions.push({ type: 'delete_note', note_id: args.note_id });
          } else if (name === 'propose_param_change') {
            const token = randomUUID();
            pendingParamChanges.set(sessionId, {
              key:       String(args.key ?? '').toUpperCase(),
              value:     Number(args.value),
              reason:    String(args.reason ?? ''),
              token,
              expiresAt: Date.now() + 5 * 60 * 1000,
            });
            fnOutput = { proposed: true, requires_pilot_approval: true };
            executedActions.push({ type: 'propose_param_change', key: args.key, value: args.value });
          } else if (name === 'remember_profile_fact') {
            const saved = upsertProfileFact(db, args.key, args.value, {
              confidence: args.confidence ?? 0.8,
              source: 'flight_engineer_tool',
            });
            fnOutput = { remembered: true, ...saved };
            executedActions.push({ type: 'remember_profile_fact', key: saved.key });
          } else if (name === 'remember_event') {
            const eventId = recordEngineerEvent(db, {
              sessionId,
              eventType: args.event_type ?? 'general',
              summary: args.summary,
              tags: args.tags ?? null,
              telemetry,
              params: fcParams,
            });
            fnOutput = { remembered: true, event_id: eventId };
            executedActions.push({ type: 'remember_event', event_id: eventId });
          } else {
            fnOutput = { error: 'unknown function' };
          }

          fnResults.push({ functionResponse: { name, response: fnOutput } });
        }

        // Send function results back and get the final text
        result = await chat.sendMessage(fnResults);
        response = result.response;
      }

      let replyRaw = '';
      try {
        replyRaw = response.text().trim();
      } catch (e) {
        logger.warn({ modelId, sessionId, err: e?.message }, '[flight-engineer] response.text() failed');
        replyRaw = '';
      }

      // Extract [SUGGEST: a | b | c] block before any other processing
      let suggestions = [];
      const suggestMatch = replyRaw.match(/\[SUGGEST:\s*([^\]]+)\]/i);
      if (suggestMatch) {
        suggestions = suggestMatch[1]
          .split('|')
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && s.length <= 80);
        replyRaw = replyRaw.replace(/\[SUGGEST:[^\]]+\]/gi, '').trim();
      }

      let replyText = replyRaw;
      if (!replyText) {
        const synth = synthesizeFallbackFromEngineerActions(pilotLoc, executedActions);
        if (!synth) {
          logger.warn({ modelId, sessionId }, '[flight-engineer] empty reply text — block/safety/off-model');
          replyText =
            pilotLoc === 'en'
              ? 'I did not get a usable text reply from the model this round (tools or safety filter). Please ask again in one short sentence.'
              : pilotLoc === 'zh'
                ? '本轮未收到有效文本回复（工具或安全过滤）。请用简短中文再问一次。'
                : 'לא קיבלתי טקסט תקין מהמודל בשיחה הזו (לעיתים קורה עם כלי פונקציה או סינון). נסח שוב בקצרה או לחץ שוב על שליחה.';
        } else {
          replyText = synth;
        }
      } else {
        replyText = sanitizeEngineerReply(replyText, text, { telemetry, memory: memoryBlock });
        replyText = guardReplyAgainstSttHallucination(replyText, text, telemetry);
      }
      logger.info({ modelId, sessionId, actions: executedActions.length, suggestChips: suggestions.length }, '[flight-engineer] chat ok');
      return {
        text: replyText,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
        actions: executedActions,
        notes: getNotes(db, sessionId),
        pendingChange: pendingParamChanges.get(sessionId) ?? null,
      };

    } catch (err) {
      const msg = err?.message ?? '';
      // Only give up entirely on permanent auth/key errors — everything else is worth trying the next model.
      const isPermanent = msg.includes('401') || msg.includes('API_KEY_INVALID')
        || msg.includes('PERMISSION_DENIED') || msg.includes('API key not valid');
      logger.warn({ modelId, err: msg }, '[flight-engineer] model attempt failed');
      lastErr = err;
      if (isPermanent) break;
      // For all other errors (400, 503, rate-limit, schema, etc.) — try next model in chain.
    }
  }

  logger.error({ err: lastErr }, '[flight-engineer] all models failed');
  return { text: cleanFriendlyError(lastErr?.message, pilotLoc), actions: [] };
}

// ── TTS via ElevenLabs ────────────────────────────────────────────────────────────
/** Docs: flagship expressive synthesis, 70+ languages (incl. Hebrew). Best “human” tier for TTS API. */
export const ELEVENLABS_FLAGSHIP_MODEL = 'eleven_v3';
/** Real-time tier when you override ELEVENLABS_MODEL — ~75ms inference; trade naturalness for speed. */
export const ELEVENLABS_FAST_MODEL = 'eleven_flash_v2_5';

function elevenEnvFloat(key, fallback, lo, hi) {
  const raw = process.env[key];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function elevenEnvInt(key, fallback, lo, hi) {
  const raw = process.env[key];
  if (raw == null || raw === '') return fallback;
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Resolved ElevenLabs TTS options (env + defaults). Used by streamTts and /api status.
 */
export function getElevenLabsTtsPlaybackConfig() {
  const modelId = String(process.env.ELEVENLABS_MODEL || '').trim() || ELEVENLABS_FLAGSHIP_MODEL;
  const optimizeLatency = elevenEnvInt('ELEVENLABS_OPTIMIZE_LATENCY', 2, 0, 4);
  const boostRaw = String(process.env.ELEVENLABS_SPEAKER_BOOST ?? '1').toLowerCase();
  const useSpeakerBoost = !['0', 'false', 'no', 'off'].includes(boostRaw);
  return {
    voiceId: process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB',
    modelId,
    optimizeLatency,
    voiceSettings: {
      // Lower stability + higher style → less flat/robotic on Hebrew; override via .env if needed.
      stability:        elevenEnvFloat('ELEVENLABS_STABILITY', 0.36, 0, 1),
      similarity_boost: elevenEnvFloat('ELEVENLABS_SIMILARITY', 0.80, 0, 1),
      style:            elevenEnvFloat('ELEVENLABS_STYLE', 0.38, 0, 1),
      use_speaker_boost: useSpeakerBoost,
    },
    tierHint: modelId.includes('flash') ? 'latency' : 'expressive',
  };
}

/**
 * Safe ElevenLabs `voice_id` from client input — rejects garbage / injection attempts.
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeElevenLabsVoiceId(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  if (!/^[a-zA-Z0-9_-]{10,64}$/.test(s)) return null;
  return s;
}

/**
 * Stream TTS audio from ElevenLabs.
 * Returns a Node.js Readable stream (audio/mpeg) or null if not configured.
 * Caller is responsible for piping to res. Uses global fetch (Node 18+) and
 * Readable.fromWeb — not node-fetch (not a project dependency).
 * @param {string} text
 * @param {string} [_lang]
 * @param {{ voiceId?: string|null }} [opts]
 */
export async function streamTts(text, _lang = 'he', opts = {}) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;

  const cfg = getElevenLabsTtsPlaybackConfig();
  const override = normalizeElevenLabsVoiceId(opts.voiceId);
  const voiceId = override || cfg.voiceId;
  const { modelId, optimizeLatency, voiceSettings } = cfg;

  const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`);
  // eleven_v3 rejects optimize_streaming_latency (400 unsupported_model).
  if (!String(modelId).includes('eleven_v3')) {
    url.searchParams.set('optimize_streaming_latency', String(optimizeLatency));
  }

  const resp = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: voiceSettings,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    logger.warn({ status: resp.status, body: body.slice(0, 200) }, '[flight-engineer] ElevenLabs TTS error');
    return null;
  }

  if (!resp.body) {
    logger.warn('[flight-engineer] ElevenLabs TTS empty body');
    return null;
  }

  return Readable.fromWeb(resp.body);
}

/**
 * Detect language of text (Hebrew / Chinese / English) for TTS hints.
 */
export function detectLang(text) {
  const s = String(text || '');
  if (/[\u0590-\u05FF]/.test(s)) return 'he';
  if (/[\u4e00-\u9fff]/.test(s)) return 'zh';
  return 'en';
}
