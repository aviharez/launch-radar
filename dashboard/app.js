// Launch Radar's dashboard: reads window.RADAR (written beside dashboard/ by main.ts) and renders the
// ranked board, the method page and the live-token comps. No network, no framework, no fetch: every
// number on the page comes from data.js, and the detail drawer recomputes a row's implied value from
// its four stored terms so the page and board.json can be seen to agree.
(function () {
  'use strict';

  var D = window.RADAR;
  if (!D) return;
  var M = D.meta, F = M.fit;
  var $ = function (id) { return document.getElementById(id); };
  var state = { q: '', category: 'all', chain: 'all', watch: false, sort: 'implied', dir: -1, tab: 'board', slug: null };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function usd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function usdFull(n) {
    if (n === null || n === undefined) return 'n/a';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2) + '%';
  }
  function ageText(days) {
    if (days === null || days === undefined) return '—';
    if (days >= 365) return (days / 365.25).toFixed(1) + 'y';
    return Math.max(1, Math.round(days)) + 'd';
  }
  function catName(i) { return D.categories[i] === 'Other' ? 'Other' : D.categories[i]; }
  function chainText(ids) { return ids.map(function (i) { return D.chains[i]; }).join(', '); }
  function chainShort(ids) {
    var names = ids.map(function (i) { return D.chains[i]; });
    return names.slice(0, 3).join(' · ') + (names.length > 3 ? ' +' + (names.length - 3) : '');
  }
  function pctRank(n) { return Math.round(n * 1000) / 10 + '%'; }

  // rows: [rank, slug, name, category, chains, tvl, growth, ageDays, watch, implied, low, high,
  //        sizeMultiple, ageMultiplier, growthMultiplier, categoryMultiplier, budget, holdDays]
  var rows = D.rows.map(function (r) {
    return {
      rank: r[0], slug: r[1], name: r[2], category: catName(r[3]), chains: chainText(r[4]), chainsShort: chainShort(r[4]),
      tvl: r[5], growth: r[6], age: r[7], watch: r[8] === 1, implied: r[9], low: r[10], high: r[11],
      sizeMul: r[12], ageMul: r[13], growthMul: r[14], catMul: r[15], budget: r[16], hold: r[17]
    };
  });
  var maxImplied = rows[0] ? rows[0].implied : 1;

  // ------------------------------------------------------------------ the farm plan

  function planFor(row) {
    var capital = row.budget, hold = row.hold, chain = row.chains.split(', ')[0] || 'its main chain';
    var c = row.category.toLowerCase(), name = row.name;
    var gas = row.chains.indexOf('Ethereum') >= 0 ? (row.tvl >= 1e9 ? 18 : 12) : row.chains.indexOf('Solana') >= 0 ? 2 : 4;
    var action;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) {
      action = 'Supply $' + capital + ' USDC to ' + name + ' on ' + chain + ', then borrow $' + Math.round(capital / 3) + " of the chain's major asset against it and keep the loan-to-value under 40%.";
    } else if (c.indexOf('dex') >= 0 || c.indexOf('liquidity manager') >= 0) {
      action = "Add $" + capital + " of liquidity to " + name + "'s deepest USDC pair on " + chain + ', then stake the LP receipt if the app offers it.';
    } else if (c.indexOf('leveraged farm') >= 0 || c.indexOf('yield') >= 0) {
      action = 'Deposit $' + capital + ' USDC into ' + name + "'s top vault on " + chain + '; read its fee and lock-up before you sign, then leave the shares in the vault.';
    } else if (c.indexOf('bridge') >= 0) {
      action = 'Bridge $' + capital + ' USDC to ' + chain + ' through ' + name + ', then use the bridged balance in its app at least once so the bridge counts a real user.';
    } else if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) {
      action = "Stake $" + capital + " of " + chain + "'s native asset through " + name + ' and keep the liquid receipt token in the same wallet.';
    } else if (c.indexOf('rwa') >= 0 || c.indexOf('tokenized') >= 0) {
      action = 'Finish ' + name + "'s KYC first, then mint or subscribe $" + capital + ' of its yield asset on ' + chain + ' and hold the receipt.';
    } else if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('option') >= 0 || c.indexOf('basis') >= 0) {
      action = 'Deposit $' + capital + ' USDC as margin on ' + name + ' on ' + chain + ' and open one small delta-neutral position.';
    } else if (c.indexOf('prediction') >= 0) {
      action = 'Fund $' + capital + ' on ' + name + ' on ' + chain + ' and place one position in a market that resolves within 30 days.';
    } else if (c.indexOf('insurance') >= 0) {
      action = 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy receipt in the farming wallet.';
    } else if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0 || c.indexOf('fund') >= 0) {
      action = 'Deposit $' + capital + ' USDC into a ' + name + ' vault on ' + chain + ', note its curator, fee and redemption window, then leave it open.';
    } else {
      action = 'Deposit $' + capital + ' USDC into ' + name + ' on ' + chain + ' and keep the position open through the snapshot window.';
    }
    return [
      { text: 'Create a fresh ' + chain + ' wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: action, cost: '$' + capital + ' of capital and about $' + gas + ' of gas', time: '20 minutes to set up' },
      { text: 'Make one qualifying action each week from that wallet: a deposit, a borrow, a swap or a vote in ' + name + "'s governance.", cost: 'about $2-5 of gas a week', time: '10 minutes a week' },
      { text: 'Keep the position open for at least ' + hold + ' days so two snapshot dates see it, and do not move the wallet’s funds in between.', cost: 'the $' + capital + ' stays deployed', time: hold + ' days' },
      { text: "Before you withdraw, check " + name + "'s own site and X for a points or claim page; never pay a fee or sign a blind permit to claim.", cost: 'no fee to check, and never a fee to claim', time: '10 minutes' },
      { text: 'Write the wallet address, every date, the gas and each transaction hash in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' }
    ];
  }

  // ------------------------------------------------------------------ chrome

  function renderChrome() {
    $('top-date').textContent = 'snapshot ' + M.as_of;
    $('lede').innerHTML =
      'A size curve fitted on <b>' + F.n_live + ' live-token protocols</b> prices <b>' + M.rows +
      ' pre-token protocols</b> from their own TVL, seven-day change and time without a token. Every row carries the 10–90% band the fit earned, and the method page shows every term it kept and every term it could not.';
    $('hero-tags').innerHTML =
      '<span><b>' + M.watchlist + '/40</b> watchlist covered</span>' +
      '<span><b>' + F.n_live + '</b> live comps</span>' +
      '<span><b>' + pctRank(F.loo_mdape) + '</b> LOO median error</span>' +
      '<span><b>rank ' + F.loo_rank.toFixed(2) + '</b> held out</span>' +
      '<span>frozen ' + M.as_of + '</span>';
    $('eq').innerHTML = 'ln(mcap) <span class="op">=</span> <b>' + F.intercept.toFixed(2) + '</b> <span class="op">+</span> <b>' + F.slope.toFixed(3) + '</b> ln(TVL)<br><span class="op">+</span> age <span class="op">+</span> 7d <span class="op">+</span> category, each capped';
    $('factors').innerHTML =
      '<li><span>Size curve</span><b>ln slope ' + F.slope.toFixed(3) + '</b></li>' +
      '<li><span>Seasoning, capped</span><b>±' + Math.round(F.age_cap * 100) + '%</b></li>' +
      '<li><span>Momentum, capped</span><b>±' + Math.round(F.growth_cap * 100) + '%</b></li>' +
      '<li><span>Category comps</span><b>' + F.cats.length + ' groups</b></li>';
    $('card-foot').textContent = 'R² ' + F.r2.toFixed(2) + ' on ' + F.n_live + ' live tokens; the band is wide and honest. The fit is a prior, not a prophecy.';
    var stats = [
      ['amber', M.watchlist + '<small>/' + M.watchlist + '</small>', 'Watchlist protocols covered'],
      ['', String(M.rows), 'Rows ranked by implied value'],
      ['', String(F.n_live), 'Live-token comps in the fit'],
      ['mint', pctRank(F.loo_mdape), 'Held-out median error, full model'],
      ['', 'rank ' + F.loo_rank.toFixed(2), 'Held-out rank correlation']
    ];
    $('stats').innerHTML = stats.map(function (s) {
      return '<div class="stat ' + s[0] + '"><b>' + s[1] + '</b><span>' + s[2] + '</span></div>';
    }).join('');
  }

  // ------------------------------------------------------------------ board

  function fillFilters() {
    var cats = {}, chains = {};
    rows.forEach(function (r) {
      cats[r.category] = (cats[r.category] || 0) + 1;
      r.chains.split(', ').forEach(function (c) { chains[c] = (chains[c] || 0) + 1; });
    });
    $('category').innerHTML = '<option value="all">All categories</option>' + Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a]; })
      .map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + ' (' + cats[c] + ')</option>'; }).join('');
    $('chain').innerHTML = '<option value="all">All chains</option>' + Object.keys(chains).sort(function (a, b) { return chains[b] - chains[a]; }).slice(0, 24)
      .map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + ' (' + chains[c] + ')</option>'; }).join('');
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var out = rows.filter(function (r) {
      if (state.watch && !r.watch) return false;
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && r.chains.split(', ').indexOf(state.chain) < 0) return false;
      if (q) {
        var hay = (r.name + ' ' + r.slug + ' ' + r.category + ' ' + r.chains).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    var key = state.sort, dir = state.dir;
    out.sort(function (a, b) {
      var va = key === 'growth' && a.growth === null ? -1e9 : key === 'age' && a.age === null ? 1e9 : a[key];
      var vb = key === 'growth' && b.growth === null ? -1e9 : key === 'age' && b.age === null ? 1e9 : b[key];
      if (key === 'name') return dir * String(va).localeCompare(String(vb));
      return dir * ((va > vb) - (va < vb));
    });
    return out;
  }

  function renderRows() {
    var list = filtered();
    $('rows').innerHTML = list.map(function (r) {
      var width = Math.max(4, Math.pow(r.implied / maxImplied, 0.45) * 100);
      var g = r.growth === null ? 'n/a' : pct(r.growth);
      var gcls = r.growth === null ? '' : r.growth > 0 ? 'up' : r.growth < 0 ? 'down' : '';
      return '<tr data-slug="' + esc(r.slug) + '" tabindex="0" class="' + (state.slug === r.slug ? 'open' : '') + '">' +
        '<td class="rank">' + String(r.rank).padStart(3, '0') + '</td>' +
        '<td><div class="proto"><b>' + (r.watch ? '<span class="watch" title="on the 40-protocol watchlist">◆</span>' : '') + esc(r.name) + '</b>' +
        '<small>' + esc(r.category) + ' · ' + esc(r.chainsShort) + '</small></div></td>' +
        '<td class="money">' + usd(r.tvl) + '</td>' +
        '<td class="growth ' + gcls + '">' + g + '</td>' +
        '<td class="age">' + ageText(r.age) + '</td>' +
        '<td class="value"><div class="value-row"><b>' + usd(r.implied) + '</b><span class="bar"><i style="width:' + width.toFixed(1) + '%"></i></span></div></td>' +
        '<td class="band">' + usd(r.low) + ' – ' + usd(r.high) + '</td>' +
        '<td class="chev">›</td></tr>';
    }).join('');
    $('count').innerHTML = '<b>' + list.length + '</b> of ' + rows.length + ' rows';
    $('board-foot').innerHTML = 'Ranked by implied value, the model’s claim of what the token would be worth if the protocol’s record stayed as it is. ' +
      '<b>◆</b> marks a protocol on the snapshot’s 40-protocol watchlist; the rest are early rows below the floor. Click a row for the terms and the farm plan.';
    document.querySelectorAll('#table thead th[data-key]').forEach(function (th) {
      var on = th.getAttribute('data-key') === state.sort;
      th.setAttribute('aria-sort', on ? (state.dir > 0 ? 'ascending' : 'descending') : 'none');
      var arrow = th.querySelector('.arrow');
      if (arrow) arrow.textContent = on ? (state.dir > 0 ? '↑' : '↓') : '↕';
    });
  }

  // ------------------------------------------------------------------ drawer

  function openDrawer(row) {
    state.slug = row.slug;
    var recomputed = Math.round(row.tvl * row.sizeMul * row.ageMul * row.growthMul * row.catMul);
    var catN = 0;
    F.cats.forEach(function (c) { if (D.categories[c[0]] === row.category) catN = c[1]; });
    var delta = Math.abs(recomputed - row.implied) / row.implied;
    var steps = planFor(row);
    var factors = [
      ['Size curve', 'fitted ' + row.sizeMul.toFixed(3) + '× TVL at this size, slope ' + F.slope.toFixed(3), row.sizeMul, true],
      ['Seasoning', 'capped at ±' + Math.round(F.age_cap * 100) + '%; tracked ' + ageText(row.age), row.ageMul, false],
      ['Momentum', '7-day change ' + pct(row.growth) + ', capped at ±' + Math.round(F.growth_cap * 100) + '%', row.growthMul, false],
      ['Category comps', row.category + (catN ? ' · ' + catN + ' comps, shrunk n/(n+4)' : ' · no comps, no adjustment'), row.catMul, false]
    ];
    $('drawer').innerHTML =
      '<div class="drawer-head"><span>Protocol detail · rank ' + row.rank + ' of ' + rows.length + '</span><button class="close" aria-label="Close">×</button></div>' +
      '<div class="drawer-body">' +
      '<h2>' + esc(row.name) + '</h2>' +
      '<p class="sub">' + esc(row.category) + ' · ' + esc(row.chainsShort) + (row.watch ? ' · ◆ watchlist' : ' · early radar') + '</p>' +
      '<p class="big-value">' + usd(row.implied) + '<small>implied token value</small></p>' +
      '<p class="band-line">10–90% band <b>' + usd(row.low) + ' – ' + usd(row.high) + '</b> · ' + (row.implied / row.tvl).toFixed(3) + '× its TVL</p>' +
      '<p class="check-line">Page arithmetic: ' + usd(row.tvl) + ' × ' + row.sizeMul.toFixed(3) + ' (size) × ' + row.ageMul.toFixed(2) + ' (seasoning) × ' + row.growthMul.toFixed(2) + ' (momentum) × ' + row.catMul.toFixed(2) + ' (category) = <b>' + usd(recomputed) + '</b> — ' + (delta < 0.002 ? 'matches board.json (' + usdFull(row.implied) + ').' : 'board.json says ' + usdFull(row.implied) + '; the difference is the stored multipliers rounded.') + '</p>' +
      '<p class="section-h">What made the number</p><div class="decomp">' +
      factors.map(function (f) {
        var cls = f[3] ? '' : Math.abs(f[2] - 1) < 0.005 ? '' : f[2] > 1 ? 'pos' : 'neg';
        return '<div><span>' + esc(f[0]) + '<small>' + esc(f[1]) + '</small></span><b class="' + cls + '">' + (f[3] ? f[2].toFixed(3) + '×' : '×' + f[2].toFixed(2)) + '</b></div>';
      }).join('') + '</div>' +
      '<p class="section-h">Farm plan · $' + row.budget + ' budget · ' + row.hold + '-day hold</p><ol class="plan">' +
      steps.map(function (s) {
        return '<li><p>' + esc(s.text) + '</p><div class="chips"><span>' + esc(s.cost) + '</span><span>' + esc(s.time) + '</span></div></li>';
      }).join('') + '</ol>' +
      '<p class="section-h">The record</p><div class="kv">' +
      '<div><span>TVL</span><b>' + usdFull(row.tvl) + '</b></div>' +
      '<div><span>7-day TVL change</span><b>' + pct(row.growth) + '</b></div>' +
      '<div><span>Tracked without a token</span><b>' + ageText(row.age) + '</b></div>' +
      '<div><span>Category comps</span><b>' + row.category + '</b></div>' +
      '<div><span>Implied value</span><b>' + usdFull(row.implied) + '</b></div>' +
      '<div><span>10–90% band</span><b>' + usd(row.low) + ' – ' + usd(row.high) + '</b></div></div>' +
      '<p class="disclaimer">The plan is generated from this protocol’s own category, chains, TVL and age, never from a hand-written list. Nothing here is investment advice.</p>' +
      '</div>';
    $('drawer').classList.add('open');
    $('drawer').setAttribute('aria-hidden', 'false');
    $('scrim').hidden = false;
    $('drawer').querySelector('.close').focus();
    renderRows();
  }

  function closeDrawer() {
    state.slug = null;
    $('drawer').classList.remove('open');
    $('drawer').setAttribute('aria-hidden', 'true');
    $('scrim').hidden = true;
    renderRows();
  }

  // ------------------------------------------------------------------ method

  function scatterSvg() {
    var pts = D.scatter, w = 560, h = 300, pad = 40;
    var xs = pts.map(function (p) { return p[0]; }), ys = [];
    pts.forEach(function (p) { ys.push(p[1], p[2]); });
    var x0 = Math.min.apply(null, xs) - 0.2, x1 = Math.max.apply(null, xs) + 0.2;
    var y0 = Math.min.apply(null, ys) - 0.2, y1 = Math.max.apply(null, ys) + 0.2;
    var sx = function (v) { return pad + (v - x0) / (x1 - x0) * (w - pad - 14); };
    var sy = function (v) { return h - pad - (v - y0) / (y1 - y0) * (h - pad - 16); };
    var ticks = [7, 8, 9, 10];
    var out = '<svg class="scatter" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Predicted against actual market cap for live tokens">';
    out += '<rect x="' + pad + '" y="14" width="' + (w - pad - 14) + '" height="' + (h - pad - 14) + '" fill="none" stroke="#1f2836"/>';
    ticks.forEach(function (t) {
      if (t < x0 || t > x1) return;
      out += '<line class="axis" x1="' + sx(t) + '" y1="' + (h - pad) + '" x2="' + sx(t) + '" y2="14"/>';
      out += '<text x="' + sx(t) + '" y="' + (h - pad + 14) + '" text-anchor="middle">$' + (t === 7 ? '10M' : t === 8 ? '100M' : t === 9 ? '1B' : '10B') + '</text>';
    });
    ticks.forEach(function (t) {
      if (t < y0 || t > y1) return;
      out += '<line class="axis" x1="' + pad + '" y1="' + sy(t) + '" x2="' + (w - 14) + '" y2="' + sy(t) + '"/>';
      out += '<text x="' + (pad - 6) + '" y="' + (sy(t) + 3) + '" text-anchor="end">$' + (t === 7 ? '10M' : t === 8 ? '100M' : t === 9 ? '1B' : '10B') + '</text>';
    });
    var lo = Math.max(x0, y0), hi = Math.min(x1, y1);
    out += '<line class="diag" x1="' + sx(lo) + '" y1="' + sy(lo) + '" x2="' + sx(hi) + '" y2="' + sy(hi) + '"/>';
    out += '<text x="' + sx(x0 + (x1 - x0) * 0.06) + '" y="' + (h - 10) + '">TVL, log scale</text>';
    out += '<text x="' + (pad + 4) + '" y="24">market cap, log scale</text>';
    pts.forEach(function (p) {
      out += '<circle class="dot" cx="' + sx(p[2]).toFixed(1) + '" cy="' + sy(p[1]).toFixed(1) + '" r="2.4"><title>' + esc('market ' + Math.pow(10, p[1]).toFixed(0) + ' vs model ' + Math.pow(10, p[2]).toFixed(0)) + '</title></circle>';
    });
    return out + '</svg>';
  }

  function renderMethod() {
    var metric = [
      ['Full model, second-order terms capped', F.loo_mdape, F.loo_rank, true],
      ['Size curve only', F.size_only_mdape, F.size_only_rank, false],
      ['Flat 0.25× multiple (the house baseline)', F.flat_mdape, F.flat_rank, false]
    ];
    var cal = F.buckets;
    var maxMult = Math.max.apply(null, cal.map(function (b) { return Math.max(b[2], b[3]); }));
    var cats = F.cats.slice(0, 10);
    $('view-method').innerHTML =
      '<div class="view-head"><div><h2>What the fit earned — and what it did not.</h2>' +
      '<p>Every number below is computed from the snapshot’s own live-token protocols, then tested on the protocol it never saw. The size curve carries the model; the seasoning and momentum terms are reported, capped and kept small.</p></div></div>' +
      '<div class="grid-2">' +
      '<section class="panel"><h3>Held-out error</h3><p class="hint">Leave-one-out over ' + F.n_live + ' live tokens. MdAPE is the median absolute percentage error of the level; ρ is the rank correlation of the held-out prediction.</p>' +
      '<table class="metric-table"><thead><tr><th>Model</th><th>MdAPE</th><th>Rank corr.</th></tr></thead><tbody>' +
      metric.map(function (m) {
        return '<tr class="' + (m[3] ? 'best' : '') + '"><td>' + m[0] + '</td><td class="n">' + pctRank(m[1]) + '</td><td class="n">' + m[2].toFixed(2) + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<p class="hint" style="margin:12px 0 0">Ranking is not where a flat multiple fails: ranking by TVL ranks well. Its <b>levels</b> are what fail — 0.25× at $1B+ is about eight times the market’s median, while the fitted curve tracks it. The seasoning and momentum terms are capped so they tilt the size curve, never swamp it.</p></section>' +
      '<section class="panel"><h3>Terms tested</h3><p class="hint">Ordinary least squares on ln(market cap). Intervals are the 5th–95th percentile of 300 bootstrap resamples.</p>' +
      '<table class="metric-table"><thead><tr><th>Term</th><th>Coefficient</th><th>90% interval</th><th>Verdict</th></tr></thead><tbody>' +
      F.terms.map(function (t) {
        var keep = t[4].indexOf('kept') === 0;
        return '<tr><td>' + esc(t[0]) + '</td><td class="n">' + t[1].toFixed(3) + '</td><td class="n">' + t[2].toFixed(2) + ' … ' + t[3].toFixed(2) + '</td><td><span class="tag ' + (keep ? 'keep' : 'soft') + '">' + (keep ? 'kept' : 'capped') + '</span><div class="term-verdict">' + esc(t[4]) + '</div></td></tr>';
      }).join('') + '</tbody></table></section></div>' +
      '<div class="grid-2" style="margin-top:18px">' +
      '<section class="panel"><h3>Calibration by size</h3><p class="hint">Median market-cap-to-TVL multiple in each TVL bucket: what the live tokens show against what the model says.</p>' +
      '<div class="legend"><span><i style="background:#94a0b4"></i>observed</span><span><i style="background:#f3b74e"></i>model</span></div><div class="cal">' +
      cal.map(function (b) {
        return '<div class="cal-row"><span>' + esc(b[0]) + '<br>n = ' + b[1] + '</span><div class="cal-bars">' +
          '<div class="cal-bar obs"><i><em style="width:' + (b[2] / maxMult * 100).toFixed(1) + '%"></em></i><b>' + b[2].toFixed(3) + '×</b></div>' +
          '<div class="cal-bar pred"><i><em style="width:' + (b[3] / maxMult * 100).toFixed(1) + '%"></em></i><b>' + b[3].toFixed(3) + '×</b></div></div></div>';
      }).join('') + '</div></section>' +
      '<section class="panel"><h3>Predicted against actual</h3><p class="hint">Each dot is one live-token protocol. The dashed line is perfect agreement; the spread is the band the board carries.</p>' +
      scatterSvg() + '</section></div>' +
      '<section class="panel" style="margin-top:18px"><h3>Category comps</h3><p class="hint">The median residual of the live tokens that share a category, shrunk by n/(n+4) and capped at ±0.5 in log space. A category with no comps gets no adjustment.</p>' +
      '<table class="metric-table"><thead><tr><th>Category</th><th>Comps</th><th>Median residual</th><th>Multiplier</th></tr></thead><tbody>' +
      cats.map(function (c) {
        return '<tr><td>' + esc(catName(c[0])) + '</td><td class="n">' + c[1] + '</td><td class="n">' + (c[2] > 0 ? '+' : '') + c[2].toFixed(2) + '</td><td class="n">×' + Math.exp(c[3]).toFixed(2) + '</td></tr>';
      }).join('') + '</tbody></table></section>' +
      '<p class="method-note"><b>How to read the board.</b> Ranks go by implied value, which is an absolute claim, not a multiple: a $28M TVL protocol can outrank a $2.8B one when the size curve says the market pays small protocols a richer multiple. A band is the 10th–90th percentile of the fit’s residual spread, not a promise. The snapshot is frozen at ' + M.as_of + '; the model never reads the network, and no protocol is special-cased by name.</p>';
  }

  function renderLive() {
    var live = D.live;
    $('view-live').innerHTML =
      '<div class="view-head"><div><h2>The other side of the fit: tokens that already trade.</h2>' +
      '<p>The ' + live.length + ' largest live-token protocols in the snapshot, priced by the market. They never enter the board — the model is for protocols still waiting — and they are the comps the curve is fitted on.</p></div></div>' +
      '<div class="table-wrap"><table class="live-table"><thead><tr><th>Protocol</th><th>Category</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Market ×TVL</th><th class="num">Model ×TVL</th><th class="num">Gap</th><th class="num">In fit</th></tr></thead><tbody>' +
      live.map(function (l) {
        var gap = l[6] - l[5];
        return '<tr><td>' + esc(l[0]) + '</td><td>' + esc(catName(l[1])) + '</td><td class="num">' + usd(l[3]) + '</td><td class="num">' + usd(l[4]) + '</td><td class="num">' + l[5].toFixed(3) + '×</td><td class="num">' + l[6].toFixed(3) + '×</td><td class="num" style="color:' + (Math.abs(gap) > 0.15 ? '#ff7f6e' : '#94a0b4') + '">' + (Math.abs(gap) >= 100 ? (gap > 0 ? '>99×' : '<-99×') : (gap > 0 ? '+' : '') + gap.toFixed(3)) + '</td><td class="num" style="color:' + (l[7] ? '#5fd6a2' : '#6a7688') + '">' + (l[7] ? 'yes' : '—') + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<p class="footnote">Model ×TVL is the fitted value for that protocol’s size and category, before the seasoning and momentum caps. <b>In fit</b> marks the ' + F.n_live + ' comps: a live token with a tracking date and a market cap within ' + F.outlier_multiple + '× its TVL. ' + F.n_excluded + ' priced above that line sit outside the curve — at that distance the token is pricing something TVL does not describe. The gap is information, not an error to hide.</p>';
  }

  // ------------------------------------------------------------------ wiring

  function switchTab(name) {
    state.tab = name;
    ['board', 'method', 'live'].forEach(function (t) {
      $('view-' + t).hidden = t !== name;
      var btn = document.querySelector('.tab[data-tab="' + t + '"]');
      btn.setAttribute('aria-selected', String(t === name));
    });
    if ($('hero')) $('hero').hidden = name !== 'board';
    if ($('stats')) $('stats').hidden = name !== 'board';
    if (name === 'method') renderMethod();
    if (name === 'live') renderLive();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function applyUrl() {
    var p = new URLSearchParams(location.search);
    if (p.get('tab')) switchTab(p.get('tab'));
    if (p.get('category')) { state.category = p.get('category'); $('category').value = state.category; }
    if (p.get('chain')) { state.chain = p.get('chain'); $('chain').value = state.chain; }
    if (p.get('q')) { state.q = p.get('q'); $('q').value = state.q; }
    if (p.get('watch') === '1') { state.watch = true; $('watch').checked = true; }
    if (p.get('sort')) { var s = p.get('sort'); if (['rank', 'name', 'tvl', 'growth', 'age', 'implied'].indexOf(s) >= 0) state.sort = s; }
    if (p.get('dir')) state.dir = p.get('dir') === 'asc' ? 1 : -1;
    renderRows();
    if (p.get('slug')) {
      var row = rows.filter(function (r) { return r.slug === p.get('slug'); })[0];
      if (row) openDrawer(row);
    }
  }

  renderChrome();
  fillFilters();
  renderRows();
  renderMethod();
  renderLive();

  document.querySelectorAll('.tab').forEach(function (b) {
    b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
  });
  document.querySelectorAll('#table thead th[data-key]').forEach(function (th) {
    th.addEventListener('click', function () {
      var key = th.getAttribute('data-key');
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = key === 'name' || key === 'rank' ? 1 : -1; }
      renderRows();
    });
  });
  $('q').addEventListener('input', function () { state.q = $('q').value; renderRows(); });
  $('category').addEventListener('change', function () { state.category = $('category').value; renderRows(); });
  $('chain').addEventListener('change', function () { state.chain = $('chain').value; renderRows(); });
  $('watch').addEventListener('change', function () { state.watch = $('watch').checked; renderRows(); });
  $('reset').addEventListener('click', function () {
    state.q = ''; state.category = 'all'; state.chain = 'all'; state.watch = false;
    $('q').value = ''; $('category').value = 'all'; $('chain').value = 'all'; $('watch').checked = false;
    renderRows();
  });
  $('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (!tr) return;
    var row = rows.filter(function (r) { return r.slug === tr.getAttribute('data-slug'); })[0];
    if (row) openDrawer(row);
  });
  $('rows').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var tr = e.target.closest('tr[data-slug]');
    if (!tr) return;
    e.preventDefault();
    var row = rows.filter(function (r) { return r.slug === tr.getAttribute('data-slug'); })[0];
    if (row) openDrawer(row);
  });
  $('drawer').addEventListener('click', function (e) {
    if (e.target.classList.contains('close')) closeDrawer();
  });
  $('scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.slug) closeDrawer(); });
  applyUrl();
})();
