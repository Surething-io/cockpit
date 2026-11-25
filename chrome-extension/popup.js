/**
 * Toolbar popup: the tabs Cockpit is driving right now (what Chrome's
 * "is debugging this browser" bar is about — click to go there, Stop to let
 * go), the current tab's id + grant state, the list of granted tabs, and —
 * while Cockpit waits — the approval prompt for this tab.
 *
 * Extension UI, so the page being controlled cannot see or click it. It never
 * talks to the service worker directly: it reads state from storage and
 * writes requests to storage.session (`popupRequest` / `approvalDecision`),
 * which the worker applies. Grant changes keep it open and redraw in place.
 */
(async () => {
  const root = document.getElementById('root');
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'onclick') n.addEventListener('click', v); else if (v != null) n.setAttribute(k, v);
    }
    for (const c of children) if (c != null) n.append(c);
    return n;
  };
  const send = async (key, value) => {
    await chrome.storage.session.set({ [key]: { ...value, at: Date.now() } });
  };
  // Restores the `<all_urls>` grant if the user withheld it. Must run inside a
  // click handler: Chrome only shows its prompt for a user gesture.
  const ensureAllSites = async () => {
    const all = { origins: ['<all_urls>'] };
    if (await chrome.permissions.contains(all)) return true;
    return chrome.permissions.request(all).catch(() => false);
  };

  const draw = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [{ bridgeState: s = {} }, { approvalRequests = {}, nativeStatus, serverCount, siteAccessAll, debugTabs = [] }] = await Promise.all([
      chrome.storage.local.get('bridgeState'),
      chrome.storage.session.get(['approvalRequests', 'nativeStatus', 'serverCount', 'siteAccessAll', 'debugTabs']),
    ]);
    // Tabs the debugger is on right now — the ones Chrome's "is debugging this
    // browser" bar is about.
    const driving = new Map(debugTabs.map((d) => [d.tabId, d]));
    const drivingText = (d) => {
      const parts = [...d.reasons];
      if (d.captureUntil) {
        const left = Math.max(0, Math.round((d.captureUntil - Date.now()) / 1000));
        const i = parts.indexOf('console & network capture');
        if (i >= 0) parts[i] = `console & network capture, ${left >= 60 ? `${Math.ceil(left / 60)} min` : `${left}s`} left`;
      }
      return parts.length ? parts.join(' · ') : 'working — lets go a few seconds after the last command';
    };
    const hostOf = (url) => { try { return new URL(url).host || 'local file'; } catch { return url; } };
    const granted = new Set((s.grantedTabs || []).map(Number));
    // One command: production's; a dev server only when it is the only one connected.
    const clis = Array.isArray(s.clis) && s.clis.length ? s.clis : ['cockpit'];
    const cmdFor = (tabId, cli = clis[0]) => {
      const shortId = (s.shortIds || {})[(s.tabIds || {})[tabId]];
      return shortId ? `${cli} browser ${shortId}` : null;
    };
    const render = (...nodes) => { root.replaceChildren(...nodes); };
    // Grant changes keep the popup open; the storage listener below redraws it.
    const request = (op, tabId) => async () => { await send('popupRequest', { op, tabId }); };

    // 1) A pending approval takes over the popup — this tab's first, otherwise
    //    any tab's: the prompt opens in whatever window the user is in.
    const pendingIds = Object.keys(approvalRequests).map(Number);
    const reqTabId = tab && approvalRequests[tab.id] ? tab.id : pendingIds[0];
    if (reqTabId != null) {
      const req = approvalRequests[reqTabId];
      const elsewhere = reqTabId !== tab?.id;
      const answer = (decision) => async () => {
        // Restore site access first, while the click still counts as a gesture.
        if (decision === 'allow') await ensureAllSites();
        await send('approvalDecision', { tabId: reqTabId, requestId: req.requestId, decision });
        window.close();
      };
      const shortId = (s.shortIds || {})[(s.tabIds || {})[reqTabId]];
      render(el('section', {},
        el('h1', {}, elsewhere ? 'OpenCockpit wants to control another tab' : 'OpenCockpit wants to control this tab'),
        el('div', { class: 'host' }, req.host),
        el('div', { class: 'muted small' }, `${shortId ? `[${shortId}] ` : ''}${req.title || ''}`),
        el('p', { class: 'muted small' }, 'An AI session in Cockpit asked to read and act on that tab, with your login. Only that tab — other tabs still ask.'),
        el('button', { class: 'block primary', onclick: answer('allow') }, 'Allow this tab'),
        el('button', { class: 'block', onclick: answer('deny') }, 'Deny'),
        elsewhere ? el('button', { class: 'block', onclick: request('show-tab', reqTabId) }, 'Show the tab') : null,
        pendingIds.length > 1 ? el('p', { class: 'muted small' }, `${pendingIds.length - 1} more request(s) waiting — reopen after answering.`) : null,
      ));
      return;
    }

    const sections = [];

    // One row layout for every tab shown: favicon, title + host, id, actions.
    const shortIdOf = (tabId) => (s.shortIds || {})[(s.tabIds || {})[tabId]];
    const tabRow = (t, { here, actions, sub, clickable, extra }) => {
      const icon = t.favIconUrl && /^https?:|^data:/.test(t.favIconUrl)
        ? el('img', { class: 'fav', src: t.favIconUrl, alt: '' })
        : el('span', { class: 'fav blank' });
      const sid = shortIdOf(t.id);
      return el('div', {
        class: `tabrow${here ? ' current' : ''}${clickable ? ' clickable' : ''}`,
        title: `${t.title || ''}\n${t.url || ''}${clickable ? '\nClick to switch to this tab' : ''}`,
        onclick: clickable ? () => send('popupRequest', { op: 'show-tab', tabId: t.id }) : undefined,
      },
        icon,
        el('div', { class: 'meta' },
          el('div', { class: 'title' }, t.title || hostOf(t.url)),
          el('div', { class: 'sub' }, hostOf(t.url), sub || null)),
        sid ? el('code', { class: 'sid' }, sid) : null,
        ...actions,
        extra || null);
    };
    const button = (label, onclick, cls = 'small') =>
      el('button', { class: cls, onclick: async (e) => { e.stopPropagation(); await onclick(e); } }, label);
    const stopButton = (tabId) => button('Stop', request('revoke-tab', tabId));
    const detachButton = (tabId) => button('Stop', request('detach-tab', tabId), 'small warnbtn');
    const drivingLine = (tabId) => (driving.has(tabId)
      ? el('div', { class: 'driving' }, el('span', { class: 'dot' }), drivingText(driving.get(tabId)))
      : null);

    // 2) Being driven right now, other than this tab (which shows it below).
    const drivenElsewhere = (await Promise.all([...driving.keys()]
      .filter((id) => id !== tab?.id)
      .map((id) => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
    if (drivenElsewhere.length) {
      sections.push(el('section', { class: 'drivingsec' },
        el('h1', {}, 'Cockpit is driving now'),
        el('div', { class: 'tabs' }, ...drivenElsewhere.map((t) => tabRow(t, {
          clickable: true,
          extra: drivingLine(t.id),
          actions: [detachButton(t.id)],
        })))));
    }

    // 3) This tab.
    const url = tab?.url || '';
    if (tab && /^(https?|file):/.test(url) && (s.tabIds || {})[tab.id]) {
      const command = cmdFor(tab.id);
      const on = granted.has(tab.id);
      const copyButton = (text, label = 'Copy') => button(label, async (e) => {
        await navigator.clipboard.writeText(text);
        e.target.textContent = 'Copied';
        setTimeout(() => { e.target.textContent = label; }, 1200);
      });
      const copy = command ? copyButton(command) : null;

      sections.push(el('section', {},
        el('h1', {}, 'This tab'),
        el('div', { class: 'tabs' }, tabRow(tab, {
          sub: on ? null : el('span', { class: 'off' }, ' · not allowed'),
          extra: drivingLine(tab.id),
          actions: driving.has(tab.id)
            ? [copy, detachButton(tab.id)]
            : on
            ? [copy, stopButton(tab.id)]
            : [button('Allow', async () => {
                await send('popupRequest', { op: 'allow-tab', tabId: tab.id });
                await ensureAllSites();
              }, 'small primary')],
        }))));
    } else {
      sections.push(el('section', {}, el('h1', {}, 'This tab'),
        el('div', { class: 'muted' }, 'Cockpit does not control this kind of page.')));
    }

    // 4) Other granted tabs (this one and the driven ones are shown above).
    const otherTabs = (await chrome.tabs.query({})).filter((t) => granted.has(t.id) && t.id !== tab?.id && !driving.has(t.id));
    if (otherTabs.length || !granted.has(tab?.id)) {
      sections.push(el('section', {},
        el('h1', {}, 'Other tabs Cockpit may control'),
        otherTabs.length
          ? el('div', { class: 'tabs' }, ...otherTabs.map((t) => tabRow(t, {
              clickable: true,
              actions: [stopButton(t.id)],
            })))
          : el('div', { class: 'muted small' }, 'None. Cockpit asks before acting on any tab.'),
      ));
    }

    // 5) Problems only.
    if (siteAccessAll === false) {
      sections.push(el('section', { class: 'warn small' },
        el('div', {}, 'Chrome is withholding site access, so Cockpit cannot run in pages. It needs access to all sites (which tabs it may act on is still up to you, tab by tab).'),
        el('div', { class: 'row', style: 'justify-content:flex-start' },
          button('Grant access to all sites', async () => { await ensureAllSites(); draw(); }, 'small primary'),
          button('Open settings', () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })))));
    }
    if (!nativeStatus?.connected) {
      sections.push(el('section', { class: 'warn small' },
        'Not connected to OpenCockpit — start cockpit (it registers the bridge). ',
        el('span', { class: 'muted' }, nativeStatus?.error || '')));
    } else if (serverCount === 0) {
      sections.push(el('section', { class: 'warn small' }, 'No Cockpit server is running.'));
    }

    render(...sections);
  };

  await draw();
  // Keep the "N min left" of a running capture honest while the popup is open.
  setInterval(draw, 15_000);
  // Redraw on any state change: our own grant changes, the worker assigning an
  // id, or an approval request arriving while the popup is open.
  let redraw = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === 'local' && changes.bridgeState) ||
        (area === 'session' && (changes.approvalRequests || changes.nativeStatus || changes.serverCount || changes.siteAccessAll || changes.debugTabs))) {
      clearTimeout(redraw);
      redraw = setTimeout(draw, 50);
    }
  });
})();
