/* Executed unchanged by main.ts and the offline dashboard. Figures are planning assumptions. */
/** @typedef {{
 * route: string, chain: string, active: boolean, capital: number, hold: number,
 * gas: number, venue: number, carry: number, hours: number, cost: number, drop: number,
 * net: number, netHour: number, label: 'worth'|'marginal'|'skip'|'watch',
 * noDrop: number, breakEven: number|null, steps: [string,string,string,string][]
 * }} FarmScenario */
(function (root) {
  'use strict';
  const DEFAULT_TICKET = 1000, DROP_SHARE = 0.10, HOUR_RATE = 25, CAPITAL_RATE = 0.02;
  const money = (n) => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const gasPerTx = (chain) => ({ Ethereum: 6, Solana: 0.25, Bitcoin: 3, Tron: 3, Avalanche: 0.60, Base: 0.15, Arbitrum: 0.25, Optimism: 0.25, Polygon: 0.10 })[chain] ?? 2;

  // The sealed file carries no product, eligibility, fees or campaign data. A route is a
  // conditional workflow, not a claim that a certain market, asset or reward exists.
  function route(category) {
    if (/^(CDP|Collateral Markets|Uncollateralized Lending)$/i.test(category)) return [
      'Collateral review', 'Open the documented collateral or credit flow without signing. Inspect minimums, oracle, liquidation terms and legal eligibility; do not mint debt just to farm.',
      'Follow published reserve and risk updates. If there is no documented supply-only route, keep exposure at zero.',
      'Record the terms; reopen the research only if a non-leveraged, eligible activity is published.', 0];
    if (/lend/i.test(category)) return [
      'Supply-only', 'Find its official supply-only market for an asset you already hold. Check utilization, withdrawal liquidity and reserve limits; do not borrow or loop.',
      'Watch available cash and utilization. Stop if redemption liquidity dries up or the reserve becomes paused.',
      'Redeem the receipt into the underlying asset; confirm wallet balance and remove unused approvals.', 2];
    if (/dex|liquidity manager|indexes/i.test(category)) return [
      'Liquidity', 'Confirm a supported liquid pair, fee tier and quoted entry slippage; use a small wide-range position only if impermanent loss is acceptable.',
      'Check range, pool liquidity and underlying asset prices; do not churn volume or rebalance purely for rewards.',
      'Remove liquidity, collect fees and inspect exit slippage before converting either leg.', 3];
    if (/rwa|tokenized|tokenised/i.test(category)) return [
      'Access check', 'Check investor restrictions, identity requirements, minimum order, custody and redemption terms. Do not deposit without independent verification.',
      'Track the issuer’s eligibility notice and redemption calendar. A listing in DefiLlama does not make the product publicly accessible.',
      'If you already hold a position, document the actual redemption window; otherwise keep this on a no-capital watchlist.', 0];
    if (/basis|derivative|prediction|leveraged|restak|staking|btc|insurance|^chain$|payment|card|governance|dual-token|stablecoin wrapper|cedefi/i.test(category)) return [
      'Observe only', 'Read the official product and participation terms. Do not take a directional, leveraged, bridge, custody or lock-up position solely for speculative eligibility.',
      'Look for a dated public eligibility update and a permitted low-risk activity; no recurring transaction is assumed.',
      'Archive the official terms and stop tracking if participation requires a risk or restriction you cannot accept.', 0];
    if (/yield|farm|curator|allocator|fund/i.test(category)) return [
      'Vault', 'Locate the actual vault and quote entry and exit on the selected network. Verify curator, underlying exposure, caps, share price and redemption queue before a small deposit.',
      'Check share price, utilization and the withdrawal queue weekly. Flag a depeg, paused withdrawals or a change of curator; do not top up for points.',
      'Request redemption before the planned exit if queued, confirm settlement and remove any standing token approval.', 2];
    return ['Research only', 'Identify a public, documented user flow on the listed network. With no verified flow in the snapshot, keep capital at zero.', 'Check the project’s official notices for dated participation terms.', 'Archive the result and reassess only after the project documents eligibility.', 0];
  }

  /** @returns {FarmScenario} */
  function evaluate(row, ticket = DEFAULT_TICKET, dropShare = DROP_SHARE) {
    const [name, first, review, exit, tx] = route(row.category ?? '');
    const chain = row.chains[0] ?? 'unlisted network';
    const active = tx > 0 && row.chains.length > 0;
    const capital = active ? ticket : 0;
    const hold = active ? 28 : 0;
    const gas = active ? gasPerTx(chain) * tx : 0;
    const venue = active ? capital * (tx === 3 ? 0.003 : 0.001) : 0;
    const carry = capital * CAPITAL_RATE * hold / 365;
    const hours = active ? 70 / 60 : 25 / 60;
    const cost = gas + venue + carry + hours * HOUR_RATE;
    const fraction = Math.min(1, capital / row.tvl);
    const drop = row.expected * fraction * dropShare;
    const net = drop - cost;
    const netHour = net / hours;
    const label = active ? (netHour >= HOUR_RATE ? 'worth' : net >= 0 ? 'marginal' : 'skip') : 'watch';
    return {
      route: name, chain, active, capital, hold, gas, venue, carry, hours, cost, drop, net, netHour, label,
      noDrop: -cost, breakEven: drop > 0 ? dropShare * cost / drop : null,
      steps: [
        ['Before funding', `Confirm ${row.name} lists the intended product on ${chain}; verify the official domain, contract and current jurisdiction rules. No confirmed incentive is in the sealed input.`, '$0', '10 min'],
        [active ? 'Day 0 · quote first' : 'Before any deposit', first, active ? `${money(capital)} max principal · ${money(gas + venue)} round-trip allowance` : '$0 principal', active ? '20 min' : '10 min'],
        [active ? 'Weekly ×4' : 'If terms change', review, '$0 planned on-chain spend', active ? '4 × 6 min' : 'Alert only'],
        [active ? 'Day 28 · exit' : 'After review', exit, active ? 'Exit included in round-trip allowance' : '$0', active ? '16 min' : '5 min'],
      ],
    };
  }

  const api = { evaluate, DEFAULT_TICKET, DROP_SHARE, HOUR_RATE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Farm = api;
})(globalThis);
