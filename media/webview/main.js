// @ts-check
/* Sleepwalker panel. Plain DOM, no framework: the extension sends a full state
 * snapshot on every change; the layout is rebuilt only when its shape changes
 * (idle ⇄ active, form opened…) and live values are patched in place, so the
 * lid animation and the form inputs are never interrupted. */
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const boot = JSON.parse(/** @type {HTMLElement} */ (document.getElementById('boot')).textContent || '{}');
  /** @type {Record<string, string>} */
  const S = boot.strings || {};
  const locale = boot.locale || undefined;
  if (boot.reducedMotion) document.body.classList.add('reduce-motion');

  const app = /** @type {HTMLElement} */ (document.getElementById('app'));

  /** UI-only state, kept across reloads of the view. */
  const ui = Object.assign(
    { mode: 'untilReturn', minutes: 60, emailOpen: false, timelineOpen: false },
    vscode.getState() || {},
  );
  const save = () => vscode.setState(ui);

  /** Latest snapshot from the extension. */
  let state = null;
  let layoutKey = '';
  /** Elements patched by the 1-second clock and by state updates. */
  let refs = {};

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

  const svgNS = 'http://www.w3.org/2000/svg';

  /** h('div', {class: 'x', onclick: fn}, child, 'text') */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function s(tag, attrs, ...children) {
    const el = document.createElementNS(svgNS, tag);
    for (const [key, value] of Object.entries(attrs || {})) el.setAttribute(key, String(value));
    for (const child of children) el.append(child);
    return el;
  }

  function fmt(template, ...args) {
    return String(template || '').replace(/\{(\d+)\}/g, (m, i) => (args[i] !== undefined ? String(args[i]) : m));
  }

  function duration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const hh = Math.floor(total / 3600);
    const mm = Math.floor((total % 3600) / 60);
    const ss = total % 60;
    if (hh > 0) return `${hh}h ${String(mm).padStart(2, '0')}m`;
    if (mm > 0) return `${mm}m ${String(ss).padStart(2, '0')}s`;
    return `${ss}s`;
  }

  function clock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hh = Math.floor(total / 3600);
    const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    return hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function timeOf(ts) {
    try {
      return new Date(ts).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    } catch {
      return new Date(ts).toLocaleTimeString();
    }
  }

  const post = (message) => vscode.postMessage(message);

  // -------------------------------------------------------------------------
  // The night window (built once; only its classes change)
  // -------------------------------------------------------------------------

  const night = (() => {
    const stars = [
      [22, 18, 1.2, 'twinkle'],
      [46, 38, 0.9, ''],
      [74, 12, 1.1, 'twinkle late'],
      [104, 26, 0.8, ''],
      [136, 10, 1.2, ''],
      [162, 30, 0.9, 'twinkle'],
      [222, 56, 1, 'twinkle late'],
      [16, 62, 0.9, ''],
      [40, 84, 0.8, ''],
      [212, 80, 0.8, ''],
    ].map(([cx, cy, r, extra]) => s('circle', { class: `star ${extra}`.trim(), cx, cy, r }));

    const codeLines = s(
      'g',
      { class: 'cursor' },
      s('rect', { x: 80, y: 55, width: 34, height: 2.4, rx: 1.2 }),
      s('rect', { x: 86, y: 61, width: 52, height: 2.4, rx: 1.2, opacity: 0.7 }),
      s('rect', { x: 86, y: 67, width: 40, height: 2.4, rx: 1.2, opacity: 0.7 }),
      s('rect', { x: 80, y: 73, width: 24, height: 2.4, rx: 1.2 }),
      s('rect', { x: 80, y: 81, width: 6, height: 7, rx: 1 }),
    );

    const svg = s(
      'svg',
      { viewBox: '0 0 240 120', preserveAspectRatio: 'xMidYMid slice', 'aria-hidden': 'true' },
      ...stars,
      s('circle', { class: 'moon', cx: 196, cy: 30, r: 11 }),
      s('circle', { class: 'moon-shadow', cx: 202, cy: 25, r: 9.5 }),
      s('rect', { class: 'desk', x: 0, y: 104, width: 240, height: 16 }),
      s('ellipse', { class: 'glow', cx: 120, cy: 102, rx: 74, ry: 6 }),
      s(
        'g',
        { class: 'lid' },
        s('rect', { class: 'lid-shell', x: 68, y: 41, width: 104, height: 58, rx: 4 }),
        s('rect', { class: 'screen', x: 73, y: 46, width: 94, height: 48, rx: 2 }),
        codeLines,
      ),
      s('rect', { class: 'base', x: 54, y: 98, width: 132, height: 6, rx: 3 }),
    );

    const el = h('div', { class: 'night', role: 'img' }, svg);
    return {
      el,
      update(asleep, working) {
        el.classList.toggle('is-asleep', asleep);
        el.classList.toggle('is-working', asleep && working);
        el.setAttribute(
          'aria-label',
          asleep ? (working ? `${S['active.title']}: ${S['active.agentBusy']}` : S['active.title']) : S['idle.title'],
        );
      },
    };
  })();

  const content = h('div', { class: 'content' });
  app.append(night.el, content);

  // -------------------------------------------------------------------------
  // Idle layout
  // -------------------------------------------------------------------------

  function idleLayout(v) {
    const starting = v.phase === 'starting';
    const nodes = [];

    if (v.platform === 'unsupported') {
      nodes.push(
        h('div', { class: 'intro' }, h('h1', { text: S['idle.title'] })),
        h('div', { class: 'notice', role: 'alert', text: S['unsupported'] }),
      );
      return nodes;
    }

    nodes.push(h('div', { class: 'intro' }, h('h1', { text: S['idle.title'] }), h('p', { text: S['idle.lead'] })));
    if (v.error) nodes.push(h('div', { class: 'notice', role: 'alert', text: v.error }));

    // Mode picker
    const list = h('div', { class: 'modes', role: 'radiogroup', 'aria-label': S['mode.heading'] });
    for (const mode of ['untilReturn', 'whileAgent', 'timer']) {
      const selected = ui.mode === mode;
      const input = h('input', {
        type: 'radio',
        name: 'mode',
        value: mode,
        checked: selected,
        onchange: () => {
          ui.mode = mode;
          save();
          rebuild();
        },
      });
      const row = h(
        'label',
        { class: `mode${selected ? ' is-selected' : ''}` },
        input,
        h('span', { class: 'dot', 'aria-hidden': 'true' }),
        h('span', { class: 'title', text: S[`mode.title.${mode}`] }),
        h('span', { class: 'hint', text: S[`mode.hint.${mode}`] }),
      );
      if (mode === 'timer' && selected) {
        const chips = h('div', { class: 'durations', role: 'group', 'aria-label': S['mode.title.timer'] });
        for (const minutes of [30, 60, 120, 240, 480]) {
          const label = minutes < 60 ? fmt(S['timer.minutes'], minutes) : fmt(S['timer.hours'], minutes / 60);
          chips.append(
            h('button', {
              class: 'chip',
              type: 'button',
              'aria-pressed': ui.minutes === minutes ? 'true' : 'false',
              text: label,
              onclick: (e) => {
                e.preventDefault();
                ui.minutes = minutes;
                save();
                rebuild();
              },
            }),
          );
        }
        row.append(chips);
      }
      list.append(row);
    }
    nodes.push(h('section', { class: 'section' }, h('h2', { text: S['mode.heading'] }), list));

    nodes.push(
      h('button', {
        class: 'btn btn-primary',
        type: 'button',
        disabled: starting,
        text: starting ? S['start.starting'] : S['start.button'],
        onclick: () => post({ type: 'start', mode: ui.mode, minutes: ui.mode === 'timer' ? ui.minutes : undefined }),
      }),
    );

    // Options
    const st = state.settings;
    const switchRow = (key, label) =>
      h(
        'label',
        { class: 'switch' },
        h('span', { text: label }),
        h('input', {
          type: 'checkbox',
          checked: !!st[key],
          onchange: (e) => post({ type: 'setSetting', key, value: e.target.checked }),
        }),
        h('span', { class: 'track', 'aria-hidden': 'true' }),
      );
    const endSelect = h(
      'select',
      { onchange: (e) => post({ type: 'setSetting', key: 'endAction', value: e.target.value }) },
      ...['sleep', 'hibernate', 'none'].map((value) =>
        h('option', { value, selected: st.endAction === value, text: S[`endAction.${value}`] }),
      ),
    );
    nodes.push(emailSection(v));

    nodes.push(
      h(
        'section',
        { class: 'section' },
        h('h2', { text: S['options.heading'] }),
        h(
          'div',
          { class: 'options' },
          switchRow('lockScreen', S['options.lockScreen']),
          switchRow('turnOffDisplay', S['options.turnOffDisplay']),
          h('label', { class: 'field' }, h('span', { text: S['options.endAction'] }), endSelect),
        ),
      ),
    );

    nodes.push(summarySection(v.lastSummary));
    return nodes;
  }

  // -------------------------------------------------------------------------
  // Active layout
  // -------------------------------------------------------------------------

  function activeLayout(v) {
    const stopping = v.phase === 'stopping';
    refs.clock = h('time', { 'aria-live': 'off' });
    refs.when = h('div', { class: 'when' });
    refs.agent = h('dd');
    refs.lid = h('dd');
    refs.battery = h('dd');
    refs.temperature = h('dd');
    refs.limit = h('p', { class: 'fine' });

    const nodes = [
      h(
        'div',
        { class: 'clock' },
        h('span', { class: 'label', text: S['active.title'] }),
        refs.clock,
        refs.when,
      ),
      h(
        'dl',
        { class: 'readings' },
        h('dt', { text: S['active.agent'] }),
        refs.agent,
        h('dt', { text: S['active.lid'] }),
        refs.lid,
        h('dt', { text: S['active.battery'] }),
        refs.battery,
        h('dt', { text: S['active.temperature'] }),
        refs.temperature,
      ),
      h('button', {
        class: 'btn btn-wake',
        type: 'button',
        disabled: stopping,
        text: stopping ? S['stop.stopping'] : S['stop.button'],
        onclick: () => post({ type: 'stop' }),
      }),
      refs.limit,
      emailSection(v),
    ];
    return nodes;
  }

  function meter(fraction, tone) {
    const bar = h('i');
    bar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    return h('span', { class: `meter ${tone}`.trim(), 'aria-hidden': 'true' }, bar);
  }

  /** Patches the live values (called on every state and every second). */
  function updateLive() {
    const live = state && state.view.live;
    if (!live || !refs.clock) return;
    const now = Date.now();
    refs.clock.textContent = clock(now - live.startedAt);
    refs.clock.setAttribute('datetime', `PT${Math.floor((now - live.startedAt) / 1000)}S`);

    if (live.mode === 'timer' && live.endsAt) refs.when.textContent = fmt(S['active.endsAt'], timeOf(live.endsAt));
    else if (live.mode === 'whileAgent')
      refs.when.textContent = live.finishesAt
        ? fmt(S['active.whileAgentIdle'], timeOf(live.finishesAt))
        : fmt(S['active.whileAgentBusy'], state.settings.idleMinutes);
    else refs.when.textContent = S['active.untilReturn'];

    // Agent
    const agentBits = [h('span', { class: `pulse${live.agentBusy ? ' on' : ''}`, 'aria-hidden': 'true' })];
    if (live.agentBusy) {
      agentBits.push(h('span', { text: S['active.agentBusy'] }));
      if (live.runningCommands > 0) agentBits.push(h('span', { class: 'sub', text: fmt(S['active.commands'], live.runningCommands) }));
      else if (live.cpuPercent !== null) agentBits.push(h('span', { class: 'sub', text: fmt(S['active.cpu'], Math.round(live.cpuPercent)) }));
    } else {
      agentBits.push(h('span', { text: fmt(S['active.agentQuiet'], duration(now - live.lastActivityAt)) }));
    }
    refs.agent.replaceChildren(...agentBits);

    // Lid
    const closedFor = live.lidClosedMs + (live.lidOpen === false ? now - (state.receivedAt || now) : 0);
    refs.lid.textContent =
      live.lidOpen === null ? S['active.lidUnknown'] : live.lidOpen ? S['active.lidOpen'] : fmt(S['active.lidClosed'], duration(closedFor));

    // Battery
    const st = live.status;
    if (!st || st.batteryPercent === null) {
      refs.battery.replaceChildren(h('span', { class: 'sub', text: st ? S['active.noBattery'] : '…' }));
    } else {
      const min = state.settings.minBatteryPercent || 0;
      const tone = st.onAc ? '' : st.batteryPercent <= min ? 'bad' : st.batteryPercent <= min + 10 ? 'warn' : '';
      refs.battery.replaceChildren(
        h('span', { text: `${st.batteryPercent}%` }),
        meter(st.batteryPercent / 100, tone),
        h('span', { class: 'sub', text: st.onAc ? S['active.charging'] : S['active.onBattery'] }),
      );
    }

    // Temperature
    if (!st || st.temperatureC === null) {
      refs.temperature.replaceChildren(h('span', { class: 'sub', text: st ? S['active.noSensor'] : '…' }));
    } else {
      const max = state.settings.maxTemperatureC || 100;
      const tone = st.temperatureC >= max ? 'bad' : st.temperatureC >= max - 5 ? 'warn' : '';
      refs.temperature.replaceChildren(
        h('span', { text: `${Math.round(st.temperatureC)} °C` }),
        meter(st.temperatureC / Math.max(max, 1), tone),
      );
    }

    refs.limit.textContent = fmt(S['active.limit'], timeOf(live.limitAt));
    night.update(true, live.agentBusy);
  }

  // -------------------------------------------------------------------------
  // Last session
  // -------------------------------------------------------------------------

  function toneOf(reason) {
    if (['agentFinished', 'returned', 'manual', 'timerEnded'].includes(reason)) return ['good', '✓'];
    if (['timeLimit', 'battery', 'temperature'].includes(reason)) return ['warn', '!'];
    if (reason === 'error') return ['bad', '×'];
    return ['', '·'];
  }

  function timelineText(entry) {
    if (entry.kind === 'ended') return S[`reason.${entry.reason}`] || S['timeline.ended'];
    const template = S[`timeline.${entry.kind}`] || entry.kind;
    const value = entry.value !== undefined ? Math.round(entry.value) : '';
    return fmt(template, value);
  }

  function summarySection(summary) {
    const section = h('section', { class: 'section' }, h('h2', { text: S['summary.heading'] }));
    if (!summary) {
      section.append(h('p', { class: 'fine', text: S['summary.empty'] }));
      return section;
    }
    const [tone, mark] = toneOf(summary.endReason);
    const battery =
      summary.batteryStart === null
        ? '—'
        : summary.batteryEnd === null || summary.batteryEnd === summary.batteryStart
          ? `${summary.batteryStart}%`
          : `${summary.batteryStart}% → ${summary.batteryEnd}%`;

    const stat = (label, value) => h('div', null, h('dt', { text: label }), h('dd', { text: value }));
    const timeline = h(
      'details',
      {
        class: 'timeline',
        open: ui.timelineOpen,
        ontoggle: (e) => {
          ui.timelineOpen = e.target.open;
          save();
        },
      },
      h('summary', { text: S['summary.timeline'] }),
      h(
        'ol',
        null,
        ...summary.timeline.map((entry) =>
          h(
            'li',
            null,
            h('time', { text: timeOf(entry.at) }),
            h('span', { class: 'node', 'aria-hidden': 'true' }),
            h('span', { text: timelineText(entry) }),
          ),
        ),
      ),
    );

    section.append(
      h(
        'div',
        { class: 'summary-head' },
        h('span', { class: `badge ${tone}`.trim(), 'aria-hidden': 'true', text: mark }),
        h('span', { text: S[`reason.${summary.endReason}`] || summary.endReason }),
      ),
      h('p', { class: 'fine', text: `${timeOf(summary.startedAt)} – ${timeOf(summary.endedAt)}` }),
      h(
        'dl',
        { class: 'stats' },
        stat(S['summary.duration'], duration(summary.durationMs)),
        stat(S['summary.lidClosed'], summary.lidClosedMs > 0 ? duration(summary.lidClosedMs) : '—'),
        stat(S['summary.battery'], battery),
        stat(S['summary.temperature'], summary.temperatureMax !== null ? `${Math.round(summary.temperatureMax)} °C` : '—'),
        stat(S['summary.commands'], String(summary.commandsStarted)),
      ),
      timeline,
    );
    return section;
  }

  // -------------------------------------------------------------------------
  // E-mail
  // -------------------------------------------------------------------------

  const PROVIDERS = {
    gmail: { smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true },
    icloud: { smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSecure: false },
    other: null,
  };
  const EVENTS = ['agentFinished', 'timerEnded', 'guardrail', 'warning', 'started', 'returned'];

  function emailSection() {
    const email = state.email;
    const section = h('section', { class: 'section', id: 'email' });
    const actionLabel = email.complete ? S['email.edit'] : S['email.setUp'];
    section.append(
      h(
        'div',
        { class: 'section-head' },
        h('h2', { text: S['email.heading'] }),
        ui.emailOpen
          ? null
          : h('button', {
              class: 'link',
              type: 'button',
              text: actionLabel,
              onclick: () => {
                ui.emailOpen = true;
                save();
                rebuild();
              },
            }),
      ),
    );

    // Summary line with an on/off switch once everything is filled in.
    refs.emailState = h('span', { class: 'state sub' });
    const line = h('div', { class: 'email-line' }, refs.emailState);
    if (email.complete && !ui.emailOpen) {
      refs.emailSwitch = h('input', {
        type: 'checkbox',
        checked: email.enabled,
        'aria-label': S['email.enable'],
        onchange: (e) => post({ type: 'setEmailEnabled', enabled: e.target.checked }),
      });
      line.append(h('label', { class: 'switch' }, refs.emailSwitch, h('span', { class: 'track', 'aria-hidden': 'true' })));
    }
    section.append(line);
    if (ui.emailOpen) section.append(emailForm(email));
    return section;
  }

  function updateEmailLine() {
    if (!refs.emailState || !state) return;
    const email = state.email;
    refs.emailState.textContent = !email.complete
      ? email.enabled
        ? S['email.incomplete']
        : S['email.off']
      : email.enabled
        ? fmt(S['email.on'], email.to)
        : S['email.off'];
    if (refs.emailSwitch) refs.emailSwitch.checked = !!email.enabled;
    if (refs.testButton) refs.testButton.disabled = !email.complete || refs.testButton.dataset.busy === '1';
  }

  const EMAIL_DOMAINS = { 'gmail.com': 'gmail', 'googlemail.com': 'gmail', 'icloud.com': 'icloud', 'me.com': 'icloud', 'mac.com': 'icloud' };

  function emailForm(email) {
    const input = (type, value, extra) => h('input', Object.assign({ type, value: value ?? '' }, extra || {}));
    const host = input('text', email.smtpHost, { placeholder: 'smtp.example.com', autocomplete: 'off', spellcheck: 'false' });
    const port = input('number', email.smtpPort, { min: 1, max: 65535 });
    const secure = h('input', { type: 'checkbox', checked: email.smtpSecure });
    // The only thing asked up front: where notifications land. Unless overridden
    // in "Advanced", it also doubles as the SMTP login.
    const to = input('email', email.to, { autocomplete: 'off', spellcheck: 'false', placeholder: 'voce@gmail.com' });
    const account = input('email', email.smtpUser && email.smtpUser !== email.to ? email.smtpUser : '', {
      autocomplete: 'off',
      spellcheck: 'false',
    });
    const password = input('password', '', {
      autocomplete: 'new-password',
      placeholder: email.hasPassword ? S['email.passwordSaved'] : '',
    });
    const from = input('text', email.from, { placeholder: 'Sleepwalker <you@example.com>', spellcheck: 'false' });
    // Hidden while a server is already known (saved, or just filled by a provider preset);
    // shown to nudge the user towards "Advanced" when we have no server to use.
    const unknownNotice = h('p', { class: 'fine notice-inline', text: S['email.unknownProvider'], hidden: Boolean(host.value) });

    const providerChips = h('div', { class: 'providers', role: 'group', 'aria-label': S['email.provider'] });
    const pressChip = (id) => {
      for (const chip of providerChips.children) chip.setAttribute('aria-pressed', chip.dataset.id === id ? 'true' : 'false');
    };
    const applyProvider = (id) => {
      pressChip(id);
      const preset = PROVIDERS[id];
      if (preset) {
        host.value = preset.smtpHost;
        port.value = String(preset.smtpPort);
        secure.checked = preset.smtpSecure;
      }
      unknownNotice.hidden = Boolean(host.value);
    };
    for (const id of Object.keys(PROVIDERS)) {
      providerChips.append(
        h('button', {
          class: 'chip',
          type: 'button',
          'data-id': id,
          'aria-pressed': 'false',
          text: S[`email.provider.${id}`],
          onclick: () => {
            applyProvider(id);
            if (id === 'other') host.focus();
          },
        }),
      );
    }
    // Guess which chip matches an already-saved server, just for the visual state.
    const existing = Object.entries(PROVIDERS).find(([, preset]) => preset && preset.smtpHost === host.value);
    pressChip(existing ? existing[0] : host.value ? 'other' : null);

    const guessProvider = (emailValue) => {
      if (host.value) return; // a server is already set (saved or chosen); don't override it
      const domain = (emailValue.split('@')[1] || '').toLowerCase();
      const provider = EMAIL_DOMAINS[domain];
      if (provider) applyProvider(provider);
      else if (emailValue.includes('@')) details.open = true; // unknown domain: let them fill the server
    };
    to.addEventListener('blur', () => guessProvider(to.value));
    account.addEventListener('blur', () => guessProvider(account.value));

    const events = h('fieldset', { class: 'events' }, h('legend', { text: S['email.events'] }));
    const eventBoxes = EVENTS.map((id) => {
      const box = h('input', { type: 'checkbox', value: id, checked: (email.events || []).includes(id) });
      events.append(h('label', { class: 'check' }, box, h('span', { text: S[`email.event.${id}`] })));
      return box;
    });

    const feedback = h('div', { class: 'feedback', role: 'status' });
    refs.emailFeedback = feedback;

    refs.testButton = h('button', {
      class: 'btn btn-secondary',
      type: 'button',
      text: S['email.test'],
      disabled: !email.complete,
      onclick: () => {
        refs.testButton.dataset.busy = '1';
        refs.testButton.disabled = true;
        refs.testButton.textContent = S['email.testing'];
        feedback.textContent = '';
        post({ type: 'testEmail' });
      },
    });

    const details = h(
      'details',
      { class: 'disclosure' },
      h('summary', { text: S['email.advanced'] }),
      h('div', { class: 'field' }, h('span', { text: S['email.provider'] }), providerChips),
      unknownNotice,
      h(
        'div',
        { class: 'row' },
        h('label', { class: 'field' }, h('span', { text: S['email.host'] }), host),
        h('label', { class: 'field' }, h('span', { text: S['email.port'] }), port),
      ),
      h('label', { class: 'check' }, secure, h('span', { text: S['email.secure'] })),
      h('label', { class: 'field' }, h('span', { text: S['email.user'] }), account, h('span', { class: 'fine', text: S['email.userHint'] })),
      h('label', { class: 'field' }, h('span', { text: S['email.password'] }), password, h('span', { class: 'fine', text: S['email.passwordHint'] })),
      h('p', { class: 'fine', text: S['email.passwordStored'] }),
      h('label', { class: 'field' }, h('span', { text: S['email.from'] }), from),
      events,
    );

    const form = h(
      'form',
      {
        class: 'form',
        onsubmit: (e) => {
          e.preventDefault();
          feedback.textContent = '';
          post({
            type: 'saveEmail',
            fields: {
              smtpHost: host.value,
              smtpPort: Number(port.value),
              smtpSecure: secure.checked,
              smtpUser: account.value || to.value,
              to: to.value || account.value,
              from: from.value,
              events: eventBoxes.filter((b) => b.checked).map((b) => b.value),
            },
            password: password.value || undefined,
          });
          password.value = '';
          password.placeholder = S['email.passwordSaved'];
        },
      },
      h('label', { class: 'field' }, h('span', { text: S['email.to'] }), to),
      details,
      h(
        'div',
        { class: 'form-actions' },
        h('button', { class: 'btn btn-primary', type: 'submit', text: S['email.save'] }),
        refs.testButton,
        h('button', {
          class: 'link',
          type: 'button',
          text: S['email.cancel'],
          onclick: () => {
            ui.emailOpen = false;
            save();
            rebuild();
          },
        }),
      ),
      feedback,
    );
    return form;
  }

  // -------------------------------------------------------------------------
  // Footer
  // -------------------------------------------------------------------------

  function footer() {
    return h(
      'div',
      { class: 'footer' },
      h('button', { class: 'link', type: 'button', text: S['options.more'], onclick: () => post({ type: 'openSettings' }) }),
      h('button', { class: 'link', type: 'button', text: S['actions.log'], onclick: () => post({ type: 'showLog' }) }),
    );
  }

  // -------------------------------------------------------------------------
  // Render loop
  // -------------------------------------------------------------------------

  function keyOf(v) {
    return JSON.stringify([
      v.platform,
      v.live ? 'active' : 'idle',
      v.phase,
      v.error,
      v.lastSummary ? v.lastSummary.endedAt : null,
      ui.mode,
      ui.minutes,
      ui.emailOpen,
      state.email.complete,
      v.live ? null : state.settings,
    ]);
  }

  function rebuild() {
    if (!state) return;
    const v = state.view;
    refs = {};
    const nodes = v.live ? activeLayout(v) : idleLayout(v);
    if (v.platform !== 'unsupported') nodes.push(h('hr', { class: 'soft' }), footer());
    content.replaceChildren(...nodes);
    layoutKey = keyOf(v);
    night.update(Boolean(v.live), Boolean(v.live && v.live.agentBusy));
    updateLive();
    updateEmailLine();
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'state': {
        state = message;
        state.receivedAt = Date.now();
        if (keyOf(state.view) !== layoutKey) rebuild();
        else {
          updateLive();
          updateEmailLine();
          if (!state.view.live) night.update(false, false);
        }
        break;
      }
      case 'emailResult': {
        const feedback = refs.emailFeedback;
        if (message.action === 'test' && refs.testButton) {
          refs.testButton.dataset.busy = '';
          refs.testButton.textContent = S['email.test'];
          refs.testButton.disabled = !(state && state.email.complete);
        }
        if (feedback) {
          feedback.className = `feedback ${message.ok ? 'ok' : 'bad'}`;
          feedback.textContent = message.message || (message.ok ? S['email.saved'] : '');
        }
        break;
      }
      case 'focusEmail': {
        ui.emailOpen = true;
        save();
        rebuild();
        const target = document.getElementById('email');
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          const first = target.querySelector('input');
          if (first) first.focus();
        }
        break;
      }
    }
  });

  setInterval(updateLive, 1000);
  post({ type: 'ready' });
})();
