/** Guided checkerboard calibration. The companion decides each capture. */

export const CALIB_IDLE_HE = 'עדיין אין כיול.';

export function calibVerdictLine(body) {
  if (body?.rms_px == null || !body?.verdict) return '';
  const rms = Number(body.rms_px).toFixed(2);
  return `שגיאת הטלה ${rms} · ${body.verdict}`;
}

export function syncCalibButtons(camId, phase, live) {
  const start = document.getElementById(`${camId}CalibStart`);
  const save = document.getElementById(`${camId}CalibSave`);
  const retry = document.getElementById(`${camId}CalibRetry`);
  const running = phase === 'running';
  const review = phase === 'review';
  if (start) start.disabled = !live || running;
  if (save) save.disabled = !review;
  if (retry) retry.disabled = phase !== 'running' && !review;
}

export function paintCalib(camId, body) {
  const root = document.getElementById(`${camId}Calib`);
  const phase = body?.phase || 'idle';
  if (root) root.dataset.phase = phase;
  const progress = document.getElementById(`${camId}CalibProgress`);
  if (progress) progress.textContent = body?.progress || '0/20';
  const hint = document.getElementById(`${camId}CalibHint`);
  const hintText = phase === 'running' ? (body?.hint || '') : '';
  if (hint) {
    hint.hidden = !hintText;
    hint.textContent = hintText;
  }
  const state = document.getElementById(`${camId}CalibState`);
  if (state) {
    const verdict = calibVerdictLine(body);
    state.textContent = verdict || (body?.saved ? 'הכיול נשמר' : CALIB_IDLE_HE);
  }
  return phase;
}

export function bindCalibGuide(camId, api) {
  const start = document.getElementById(`${camId}CalibStart`);
  if (!start || start.dataset.bound === '1') return;
  start.dataset.bound = '1';
  let timer = 0;

  function live() {
    const root = document.getElementById(`${camId}Calib`);
    return root?.dataset.live === '1';
  }

  async function post(action) {
    const cols = document.getElementById(`${camId}CalibCols`);
    const rows = document.getElementById(`${camId}CalibRows`);
    const square = document.getElementById(`${camId}CalibSquare`);
    const body = await api(`/api/jetson/v1/${camId}/calibration/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action,
        inner_cols: Number(cols?.value || 9),
        inner_rows: Number(rows?.value || 6),
        square_mm: Number(square?.value || 25),
      }),
    });
    const phase = paintCalib(camId, body);
    syncCalibButtons(camId, phase, live());
    return body;
  }

  function stop() {
    clearInterval(timer);
    timer = 0;
  }

  start.addEventListener('click', () => {
    stop();
    void post('start').then((body) => {
      if (body?.phase !== 'running') return;
      timer = setInterval(() => {
        void post('observe').then((next) => {
          if (next?.phase !== 'running') stop();
        }).catch(() => stop());
      }, 700);
    }).catch(() => {
      paintCalib(camId, null);
    });
  });
  document.getElementById(`${camId}CalibSave`)?.addEventListener('click', () => {
    void post('save').catch(() => paintCalib(camId, null));
  });
  document.getElementById(`${camId}CalibRetry`)?.addEventListener('click', () => {
    stop();
    void post('retry').catch(() => paintCalib(camId, null));
  });
}

export function markCalibLive(camId, on) {
  const root = document.getElementById(`${camId}Calib`);
  if (root) root.dataset.live = on ? '1' : '0';
  syncCalibButtons(camId, root?.dataset.phase || 'idle', on === true);
}
