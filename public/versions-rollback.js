(function initVersionsRollback() {
  const root = document.getElementById('gsVersions');
  if (!root) return;
  const UNKNOWN = 'אין מידע';
  let latest = null;
  let pending = null;
  let localPhase = 'idle';
  let pollTimer = null;

  function el(id) { return document.getElementById(id); }
  function text(id, value) {
    const node = el(id);
    if (!node) return;
    node.textContent = value == null || value === '' ? UNKNOWN : String(value);
  }
  function formatWhen(value) {
    if (!value) return UNKNOWN;
    const raw = String(value).trim();
    const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const date = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`);
    if (Number.isNaN(date.getTime())) return raw;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  function phaseOf(view) {
    if (localPhase === 'confirm') return 'confirm';
    if (localPhase === 'running' || view?.rollback?.state === 'running') return 'progress';
    if (localPhase === 'failed' || view?.rollback?.state === 'failed') return 'failed';
    if (!view?.companion?.linked) return 'no-companion';
    return 'normal';
  }
  function show(node, on) {
    if (!node) return;
    node.hidden = !on;
  }
  function paintBackups(companion) {
    const list = el('vrBackups');
    if (!list) return;
    list.replaceChildren();
    if (!companion?.linked) {
      const item = document.createElement('li');
      item.className = 'vr-backup';
      item.textContent = UNKNOWN;
      list.appendChild(item);
      return;
    }
    const rows = Array.isArray(companion.backups) ? companion.backups : [];
    if (!rows.length) {
      const item = document.createElement('li');
      item.className = 'vr-backup';
      item.textContent = 'אין גיבויים';
      list.appendChild(item);
      return;
    }
    rows.forEach((row) => {
      const item = document.createElement('li');
      item.className = 'vr-backup';
      const ver = document.createElement('p');
      ver.className = 'vr-fromto';
      ver.textContent = row.version || UNKNOWN;
      const when = document.createElement('p');
      when.className = 'vr-note';
      when.textContent = formatWhen(row.deployedAt);
      const mark = document.createElement('p');
      mark.className = 'vr-note';
      mark.textContent = row.knownGood ? 'עבד טוב' : '';
      if (!row.knownGood) mark.hidden = true;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vr-btn';
      btn.textContent = 'החזרה לגיבוי זה';
      btn.addEventListener('click', () => {
        openConfirm('companion', companion.version, row.version || null, row.id);
      });
      item.append(ver, when, mark, btn);
      list.appendChild(item);
    });
  }
  function paint(view) {
    latest = view;
    const phase = phaseOf(view);
    root.dataset.vrState = phase;
    const console = view?.console || {};
    text('vrConsoleVersion', console.version);
    text('vrConsoleInstalled', formatWhen(console.installedAt));
    text('vrConsolePrevious', console.previousVersion);
    const note = el('vrConsoleRollbackNote');
    const consoleBtn = el('vrConsoleRollbackBtn');
    if (note) {
      note.hidden = console.rollbackAvailable === true;
      note.textContent = console.rollbackUnavailableReason || 'אין עותק של הגרסה הקודמת. החזרה לא זמינה.';
    }
    if (consoleBtn) consoleBtn.disabled = console.rollbackAvailable !== true || phase === 'progress';
    const companion = view?.companion || {};
    text('vrCompanionLink', companion.linked ? 'מקושר' : 'אין קישור למחשב המשימה');
    text('vrCompanionVersion', companion.linked ? companion.version : null);
    text('vrCompanionDeployed', companion.linked ? formatWhen(companion.deployedAt) : null);
    text('vrCompanionSha', companion.linked ? companion.gitSha : null);
    paintBackups(companion);
    const fcAt = view?.fcParams?.snapshotAt;
    text('vrFcSnapshot', fcAt ? formatWhen(fcAt) : null);
    const known = view?.knownGood;
    const knownNode = el('vrKnownGoodStatus');
    if (knownNode) {
      if (!known?.at) knownNode.textContent = UNKNOWN;
      else {
        const how = known.source === 'flight' ? 'סומן אחרי טיסה בלי שגיאות' : 'סומן ידנית';
        knownNode.textContent = `${how} ${formatWhen(known.at)}`;
      }
    }
    const confirm = el('vrConfirm');
    show(confirm, phase === 'confirm');
    if (phase === 'confirm' && pending) {
      text('vrConfirmFrom', `מ־ ${pending.from || UNKNOWN}`);
      text('vrConfirmTo', `אל ${pending.to || UNKNOWN}`);
    }
    const progress = el('vrProgress');
    show(progress, phase === 'progress');
    if (progress && phase === 'progress') {
      const from = pending?.from || view?.rollback?.from || UNKNOWN;
      const to = pending?.to || view?.rollback?.to || UNKNOWN;
      progress.textContent = `מחזירים גרסה. מ־ ${from} אל ${to}`;
    }
    const error = el('vrError');
    const failed = phase === 'failed';
    show(error, failed);
    if (error && failed) {
      error.textContent = localPhase === 'failed'
        ? (pending?.error || view?.rollback?.error || 'ההחזרה נכשלה.')
        : (view?.rollback?.error || 'ההחזרה נכשלה.');
    }
  }
  function openConfirm(kind, from, to, backupId) {
    pending = { kind, from: from || null, to: to || null, backupId: backupId || null, error: null };
    localPhase = 'confirm';
    paint(latest);
  }
  function closeConfirm() {
    pending = null;
    localPhase = 'idle';
    paint(latest);
  }
  async function load() {
    const res = await fetch('/api/versions', { cache: 'no-store' });
    if (!res.ok) throw new Error('versions');
    const data = await res.json();
    if (localPhase === 'running' && data?.rollback?.state === 'failed') {
      localPhase = 'failed';
      if (pending) pending.error = data.rollback.error || 'ההחזרה נכשלה.';
    }
    if (localPhase === 'running' && data?.rollback?.state === 'idle' && data?.rollback?.kind == null) {
      /* still waiting on the companion restart */
    }
    paint(data);
    return data;
  }
  async function poll(expectedTo) {
    const started = Date.now();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (Date.now() - started > 45000) {
        clearInterval(pollTimer);
        localPhase = 'failed';
        if (pending) pending.error = 'ההחזרה לא הסתיימה.';
        paint(latest);
        return;
      }
      try {
        const data = await load();
        const doneConsole = pending?.kind === 'console' && data?.console?.version && expectedTo && data.console.version === expectedTo;
        const doneCompanion = pending?.kind === 'companion' && data?.companion?.version && expectedTo && data.companion.version === expectedTo;
        if (doneConsole) {
          clearInterval(pollTimer);
          location.reload();
          return;
        }
        if (doneCompanion || (localPhase === 'failed')) {
          clearInterval(pollTimer);
          if (doneCompanion) {
            localPhase = 'idle';
            pending = null;
            paint(data);
          }
        }
      } catch {
        paint(latest);
      }
    }, 2000);
  }
  async function sendRollback() {
    if (!pending) return;
    const body = {
      confirm: true,
      from: pending.from,
      to: pending.to,
      backupId: pending.backupId,
    };
    const path = pending.kind === 'console'
      ? '/api/versions/rollback/console'
      : '/api/versions/rollback/companion';
    localPhase = 'running';
    paint(latest);
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      localPhase = 'failed';
      pending.error = data.message || 'ההחזרה נכשלה.';
      paint(latest);
      return;
    }
    if (data.state === 'done') {
      localPhase = 'idle';
      pending = null;
      await load().catch(() => {});
      return;
    }
    localPhase = 'running';
    paint(latest);
    poll(data.to || pending?.to);
  }
  el('vrConsoleRollbackBtn')?.addEventListener('click', () => {
    const console = latest?.console;
    if (!console?.rollbackAvailable) return;
    openConfirm('console', console.version, console.previousVersion, null);
  });
  el('vrConfirmNo')?.addEventListener('click', () => closeConfirm());
  el('vrConfirmYes')?.addEventListener('click', () => { void sendRollback(); });
  el('vrKnownGoodBtn')?.addEventListener('click', async () => {
    const res = await fetch('/api/versions/known-good', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!res.ok) {
      localPhase = 'failed';
      pending = { error: 'לא ניתן לסמן עכשיו.' };
      paint(latest);
      return;
    }
    localPhase = 'idle';
    pending = null;
    await load().catch(() => {});
  });
  void load().catch(() => {
    paint({
      console: { version: document.querySelector('meta[name="app-version"]')?.content || null, rollbackAvailable: false, rollbackUnavailableReason: 'אין עותק של הגרסה הקודמת. החזרה לא זמינה.' },
      companion: { linked: false },
      fcParams: { snapshotAt: null },
      knownGood: null,
      rollback: { state: 'idle' },
    });
  });
})();
