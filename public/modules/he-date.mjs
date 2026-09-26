/**
 * Hebrew date control. Day, then month, then year. No native date input.
 */

export function heDateMarkup({ id, label }) {
  return `<div class="he-date-wrap">
    <span class="he-date-caption">${label}</span>
    <fieldset class="he-date" id="${id}" dir="ltr" data-he-date>
    <input data-part="day" inputmode="numeric" maxlength="2" placeholder="יום" aria-label="${label} יום" autocomplete="off" />
    <span class="he-date-sep" aria-hidden="true">/</span>
    <input data-part="month" inputmode="numeric" maxlength="2" placeholder="חודש" aria-label="${label} חודש" autocomplete="off" />
    <span class="he-date-sep" aria-hidden="true">/</span>
    <input data-part="year" inputmode="numeric" maxlength="4" placeholder="שנה" aria-label="${label} שנה" autocomplete="off" />
  </fieldset>
  </div>`;
}

export function isoFromParts(day, month, year) {
  const d = String(day || '').replace(/\D/g, '');
  const m = String(month || '').replace(/\D/g, '');
  const y = String(year || '').replace(/\D/g, '');
  if (!d && !m && !y) return '';
  if (y.length !== 4 || !d || !m) return '';
  const dn = Number(d);
  const mn = Number(m);
  const yn = Number(y);
  if (mn < 1 || mn > 12 || dn < 1 || dn > 31) return '';
  const dt = new Date(Date.UTC(yn, mn - 1, dn));
  if (dt.getUTCFullYear() !== yn || dt.getUTCMonth() !== mn - 1 || dt.getUTCDate() !== dn) return '';
  return `${y}-${String(mn).padStart(2, '0')}-${String(dn).padStart(2, '0')}`;
}

export function bindHeDate(root, onChange) {
  let last = '';
  function emit() {
    const next = isoFromParts(
      root.querySelector('[data-part="day"]')?.value,
      root.querySelector('[data-part="month"]')?.value,
      root.querySelector('[data-part="year"]')?.value,
    );
    if (next === last) return;
    last = next;
    onChange(next);
  }
  for (const part of ['day', 'month', 'year']) {
    const input = root.querySelector(`[data-part="${part}"]`);
    if (!input) continue;
    input.addEventListener('input', () => {
      const max = part === 'year' ? 4 : 2;
      input.value = input.value.replace(/\D/g, '').slice(0, max);
      emit();
    });
  }
}
