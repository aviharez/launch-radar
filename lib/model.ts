// Launch Radar: a comps-fitted value model for pre-token protocols.
//
// The snapshot is one frozen read of DefiLlama's protocol index: 758 protocols, 144 of them with a
// token that trades, and 40 on the watchlist (>= $50M TVL, no token recorded, not a wrapped or staked
// product of a token that already trades). The model answers one question for a pre-token protocol:
//
//     if this protocol's record stayed as it is and its token traded, what would that token be worth?
//
// It answers from the snapshot's own record, never from a hand-written list of names:
//
//   1. A size curve is fitted on the protocols whose token already trades:
//          ln(market cap) = a + b * ln(TVL) + c * ln(age in years) + d * (7-day TVL change, %)
//      with age the days DefiLlama has tracked the protocol. The fit is ordinary least squares on
//      every live token with a market cap, a TVL and a tracking date.
//   2. A category comps adjustment is the median residual of the live tokens in that category
//      (Aave-like "Lending" trades richer than "Liquid Staking"), shrunk toward zero by n / (n + 4)
//      and capped at +/- 0.5 in log space, so a three-protocol category cannot run away with the
//      board.
//   3. The implied value is exp(prediction + adjustment), and the row also carries a 10-90% band
//      from the fit's residual spread. A row's decomposition (size multiple, seasoning, momentum,
//      category) is shown in the page, never hidden.
//
// The page reports what the fit earned and what it did not: leave-one-out error and rank correlation
// for the size curve and the full model, the same for the house's flat 0.25x multiple, the bootstrap
// interval of every non-size term, and a calibration table by TVL bucket. The talk is in the dashboard;
// this file is the arithmetic.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export const MODEL_VERSION = 'launch-comps/2.1';
/** The board carries every watchlist slug and the largest pre-token protocols below the floor. */
export const BOARD_ROWS = 150;
/** The house's flat multiple, the baseline the fitted curve has to beat. */
export const FLAT_MULTIPLE = 0.25;
/** A row's band is the 10th to 90th percentile of the fit's residual spread. */
const Z80 = 1.2816;
/** The second-order terms' caps, in log space: a term whose interval straddles zero tilts, never rules. */
const AGE_CAP = 0.08;
const GROWTH_CAP = 0.05;
/** A live token priced above this multiple of its TVL is not a comparable: the token prices something TVL does not describe. */
const OUTLIER_MULTIPLE = 10;

const DAY_MS = 86_400_000;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** Whole days from the snapshot's date back to `listedAt`; null when either is missing or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Years of tracking, floored at three weeks so ln() stays finite and a brand-new protocol is not infinity. */
function ageYears(asOf: string, listedAt: string | null): number | null {
  const days = ageDays(asOf, listedAt);
  return days === null ? null : Math.max(days / 365.25, 0.06);
}

/** The median of a list; 0 when empty. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The p-th percentile of a list (0..1), linearly interpolated. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const at = Math.min(s.length - 1, Math.max(0, (s.length - 1) * p));
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return s[lo]! + (s[hi]! - s[lo]!) * (at - lo);
}

/** Average ranks, so ties do not distort a rank correlation. */
function ranks(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i);
  const out = new Array<number>(values.length).fill(0);
  let at = 0;
  while (at < order.length) {
    let end = at;
    while (end + 1 < order.length && order[end + 1]!.v === order[at]!.v) end++;
    const rank = (at + end) / 2 + 1;
    for (let k = at; k <= end; k++) out[order[k]!.i] = rank;
    at = end + 1;
  }
  return out;
}

/** Spearman's rank correlation, 0 when either side has no spread. */
function spearman(a: number[], b: number[]): number {
  const ra = ranks(a);
  const rb = ranks(b);
  const n = ra.length;
  if (n < 3) return 0;
  const ma = ra.reduce((s, v) => s + v, 0) / n;
  const mb = rb.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i]! - ma) * (rb[i]! - mb);
    da += (ra[i]! - ma) ** 2;
    db += (rb[i]! - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/** Solve a small dense system by Gaussian elimination with partial pivoting. */
function solve(matrix: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row;
    if (Math.abs(a[pivot]![col]!) < 1e-12) return new Array<number>(n).fill(NaN);
    if (pivot !== col) [a[pivot], a[col]] = [a[col]!, a[pivot]!];
    const div = a[col]![col]!;
    for (let k = col; k <= n; k++) a[col]![k] = a[col]![k]! / div;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = a[row]![col]!;
      if (f === 0) continue;
      for (let k = col; k <= n; k++) a[row]![k] = a[row]![k]! - f * a[col]![k]!;
    }
  }
  return a.map((row) => row[n]!);
}

/** Least squares with an intercept: `features` holds the non-intercept columns. */
function leastSquares(features: number[][], y: number[]): number[] {
  const k = features.length + 1;
  const xtx = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty = new Array<number>(k).fill(0);
  for (let i = 0; i < y.length; i++) {
    const row = [1, ...features.map((f) => f[i]!)];
    for (let a = 0; a < k; a++) {
      xty[a] += row[a]! * y[i]!;
      for (let b = 0; b < k; b++) xtx[a]![b] += row[a]! * row[b]!;
    }
  }
  return solve(xtx, xty);
}

function dot(beta: number[], x: number[]): number {
  return beta[0]! + x.reduce((s, v, i) => s + beta[i + 1]! * v, 0);
}

/** The fitted log value with the two second-order terms capped, so an interval that straddles zero tilts. */
function cappedLog(beta: number[], x: number, z: number, growth: number): number {
  return (
    beta[0]! +
    beta[1]! * x +
    Math.max(-AGE_CAP, Math.min(AGE_CAP, beta[2]! * z)) +
    Math.max(-GROWTH_CAP, Math.min(GROWTH_CAP, beta[3]! * growth))
  );
}

/** A tiny seeded generator: the bootstrap is deterministic, so two runs of main.ts write the same bytes. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One live token: the comp set the model is fitted on. */
interface Comp {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl: number;
  mcap: number;
  growth: number;
  x: number; // ln(TVL)
  z: number; // ln(age in years)
  y: number; // ln(market cap)
}

interface TermTest {
  term: string;
  coefficient: number;
  low: number;
  high: number;
  verdict: string;
}

interface CategoryAdjustment {
  category: string;
  n: number;
  residual: number;
  shrunk: number;
}

interface BucketRow {
  label: string;
  n: number;
  observed: number;
  predicted: number;
}

interface ScatterPoint {
  tvl: number;
  actual: number;
  predicted: number;
}

interface LiveRow {
  name: string;
  category: string | null;
  chains: string[];
  tvl: number;
  mcap: number;
  growth: number | null;
  multiple: number;
  modelled: number;
  comp: boolean;
}

export interface FitSummary {
  version: string;
  n_live: number;
  n_excluded: number;
  n_pre_token: number;
  n_watchlist: number;
  outlier_multiple: number;
  intercept: number;
  slope: number;
  r2: number;
  sigma: number;
  loo_mdape: number;
  loo_rank: number;
  flat_mdape: number;
  flat_rank: number;
  size_only_mdape: number;
  size_only_rank: number;
  age_cap: number;
  growth_cap: number;
  terms: TermTest[];
  categories: CategoryAdjustment[];
  buckets: BucketRow[];
  scatter: ScatterPoint[];
  live: LiveRow[];
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  range: { low_usd: number; high_usd: number };
  model: {
    size_multiple: number;
    age_multiplier: number;
    growth_multiplier: number;
    category_multiplier: number;
    category_n: number;
    age_years: number | null;
    growth_pct: number;
    budget_usd: number;
    hold_days: number;
  };
  farm_steps: string[];
}

/** A farm step, before it is written as one string: what to do, what it costs, how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

// ------------------------------------------------------------------ the fit

/** The comp set: live tokens with a market cap, a positive TVL and a tracking date. */
function comps(snapshot: Snapshot): Comp[] {
  const rows: Comp[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    if (p.mcap_usd > OUTLIER_MULTIPLE * p.tvl_usd) continue;
    const years = ageYears(snapshot.as_of, p.listed_at);
    if (years === null) continue;
    rows.push({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl: p.tvl_usd,
      mcap: p.mcap_usd,
      growth: p.change_7d ?? 0,
      x: Math.log(p.tvl_usd),
      z: Math.log(years),
      y: Math.log(p.mcap_usd),
    });
  }
  return rows;
}

/** Fit every part of the model and write down what each part earned. Deterministic throughout. */
export function fitRadar(snapshot: Snapshot): FitSummary {
  const rows = comps(snapshot);
  if (rows.length < 12) throw new SnapshotError(`only ${rows.length} live-token protocols with a tracking date: too few to fit a comps curve`);
  const y = rows.map((r) => r.y);
  const xs = rows.map((r) => r.x);
  const zs = rows.map((r) => r.z);
  const gs = rows.map((r) => r.growth);

  const fullFeatures = [xs, zs, gs];
  const beta = leastSquares(fullFeatures, y);
  const predictFull = rows.map((_, i) => cappedLog(beta, xs[i]!, zs[i]!, gs[i]!));
  const residuals = y.map((v, i) => v - predictFull[i]!);
  const meanY = y.reduce((s, v) => s + v, 0) / y.length;
  const ssTot = y.reduce((s, v) => s + (v - meanY) ** 2, 0);
  const ssRes = residuals.reduce((s, v) => s + v * v, 0);
  const sigma = Math.sqrt(ssRes / Math.max(1, y.length - 4));
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  // Leave-one-out: refit without each row, then score the row it never saw.
  const looFull: number[] = [];
  const looSize: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const keep = rows.map((_, j) => j).filter((j) => j !== i);
    const b = leastSquares(
      fullFeatures.map((f) => f.filter((_, j) => j !== i)),
      keep.map((j) => y[j]!),
    );
    looFull.push(cappedLog(b, xs[i]!, zs[i]!, gs[i]!));
    const bSize = leastSquares([xs.filter((_, j) => j !== i)], keep.map((j) => y[j]!));
    looSize.push(bSize[0]! + bSize[1]! * xs[i]!);
  }
  const mdape = (predicted: number[]): number =>
    median(rows.map((r, i) => Math.abs(Math.exp(predicted[i]! - r.y) - 1)));
  const looRank = spearman(looFull, y);
  const sizeOnlyRank = spearman(looSize, y);
  const flatPred = rows.map((r) => FLAT_MULTIPLE * r.tvl);
  const flatMdape = median(rows.map((r, i) => Math.abs(flatPred[i]! / r.mcap - 1)));
  const flatRank = spearman(flatPred, y.map((v) => Math.exp(v)));

  // Bootstrap the non-size terms: a term whose interval straddles zero is reported as second-order.
  const rand = mulberry32(0x5eed_1a7d);
  const bootSlope: number[] = [];
  const bootAge: number[] = [];
  const bootGrowth: number[] = [];
  for (let b = 0; b < 300; b++) {
    const pick = Array.from({ length: rows.length }, () => Math.floor(rand() * rows.length));
    const by = pick.map((i) => y[i]!);
    const bx = pick.map((i) => xs[i]!);
    const bz = pick.map((i) => zs[i]!);
    const bg = pick.map((i) => gs[i]!);
    const bb = leastSquares([bx, bz, bg], by);
    if (Number.isFinite(bb[1]!)) bootSlope.push(bb[1]!);
    if (Number.isFinite(bb[2]!)) bootAge.push(bb[2]!);
    if (Number.isFinite(bb[3]!)) bootGrowth.push(bb[3]!);
  }
  const ageLow = percentile(bootAge, 0.05);
  const ageHigh = percentile(bootAge, 0.95);
  const growthLow = percentile(bootGrowth, 0.05);
  const growthHigh = percentile(bootGrowth, 0.95);
  const verdict = (low: number, high: number): string =>
    low > 0 || high < 0 ? 'kept: the interval excludes zero' : 'second-order: the interval straddles zero';

  // Category comps: the median residual of the live tokens that share a category, shrunk and capped.
  const byCategory = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const key = rows[i]!.category ?? 'Other';
    const list = byCategory.get(key) ?? [];
    list.push(residuals[i]!);
    byCategory.set(key, list);
  }
  const categories: CategoryAdjustment[] = [...byCategory.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([category, list]) => {
      const residual = median(list);
      const shrunk = Math.max(-0.5, Math.min(0.5, (residual * list.length) / (list.length + 4)));
      return { category, n: list.length, residual: Math.round(residual * 1e4) / 1e4, shrunk: Math.round(shrunk * 1e4) / 1e4 };
    })
    .sort((a, b) => b.n - a.n || a.category.localeCompare(b.category));
  const adjustment = new Map(categories.map((c) => [c.category, c]));

  // Calibration: the observed median multiple against the model's own, by size.
  const bucketDefs: { label: string; lo: number; hi: number }[] = [
    { label: '< $10M', lo: 0, hi: 1e7 },
    { label: '$10M - $50M', lo: 1e7, hi: 5e7 },
    { label: '$50M - $200M', lo: 5e7, hi: 2e8 },
    { label: '$200M - $1B', lo: 2e8, hi: 1e9 },
    { label: '$1B +', lo: 1e9, hi: Infinity },
  ];
  const buckets: BucketRow[] = bucketDefs
    .map((b) => {
      const members = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.tvl >= b.lo && r.tvl < b.hi);
      if (members.length === 0) return null;
      const catMult = (r: Comp): number => Math.exp(adjustment.get(r.category ?? 'Other')?.shrunk ?? 0);
      return {
        label: b.label,
        n: members.length,
        observed: Math.round(median(members.map(({ r }) => r.mcap / r.tvl)) * 1e3) / 1e3,
        predicted: Math.round(median(members.map(({ r, i }) => (Math.exp(predictFull[i]!) * catMult(r)) / r.tvl)) * 1e3) / 1e3,
      };
    })
    .filter((b): b is BucketRow => b !== null);

  const scatter: ScatterPoint[] = rows.map((r, i) => ({
    tvl: r.tvl,
    actual: r.mcap,
    predicted: Math.exp(predictFull[i]!) * Math.exp(adjustment.get(r.category ?? 'Other')?.shrunk ?? 0),
  }));

  const live: LiveRow[] = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || b.mcap_usd! - a.mcap_usd!)
    .slice(0, 24)
    .map((p) => {
      const comp = rows.find((r) => r.slug === p.slug);
      const years = ageYears(snapshot.as_of, p.listed_at) ?? 1.5;
      const logPred = cappedLog(beta, Math.log(p.tvl_usd), Math.log(years), p.change_7d ?? 0) +
        (adjustment.get(p.category ?? 'Other')?.shrunk ?? 0);
      return {
        name: p.name,
        category: p.category,
        chains: p.chains,
        tvl: p.tvl_usd,
        mcap: p.mcap_usd,
        growth: p.change_7d,
        multiple: Math.round((p.mcap_usd / p.tvl_usd) * 1e3) / 1e3,
        modelled: Math.round((Math.exp(logPred) / p.tvl_usd) * 1e3) / 1e3,
        comp: comp !== undefined,
      };
    });

  return {
    version: MODEL_VERSION,
    n_live: rows.length,
    n_excluded: snapshot.protocols.filter((p) =>
      p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 &&
      ageYears(snapshot.as_of, p.listed_at) !== null &&
      p.mcap_usd > OUTLIER_MULTIPLE * p.tvl_usd,
    ).length,
    n_pre_token: snapshot.protocols.filter((p) => p.mcap_usd === null).length,
    outlier_multiple: OUTLIER_MULTIPLE,
    n_watchlist: snapshot.watchlist.length,
    intercept: Math.round(beta[0]! * 1e4) / 1e4,
    slope: Math.round(beta[1]! * 1e4) / 1e4,
    r2: Math.round(r2 * 1e3) / 1e3,
    sigma: Math.round(sigma * 1e4) / 1e4,
    loo_mdape: Math.round(mdape(looFull) * 1e3) / 1e3,
    loo_rank: Math.round(looRank * 1e3) / 1e3,
    flat_mdape: Math.round(flatMdape * 1e3) / 1e3,
    flat_rank: Math.round(flatRank * 1e3) / 1e3,
    size_only_mdape: Math.round(mdape(looSize) * 1e3) / 1e3,
    size_only_rank: Math.round(sizeOnlyRank * 1e3) / 1e3,
    terms: [
      {
        term: 'ln(TVL): the size curve',
        coefficient: Math.round(beta[1]! * 1e4) / 1e4,
        low: Math.round(percentile(bootSlope, 0.05) * 1e4) / 1e4,
        high: Math.round(percentile(bootSlope, 0.95) * 1e4) / 1e4,
        verdict: 'kept: the interval excludes zero on every fold',
      },
      {
        term: 'ln(age in years)',
        coefficient: Math.round(beta[2]! * 1e4) / 1e4,
        low: Math.round(ageLow * 1e4) / 1e4,
        high: Math.round(ageHigh * 1e4) / 1e4,
        verdict: verdict(ageLow, ageHigh),
      },
      {
        term: '7-day TVL change (%)',
        coefficient: Math.round(beta[3]! * 1e4) / 1e4,
        low: Math.round(growthLow * 1e4) / 1e4,
        high: Math.round(growthHigh * 1e4) / 1e4,
        verdict: verdict(growthLow, growthHigh),
      },
    ],
    age_cap: AGE_CAP,
    growth_cap: GROWTH_CAP,
    categories,
    buckets,
    scatter,
    live,
  };
}

// ------------------------------------------------------------------ the board

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a pre-token protocol can stand as a row of the early radar. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Check the protocol's own page before you sign.`;
  return s;
}

/** A farm budget from the protocol's own size: money the position can move, not a slogan. */
export function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long the position has to stay open so two snapshot dates see it. */
export function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** Gas estimate for the protocol's first transaction, from its chain count and size. */
function gasFor(p: SnapshotProtocol): number {
  if (p.chains.includes('Ethereum')) return p.tvl_usd >= 1_000_000_000 ? 18 : 12;
  if (p.chains.includes('Solana')) return 2;
  return 4;
}

/** The category's concrete action on this protocol. One sentence a farmer can follow. */
export function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $${capital} USDC to ${name} on ${chain}, then borrow $${Math.round(capital / 3)} of the chain's major asset against it and keep the loan-to-value under 40%.`;
  }
  if (c.includes('dex') || c.includes('liquidity manager')) {
    return `Add $${capital} of liquidity to ${name}'s deepest USDC pair on ${chain}, then stake the LP receipt if the app offers it.`;
  }
  if (c.includes('leveraged farm') || c.includes('yield')) {
    return `Deposit $${capital} USDC into ${name}'s top vault on ${chain}; read its fee and lock-up before you sign, then leave the shares in the vault.`;
  }
  if (c.includes('bridge')) {
    return `Bridge $${capital} USDC to ${chain} through ${name}, then use the bridged balance in its app at least once so the bridge counts a real user.`;
  }
  if (c.includes('staking') || c.includes('restak')) {
    return `Stake $${capital} of ${chain}'s native asset through ${name} and keep the liquid receipt token in the same wallet.`;
  }
  if (c.includes('rwa') || c.includes('tokenized')) {
    return `Finish ${name}'s KYC first, then mint or subscribe $${capital} of its yield asset on ${chain} and hold the receipt.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option') || c.includes('basis')) {
    return `Deposit $${capital} USDC as margin on ${name} on ${chain} and open one small delta-neutral position.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} on ${name} on ${chain} and place one position in a market that resolves within 30 days.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy receipt in the farming wallet.`;
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('fund')) {
    return `Deposit $${capital} USDC into a ${name} vault on ${chain}, note its curator, fee and redemption window, then leave it open.`;
  }
  return `Deposit $${capital} USDC into ${name} on ${chain} and keep the position open through the snapshot window.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. Derived from the
 * protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = p.chains[0] ?? 'its main chain';
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(p);
  return [
    {
      text: `Create a fresh ${chain} wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '20 minutes to set up',
    },
    {
      text: `Make one qualifying action each week from that wallet: a deposit, a borrow, a swap or a vote in ${p.name}'s governance.`,
      cost: 'about $2-5 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Keep the position open for at least ${hold} days so two snapshot dates see it, and do not move the wallet's funds in between.`,
      cost: `the $${capital} stays deployed`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, check ${p.name}'s own site and X for a points or claim page; never pay a fee or sign a blind permit to claim.`,
      cost: 'no fee to check, and never a fee to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet address, every date, the gas and each transaction hash in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  range_low_usd: number;
  range_high_usd: number;
  size_multiple: number;
  age_multiplier: number;
  growth_multiplier: number;
  category_multiplier: number;
  budget_usd: number;
  hold_days: number;
}

export interface RadarData {
  meta: {
    as_of: string;
    source: string;
    floor_usd: number;
    version: string;
    rows: number;
    early: number;
    watchlist: number;
    fit: FitSummary;
  };
  rows: RadarRow[];
}

/** The implied value of one pre-token protocol, and every term that made it. */
function valueRow(
  p: SnapshotProtocol,
  snapshot: Snapshot,
  beta: { intercept: number; slope: number; age: number; growth: number; sigma: number },
  adjustment: Map<string, CategoryAdjustment>,
): Omit<RadarRow, 'rank'> {
  const age = ageDays(snapshot.as_of, p.listed_at);
  const years = ageYears(snapshot.as_of, p.listed_at) ?? 1.5;
  const growth = p.change_7d ?? 0;
  const cat = adjustment.get(p.category ?? 'Other');
  const catShrunk = cat?.shrunk ?? 0;
  const sizeBase = Math.exp(beta.intercept) * p.tvl_usd ** beta.slope;
  const ageMultiplier = Math.exp(Math.max(-AGE_CAP, Math.min(AGE_CAP, beta.age * Math.log(years))));
  const growthMultiplier = Math.exp(Math.max(-GROWTH_CAP, Math.min(GROWTH_CAP, beta.growth * growth)));
  const categoryMultiplier = Math.exp(catShrunk);
  const implied = Math.min(1e11, Math.max(1, Math.round(sizeBase * ageMultiplier * growthMultiplier * categoryMultiplier)));
  const low = Math.max(1, Math.round(implied * Math.exp(-Z80 * beta.sigma)));
  const high = Math.min(1e11, Math.round(implied * Math.exp(Z80 * beta.sigma)));
  return {
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    age_days: age,
    watchlist: snapshot.watchlist.includes(p.slug),
    implied_value_usd: implied,
    range_low_usd: low,
    range_high_usd: high,
    size_multiple: Math.round((sizeBase / p.tvl_usd) * 1e4) / 1e4,
    age_multiplier: Math.round(ageMultiplier * 1e4) / 1e4,
    growth_multiplier: Math.round(growthMultiplier * 1e4) / 1e4,
    category_multiplier: Math.round(categoryMultiplier * 1e4) / 1e4,
    budget_usd: capitalFor(p),
    hold_days: holdDaysFor(age),
  };
}

/** Everything the entry writes, from one snapshot: the board, the page's data, and the fit's numbers. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData; summary: FitSummary } {
  const summary = fitRadar(snapshot);
  // The exact coefficients again (the summary rounds them for the page; the board is computed unrounded).
  const rows = comps(snapshot);
  const beta = leastSquares(
    [rows.map((r) => r.x), rows.map((r) => r.z), rows.map((r) => r.growth)],
    rows.map((r) => r.y),
  );
  const sigma = Math.sqrt(
    rows.reduce((s, r) => s + (r.y - cappedLog(beta, r.x, r.z, r.growth)) ** 2, 0) / Math.max(1, rows.length - 4),
  );
  const adjustment = new Map(summary.categories.map((c) => [c.category, c]));
  const params = { intercept: beta[0]!, slope: beta[1]!, age: beta[2]!, growth: beta[3]!, sigma };

  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, Math.max(0, BOARD_ROWS - chosen.size));
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, value: valueRow(p, snapshot, params, adjustment) }));
  scored.sort(
    (a, b) =>
      b.value.implied_value_usd - a.value.implied_value_usd ||
      b.p.tvl_usd - a.p.tvl_usd ||
      (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );

  const board: BoardRow[] = scored.map(({ p, value }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    mcap_usd: p.mcap_usd,
    listed_at: p.listed_at,
    gecko_id: p.gecko_id,
    symbol: p.symbol,
    token_status: 'pre-token',
    age_days: value.age_days,
    watchlist: value.watchlist,
    implied_value_usd: value.implied_value_usd,
    range: { low_usd: value.range_low_usd, high_usd: value.range_high_usd },
    model: {
      size_multiple: value.size_multiple,
      age_multiplier: value.age_multiplier,
      growth_multiplier: value.growth_multiplier,
      category_multiplier: value.category_multiplier,
      category_n: adjustment.get(p.category ?? 'Other')?.n ?? 0,
      age_years: value.age_days === null ? null : Math.round((value.age_days / 365.25) * 100) / 100,
      growth_pct: p.change_7d ?? 0,
      budget_usd: value.budget_usd,
      hold_days: value.hold_days,
    },
    farm_steps: farmSteps(p, value.age_days).map(stepText),
  }));

  return {
    board,
    summary,
    radar: {
      meta: {
        as_of: snapshot.as_of,
        source: snapshot.source,
        floor_usd: snapshot.floor_usd,
        version: MODEL_VERSION,
        rows: board.length,
        early: board.filter((r) => !r.watchlist).length,
        watchlist: snapshot.watchlist.length,
        fit: summary,
      },
      rows: board.map((r) => ({
        rank: r.rank,
        slug: r.slug,
        name: r.name,
        category: r.category,
        chains: r.chains,
        tvl_usd: r.tvl_usd,
        change_7d: r.change_7d,
        age_days: r.age_days,
        watchlist: r.watchlist,
        implied_value_usd: r.implied_value_usd,
        range_low_usd: r.range.low_usd,
        range_high_usd: r.range.high_usd,
        size_multiple: r.model.size_multiple,
        age_multiplier: r.model.age_multiplier,
        growth_multiplier: r.model.growth_multiplier,
        category_multiplier: r.model.category_multiplier,
        budget_usd: r.model.budget_usd,
        hold_days: r.model.hold_days,
      })),
    },
  };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** The page's dataset: one script, no fetch, no network, and short keys so the source stays readable. */
export function dataScript(radar: RadarData): string {
  const categories: string[] = [];
  const categoryAt = new Map<string, number>();
  const chains: string[] = [];
  const chainAt = new Map<string, number>();
  const catId = (category: string | null): number => {
    const key = category ?? 'Other';
    const found = categoryAt.get(key);
    if (found !== undefined) return found;
    categoryAt.set(key, categories.length);
    categories.push(key);
    return categories.length - 1;
  };
  const chainIds = (names: string[]): number[] =>
    names.map((name) => {
      const found = chainAt.get(name);
      if (found !== undefined) return found;
      chainAt.set(name, chains.length);
      chains.push(name);
      return chains.length - 1;
    });
  const fit = radar.meta.fit;
  const round3 = (v: number): number => Math.round(v * 1e3) / 1e3;
  const live = fit.live.map((l) => [l.name, catId(l.category), chainIds(l.chains), l.tvl, l.mcap, l.multiple, l.modelled, l.growth === null ? null : round3(l.growth)]);
  const scatter = fit.scatter.map((s) => [round3(Math.log10(s.tvl)), round3(Math.log10(s.actual)), round3(Math.log10(s.predicted))]);
  const rows = radar.rows.map((r) => [
    r.rank,
    r.slug,
    r.name,
    catId(r.category),
    chainIds(r.chains),
    r.tvl_usd,
    r.change_7d === null ? null : round3(r.change_7d),
    r.age_days,
    r.watchlist ? 1 : 0,
    r.implied_value_usd,
    r.range_low_usd,
    r.range_high_usd,
    r.size_multiple,
    r.age_multiplier,
    r.growth_multiplier,
    r.category_multiplier,
    r.budget_usd,
    r.hold_days,
  ]);
  const meta = {
    as_of: radar.meta.as_of,
    floor_usd: radar.meta.floor_usd,
    version: radar.meta.version,
    rows: rows.length,
    early: radar.meta.early,
    watchlist: radar.meta.watchlist,
    fit: {
      n_live: fit.n_live,
      n_excluded: fit.n_excluded,
      n_pre_token: fit.n_pre_token,
      outlier_multiple: fit.outlier_multiple,
      intercept: fit.intercept,
      slope: fit.slope,
      r2: fit.r2,
      sigma: fit.sigma,
      loo_mdape: fit.loo_mdape,
      loo_rank: fit.loo_rank,
      flat_mdape: fit.flat_mdape,
      flat_rank: fit.flat_rank,
      size_only_mdape: fit.size_only_mdape,
      size_only_rank: fit.size_only_rank,
      age_cap: fit.age_cap,
      growth_cap: fit.growth_cap,
      terms: fit.terms.map((t) => [t.term, t.coefficient, t.low, t.high, t.verdict]),
      buckets: fit.buckets.map((b) => [b.label, b.n, b.observed, b.predicted]),
      cats: fit.categories.map((c) => [catId(c.category), c.n, c.residual, c.shrunk]),
    },
  };
  return `window.RADAR=${JSON.stringify({ meta, categories, chains, rows, live, scatter })};\n`;
}

