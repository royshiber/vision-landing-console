/** Draft a Capability Brief from an Ask development / request intent. */

const FEATURE_DEFAULT = 'FEATURE';

export function buildCapabilityBrief({
  title,
  description,
  taxonomy,
  target_area,
  priority,
} = {}) {
  const whatTitle = String(title || '').trim() || 'יכולת חדשה';
  const whatBody = String(description || title || '').trim();
  const tax = String(taxonomy || FEATURE_DEFAULT).trim() || FEATURE_DEFAULT;
  const target = String(target_area || 'OTHER').trim() || 'OTHER';
  const modules = guessBriefModules(whatTitle, whatBody, target);
  return {
    title: whatTitle.length > 80 ? `${whatTitle.slice(0, 77)}...` : whatTitle,
    what: whatBody || 'כתבו כותרת ותיאור. הכרטיס ייבנה כאן.',
    why: guessBriefWhy(whatBody, tax),
    modules,
    taxonomy: tax,
    target_area: target,
    priority: String(priority || 'HIGH').trim() || 'HIGH',
    impact: guessBriefImpact(target, modules),
    description: whatBody || whatTitle,
  };
}

export function guessBriefModules(title, description, target) {
  const blob = `${title} ${description} ${target}`.toLowerCase();
  const modules = [];
  if (/landing|נחית|zone|אזור/.test(blob)) modules.push('Mission UI');
  if (/jetson|overlay|שכבת/.test(blob) || target === 'COMPANION') modules.push('Jetson Overlay');
  if (/debrief|תחקור|סיכום/.test(blob)) modules.push('Debrief');
  if (/voice|קול|דיבור/.test(blob)) modules.push('Voice');
  if (/ask|assist/.test(blob) || /קול|תחקור/.test(blob)) modules.push('AIRVIX Ask');
  if (/api|סוכן|agent/.test(blob)) modules.push('Agent API');
  if (target === 'LANDING' && !modules.includes('Mission UI')) modules.push('Mission UI');
  if (target === 'UI' && !modules.includes('Mission UI')) modules.push('Platform');
  if (!modules.length) modules.push('Platform', 'Agent API');
  return [...new Set(modules)].slice(0, 4);
}

export function guessBriefWhy(description, taxonomy) {
  const first = String(description || '').trim().split(/\n+/)[0];
  if (first && first.length > 12) return first.slice(0, 180);
  if (taxonomy === 'BUG') return 'מתקן התנהגות שכבר אמורה לעבוד, בלי לשנות את גבול הבטיחות.';
  if (taxonomy === 'EXPERIMENT') return 'ניסוי מבודד. התוצאה חוזרת למוצר רק אחרי אימות.';
  if (taxonomy === 'REQUEST') return 'בקשת יכולת. נפתח כטיוטה ואפשר להמשיך בפיתוח.';
  return 'מרעיון ליכולת מאומתת, בלי לשנות את מעטפת המוצר.';
}

export function guessBriefImpact(target, modules = []) {
  if (target === 'LANDING') return 'Mission + Ops';
  if (target === 'COMPANION') return 'Ops + Overlay';
  if (modules.includes('Debrief')) return 'Debrief + Ask';
  if (modules.includes('Voice')) return 'Voice + Ops';
  return 'Product + API';
}
