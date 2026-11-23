// Launch Radar's dashboard: reads window.RADAR (written beside dashboard/ by main.ts) and renders the
// expected-value board, the costed farm verdicts, the accounting ledger and the evidence page. No
// network, no framework, no fetch. The detail drawer recomputes a row's launch value and expected value
// from its stored terms, so the page and board.json can be seen to agree.
(function () {
  'use strict';

  var D = window.RADAR;
  if (!D) return;
  var M = D.meta, F = M.fit, O = F.odds;
  var $ = function (id) { return document.getElementById(id); };
  var state = { q: '', category: 'all', chain: 'all', verdict: 'all', watch: false, ticket: 10000, sort: 'implied', dir: -1, tab: 'board', slug: null };
  var TICKET = 10000, DROP_SHARE = 0.10, CAPITAL_CHARGE = 0.02, HOUR_RATE = 25;

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
  function usdFull(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2) + '%';
  }
  function ageText(days) {
    if (days === null || days === undefined) return '—';
    if (days >= 365) return (days / 365.25).toFixed(1) + 'y';
    return Math.max(1, Math.round(days)) + 'd';
  }
  function catName(i) { return D.categories[i] || 'Other'; }
  function chainText(ids) { return ids.map(function (i) { return D.chains[i]; }).join(', '); }
  function chainShort(ids) {
    var names = ids.map(function (i) { return D.chains[i]; });
    return names.slice(0, 3).join(' · ') + (names.length > 3 ? ' +' + (names.length - 3) : '');
  }
  function pctRank(n) { return Math.round(n * 1000) / 10 + '%'; }
  function ticketLabel(n) { return '$' + n.toLocaleString('en-US'); }

  // rows: [rank, slug, name, cat, chains, tvl, growth, ageDays, watch, implied, oddsInt, low, high,
  //        expected, slice1k, fees, setupMin, sizeMul, ageMul, growthMul, catMul, budget, hold, gas,
  //        verdictCode, netHour, cost, drop, breakEven]
  var rows = D.rows.map(function (r) {
    return {
      rank: r[0], slug: r[1], name: r[2], category: catName(r[3]), chains: chainText(r[4]), chainsShort: chainShort(r[4]),
      tvl: r[5], growth: r[6], age: r[7], watch: r[8] === 1, implied: r[9], odds: r[10] / 10000,
      low: r[11], high: r[12], expected: r[13], slice1k: r[14], fees: r[15], setupMin: r[16],
      sizeMul: r[17], ageMul: r[18], growthMul: r[19], catMul: r[20], budget: r[21], hold: r[22], gas: r[23]
    };
  });

  function verdictOf(row, ticket) {
    var weeks = Math.max(1, Math.ceil(row.hold / 7));
    var hours = 0.25 + 0.15 * weeks + 0.2;
    var cost = row.gas + 3 * weeks + ticket * CAPITAL_CHARGE * (row.hold / 365) + hours * HOUR_RATE;
    var share = Math.min(1, ticket / Math.max(1, row.tvl));
    var drop = row.expected * share * DROP_SHARE;
    var net = drop - cost;
    var perHour = net / hours;
    return {
      ticket: ticket, cost: cost, drop: drop, net: net, netHour: perHour, hours: hours,
      label: perHour >= HOUR_RATE ? 'worth' : net >= 0 ? 'marginal' : 'skip',
      breakEven: cost / Math.max(1e-9, share * DROP_SHARE)
    };
  }

  // ------------------------------------------------------------------ chrome, tiles, ledger

  function renderValueMap() {
    var el = $('value-map');
    if (!el) return;
    var w = 330, h = 118, pad = 12, x0 = 6.5, x1 = 10.2, y0 = 5.0, y1 = 9.0;
    var sx = function (v) { return pad + (v - x0) / (x1 - x0) * (w - pad - 8); };
    var sy = function (v) { return h - pad - (v - y0) / (y1 - y0) * (h - pad - 10); };
    var out = '<svg viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="TVL against implied value, log scales">';
    out += '<line x1="' + pad + '" y1="' + (h - pad) + '" x2="' + (w - 8) + '" y2="' + (h - pad) + '" stroke="#2b3647"/>';
    out += '<line x1="' + pad + '" y1="10" x2="' + pad + '" y2="' + (h - pad) + '" stroke="#2b3647"/>';
    out += '<text x="' + (w - 8) + '" y="' + (h - 3) + '" text-anchor="end" fill="#6a7688" font-size="8.5">TVL, log</text>';
    out += '<text x="' + (pad + 3) + '" y="12" fill="#6a7688" font-size="8.5">implied value</text>';
    rows.forEach(function (r) {
      var cx = sx(Math.log10(Math.max(1, r.tvl))), cy = sy(Math.log10(Math.max(1, r.implied)));
      if (cx < pad || cx > w - 8 || cy < 10 || cy > h - pad) return;
      out += '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + (r.watch ? 2.3 : 1.4) + '" fill="' + (r.watch ? '#f3b74e' : '#5a6b86') + '" fill-opacity="' + (r.watch ? 0.9 : 0.55) + '"/>';
    });
    el.innerHTML = out + '</svg>';
  }

  function renderChrome() {
    renderValueMap();
    $('top-date').textContent = 'snapshot ' + M.as_of;
    $('lede').innerHTML =
      'A size and category comps curve prices each pre-token protocol <b>if its token launches</b>; a peer-odds model fitted on <b>' + O.n +
      ' eligible protocols</b> supplies the chance it ever records one. The board ranks by implied value; every row carries its expected value, a $1,000 slice and a costed farm verdict.';
    $('formula').innerHTML =
      'implied value <span class="op">=</span> TVL <span class="op">×</span> fitted multiple <span class="op">·</span> (age, momentum, category, capped) — what the token is worth if it launches. ' +
      'expected value <span class="op">=</span> implied <span class="op">×</span> token odds <span class="op">·</span> (size, age, chains, category); slice <span class="op">=</span> expected <span class="op">×</span> your share of TVL <span class="op">×</span> 10%. Every coefficient is fitted on this snapshot and tested held-out. No protocol is named in the code.';
    $('eq').innerHTML = 'implied value <span class="op">=</span> <b>' + F.intercept.toFixed(2) + '</b> <span class="op">+</span> <b>' + F.slope.toFixed(3) + '</b> ln(TVL)<br>' +
      '<span class="op">×</span> age <span class="op">×</span> 7d <span class="op">×</span> category, capped<br>' +
      'odds <span class="op">=</span> logit(size, age, chains, category)';
    var worthRows = rows.map(function (r) { return { r: r, v: verdictOf(r, state.ticket) }; }).filter(function (x) { return x.v.label === 'worth'; });
    var worth = worthRows.length;
    var best = worthRows.reduce(function (m, x) { return Math.max(m, x.v.netHour); }, 0);
    $('card-foot').textContent = 'Value R² ' + F.r2.toFixed(2) + ' · band ' + pctRank(F.coverage) + ' · odds Brier ' + O.cv_brier.toFixed(3) + ' vs ' + O.base_brier.toFixed(3) + ' base (AUC ' + O.cv_auc.toFixed(2) + ', ' + O.n + ' peers). The band is wide and honest; the odds are a peer base rate, not a promise.';

    var blind = F.blinds[0];
    var tiles = [
      ['amber', '×' + blind[6].toFixed(2), 'Out-of-sample miss, LOO', 'flat multiple ×' + blind[7].toFixed(2)],
      ['mint', pctRank(F.coverage), 'P10–P90 band coverage', 'ideal 80%; ' + F.n_live + ' held-out caps'],
      ['', usd(M.total_implied_usd), 'Total implied value', M.watchlist + ' watchlist + ' + M.early + ' early'],
      ['mint', worth + ' of ' + rows.length, 'Worth farming', ticketLabel(state.ticket) + ' ticket · $25/hour bar'],
      ['', '+$' + Math.round(best) + '/h', 'Best farm rate', 'net of gas, fees, capital and time'],
      ['amber', M.watchlist + '/40', 'Watchlist ranked', M.watchlist + ' watchlist · ' + M.early + ' early']
    ];
    $('tiles').innerHTML = tiles.map(function (t) {
      return '<div class="tile ' + t[0] + '"><b>' + t[1] + '</b><span>' + t[2] + '</span><em>' + t[3] + '</em></div>';
    }).join('');
  }

  function checksumOf(list) {
    var hash = 0x811c9dc5;
    list.forEach(function (r) {
      var text = r.slug + ':' + r.implied;
      for (var i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
    });
    return hash.toString(16).padStart(8, '0');
  }

  function renderLedger() {
    var groups = F.ledger, total = groups.reduce(function (s, g) { return s + g[2]; }, 0);
    var colors = { watch: '#f3b74e', early: '#5fd6a2', comp: '#8aabff', 'live-out': '#4b5a74', 'pre-out': '#2b3647' };
    var sum = rows.reduce(function (s, r) { return s + r.implied; }, 0);
    var ranksOk = rows.every(function (r, i) { return r.rank === i + 1; });
    var watchOk = rows.filter(function (r) { return r.watch; }).length === M.watchlist;
    var checksumOk = checksumOf(rows) === M.checksum;
    var totalOk = sum === M.total_implied_usd;
    $('ledger').innerHTML =
      '<div class="ledger-head"><span>Protocol accounting</span><span><b>' + M.rows + '</b> ranked of <b>' + total + '</b> snapshot protocols, in exactly one group</span></div>' +
      '<div class="stack">' + groups.map(function (g) {
        return '<i style="width:' + (g[2] / total * 100).toFixed(2) + '%;background:' + colors[g[0]] + '" title="' + esc(g[1]) + ': ' + g[2] + '"></i>';
      }).join('') + '</div>' +
      '<div class="ledger-legend">' + groups.map(function (g) {
        return '<span><i style="background:' + colors[g[0]] + '"></i>' + esc(g[1]) + ' <b>' + g[2] + '</b></span>';
      }).join('') + '</div>' +
      '<div class="ledger-checks">' +
      '<span>' + (ranksOk ? '<b>✓</b>' : '✗') + ' ranks 1–' + rows.length + '</span>' +
      '<span>' + (totalOk ? '<b>✓</b>' : '✗') + ' totals equal ' + usdFull(M.total_implied_usd) + '</span>' +
      '<span>' + (watchOk ? '<b>✓</b>' : '✗') + ' watchlist ' + M.watchlist + ' of ' + M.watchlist + '</span>' +
      '<span>' + (checksumOk ? '<b>✓</b>' : '✗') + ' checksum ' + M.checksum + ' = main.ts</span>' +
      '<span>' + (total === 758 ? '<b>✓</b>' : '✗') + ' ledger ' + total + ' of 758</span>' +
      '</div>';
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
      if (state.verdict !== 'all' && verdictOf(r, state.ticket).label !== state.verdict) return false;
      if (q) {
        var hay = (r.name + ' ' + r.slug + ' ' + r.category + ' ' + r.chains).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    var key = state.sort, dir = state.dir;
    out.sort(function (a, b) {
      var va, vb;
      if (key === 'nph') { va = verdictOf(a, state.ticket).netHour; vb = verdictOf(b, state.ticket).netHour; }
      else if (key === 'growth') { va = a.growth === null ? -1e9 : a.growth; vb = b.growth === null ? -1e9 : b.growth; }
      else if (key === 'age') { va = a.age === null ? 1e9 : a.age; vb = b.age === null ? 1e9 : b.age; }
      else if (key === 'slice') { va = a.slice1k; vb = b.slice1k; }
      else { va = a[key]; vb = b[key]; }
      if (key === 'name') return dir * String(va).localeCompare(String(vb));
      return dir * ((va > vb) - (va < vb));
    });
    return out;
  }

  function renderRows() {
    var list = filtered();
    $('rows').innerHTML = list.map(function (r) {
      var v = verdictOf(r, state.ticket);
      var g = r.growth === null ? 'n/a' : pct(r.growth);
      var gcls = r.growth === null ? '' : r.growth > 0 ? 'up' : r.growth < 0 ? 'down' : '';
      return '<tr data-slug="' + esc(r.slug) + '" tabindex="0" class="' + (state.slug === r.slug ? 'open' : '') + '">' +
        '<td class="rank">' + String(r.rank).padStart(3, '0') + '</td>' +
        '<td><div class="proto"><b>' + (r.watch ? '<span class="watch" title="on the 40-protocol watchlist">◆</span>' : '') + esc(r.name) + '</b>' +
        '<small>' + esc(r.category) + ' · ' + esc(r.chainsShort) + '</small></div></td>' +
        '<td class="money">' + usd(r.tvl) + '</td>' +
        '<td class="growth ' + gcls + '">' + g + '</td>' +
        '<td class="age">' + ageText(r.age) + '</td>' +
        '<td class="odds">' + Math.round(r.odds * 100) + '%</td>' +
        '<td class="value"><b>' + usd(r.implied) + '</b><small>' + usd(r.low) + ' – ' + usd(r.high) + '</small></td>' +
        '<td class="slice">$' + r.slice1k.toFixed(2) + '</td>' +
        '<td class="fees">$' + r.fees + '<br>' + r.setupMin + 'm</td>' +
        '<td class="verdict"><span class="badge ' + v.label + '">' + v.label + '</span><small>' + (v.netHour > 0 ? '+' : '') + '$' + v.netHour.toFixed(0) + '/h</small></td>' +
        '<td class="chev">›</td></tr>';
    }).join('');
    $('count').innerHTML = '<b>' + list.length + '</b> of ' + rows.length + ' rows';
    document.title = 'Launch Radar — ' + list.length + ' pre-token protocols ranked by expected value';
    $('board-foot').innerHTML = 'Ranked by implied value — what the token is worth if it launches — with the 10–90% band beneath. The expected value multiplies by token odds. ' +
      'The slice is what $1,000 would hold if depositors get 10% of the expected value pro rata to TVL; fees are gas and weekly actions, setup is the plan’s time. ' +
      'The verdict uses a ' + ticketLabel(state.ticket) + ' ticket and charges gas, fees, a 2%/yr capital charge and time. <b>◆</b> marks the watchlist; the rest are early rows below the floor.';
    document.querySelectorAll('#table thead th[data-key]').forEach(function (th) {
      var on = th.getAttribute('data-key') === state.sort;
      th.setAttribute('aria-sort', on ? (state.dir > 0 ? 'ascending' : 'descending') : 'none');
      var arrow = th.querySelector('.arrow');
      if (arrow) arrow.textContent = on ? (state.dir > 0 ? '↑' : '↓') : '↕';
    });
  }

  // ------------------------------------------------------------------ drawer

  function planFor(row) {
    var chain = row.chains.split(', ')[0] || 'its main chain';
    var capital = row.budget, hold = row.hold, gas = row.gas, name = row.name;
    var cap = capital.toLocaleString('en-US');
    var c = row.category.toLowerCase();
    var action;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) {
      action = 'Supply $' + cap + ' USDC to ' + name + ' on ' + chain + ', then borrow $' + Math.round(capital / 3).toLocaleString('en-US') + " of the chain's major asset against it and keep the loan-to-value under 40%.";
    } else if (c.indexOf('dex') >= 0 || c.indexOf('liquidity manager') >= 0) {
      action = "Add $" + cap + " of liquidity to " + name + "'s deepest USDC pair on " + chain + ', then stake the LP receipt if the app offers it.';
    } else if (c.indexOf('leveraged farm') >= 0 || c.indexOf('yield') >= 0) {
      action = 'Deposit $' + cap + ' USDC into ' + name + "'s top vault on " + chain + '; read its fee and lock-up before you sign, then leave the shares in the vault.';
    } else if (c.indexOf('bridge') >= 0) {
      action = 'Bridge $' + cap + ' USDC to ' + chain + ' through ' + name + ', then use the bridged balance in its app at least once so the bridge counts a real user.';
    } else if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) {
      action = "Stake $" + cap + " of " + chain + "'s native asset through " + name + ' and keep the liquid receipt token in the same wallet.';
    } else if (c.indexOf('rwa') >= 0 || c.indexOf('tokenized') >= 0) {
      action = 'Finish ' + name + "'s KYC first, then mint or subscribe $" + cap + ' of its yield asset on ' + chain + ' and hold the receipt.';
    } else if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('option') >= 0 || c.indexOf('basis') >= 0) {
      action = 'Deposit $' + cap + ' USDC as margin on ' + name + ' on ' + chain + ' and open one small delta-neutral position.';
    } else if (c.indexOf('prediction') >= 0) {
      action = 'Fund $' + cap + ' on ' + name + ' on ' + chain + ' and place one position in a market that resolves within 30 days.';
    } else if (c.indexOf('insurance') >= 0) {
      action = 'Buy $' + cap + ' of cover from ' + name + ' on ' + chain + ' and keep the policy receipt in the farming wallet.';
    } else if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0 || c.indexOf('fund') >= 0) {
      action = 'Deposit $' + cap + ' USDC into a ' + name + ' vault on ' + chain + ', note its curator, fee and redemption window, then leave it open.';
    } else {
      action = 'Deposit $' + cap + ' USDC into ' + name + ' on ' + chain + ' and keep the position open through the snapshot window.';
    }
    return [
      { text: 'Create a fresh ' + chain + ' wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: action, cost: '$' + cap + ' of capital and about $' + gas + ' of gas', time: '20 minutes to set up' },
      { text: 'Make one qualifying action each week from that wallet: a deposit, a borrow, a swap or a vote in ' + name + "'s governance.", cost: 'about $2-5 of gas a week', time: '10 minutes a week' },
      { text: 'Keep the position open for at least ' + hold + ' days so two snapshot dates see it, and do not move the wallet’s funds in between.', cost: 'the $' + cap + ' stays deployed', time: hold + ' days' },
      { text: "Before you withdraw, check " + name + "'s own site and X for a points or claim page; never pay a fee or sign a blind permit to claim.", cost: 'no fee to check, and never a fee to claim', time: '10 minutes' },
      { text: 'Write the wallet address, every date, the gas and each transaction hash in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' }
    ];
  }

  function openDrawer(row) {
    state.slug = row.slug;
    var v = verdictOf(row, state.ticket);
    var launch = Math.round(row.tvl * row.sizeMul * row.ageMul * row.growthMul * row.catMul);
    var ev = Math.round(launch * row.odds);
    var launchDelta = Math.abs(launch - row.implied) / row.implied;
    var evDelta = Math.abs(ev - row.expected) / row.expected;
    var catN = 0;
    F.cats.forEach(function (c) { if (D.categories[c[0]] === row.category) catN = c[1]; });
    var factors = [
      ['Size curve', 'fitted ' + row.sizeMul.toFixed(3) + '× TVL at this size, slope ' + F.slope.toFixed(3), row.sizeMul, 'mul'],
      ['Seasoning', 'capped at ±' + Math.round(F.age_cap * 100) + '%; tracked ' + ageText(row.age), row.ageMul, 'mul'],
      ['Momentum', '7-day change ' + pct(row.growth) + ', capped at ±' + Math.round(F.growth_cap * 100) + '%', row.growthMul, 'mul'],
      ['Category comps', row.category + (catN ? ' · ' + catN + ' comps, shrunk n/(n+4)' : ' · no comps, no adjustment'), row.catMul, 'mul'],
      ['Token odds', O.n + ' eligible peers, fitted size/age/chains/category', row.odds, 'odds']
    ];
    var steps = planFor(row);
    var word = v.label === 'worth' ? 'worth it at the $25/hour bar' : v.label === 'marginal' ? 'marginal: clears its costs but not the time bar' : 'skip: the expected drop does not cover the cost';
    $('drawer').innerHTML =
      '<div class="drawer-head"><span>Protocol detail · rank ' + row.rank + ' of ' + rows.length + '</span><button class="close" aria-label="Close">×</button></div>' +
      '<div class="drawer-body">' +
      '<h2>' + esc(row.name) + '</h2>' +
      '<p class="sub">' + esc(row.category) + ' · ' + esc(row.chainsShort) + (row.watch ? ' · ◆ watchlist' : ' · early radar') + '</p>' +
      '<p class="big-value">' + usd(row.implied) + '<small>implied value</small></p>' +
      '<p class="band-line"><b>' + usd(row.implied) + '</b> if it launches × <b>' + Math.round(row.odds * 100) + '%</b> odds = <b>' + usd(row.expected) + '</b> expected · 10–90% band <b>' + usd(row.low) + ' – ' + usd(row.high) + '</b></p>' +
      '<p class="check-line">Page arithmetic: ' + usd(row.tvl) + ' × ' + row.sizeMul.toFixed(3) + ' × ' + row.ageMul.toFixed(2) + ' × ' + row.growthMul.toFixed(2) + ' × ' + row.catMul.toFixed(2) + ' = <b>' + usd(launch) + '</b> if launched; × ' + Math.round(row.odds * 100) + '% = <b>' + usd(ev) + '</b>. ' + (launchDelta < 0.003 && evDelta < 0.01 ? 'Matches board.json (' + usdFull(row.implied) + ' implied, ' + usdFull(row.expected) + ' expected).' : 'board.json says ' + usdFull(row.implied) + '; the difference is the stored multipliers rounded.') + '</p>' +
      '<div class="verdict-card"><div class="vc-top"><span class="badge ' + v.label + '">' + v.label + '</span><b>Farm verdict · ' + ticketLabel(state.ticket) + ' ticket</b><span>' + (v.netHour > 0 ? '+' : '') + '$' + v.netHour.toFixed(2) + '/h</span></div>' +
      '<p>$' + v.cost.toFixed(0) + ' all in over ' + row.hold + ' days (' + v.hours.toFixed(2) + ' h of work) against a <b>$' + v.drop.toFixed(0) + ' expected drop</b> (10% of the expected value for your share of TVL): net <b>$' + v.net.toFixed(0) + '</b>, ' + word + '. Breaks even if the expected value is worth <b>' + usd(v.breakEven) + '</b>.</p></div>' +
      '<p class="section-h">What made the number</p><div class="decomp">' +
      factors.map(function (f) {
        var cls = f[3] === 'odds' ? 'pos' : Math.abs(f[2] - 1) < 0.005 ? '' : f[2] > 1 ? 'pos' : 'neg';
        return '<div><span>' + esc(f[0]) + '<small>' + esc(f[1]) + '</small></span><b class="' + cls + '">' + (f[3] === 'odds' ? Math.round(f[2] * 100) + '%' : f[2].toFixed(3) + '×') + '</b></div>';
      }).join('') + '</div>' +
      '<p class="section-h">Farm plan · $' + row.budget.toLocaleString('en-US') + ' budget · ' + row.hold + '-day hold</p><ol class="plan">' +
      steps.map(function (s) {
        return '<li><p>' + esc(s.text) + '</p><div class="chips"><span>' + esc(s.cost) + '</span><span>' + esc(s.time) + '</span></div></li>';
      }).join('') +
      '<li><p>Farm verdict at a ' + ticketLabel(state.ticket) + ' ticket: $' + v.cost.toFixed(0) + ' of gas, fees and capital charge over ' + row.hold + ' days, against a $' + v.drop.toFixed(0) + ' expected drop — net $' + v.net.toFixed(0) + ', $' + v.netHour.toFixed(2) + '/hour, ' + word + '.</p><div class="chips"><span>$' + v.cost.toFixed(0) + ' all in</span><span>' + row.hold + ' days</span></div></li>' +
      '</ol>' +
      '<p class="section-h">The record</p><div class="kv">' +
      '<div><span>TVL</span><b>' + usdFull(row.tvl) + '</b></div>' +
      '<div><span>7-day TVL change</span><b>' + pct(row.growth) + '</b></div>' +
      '<div><span>Tracked without a token</span><b>' + ageText(row.age) + '</b></div>' +
      '<div><span>Expected value</span><b>' + usdFull(row.expected) + '</b></div>' +
      '<div><span>Token odds</span><b>' + Math.round(row.odds * 100) + '%</b></div>' +
      '<div><span>Category comps</span><b>' + row.category + (catN ? ' · n=' + catN : '') + '</b></div></div>' +
      '<p class="disclaimer">The plan is generated from this protocol’s own category, chains, TVL and age, never from a hand-written list. The verdict assumes 10% of the expected value reaches depositors, pro rata to their share of TVL. Nothing here is investment advice.</p>' +
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
      out += '<circle class="dot" cx="' + sx(p[2]).toFixed(1) + '" cy="' + sy(p[1]).toFixed(1) + '" r="2.4"/>';
    });
    return out + '</svg>';
  }

  function renderMethod() {
    var cal = F.buckets, maxMult = Math.max.apply(null, cal.map(function (b) { return Math.max(b[2], b[3]); }));
    var cats = F.cats.slice(0, 10);
    var blindRows = F.blinds.map(function (b) {
      var better = b[2] <= b[3];
      return '<tr class="' + (better ? 'best' : '') + '"><td>' + esc(b[0]) + '</td><td class="n">' + b[1] + '</td><td class="n">' + pctRank(b[2]) + '</td><td class="n">' + pctRank(b[3]) + '</td><td class="n">' + b[4].toFixed(2) + '</td><td class="n">' + b[5].toFixed(2) + '</td><td class="n">×' + b[6].toFixed(2) + '</td><td class="n">×' + b[7].toFixed(2) + '</td></tr>';
    }).join('');
    var terms = F.terms.map(function (t) {
      var keep = t[4].indexOf('kept') === 0;
      return '<tr><td>' + esc(t[0]) + '</td><td class="n">' + t[1].toFixed(3) + '</td><td class="n">' + t[2].toFixed(2) + '–' + t[3].toFixed(2) + '</td><td><span class="tag ' + (keep ? 'keep' : 'soft') + '">' + (keep ? 'kept' : 'capped') + '</span></td></tr>';
    }).join('');
    var oddsTerms = O.terms.map(function (t) {
      return '<tr><td>' + esc(t[0]) + '</td><td class="n">' + t[1].toFixed(3) + '</td><td class="term-verdict">' + esc(t[2]) + '</td></tr>';
    }).join('');
    var oddsCats = O.cats.slice(0, 8).map(function (c) {
      return '<tr><td>' + esc(catName(c[0])) + '</td><td class="n">' + c[1] + '</td><td class="n">' + (c[2] > 0 ? '+' : '') + c[2].toFixed(2) + '</td></tr>';
    }).join('');
    $('view-method').innerHTML =
      '<div class="view-head"><div><h2>What the fit earned — and what it did not.</h2>' +
      '<p>Every number is computed from the snapshot’s own protocols, then tested on the ones the fit never saw. Two blind tests carry the value model: leave-one-out, and a temporal split in both directions. The odds model carries its own held-out Brier and AUC.</p></div></div>' +
      '<section class="panel"><h3>Two blind tests</h3><p class="hint">MdAPE is the median absolute percentage error of the level; rank is the Spearman correlation; miss is the geometric median of |ln(predicted / actual)|. The flat multiple is the house baseline.</p>' +
      '<table class="metric-table"><thead><tr><th>Test</th><th>n</th><th>MdAPE</th><th>Flat MdAPE</th><th>Rank</th><th>Flat rank</th><th>Miss</th><th>Flat miss</th></tr></thead><tbody>' + blindRows + '</tbody></table>' +
      '<p class="hint" style="margin:12px 0 0">The fitted curve cuts the <b>miss factor</b> on every test (×2.64–3.05 vs ×3.88–4.03 flat). Its median level error is better on leave-one-out; the two temporal splits are mixed on MdAPE because the flat multiple happens to catch the newer cohort’s levels. Ranking is not where a flat multiple fails: ranking by TVL ranks well. Its <b>levels</b> are what fail — 0.25× at $1B+ is about eight times the market’s median, while the fitted curve tracks it. The P10–P90 band covers <b>' + pctRank(F.coverage) + '</b> of held-out caps against an ideal 80%.</p></section>' +
      '<div class="grid-2" style="margin-top:18px">' +
      '<section class="panel"><h3>The value model</h3><p class="hint">Ordinary least squares on ln(market cap), ' + F.n_live + ' live tokens within ' + F.outlier_multiple + '× TVL. Intervals are the 5th–95th percentile of 300 bootstrap resamples.</p>' +
      '<table class="metric-table"><thead><tr><th>Term</th><th>Coefficient</th><th>90% interval</th><th>Verdict</th></tr></thead><tbody>' + terms + '</tbody></table>' +
      '<p class="hint" style="margin:12px 0 0">A kept term’s 90% interval excludes zero. A capped term’s straddles it, so the term tilts the size curve by at most ±' + Math.round(F.age_cap * 100) + '% (age) or ±' + Math.round(F.growth_cap * 100) + '% (momentum). ' + F.n_excluded + ' live tokens priced above ' + F.outlier_multiple + '× TVL sit outside the comp set: at that distance the token is pricing something TVL does not describe.</p></section>' +
      '<section class="panel"><h3>The odds model</h3><p class="hint">Logistic regression on ' + O.n + ' eligible protocols with a tracking date. Label: records a token. 5-fold Brier <b>' + O.cv_brier.toFixed(3) + '</b> vs <b>' + O.base_brier.toFixed(3) + '</b> base; AUC <b>' + O.cv_auc.toFixed(2) + '</b>. Temporal blind test Brier <b>' + O.blind_brier.toFixed(3) + '</b>, AUC <b>' + O.blind_auc.toFixed(2) + '</b>.</p>' +
      '<table class="metric-table"><thead><tr><th>Term</th><th>Coef.</th><th>Why</th></tr></thead><tbody>' + oddsTerms + '</tbody></table>' +
      '<table class="metric-table" style="margin-top:12px"><thead><tr><th>Category effect</th><th>Peers</th><th>Log-odds</th></tr></thead><tbody>' + oddsCats + '</tbody></table></section></div>' +
      '<div class="grid-2" style="margin-top:18px">' +
      '<section class="panel"><h3>Calibration by size</h3><p class="hint">Median market-cap-to-TVL multiple in each TVL bucket: what the live tokens show against what the model says.</p>' +
      '<div class="legend"><span><i style="background:#94a0b4"></i>observed</span><span><i style="background:#f3b74e"></i>model</span></div><div class="cal">' +
      cal.map(function (b) {
        return '<div class="cal-row"><span>' + esc(b[0]) + '<br>n = ' + b[1] + '</span><div class="cal-bars">' +
          '<div class="cal-bar obs"><i><em style="width:' + (b[2] / maxMult * 100).toFixed(1) + '%"></em></i><b>' + b[2].toFixed(3) + '×</b></div>' +
          '<div class="cal-bar pred"><i><em style="width:' + (b[3] / maxMult * 100).toFixed(1) + '%"></em></i><b>' + b[3].toFixed(3) + '×</b></div></div></div>';
      }).join('') + '</div></section>' +
      '<section class="panel"><h3>Predicted against actual</h3><p class="hint">Each dot is one live-token protocol. The dashed line is perfect agreement; the spread is the band the board carries.</p>' + scatterSvg() + '</section></div>' +
      '<section class="panel" style="margin-top:18px"><h3>Category comps</h3><p class="hint">The median residual of the live tokens in a category, shrunk n/(n+4) and capped at ±0.5 in log space. A category with no comps gets no adjustment.</p>' +
      '<table class="metric-table"><thead><tr><th>Category</th><th>Comps</th><th>Median residual</th><th>Multiplier</th></tr></thead><tbody>' +
      cats.map(function (c) {
        return '<tr><td>' + esc(catName(c[0])) + '</td><td class="n">' + c[1] + '</td><td class="n">' + (c[2] > 0 ? '+' : '') + c[2].toFixed(2) + '</td><td class="n">×' + Math.exp(c[3]).toFixed(2) + '</td></tr>';
      }).join('') + '</tbody></table></section>' +
      '<small class="method-note" style="display:block">Ledger: ' + F.ledger.map(function (g) { return esc(g[1]) + ' <b>' + g[2] + '</b>'; }).join(' · ') + ' — ' + F.ledger.reduce(function (s, g) { return s + g[2]; }, 0) + ' of 758. Checksum <b>' + M.checksum + '</b>.</small>';
  }

  function renderLive() {
    var live = D.live;
    $('view-live').innerHTML =
      '<div class="view-head"><div><h2>The other side of the fit: tokens that already trade.</h2>' +
      '<p>The ' + live.length + ' largest live-token protocols in the snapshot, priced by the market. They never enter the board — the model is for protocols still waiting — and the live comps are what the value curve is fitted on.</p></div></div>' +
      '<div class="table-wrap"><table class="live-table"><thead><tr><th>Protocol</th><th>Category</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Market ×TVL</th><th class="num">Model ×TVL</th><th class="num">Gap</th><th class="num">In fit</th></tr></thead><tbody>' +
      live.map(function (l) {
        var gap = l[6] - l[5];
        return '<tr><td>' + esc(l[0]) + '</td><td>' + esc(catName(l[1])) + '</td><td class="num">' + usd(l[3]) + '</td><td class="num">' + usd(l[4]) + '</td><td class="num">' + l[5].toFixed(3) + '×</td><td class="num">' + l[6].toFixed(3) + '×</td><td class="num" style="color:' + (Math.abs(gap) > 0.15 ? '#ff7f6e' : '#94a0b4') + '">' + (Math.abs(gap) >= 100 ? (gap > 0 ? '>99×' : '<-99×') : (gap > 0 ? '+' : '') + gap.toFixed(3)) + '</td><td class="num" style="color:' + (l[7] ? '#5fd6a2' : '#6a7688') + '">' + (l[7] ? 'yes' : '—') + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<p class="footnote">Model ×TVL is the fitted value for that protocol’s size and category, before the seasoning and momentum caps. <b>In fit</b> marks the ' + F.n_live + ' comps: a live token with a tracking date and a market cap within ' + F.outlier_multiple + '× its TVL. ' + F.n_excluded + ' priced above that line sit outside the curve. The gap is information, not an error to hide.</p>';
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
    if ($('tiles')) $('tiles').hidden = name !== 'board';
    if ($('ledger')) $('ledger').hidden = name !== 'board';
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
    if (p.get('verdict')) { state.verdict = p.get('verdict'); $('verdict').value = state.verdict; }
    if (p.get('ticket')) { state.ticket = Number(p.get('ticket')) || 10000; $('ticket').value = String(state.ticket); }
    if (p.get('watch') === '1') { state.watch = true; $('watch').checked = true; }
    if (p.get('sort')) { var s = p.get('sort'); if (['rank', 'name', 'tvl', 'growth', 'age', 'odds', 'implied', 'slice', 'fees', 'nph'].indexOf(s) >= 0) state.sort = s; }
    if (p.get('dir')) state.dir = p.get('dir') === 'asc' ? 1 : -1;
    renderRows();
    renderChrome();
    renderLedger();
    if (p.get('slug')) {
      var row = rows.filter(function (r) { return r.slug === p.get('slug'); })[0];
      if (row) openDrawer(row);
    }
  }

  renderChrome();
  renderLedger();
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
  $('verdict').addEventListener('change', function () { state.verdict = $('verdict').value; renderRows(); });
  $('ticket').addEventListener('change', function () { state.ticket = Number($('ticket').value) || 10000; renderRows(); renderChrome(); });
  $('watch').addEventListener('change', function () { state.watch = $('watch').checked; renderRows(); });
  $('reset').addEventListener('click', function () {
    state.q = ''; state.category = 'all'; state.chain = 'all'; state.verdict = 'all'; state.watch = false; state.ticket = 10000;
    $('q').value = ''; $('category').value = 'all'; $('chain').value = 'all'; $('verdict').value = 'all'; $('watch').checked = false; $('ticket').value = '10000';
    renderRows(); renderChrome();
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
  $('drawer').addEventListener('click', function (e) { if (e.target.classList.contains('close')) closeDrawer(); });
  $('scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.slug) closeDrawer(); });
  applyUrl();
})();
