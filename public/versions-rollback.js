(function initVersionsRollback() {
  const root = document.getElementById('gsVersions');
  if (!root) return;
  const UNKNOWN = 'אין מידע';
  const UNKNOWN_VERSION = 'גרסה לא ידועה';
  let latest = null;
  let pending = null;
  let localPhase = 'idle';
  let pollTimer = null;
  let sending = false;

  function el(id) { return document.getElementById(id); }
  function text(id, value) {
    const node = el(id);
    if (!node) return;
    node.textContent = value == null || value === '' ? UNKNOWN : String(value);
  }
  function setVersion(id, value) {
    const node = el(id);
    if (!node) return;
    node.replaceChildren();
    if (value == null || value === '') {
      node.textContent = UNKNOWN;
      return;
    }
    const bdi = document.createElement('bdi');
    bdi.dir = 'ltr';
    bdi.textContent = String(value);
    node.appendChild(bdi);
  }
  function versionNode(value) {
    const bdi = document.createElement('bdi');
    bdi.dir = 'ltr';
    bdi.textContent = value == null || value === '' ? UNKNOWN_VERSION : String(value);
    return bdi;
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
    if (view?.rollback?.state === 'failed' || localPhase === 'failed') return 'failed';
    if (localPhase === 'running' || view?.rollback?.state === 'running') return 'progress';
    if (!view?.companion?.linked) return 'no-companion';
    return 'normal';
  }
  function show(node, on) {
    if (!node) return;
    node.hidden = !on;
  }
  function targetName(kind) {
    return kind === 'console' ? 'קונסולה' : 'מחשב משימה';
  }
  function paintBackups(companion, busy) {
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
      ver.append(versionNode(row.version));
      const when = document.createElement('p');
      when.className = 'vr-note';
      when.append('תאריך פריסה ');
      when.append(document.createTextNode(formatWhen(row.deployedAt)));
      const mark = document.createElement('p');
      mark.className = 'vr-note';
      mark.textContent = row.knownGood ? 'עבד טוב' : '';
      if (!row.knownGood) mark.hidden = true;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vr-btn vr-backup-btn';
      btn.textContent = 'החזרה לגיבוי זה';
      btn.disabled = busy;
      btn.addEventListener('click', () => {
        if (busy) return;
        openConfirm('companion', companion.version, row.version || '', row.id, row.deployedAt);
      });
      item.append(ver, when, mark, btn);
      list.appendChild(item);
    });
  }
  function paintKnown(view) {
    const known = view?.knownGood;
    const knownNode = el('vrKnownGoodStatus');
    if (!knownNode) return;
    knownNode.replaceChildren();
    if (!known?.at) {
      knownNode.textContent = 'לא סומן';
      return;
    }
    const how = known.source === 'flight' ? 'סומן אחרי טיסה בלי שגיאות' : 'סומן ידנית';
    knownNode.append(`${how} ${formatWhen(known.at)}. קונסולה `);
    knownNode.append(versionNode(known.consoleVersion));
    knownNode.append('. מחשב משימה ');
    if (known.companionVersion) knownNode.append(versionNode(known.companionVersion));
    else knownNode.append('בלי גרסה');
    if (known.source === 'flight' && known.flightId != null) {
      knownNode.append(`. טיסה ${known.flightId}`);
    }
  }
  function paint(view) {
    latest = view;
    const phase = phaseOf(view);
    root.dataset.vrState = phase;
    const busy = phase === 'progress' || phase === 'confirm';
    const console = view?.console || {};
    setVersion('vrConsoleVersion', console.version);
    text('vrConsoleInstalled', formatWhen(console.installedAt));
    setVersion('vrConsolePrevious', console.previousVersion);
    const note = el('vrConsoleRollbackNote');
    const consoleBtn = el('vrConsoleRollbackBtn');
    if (note) {
      note.hidden = console.rollbackAvailable === true;
      note.textContent = console.rollbackUnavailableReason || 'אין עותק של הגרסה הקודמת. החזרה לא זמינה.';
    }
    if (consoleBtn) consoleBtn.disabled = console.rollbackAvailable !== true || busy;
    const companion = view?.companion || {};
    text('vrCompanionLink', companion.linked ? 'מקושר' : 'אין קישור למחשב המשימה');
    if (companion.linked) setVersion('vrCompanionVersion', companion.version);
    else text('vrCompanionVersion', null);
    text('vrCompanionDeployed', companion.linked ? formatWhen(companion.deployedAt) : null);
    if (companion.linked) setVersion('vrCompanionSha', companion.gitSha);
    else text('vrCompanionSha', null);
    paintBackups(companion, busy);
    const fcAt = view?.fcParams?.snapshotAt;
    text('vrFcSnapshot', fcAt ? formatWhen(fcAt) : null);
    paintKnown(view);
    const knownBtn = el('vrKnownGoodBtn');
    if (knownBtn) knownBtn.disabled = phase === 'progress';
    const confirm = el('vrConfirm');
    show(confirm, phase === 'confirm');
    if (confirm) confirm.setAttribute('aria-hidden', phase === 'confirm' ? 'false' : 'true');
    if (phase === 'confirm' && pending) {
      text('vrConfirmTitle', `אישור החזרה של ${targetName(pending.kind)}`);
      const from = el('vrConfirmFrom');
      if (from) {
        from.replaceChildren();
        from.append('מ־');
        from.append(versionNode(pending.from));
      }
      const to = el('vrConfirmTo');
      if (to) {
        to.replaceChildren();
        to.append('אל ');
        to.append(versionNode(pending.to));
      }
      const when = el('vrConfirmWhen');
      if (when) when.textContent = `תאריך ${formatWhen(pending.when)}`;
    }
    const progress = el('vrProgress');
    show(progress, phase === 'progress');
    const progressText = el('vrProgressText');
    if (progressText && phase === 'progress') {
      const from = pending?.from || view?.rollback?.from || UNKNOWN_VERSION;
      const to = pending?.to || view?.rollback?.to || UNKNOWN_VERSION;
      const kind = pending?.kind || view?.rollback?.kind;
      progressText.replaceChildren();
      progressText.append(`מחזירים את ${targetName(kind)}. מ־`);
      progressText.append(versionNode(from));
      progressText.append(' אל ');
      progressText.append(versionNode(to));
    }
    const error = el('vrError');
    const failed = phase === 'failed';
    show(error, failed);
    if (error && failed) {
      error.textContent = pending?.error || view?.rollback?.error || 'ההחזרה נכשלה.';
    }
    const dismiss = el('vrDismiss');
    show(dismiss, failed);
    if (phase === 'confirm') focusConfirm();
  }
  function focusConfirm() {
    const dialog = el('vrConfirm');
    const yes = el('vrConfirmYes');
    if (!dialog) return;
    dialog.scrollIntoView({ block: 'center', inline: 'nearest' });
    const target = yes && !yes.disabled ? yes : dialog;
    if (document.activeElement !== target) target.focus();
  }
  function focusables() {
    const dialog = el('vrConfirm');
    if (!dialog) return [];
    return [...dialog.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])')]
      .filter((node) => !node.disabled && !node.hidden);
  }
  function openConfirm(kind, from, to, backupId, when) {
    if (phaseOf(latest) === 'progress') return;
    pending = {
      kind,
      from: from || '',
      to: to || '',
      backupId: backupId || null,
      when: when || null,
      error: null,
    };
    sending = false;
    const yes = el('vrConfirmYes');
    if (yes) yes.disabled = false;
    localPhase = 'confirm';
    paint(latest);
  }
  function closeConfirm() {
    if (localPhase !== 'confirm') return;
    pending = null;
    sending = false;
    localPhase = syncPhase(latest);
    paint(latest);
  }
  function syncPhase(data) {
    if (data?.rollback?.state === 'failed') return 'failed';
    if (data?.rollback?.state === 'running') return 'running';
    return 'idle';
  }
  function applyServer(data) {
    if (localPhase === 'confirm') return;
    if (data?.rollback?.state === 'failed') {
      localPhase = 'failed';
      pending = {
        ...(pending || {}),
        error: data.rollback.error || pending?.error || 'ההחזרה נכשלה.',
        kind: data.rollback.kind,
        from: data.rollback.from,
        to: data.rollback.to,
      };
      return;
    }
    if (data?.rollback?.state === 'running') {
      localPhase = 'running';
      pending = {
        kind: data.rollback.kind,
        from: data.rollback.from,
        to: data.rollback.to,
        backupId: data.rollback.backupId,
        when: pending?.when || null,
        error: null,
      };
      return;
    }
    if (localPhase === 'running' || localPhase === 'failed') {
      localPhase = 'idle';
      pending = null;
    }
  }
  async function load() {
    const res = await fetch('/api/versions', { cache: 'no-store' });
    if (!res.ok) throw new Error('versions');
    const data = await res.json();
    applyServer(data);
    if (localPhase === 'running' && !pollTimer) poll(data?.rollback?.to);
    paint(data);
    return data;
  }
  async function poll(expectedTo) {
    const started = Date.now();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (Date.now() - started > 45000) {
        clearInterval(pollTimer);
        pollTimer = null;
        try { await load(); } catch { /* server reconcile owns the terminal state */ }
        if (localPhase === 'running') {
          localPhase = 'failed';
          if (pending) pending.error = 'ההחזרה לא הסתיימה.';
          paint(latest);
        }
        return;
      }
      try {
        const data = await load();
        const doneConsole = pending?.kind === 'console' && data?.console?.version && expectedTo && data.console.version === expectedTo && data?.rollback?.state !== 'running';
        if (doneConsole) {
          clearInterval(pollTimer);
          pollTimer = null;
          location.reload();
          return;
        }
        if (localPhase !== 'running') {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      } catch {
        paint(latest);
      }
    }, 2000);
  }
  async function sendRollback() {
    if (!pending || sending || localPhase !== 'confirm') return;
    sending = true;
    const yes = el('vrConfirmYes');
    if (yes) yes.disabled = true;
    const body = {
      confirm: true,
      from: pending.from,
      to: pending.to || '',
      backupId: pending.backupId,
    };
    const path = pending.kind === 'console'
      ? '/api/versions/rollback/console'
      : '/api/versions/rollback/companion';
    localPhase = 'running';
    paint(latest);
    let res;
    let data = {};
    try {
      res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      data = await res.json().catch(() => ({}));
    } catch (err) {
      res = null;
      data = { message: err?.message || 'ההחזרה נכשלה.' };
    }
    sending = false;
    if (!res || !res.ok || data.ok === false) {
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
    if (phaseOf(latest) === 'progress') return;
    openConfirm('console', console.version, console.previousVersion, null, null);
  });
  el('vrConfirmNo')?.addEventListener('click', () => closeConfirm());
  el('vrConfirmYes')?.addEventListener('click', () => { void sendRollback(); });
  el('vrDismiss')?.addEventListener('click', async () => {
    const res = await fetch('/api/versions/rollback/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!res.ok) return;
    localPhase = 'idle';
    pending = null;
    await load().catch(() => { paint(latest); });
  });
  el('vrKnownGoodBtn')?.addEventListener('click', async () => {
    if (el('vrKnownGoodBtn')?.disabled) return;
    const errNode = el('vrKnownGoodError');
    const res = await fetch('/api/versions/known-good', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      if (errNode) {
        errNode.hidden = false;
        errNode.textContent = data.message || 'הסימון נכשל.';
      }
      return;
    }
    if (errNode) errNode.hidden = true;
    await load().catch(() => {});
  });
  document.getElementById('globalSettingsBtn')?.addEventListener('click', () => {
    void load().catch(() => {});
  });
  const gear = document.getElementById('globalSettingsModal');
  gear?.querySelectorAll('[data-close="1"]').forEach((node) => {
    node.addEventListener('click', () => closeConfirm());
  });
  if (gear) {
    new MutationObserver(() => {
      if (gear.hidden) closeConfirm();
    }).observe(gear, { attributes: true, attributeFilter: ['hidden'] });
  }
  document.addEventListener('keydown', (event) => {
    const dialog = el('vrConfirm');
    if (!dialog || dialog.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      closeConfirm();
      return;
    }
    if (event.key !== 'Tab') return;
    const nodes = focusables();
    if (!nodes.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, true);
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
