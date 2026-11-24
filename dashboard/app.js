/* No requests: radar-data.js comes from the same entrypoint as board.json. */
(() => {
  'use strict';
  const { meta: m, categories, chains, rows: input, live, scatter } = window.RADAR;
  const f = m.fit, o = f.odds, farm = window.Farm;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const compact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 });
  const exact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const cash = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const pc = (x) => (x * 100).toFixed(1) + '%';
  const tracked = (a) => a === null ? '—' : a < 365 ? a + 'd' : (a / 365.25).toFixed(1) + 'y';
  const label = { worth: 'Passes hurdle', marginal: 'Covers costs', skip: 'Below costs', watch: 'Research only' };
  const watchlist = new Set(m.watchlist_slugs);
  const [intercept, size, ageTerm, growthTerm] = m.beta;
  let sort = 'implied', direction = -1, restore;

  function price(tvl, age, growth) {
    const years = age === null ? 1.5 : Math.max(age / 365.25, 0.06);
    const ageLog = Math.max(-f.age_cap, Math.min(f.age_cap, ageTerm * Math.log(years)));
    const growthLog = Math.max(-f.growth_cap, Math.min(f.growth_cap, growthTerm * (growth ?? 0)));
    const base = Math.exp(intercept) * tvl ** size;
    const a = Math.exp(ageLog), g = Math.exp(growthLog);
    return { base, a, g, cap: Math.min(1e11, Math.max(1, Math.round(base * a * g))) };
  }

  const rows = input.map(([slug, name, kind, ids, tvl, growth, age, watch, implied, odds, low, high], i) => {
    const networks = ids.map((id) => chains[id]);
    return { rank: i + 1, slug, name, category: categories[kind], chains: networks, tvl, growth, age, watch: Boolean(watch),
      implied, odds, low, high, expected: Math.max(1, Math.round(implied * odds)), factors: price(tvl, age, growth),
      search: [slug, name, categories[kind], ...networks].join(' ').toLowerCase() };
  });
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const coverage = rows.filter((r) => watchlist.has(r.slug)).length;
  let checksum = 0x811c9dc5;
  for (const r of rows) for (const ch of `${r.slug}:${r.implied}`) checksum = Math.imul(checksum ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  const fingerprint = checksum.toString(16).padStart(8, '0');
  const orderOK = rows.every((r, i) => !i || rows[i - 1].implied >= r.implied);
  const payloadOK = bySlug.size === rows.length && fingerprint === m.checksum && rows.length === m.rows;
  const formulaOK = rows.filter((r) => r.factors.cap === r.implied && r.watch === watchlist.has(r.slug) &&
    r.low === Math.max(1, Math.round(r.implied * f.band[0])) && r.high === Math.min(1e11, Math.round(r.implied * f.band[1]))).length;
  const [gram, target] = m.normal;
  const fitOK = gram.every((line, i) =>
    Math.abs(line.reduce((sum, v, j) => sum + v * m.beta[j], 0) - target[i]) <= 1e-10 * Math.max(1, Math.abs(target[i])));
  const ledgerTotal = f.ledger.reduce((sum, g) => sum + g[2], 0);

  function plot() {
    const x = (v) => 33 + (v - 6.6) * 109, y = (v) => 138 - (v - 4) * 25;
    const points = (pts, cls, radius) => pts.map(([a, b]) => `<circle class="${cls}" cx="${x(a).toFixed(1)}" cy="${y(b).toFixed(1)}" r="${radius}"/>`).join('');
    const curve = [6.7, 7, 8, 9, 10].map((v) => `${x(v)},${y(intercept / Math.LN10 + size * v)}`).join(' ');
    $('hero-chart').innerHTML = '<p><b>Snapshot pricing</b><span>Log axes · USD</span></p>' +
      '<svg viewBox="0 0 440 163" role="img" aria-label="Market caps of priced peers and implied values of unpriced protocols by TVL">' +
      [5, 6, 7, 8, 9].map((n) => `<path class="grid" d="M32 ${y(n)}H426"/><text x="0" y="${y(n) + 3}">${compact.format(10 ** n)}</text>`).join('') +
      [7, 8, 9, 10].map((n) => `<text x="${x(n)}" y="154" text-anchor="middle">${compact.format(10 ** n)}</text>`).join('') +
      '<polyline class="curve" points="' + curve + '"/>' + points(scatter.map(([tvl, cap]) => [tvl, cap]), 'peer', 2.2) +
      points(rows.map((r) => [Math.log10(r.tvl), Math.log10(r.implied)]), 'candidate', 1.8) + '</svg>' +
      '<div class="plot-key"><span>● Priced comp</span><span>● Candidate</span><span>— TVL-only term</span></div>';
  }

  function renderSignals() {
    const forward = f.blinds[1];
    const parts = [
      [`${coverage} / ${watchlist.size}`, 'Sealed watchlist', `${m.early} more below ${compact.format(m.floor_usd)} TVL`],
      [`${forward[6].toFixed(2)}×`, 'Typical held-out cap miss', `${forward[7].toFixed(2)}× flat TVL rule · ${forward[1]} newer peers`],
      [pc(f.coverage), 'Range coverage', `80% target · tested on ${forward[1]} newer peers`],
      [`${formulaOK} / ${rows.length}`, 'Values replayed exactly', `${payloadOK && orderOK ? 'Export fingerprint verified' : 'ERROR · check export'} · ${fingerprint}`],
    ];
    $('signals').innerHTML = parts.map(([n, t, s]) => `<div><span>${esc(t)}</span><b>${esc(n)}</b><small>${esc(s)}</small></div>`).join('');
    $('ledger').innerHTML = `<p>${ledgerTotal} / ${m.ledger_total} protocols accounted for. ${rows.length} unique ranked rows; ${formulaOK} reproduce to the dollar. Rank and export order: ${orderOK ? 'pass' : 'fail'}. Ridge normal equations: ${fitOK ? 'pass' : 'fail'}.</p><dl>` +
      f.ledger.map(([, title, n]) => `<div><dt>${esc(title)}</dt><dd>${n}</dd></div>`).join('') + '</dl>';
  }

  const filters = ['q', 'tier', 'category', 'chain', 'verdict', 'ticket'].map($);
  const [query, tier, category, chain, verdict, ticket] = filters;
  for (const [element, options, title] of [[category, rows.map((r) => r.category), 'All categories'], [chain, rows.flatMap((r) => r.chains), 'All chains']]) {
    element.innerHTML = `<option value="">${title}</option>` + [...new Set(options)].sort().map((v) => `<option>${esc(v)}</option>`).join('');
  }

  function renderBoard() {
    const q = query.value.trim().toLowerCase();
    const budget = Number(ticket.value);
    const matches = [];
    for (const r of rows) {
      if ((q && !r.search.includes(q)) || (tier.value && r.watch !== (tier.value === 'watch')) ||
          (category.value && r.category !== category.value) || (chain.value && !r.chains.includes(chain.value))) continue;
      const scenario = farm.evaluate(r, budget);
      if (!verdict.value || scenario.label === verdict.value) matches.push({ r, scenario });
    }
    const get = (item) => sort === 'netHour' ? (item.scenario.active ? item.scenario.netHour : null) : item.r[sort];
    matches.sort((a, b) => {
      const av = get(a), bv = get(b);
      if (av === null || bv === null) return (av === null) - (bv === null) || a.r.rank - b.r.rank;
      const delta = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
      return direction * delta || a.r.rank - b.r.rank;
    });
    $('count').textContent = `${matches.length} / ${rows.length} ranked · ${matches.filter(({ r }) => r.watch).length} watchlist in view`;
    $('rows').innerHTML = matches.map(({ r, scenario: v }) => `<tr data-slug="${esc(r.slug)}">
      <td class="muted mono">${String(r.rank).padStart(3, '0')}</td>
      <td><button class="protocol" data-open="${esc(r.slug)}">${esc(r.name)} <span aria-hidden="true">↗</span></button>
      <span class="pill ${r.watch ? 'in' : 'early'}">${r.watch ? 'Watchlist' : 'Early'}</span><small>${esc(r.category)} · ${esc(r.chains.slice(0, 2).join(' / '))}${r.chains.length > 2 ? ' +' + (r.chains.length - 2) : ''}</small></td>
      <td>${compact.format(r.tvl)}</td><td class="${r.growth > 0 ? 'positive' : r.growth < 0 ? 'negative' : ''}">${r.growth === null ? '—' : `${r.growth > 0 ? '+' : ''}${r.growth.toFixed(1)}%`}</td>
      <td>${tracked(r.age)}</td><td>${pc(r.odds)}</td><td class="cap"><b>${compact.format(r.implied)}</b><small>${compact.format(r.low)} – ${compact.format(r.high)}</small></td>
      <td><span class="status ${v.label}">${label[v.label]}</span><small>${v.active ? `${cash.format(v.netHour)}/h · ${cash.format(v.cost)} cost` : `${v.route} · $0 principal`}</small></td></tr>`).join('') ||
      '<tr><td colspan="8" class="empty">No matches. Clear a filter or reset the screen.</td></tr>';
    for (const head of document.querySelectorAll('[data-sort]')) {
      if (head.dataset.sort === sort) head.setAttribute('aria-sort', direction === 1 ? 'ascending' : 'descending');
      else head.removeAttribute('aria-sort');
    }
  }

  function renderDetail(r) {
    const v = farm.evaluate(r, Number(ticket.value));
    const p = r.factors;
    $('detail-body').innerHTML = `<header class="detail-head"><div><p class="eyebrow">02 / PROTOCOL FILE · RANK ${r.rank} / ${rows.length}</p>
      <h2 id="detail-name">${esc(r.name)}</h2><p>${esc(r.category)} · ${esc(r.chains.join(' / '))} · ${r.watch ? 'Sealed watchlist' : 'Below watchlist floor'}</p></div>
      <form method="dialog"><button class="outline" autofocus aria-label="Close protocol detail">Close ×</button></form></header>
      <div class="detail-grid"><section class="valuation"><p class="eyebrow">IF A TOKEN LAUNCHES</p>
      <strong class="big">${compact.format(r.implied)}</strong><p class="muted">Implied circulating cap · ${compact.format(r.low)} – ${compact.format(r.high)} P10–P90</p>
      <dl class="factors"><div><dt>TVL basis (${compact.format(r.tvl)})</dt><dd>${exact.format(p.base)}</dd></div>
      <div><dt>Listing age · ${tracked(r.age)}</dt><dd>×${p.a.toFixed(4)}</dd></div><div><dt>7-day TVL · ${r.growth === null ? 'missing' : r.growth.toFixed(2) + '%'}</dt><dd>×${p.g.toFixed(4)}</dd></div>
      <div><dt>Exact result ${p.cap === r.implied ? '· matches board export' : '· export mismatch'}</dt><dd>${exact.format(p.cap)}</dd></div></dl>
      <div class="stress"><b>Valuation sensitivity</b><p>TVL −25%: ${compact.format(price(r.tvl * .75, r.age, r.growth).cap)} · Flat week: ${compact.format(price(r.tvl, r.age, 0).cap)}</p></div>
      <p class="note">${pc(r.odds)} fitted peer token share. Multiplying it by implied cap gives ${compact.format(r.expected)} for scenario arithmetic only. It does not estimate launch odds or timing.</p></section>
      <section class="field-plan"><p class="eyebrow">FARM WORKFLOW · ${esc(v.chain)}</p><h3>${esc(v.route)}</h3>
      <div class="scenario"><span class="status ${v.label}">${label[v.label]}</span><span>${exact.format(v.capital)} principal · ${v.hold ? v.hold + ' days' : 'no hold'} · ${Math.round(v.hours * 60)} min</span></div>
      ${v.active ? `<div class="budget"><div><small>Model reward</small><b>${cash.format(v.drop)}</b></div><div><small>All-in cost</small><b>${cash.format(v.cost)}</b></div><div><small>No-drop downside</small><b>${cash.format(v.noDrop)}</b></div></div>
      <p class="note">Gas ${cash.format(v.gas)} + venue ${cash.format(v.venue)} + carry ${cash.format(v.carry)} + time at $25/h. Net ${cash.format(v.net)}; estimated break-even requires ${pc(v.breakEven)} of peer-weighted cap going pro rata to participants. Default assumption: 10%.</p>` : `<p class="note">Research only; no qualifying action or deposit assumed. ${cash.format(v.cost)} time budget at $25/h.</p>`}
      <ol class="steps">${v.steps.map(([when, text, cost, time]) => `<li><b>${esc(when)}</b><p>${esc(text)}</p><small>${esc(cost)} · ${esc(time)}</small></li>`).join('')}</ol></section></div>
      <p class="detail-note">No token marker is not proof of no token. Gas, fees and reward share are assumptions, not quotes. Capital losses, taxes and eligibility risk are not included.</p>`;
  }

  function showTab(name) {
    for (const id of ['board', 'method', 'peers']) $(id).hidden = id !== name;
    $('intro').hidden = name !== 'board';
    for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-pressed', String(b.dataset.tab === name));
  }

  $('method').innerHTML = `<div class="section-top"><div><p class="eyebrow">03 / MODEL LAB</p><h2>Hold out the whole calculation.</h2></div></div>
    <p class="method-lead">Every holdout refits the whole specification, including category residuals when tested. The age split is by listing cohort; all caps are observed on the same date. These are comparable-token errors, not a historical launch backtest.</p>
    <div class="method-grid"><section><h3>Value ablation</h3><p>Median multiplicative miss; 1.00× is exact. Lower is better.</p>
    <table><thead><tr><th>Specification</th><th>Leave one out · n=${f.blinds[0][1]}</th><th>Older → newer · n=${f.blinds[1][1]}</th></tr></thead><tbody>${f.evidence.map(([name, a, b]) => `<tr><td>${esc(name)}</td><td>${a.toFixed(2)}×</td><td>${b.toFixed(2)}×</td></tr>`).join('')}</tbody></table></section>
    <section><h3>Where confidence ends</h3><dl class="factors"><div><dt>80% band · newer peer coverage</dt><dd>${pc(f.coverage)}</dd></div><div><dt>Band factors · from leave-one-out errors</dt><dd>×${f.band[0].toFixed(2)} to ×${f.band[1].toFixed(2)}</dd></div>
    <div><dt>Peer share · 5-fold Brier</dt><dd>${o.cv_brier.toFixed(3)}</dd></div><div><dt>Peer share · newer Brier vs train base</dt><dd>${o.blind_brier.toFixed(3)} vs ${o.blind_base.toFixed(3)}</dd></div>
    <div><dt>Peer share · 5-fold AUC</dt><dd>${o.cv_auc.toFixed(2)}</dd></div></dl><p>Value comps need a listed date and a positive cap at most ${f.outlier_multiple}× TVL. The deployment interval uses empirical log-error quantiles; newer-cohort coverage calibrates only on older peers.</p>
    <p>Caps are not FDVs. Dates are tracking dates. The input has neither token issuance timestamps nor reward rules. Age and growth remain bounded adjustments even where their holdout contribution is weak.</p></section></div>
    <p class="note">Value model: exp(intercept) × TVL^slope × exp(clamped age term) × exp(clamped growth term). Adding category hurt the cohort test; category remains in the separate peer-share fit on ${o.n} records. Age and growth are ridge-shrunk.</p>`;
  $('peers').innerHTML = `<div class="section-top"><div><p class="eyebrow">04 / PRICED PEERS</p><h2>Not launch candidates.</h2></div></div>
    <p class="method-lead">${live.length} largest protocols with a priced token cap, by TVL. Separately, ${f.ledger.find(([key]) => key === 'marked')[2]} records have token markers but no usable cap. Neither group enters the radar.</p>
    <div class="sheet"><table><thead><tr><th>Protocol</th><th>Category</th><th>TVL</th><th>Recorded cap</th><th>Cap / TVL</th><th>In fit</th></tr></thead><tbody>${live.map(([name, kind, tvl, cap, multiple, inFit]) => `<tr><td>${esc(name)}</td><td>${esc(categories[kind])}</td><td>${compact.format(tvl)}</td><td>${compact.format(cap)}</td><td>${multiple.toFixed(3)}×</td><td>${inFit ? 'Yes' : 'No'}</td></tr>`).join('')}</tbody></table></div>`;

  $('source-tag').textContent = `DEFILLAMA / SEALED ${m.as_of}`;
  $('source').textContent = `${m.source} · ${m.version} · Offline, reproducible snapshot research. Not investment advice.`;
  $('equation').innerHTML = '<b>Implied cap</b> = TVL curve × tracking-age factor × 7-day TVL factor';
  for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));
  for (const head of document.querySelectorAll('[data-sort]')) head.firstElementChild.addEventListener('click', () => {
    const next = head.dataset.sort;
    direction = next === sort ? -direction : next === 'rank' || next === 'name' ? 1 : -1;
    sort = next; renderBoard();
  });
  for (const element of filters) element.addEventListener(element === query ? 'input' : 'change', renderBoard);
  $('reset').addEventListener('click', () => {
    for (const element of filters) element.value = element === ticket ? String(farm.DEFAULT_TICKET) : '';
    sort = 'implied'; direction = -1; renderBoard();
  });
  $('rows').addEventListener('click', (event) => {
    const tr = event.target.closest('[data-slug]');
    if (!tr) return;
    restore = tr.querySelector('button');
    renderDetail(bySlug.get(tr.dataset.slug));
    $('detail').showModal();
  });
  $('detail').addEventListener('click', (event) => { if (event.target === $('detail')) $('detail').close(); });
  $('detail').addEventListener('close', () => restore?.focus());
  plot(); renderSignals(); renderBoard();
})();
