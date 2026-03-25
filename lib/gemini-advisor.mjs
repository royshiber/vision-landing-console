import { GoogleGenerativeAI } from '@google/generative-ai';
import { resolveGeminiModelName } from './gemini-model.mjs';
import { buildRetrievalContext, getLatestCodeDigest } from './retrieval.mjs';

/** Why: deterministic offline fallback when Gemini is unavailable. What: returns Hebrew heuristic reply from tuning params. */
export function localKeywordReply(question, params) {
  const q = String(question || '').toLowerCase();
  let reply = 'המלצה בסיסית: שנה פרמטר אחד בכל ניסוי, ושמור פרופיל לפני ואחרי.';
  if (q.includes('נדנוד') || q.includes('oscillation')) {
    reply = `יש סימן לנדנוד. נסה xtrack_gain נמוך יותר (${params?.xtrack_gain ?? '?'}), והגדל abort_conf_hold_s כדי למנוע תיקון חד.`;
  } else if (q.includes('הצפה') || q.includes('flare')) {
    reply = 'לשיפור ההצפה: בדוק flare_alt_m מעט גבוה יותר וזווית flare_pitch_up_deg בצעדים קטנים.';
  } else if (q.includes('ביטחון') || q.includes('confidence')) {
    reply = 'אם ביטחון יורד בסוף הגישה, שקול להעלות vision_enable_alt_m ו-vision_conf_min שמרני יותר.';
  } else if (q.includes('מהירות') || q.includes('speed')) {
    reply = 'מהירות גישה גבוהה מקשה על דיוק. נסה להוריד approach_speed_ms מעט ולשמור sink_rate_ms יציב.';
  }
  return reply;
}

/** Why: assemble one assistant reply using DB context + optional Gemini. What: returns { reply, source }. */
export async function runAdvisor({ question, params, db, flightId = null, liveState = null }) {
  const retrieval = buildRetrievalContext(db, question, { flightId });
  const digest = getLatestCodeDigest(db);
  const digestLines = digest
    ? `עדכון קוד אחרון מה-GitHub (אוטומטי): branch=${digest.branch || '?'} commit=${(digest.commit_sha || '').slice(0, 12)} נכנס ב-${digest.received_at}\nקבצים/סיכום:\n${String(digest.files_changed_text || digest.payload_json || '').slice(0, 6000)}`
    : '(עדיין לא התקבל עדכון קוד אוטומטי מ-GitHub Actions — ודא שה-workflow רץ.)';

  const paramBlock = JSON.stringify(params || {}, null, 2).slice(0, 4000);

  // Inject live telemetry so Gemini can reason about current system state, not just history.
  let liveBlock = '';
  if (liveState) {
    const { vision, jetson, slam } = liveState;
    const visionLine = vision.fresh
      ? `Vision LIVE: confidence=${(vision.confidence * 100).toFixed(0)}%, lateralOffset=${vision.lateralOffsetM}m, headingErr=${vision.headingErrorDeg}°, frames=${vision.frameCount}`
      : `Vision: לא מחובר או ישן (${vision.ageMs != null ? Math.round(vision.ageMs / 1000) + 's ago' : 'N/A'})`;
    const jetsonLine = jetson.online
      ? `Jetson: ONLINE — CPU ${jetson.cpuLoadPct ?? '?'}%, ${jetson.tempC ?? '?'}°C`
      : 'Jetson: לא מחובר';
    const slamLine = slam.ageMs != null && slam.ageMs < 10000
      ? `SLAM: pos=(${slam.posX},${slam.posY},${slam.posZ}m), yaw=${slam.yawDeg}°, quality=${slam.mapQuality ? (slam.mapQuality * 100).toFixed(0) + '%' : '?'}, loopClosures=${slam.loopClosures}`
      : 'SLAM: לא פעיל';
    liveBlock = `\n\nמצב מערכת בזמן אמת:\n${jetsonLine}\n${visionLine}\n${slamLine}`;
  }

  const systemPreamble = `אתה יועץ טיסה ונחיתה לפרויקט Vision Landing Console (ArduPilot + Jetson + vision).
ענה בעברית, קצר וברור, בטיחות ראשונה. אם אין מידע במאגר — אמור זאת.
פרמטרי כיוון נוכחיים מהממשק (JSON):\n${paramBlock}\n\nהקשר מאגר (טיסות קודמות/לוגים):\n${retrieval.block}\n\n${digestLines}${liveBlock}`;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { reply: localKeywordReply(question, params), source: 'local_rules' };
  }

  try {
    const modelName = resolveGeminiModelName();
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: systemPreamble,
    });
    const result = await model.generateContent(String(question || ''));
    const text = result.response.text();
    if (!text || !String(text).trim()) {
      return { reply: localKeywordReply(question, params), source: 'local_fallback' };
    }
    return { reply: String(text).trim(), source: 'gemini' };
  } catch (err) {
    const hint = localKeywordReply(question, params);
    return {
      reply: `${hint}\n\n[שגיאת Gemini: ${err?.message || err}]`,
      source: 'local_fallback',
    };
  }
}
