/**
 * Free-form mission and camera sentences → a plan and a short Hebrew reply.
 * This mapper never sends MAVLink and never calls the flight-op sender.
 * Whole-phrase flight allowlist, ARM, DISARM, and negation stay on their own path.
 */

import { matchVoiceFlightPhrase } from '../../public/modules/voice-flight-phrases.mjs';
import { CAMERA_NAME_HE } from '../../public/modules/camera-names.mjs';

const MODES = Object.freeze([
  'LOOK',
  'KEEP_IN_FRAME',
  'LOCK',
  'NEXT',
  'UNLOCK',
  'SEARCH',
  'SCAN',
  'ALERT',
  'ORBIT_TARGET',
]);

const COLORS = Object.freeze([
  ['ירוקה', 'ירוק'],
  ['ירוק', 'ירוק'],
  ['green', 'ירוק'],
  ['אדומה', 'אדום'],
  ['אדום', 'אדום'],
  ['red', 'אדום'],
  ['כחולה', 'כחול'],
  ['כחול', 'כחול'],
  ['blue', 'כחול'],
  ['צהובה', 'צהוב'],
  ['צהוב', 'צהוב'],
  ['yellow', 'צהוב'],
  ['לבנה', 'לבן'],
  ['לבן', 'לבן'],
  ['white', 'לבן'],
  ['שחורה', 'שחור'],
  ['שחור', 'שחור'],
  ['black', 'שחור'],
]);

const OBJECTS = Object.freeze([
  ['שלט', 'שלט'],
  ['sign', 'שלט'],
  ['אנשים', 'אנשים'],
  ['people', 'אנשים'],
  ['אדם', 'אדם'],
  ['person', 'אדם'],
  ['חיות', 'חיות'],
  ['animals', 'חיות'],
  ['חיה', 'חיה'],
  ['animal', 'חיה'],
  ['מכוניות', 'מכוניות'],
  ['cars', 'מכוניות'],
  ['רכבים', 'מכוניות'],
  ['מכונית', 'מכונית'],
  ['רכב', 'מכונית'],
  ['car', 'מכונית'],
]);

function norm(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function isLetter(ch) {
  return Boolean(ch) && /\p{L}/u.test(ch);
}

function hasWord(text, word) {
  const t = String(text || '');
  const tok = String(word || '');
  if (!tok) return false;
  let from = 0;
  while (from <= t.length - tok.length) {
    const idx = t.indexOf(tok, from);
    if (idx < 0) return false;
    const prev = idx > 0 ? t.charAt(idx - 1) : '';
    const next = t.charAt(idx + tok.length);
    const article = prev === 'ה' && (idx === 1 || !isLetter(t.charAt(idx - 2)));
    const before = idx === 0 || !isLetter(prev) || article;
    const after = !next || !isLetter(next);
    if (before && after) return true;
    from = idx + 1;
  }
  return false;
}

function findListed(text, rows) {
  const ordered = [...rows].sort((a, b) => b[0].length - a[0].length);
  for (const [word, value] of ordered) {
    if (hasWord(text, word)) return value;
  }
  return '';
}

function readTarget(text) {
  const color = findListed(text, COLORS);
  const object = findListed(text, OBJECTS);
  if (!color && !object) return null;
  const target = {};
  if (color) target.color = color;
  if (object) target.object = object;
  return target;
}

function step(mode, extra = {}) {
  return {
    mode,
    supported: extra.supported !== false,
    target: extra.target === undefined ? null : extra.target,
    ...extra,
  };
}

function planResult(steps, replyHe) {
  return {
    plan: {
      steps,
      modes: steps.map((row) => row.mode).filter((mode) => MODES.includes(mode)),
    },
    replyHe,
    sends: false,
  };
}

function readDurationSec(text) {
  const q = String(text || '');
  const he = q.match(/(?:במשך\s+|ל)?(עשר|עשרה)\s+דקות/);
  if (he) return 600;
  const en = q.match(/\b(?:for\s+)?(?:ten|10)\s+minutes?\b/);
  if (en) return 600;
  const num = q.match(/\b(\d+)\s+minutes?\b/);
  if (num) {
    const n = Number(num[1]);
    if (Number.isFinite(n) && n > 0 && n <= 180) return n * 60;
  }
  return null;
}

function hasDurationAsk(text) {
  return /כמה זמן|לכמה|for how long|what duration/.test(text);
}

function isNegated(q) {
  return /^(?:אל|לא)\s+/.test(q) || /^(?:do not|don't|dont|never|not)\b/.test(q);
}

function isGrab(q) {
  return /תפוס|תתפסו|לאחוז|אחוז|אחיזה|\bgrab\b|\bcatch\b|\bseize\b/.test(q);
}

function isOrbit(q) {
  return /\b(?:circle|orbit)\b/.test(q) || /הקף|תקיף|הקפה|לחוג|תחגו/.test(q);
}

function isRelease(q) {
  return /(?:שחררו|שחרר|שחררי|בטלו|בטל|בטלי)\s+(?:את\s+)?(?:ה)?נעילה/.test(q);
}

function isNext(q) {
  return /(?:תעברו|עברו|עבורו)\s+ל(?:אובייקט|עצם)\s+הבא/.test(q)
    || /(?:לאובייקט|לעצם|האובייקט|העצם)\s+הבא/.test(q)
    || /\bnext object\b/.test(q);
}

function isLock(q) {
  if (/\block\b/.test(q)) return true;
  if (/נעל את|נעל על/.test(q)) return true;
  if (['תנעל', 'תנעלו', 'נעלו', 'לנעול', 'נעל'].some((word) => hasWord(q, word))) return true;
  if (isRelease(q)) return false;
  return /נעילה/.test(q);
}

function isPeopleCount(q) {
  return /כמה אנשים/.test(q);
}

function isDetectAsk(q) {
  return /מה אתה מזהה|מה אתם מזהים|מה את מזהה/.test(q);
}

function flightRefusals(q) {
  const refused = [];
  if (/\barm\b|תחמש|תחימש|חימוש|לחמש|חמש את/.test(q)) refused.push('ARM');
  if (/\bdisarm\b|נטרול|לנטרל|תנטרל|נטרל/.test(q)) refused.push('DISARM');
  if (/תחזור\s+הבית|חזור\s+הבית|חזרו\s+הבית|חזרה\s+הבית|\brtl\b/.test(q)) refused.push('RTL');
  if (/\bland\b|תנחית|נחיתה עכשיו|נחיתה אוטומטית/.test(q)) refused.push('LAND');
  if (q.includes('שיוט') || /\bcruise\b/.test(q)) refused.push('CRUISE');
  return refused;
}

function spokenTarget(target) {
  if (target?.object === 'מכונית') return 'הרכב';
  if (target?.object === 'אדם') return 'האדם';
  if (target?.object === 'אנשים') return 'האנשים';
  if (target?.object) return `ה${target.object}`;
  return '';
}

function lockActive(vision) {
  if (!vision || vision.lock == null) return false;
  const id = vision.lock.id;
  return id != null && String(id) !== '';
}

const KIND_HE = Object.freeze({
  person: 'אדם',
  car: 'רכב',
  truck: 'משאית',
  bus: 'אוטובוס',
});

function kindName(row) {
  const label = String(row?.label_he || '').trim();
  if (label) return label;
  return KIND_HE[String(row?.class || '').toLowerCase()] || '';
}

function isPersonRow(row) {
  const cls = String(row?.class || '').toLowerCase();
  const label = String(row?.label_he || '').trim();
  return cls === 'person' || label === 'אדם' || label === 'אנשים';
}

function detectionState(vision) {
  if (!vision || typeof vision !== 'object') return 'no_stream';
  if (vision.enabled === false || vision.reason_he === 'הזיהוי כבוי') return 'off';
  if (vision.model === false || vision.reason_he === 'אין מודל זיהוי') return 'no_model';
  if (vision.stream === false || vision.reason_he === 'אין נתון על זרם המצלמות') return 'no_stream';
  if (!Array.isArray(vision.tracks)) return 'no_stream';
  return 'live';
}

const COLOR_AGREE = Object.freeze({
  אדום: { m: 'אדום', f: 'אדומה', mp: 'אדומים', fp: 'אדומות' },
  ירוק: { m: 'ירוק', f: 'ירוקה', mp: 'ירוקים', fp: 'ירוקות' },
  כחול: { m: 'כחול', f: 'כחולה', mp: 'כחולים', fp: 'כחולות' },
});

const FEMININE_KINDS = new Set(['משאית']);

function suppliedColor(row) {
  return String(row?.color_he || '').trim();
}

function agreeColor(color, feminine, plural) {
  const forms = COLOR_AGREE[color];
  if (!forms) return color;
  if (plural) return feminine ? forms.fp : forms.mp;
  return feminine ? forms.f : forms.m;
}

function detectionGroups(tracks) {
  const groups = [];
  const index = new Map();
  for (const row of tracks) {
    const name = kindName(row);
    if (!name) continue;
    const color = suppliedColor(row);
    const key = `${name}\0${color}`;
    const found = index.get(key);
    if (found) found.n += 1;
    else {
      const group = { name, color, n: 1, person: isPersonRow(row) };
      index.set(key, group);
      groups.push(group);
    }
  }
  return groups;
}

function groupPhrase(group) {
  const feminine = FEMININE_KINDS.has(group.name);
  const pluralPeople = group.person && group.n !== 1;
  const color = group.color ? agreeColor(group.color, feminine, pluralPeople) : '';
  if (pluralPeople) return color ? `${group.n} אנשים ${color}` : `${group.n} אנשים`;
  if (group.person) return color ? `אדם ${color} 1` : 'אדם 1';
  return color ? `${group.name} ${color} ${group.n}` : `${group.name} ${group.n}`;
}

function detectionReply(vision, peopleOnly) {
  const state = detectionState(vision);
  if (state === 'off') return 'הזיהוי כבוי.';
  if (state === 'no_model') return 'אין מודל זיהוי.';
  if (state === 'no_stream') return 'אין נתון על זרם המצלמות.';
  const tracks = vision.tracks;
  if (peopleOnly) {
    const n = tracks.filter(isPersonRow).length;
    if (n === 0) return 'אין אנשים בזיהוי.';
    if (n === 1) return 'רואים אדם אחד.';
    return `רואים ${n} אנשים.`;
  }
  if (!tracks.length) return 'אין עצמים בזיהוי.';
  const groups = detectionGroups(tracks);
  if (!groups.length) return tracks.length === 1 ? 'מזהים עצם אחד.' : `מזהים ${tracks.length} עצמים.`;
  return `מזהים ${groups.map(groupPhrase).join(', ')}.`;
}

function refusalPhrase(kind) {
  if (kind === 'ARM') return 'חימוש נחסם';
  if (kind === 'DISARM') return 'נטרול נחסם';
  if (kind === 'LAND') return 'נחיתה נדחתה';
  if (kind === 'CRUISE') return 'שיוט נדחה';
  if (kind === 'RTL') return 'חזרה הביתה נדחתה';
  return 'המצב נדחה';
}

function visionSpeechResult(q, vision) {
  const simpleLook = (isLook(q) || isKeep(q) || isScan(q) || isAlert(q) || isOrbit(q))
    && !flightRefusals(q).length
    && !isRelease(q)
    && !isNext(q)
    && !isDetectAsk(q)
    && !isPeopleCount(q);
  if (simpleLook) return null;
  const release = isRelease(q);
  const next = isNext(q);
  const people = isPeopleCount(q);
  const detect = isDetectAsk(q);
  const lock = isLock(q);
  const refused = flightRefusals(q);
  if (!release && !next && !people && !detect && !lock && !refused.length) return null;
  if (!release && !next && !people && !detect && !lock) return null;

  if ((people || detect) && !lock && !next && !release && !refused.length) {
    return {
      speech: true,
      plan: { steps: [], modes: [], detection: people ? 'people' : 'objects' },
      replyHe: detectionReply(vision, people),
      sends: false,
    };
  }

  const steps = [];
  const bits = [];
  if (lock) {
    const target = readTarget(q);
    steps.push(step('LOCK', { target }));
    const name = spokenTarget(target);
    bits.push(name ? `הנעילה על ${name} בתוכנית` : 'הנעילה בתוכנית');
  }
  if (next) {
    steps.push(step('NEXT', { target: null }));
    bits.push('המעבר לעצם הבא בתוכנית');
  }
  if (release) {
    const active = lockActive(vision);
    steps.push(step('UNLOCK', { target: null, active }));
    if (!active && !lock && !next) {
      const tail = refused.map(refusalPhrase);
      const reply = tail.length
        ? `אין נעילה פעילה. ${tail.join('. ')}. לא נשלח דבר.`
        : 'אין נעילה פעילה.';
      return {
        speech: true,
        plan: {
          steps,
          modes: ['UNLOCK'],
          refused,
        },
        replyHe: reply,
        sends: false,
      };
    }
    if (active) bits.push('שחרור הנעילה בתוכנית');
  }
  if (people || detect) bits.push(detectionReply(vision, people).replace(/\.$/, ''));
  for (const kind of refused) bits.push(refusalPhrase(kind));
  if (!bits.length) return null;
  const replyHe = `${bits.join('. ')}. לא נשלח דבר.`;
  const result = planResult(steps, replyHe);
  result.speech = true;
  if (refused.length) result.plan.refused = refused;
  return result;
}

function isLook(q) {
  return /תסתכל|תסתכלו|הסתכל|הבט על|\blook at\b/.test(q);
}

function isKeep(q) {
  return /תשאיר|השאר|שמור אותו|בפריים|\bkeep\b.{0,24}\b(?:in|inside)\b.{0,16}\bframe\b|\block\b.{0,12}\bframe\b/.test(q);
}

function isScan(q) {
  return /\bscan\b/.test(q) || /תסרוק|תסרקו|סריקה|לסרוק/.test(q) || hasWord(q, 'סרוק');
}

function isAlert(q) {
  return /\balert\b/.test(q) || /התרא|תתריע|אם .{0,40}זז/.test(q);
}

function isCameraQuestion(q) {
  if (/משדר|streaming|זרם הווידאו|האם יש וידאו/.test(q)) return false;
  if (/מה אני רואה ב/.test(q) && /מצלמ/.test(q)) return true;
  if (/מה (?:ה)?מצלמות רואות/.test(q)) return true;
  if (/מה רואות המצלמות/.test(q)) return true;
  if (/מה עם המצלמות/.test(q)) return true;
  if (/\bwhat (?:do|are) the cameras\b/.test(q)) return true;
  if (/\bwhat about the cameras\b/.test(q)) return true;
  return false;
}

function cameraReply() {
  return `המצלמות הן ${CAMERA_NAME_HE.cam0}, ${CAMERA_NAME_HE.cam1} ו${CAMERA_NAME_HE.cam3}.`;
}

function durationPhrase(durationSec) {
  const minutes = Math.round(Number(durationSec) / 60);
  if (minutes === 10) return 'עשר דקות';
  if (minutes === 1) return 'דקה';
  if (Number.isFinite(minutes) && minutes > 1) return `${minutes} דקות`;
  return 'עשר דקות';
}

function scanReply(durationSec, alertSubjects) {
  const head = durationSec == null
    ? 'סורקים עד פקודה שעוצרת או מחליפה.'
    : `סורקים ${durationPhrase(durationSec)}.`;
  if (!alertSubjects.length) return head;
  const list = alertSubjects.join(', ').replace(/, ([^,]+)$/, ' או $1');
  return `${head} התראה אם ${list} זזים. ההתראה לא עוצרת את הסריקה.`;
}

function alertSubjects(text) {
  const found = [];
  if (/אנשים|\bpeople\b|\bpersons?\b/.test(text)) found.push('אנשים');
  if (/חיות|\banimals?\b/.test(text)) found.push('חיות');
  if (/מכוניות|רכבים|\bcars?\b/.test(text)) found.push('מכוניות');
  return found;
}

/**
 * @returns {{ plan: { steps: object[], modes: string[] }, replyHe: string, sends: false }|null}
 */
export function mapMissionSentence(rawText, vision = null) {
  const q = norm(rawText);
  if (!q) return null;
  const flight = matchVoiceFlightPhrase(rawText);
  if (flight?.sendable || flight?.blocked || flight?.negated) return null;
  if (isNegated(q)) return null;
  if (hasDurationAsk(q)) return null;

  if (isGrab(q)) {
    return {
      plan: {
        steps: [{ verb: 'grab', supported: false, target: readTarget(q) }],
        modes: [],
        unsupported: ['grab'],
      },
      replyHe: 'אחיזה אינה נתמכת. לא נשלח דבר.',
      sends: false,
    };
  }

  if (isCameraQuestion(q)) {
    return {
      plan: {
        steps: [],
        modes: [],
        cameras: [
          { id: 'cam0', nameHe: CAMERA_NAME_HE.cam0 },
          { id: 'cam1', nameHe: CAMERA_NAME_HE.cam1 },
          { id: 'cam3', nameHe: CAMERA_NAME_HE.cam3 },
        ],
      },
      replyHe: cameraReply(),
      sends: false,
    };
  }

  const speech = visionSpeechResult(q, vision);
  if (speech) return speech;

  if (isOrbit(q) || (isLock(q) && /\bit\b|אותו|אותה/.test(q) && isOrbit(q))) {
    const target = readTarget(q);
    const steps = [];
    if (isOrbit(q)) steps.push(step('ORBIT_TARGET', { supported: false, target }));
    if (isLock(q)) steps.push(step('LOCK', { supported: true, target }));
    if (!steps.length) return null;
    const reply = steps.some((row) => row.mode === 'ORBIT_TARGET')
      ? 'הקפה סביב מטרה אינה נתמכת. לא נשלח דבר.'
      : 'הנעילה בתוכנית. לא נשלח דבר.';
    return planResult(steps, reply);
  }

  if (isLook(q) || isKeep(q)) {
    const target = readTarget(q);
    const steps = [];
    if (isLook(q)) steps.push(step('LOOK', { target }));
    if (isKeep(q)) steps.push(step('KEEP_IN_FRAME', { target }));
    if (isLock(q) && !isKeep(q)) steps.push(step('LOCK', { target }));
    if (!steps.length) return null;
    const name = target?.color && target?.object
      ? `ה${target.object} ה${target.color}`
      : (target?.object ? `ה${target.object}` : 'המטרה');
    const bits = [];
    if (steps.some((row) => row.mode === 'LOOK')) bits.push(`מסתכלים על ${name}`);
    if (steps.some((row) => row.mode === 'KEEP_IN_FRAME')) bits.push('שומרים אותו בפריים');
    return planResult(steps, `${bits.join(' ו')}.`);
  }

  if (isScan(q) || isAlert(q)) {
    const durationSec = readDurationSec(q);
    const subjects = isAlert(q) ? alertSubjects(q) : [];
    const steps = [];
    if (isScan(q) || subjects.length) {
      steps.push(step('SCAN', {
        target: null,
        duration_s: durationSec,
        until: durationSec == null ? 'replaced' : null,
      }));
    }
    if (subjects.length || (isAlert(q) && isScan(q))) {
      steps.push(step('ALERT', {
        target: null,
        subjects,
        motion: /זז|\bmove/.test(q),
        stopsScan: false,
      }));
    }
    if (!steps.length) return null;
    return planResult(steps, scanReply(isScan(q) ? durationSec : null, subjects));
  }

  if (isLock(q)) {
    const target = readTarget(q);
    return planResult(
      [step('LOCK', { target })],
      'הנעילה בתוכנית. לא נשלח דבר.',
    );
  }

  return null;
}
