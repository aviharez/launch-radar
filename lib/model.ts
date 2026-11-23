// Launch Radar: a launch-value comps model and a peer-odds model, both fitted on one frozen snapshot.
//
// The snapshot is one read of DefiLlama's protocol index: 758 protocols, 144 of them with a token that
// trades, and 40 on the watchlist (>= $50M TVL, no token recorded, not a wrapped or staked product of a
// token that already trades). Two questions are answered from the snapshot's own record, never from a
// hand-written list of names:
//
//   1. IF IT LAUNCHES, what is the token worth?
//          ln(market cap) = a + b ln(TVL) + c ln(age in years) + d (7-day TVL change, %)
//      fitted on the live tokens with a market cap, a tracking date and a market cap within 10x TVL
//      (a token priced above that line is pricing something TVL does not describe and is left out of
//      the comp set). A category comps adjustment is the median residual of the live tokens in that
//      category, shrunk n/(n+4) and capped at +/- 0.5 in log space. Age and momentum are capped at
//      +/- 25% and +/- 10% so an interval that straddles zero tilts, never rules.
//
//   2. WHAT ARE THE ODDS IT EVER RECORDS A TOKEN?
//          logit(P(token)) = e + f ln(TVL) + g ln(age in years) + h ln(1 + chains) + category
//      fitted on the eligible protocols that carry a tracking date (the watchlist's own eligibility
//      rule, without DefiLlama's parent field), with a ridge penalty and a per-category mean-residual
//      adjustment. It is a peer base rate, not a forecast that this protocol will launch.
//
// The implied value is the expected value: launch value x odds. The farm verdict is costed: a $10,000
// ticket, gas and weekly fees, a 2%/yr capital charge, and an assumed 10% of the launch value reaching
// depositors pro rata to their share of TVL. Every number is recomputed by the page from the same terms,
// and the method page reports what the fit earned: leave-one-out and two temporal blind tests, the
// P10-P90 band's observed coverage, the odds model's cross-validated Brier and AUC, and a ledger of all
// 758 protocols.

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

export const MODEL_VERSION = 'launch-radar/3';
/** Every watchlist slug and the largest pre-token protocols below the floor. */
export const BOARD_ROWS = 198;
/** The house's flat multiple, the baseline every fitted curve has to beat. */
export const FLAT_MULTIPLE = 0.25;
/** A live token priced above this multiple of its TVL is not a comparable. */
const OUTLIER_MULTIPLE = 10;
/** The value model's second-order caps, in log space. */
const AGE_CAP = 0.25;
const GROWTH_CAP = 0.1;
/** The band is the 10th to 90th percentile of the fit's residual spread. */
const Z80 = 1.2816;
/** The farm verdict's standard ticket, drop share and capital charge. */
const TICKET_USD = 10_000;
const DROP_SHARE = 0.1;
const CAPITAL_CHARGE = 0.02;
const HOUR_RATE = 25;

const DAY_MS = 86_400_000;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// ------------------------------------------------------------------ small maths

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

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

/** Area under the ROC curve, from ranks: 0.5 is a coin, 1 is perfect. */
function auc(y: number[], p: number[]): number {
  const positive = y.reduce((s, v) => s + v, 0);
  const negative = y.length - positive;
  if (positive === 0 || negative === 0) return 0.5;
  const r = ranks(p);
  let sum = 0;
  for (let i = 0; i < y.length; i++) if (y[i] === 1) sum += r[i]!;
  return (sum - (positive * (positive + 1)) / 2) / (positive * negative);
}

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

function cappedLog(beta: number[], x: number, z: number, growth: number): number {
  return (
    beta[0]! +
    beta[1]! * x +
    Math.max(-AGE_CAP, Math.min(AGE_CAP, beta[2]! * z)) +
    Math.max(-GROWTH_CAP, Math.min(GROWTH_CAP, beta[3]! * growth))
  );
}

function sigmoid(z: number): number {
  if (z > 30) return 1;
  if (z < -30) return 0;
  return 1 / (1 + Math.exp(-z));
}

/** A tiny seeded generator: the bootstrap is deterministic, so two runs write the same bytes. */
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

/** Whole days from the snapshot's date back to `listedAt`; null when either is missing or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

function ageYears(asOf: string, listedAt: string | null): number | null {
  const days = ageDays(asOf, listedAt);
  return days === null ? null : Math.max(days / 365.25, 0.06);
}

// ------------------------------------------------------------------ eligibility

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED = /\b(wrapped|staked|staking)\b/;
const EXCHANGE = /^(binance|coinbase|bybit|kraken|bitget|okx|bitfinex|gemini)/;
const NO_TOKEN_CATEGORY: Record<string, true> = {
  Bridge: true,
  'Canonical Bridge': true,
  'Liquid Staking': true,
  'Liquid Restaking': true,
  'Restaked BTC': true,
  CEX: true,
};

/** The watchlist's own eligibility rule, as far as the snapshot's ten fields can carry it. */
export function eligible(p: SnapshotProtocol): boolean {
  if (p.category !== null && NO_TOKEN_CATEGORY[p.category] === true) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED.test(p.name.toLowerCase())) return false;
  if (EXCHANGE.test(p.name.toLowerCase())) return false;
  return true;
}

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && eligible(p);
}

// ------------------------------------------------------------------ the value fit

interface Comp {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl: number;
  mcap: number;
  growth: number;
  listed: string;
  x: number;
  z: number;
  y: number;
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

interface BlindTest {
  name: string;
  n: number;
  mdape: number;
  flat_mdape: number;
  rank: number;
  flat_rank: number;
  miss: number;
  flat_miss: number;
}

interface OddsTerm {
  term: string;
  coefficient: number;
  verdict: string;
}

interface OddsCategory {
  category: string;
  n: number;
  adj: number;
}

export interface OddsModel {
  n: number;
  base_rate: number;
  brier: number;
  base_brier: number;
  auc: number;
  cv_brier: number;
  cv_auc: number;
  blind_brier: number;
  blind_auc: number;
  blind_base: number;
  beta: number[];
  means: number[];
  sds: number[];
  terms: OddsTerm[];
  categories: OddsCategory[];
}

interface LedgerGroup {
  key: string;
  label: string;
  n: number;
}

interface Ledger {
  groups: LedgerGroup[];
  total: number;
  ranked: number;
  total_implied_usd: number;
  checksum: string;
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
  coverage: number;
  terms: TermTest[];
  categories: CategoryAdjustment[];
  buckets: BucketRow[];
  scatter: ScatterPoint[];
  live: LiveRow[];
  odds: OddsModel;
  blinds: BlindTest[];
  ledger: Ledger;
}

function comps(snapshot: Snapshot): Comp[] {
  const rows: Comp[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    if (p.mcap_usd > OUTLIER_MULTIPLE * p.tvl_usd) continue;
    const years = ageYears(snapshot.as_of, p.listed_at);
    if (years === null || p.listed_at === null) continue;
    rows.push({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl: p.tvl_usd,
      mcap: p.mcap_usd,
      growth: p.change_7d ?? 0,
      listed: p.listed_at,
      x: Math.log(p.tvl_usd),
      z: Math.log(years),
      y: Math.log(p.mcap_usd),
    });
  }
  return rows;
}

/** The quality of a set of predictions against the truth, the same three ways every time. */
function scorePredictions(actual: number[], predicted: number[], flat: number[]): Omit<BlindTest, 'name' | 'n'> {
  const mdape = median(actual.map((a, i) => Math.abs(predicted[i]! / a - 1)));
  const flatMdape = median(actual.map((a, i) => Math.abs(flat[i]! / a - 1)));
  const miss = Math.exp(median(actual.map((a, i) => Math.abs(Math.log(predicted[i]! / a)))));
  const flatMiss = Math.exp(median(actual.map((a, i) => Math.abs(Math.log(flat[i]! / a)))));
  return {
    mdape: Math.round(mdape * 1e3) / 1e3,
    flat_mdape: Math.round(flatMdape * 1e3) / 1e3,
    rank: Math.round(spearman(predicted, actual) * 1e3) / 1e3,
    flat_rank: Math.round(spearman(flat, actual) * 1e3) / 1e3,
    miss: Math.round(miss * 1e3) / 1e3,
    flat_miss: Math.round(flatMiss * 1e3) / 1e3,
  };
}

/** Fit the odds model on the eligible protocols that carry a tracking date. */
function fitOdds(snapshot: Snapshot): OddsModel {
  const rows: { p: SnapshotProtocol; x: number; z: number; c: number; tok: number; listed: string }[] = [];
  for (const p of snapshot.protocols) {
    if (!eligible(p)) continue;
    const years = ageYears(snapshot.as_of, p.listed_at);
    if (years === null || p.listed_at === null) continue;
    rows.push({ p, x: Math.log(p.tvl_usd), z: Math.log(years), c: Math.log(1 + p.chains.length), tok: p.mcap_usd !== null ? 1 : 0, listed: p.listed_at });
  }
  const means = [0, 1, 2].map((k) => rows.reduce((s, r) => s + [r.x, r.z, r.c][k]!, 0) / rows.length);
  const sds = [0, 1, 2].map((k) => {
    const mean = means[k]!;
    const v = rows.reduce((s, r) => s + ([r.x, r.z, r.c][k]! - mean) ** 2, 0) / rows.length;
    return Math.sqrt(v) || 1;
  });
  const z = rows.map((r) => [(r.x - means[0]!) / sds[0]!, (r.z - means[1]!) / sds[1]!, (r.c - means[2]!) / sds[2]!]);
  const y = rows.map((r) => r.tok);
  const fit = (train: number[], target: number[], lam: number): number[] => {
    const k = 4;
    let beta = new Array<number>(k).fill(0);
    for (let iter = 0; iter < 60; iter++) {
      const xtwx = Array.from({ length: k }, () => new Array<number>(k).fill(0));
      const grad = new Array<number>(k).fill(0);
      for (const i of train) {
        const x = [1, ...z[i]!];
        const p = sigmoid(dot(beta, z[i]!));
        const w = Math.max(p * (1 - p), 1e-6);
        for (let a = 0; a < k; a++) {
          grad[a] += x[a]! * (target[i]! - p);
          for (let b = 0; b < k; b++) xtwx[a]![b] += x[a]! * x[b]! * w;
        }
      }
      for (let a = 1; a < k; a++) {
        grad[a] -= lam * beta[a]!;
        xtwx[a]![a] += lam;
      }
      const step = solve(xtwx, grad);
      if (step.some((v) => !Number.isFinite(v))) break;
      beta = beta.map((v, i) => v + step[i]!);
    }
    return beta;
  };
  const index = rows.map((_, i) => i);
  const beta = fit(index, y, 20);
  const predict = (i: number, b: number[] = beta): number => sigmoid(dot(b, z[i]!));
  const p = index.map((i) => predict(i));
  const categoryResidual = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const key = r.p.category ?? 'Other';
    const list = categoryResidual.get(key) ?? [];
    list.push(y[i]! - p[i]!);
    categoryResidual.set(key, list);
  });
  const categories: OddsCategory[] = [...categoryResidual.entries()]
    .filter(([, list]) => list.length >= 4)
    .map(([category, list]) => {
      const mean = list.reduce((s, v) => s + v, 0) / list.length;
      return { category, n: list.length, adj: Math.round(Math.max(-0.8, Math.min(0.8, (mean * list.length) / (list.length + 8))) * 1e4) / 1e4 };
    })
    .sort((a, b) => b.n - a.n || a.category.localeCompare(b.category));
  const catAdj = new Map(categories.map((c) => [c.category, c.adj]));
  const oddFor = (i: number, b: number[] = beta): number => {
    const logit = dot(b, z[i]!) + (catAdj.get(rows[i]!.p.category ?? 'Other') ?? 0);
    return Math.min(0.99, Math.max(0.01, sigmoid(logit)));
  };
  const pAdj = index.map((i) => oddFor(i));
  const brier = index.reduce((s, i) => s + (pAdj[i]! - y[i]!) ** 2, 0) / rows.length;
  const base = y.reduce((s, v) => s + v, 0) / rows.length;
  const baseBrier = index.reduce((s, i) => s + (base - y[i]!) ** 2, 0) / rows.length;

  // 5-fold cross-validation, by index, deterministic.
  const cvP = new Array<number>(rows.length).fill(base);
  for (let k = 0; k < 5; k++) {
    const train = index.filter((i) => i % 5 !== k);
    const test = index.filter((i) => i % 5 === k);
    const b = fit(train, y, 20);
    for (const i of test) cvP[i] = oddFor(i, b);
  }
  const cvBrier = index.reduce((s, i) => s + (cvP[i]! - y[i]!) ** 2, 0) / rows.length;

  // Temporal blind test: the older two thirds train, the newer third is scored.
  const order = [...rows.keys()].sort((a, b) => (rows[a]!.listed < rows[b]!.listed ? -1 : rows[a]!.listed > rows[b]!.listed ? 1 : a - b));
  const cut = Math.floor(order.length * 0.66);
  const trainT = order.slice(0, cut);
  const testT = order.slice(cut);
  const bT = fit(trainT, y, 20);
  const blindP = testT.map((i) => oddFor(i, bT));
  const blindBrier = testT.reduce((s, i, j) => s + (blindP[j]! - y[i]!) ** 2, 0) / testT.length;
  const blindBase = y.reduce((s, v) => s + v, 0) / rows.length;

  return {
    n: rows.length,
    base_rate: Math.round(base * 1e4) / 1e4,
    brier: Math.round(brier * 1e4) / 1e4,
    base_brier: Math.round(baseBrier * 1e4) / 1e4,
    auc: Math.round(auc(y, pAdj) * 1e3) / 1e3,
    cv_brier: Math.round(cvBrier * 1e4) / 1e4,
    cv_auc: Math.round(auc(y, cvP) * 1e3) / 1e3,
    blind_brier: Math.round(blindBrier * 1e4) / 1e4,
    blind_auc: Math.round(auc(testT.map((i) => y[i]!), blindP) * 1e3) / 1e3,
    blind_base: Math.round(blindBase * 1e4) / 1e4,
    beta: beta.map((v) => Math.round(v * 1e4) / 1e4),
    means: means.map((v) => Math.round(v * 1e4) / 1e4),
    sds: sds.map((v) => Math.round(v * 1e4) / 1e4),
    terms: [
      { term: 'ln(TVL)', coefficient: Math.round((beta[1]! / sds[0]!) * 1e4) / 1e4, verdict: beta[1]! > 0 ? 'larger protocols record tokens more often, all else equal' : 'after age, the largest protocols are the ones DefiLlama indexes without a token' },
      { term: 'ln(age in years)', coefficient: Math.round((beta[2]! / sds[1]!) * 1e4) / 1e4, verdict: 'older protocols have had longer to record a token; the fitted sign is positive' },
      { term: 'ln(1 + chains)', coefficient: Math.round((beta[3]! / sds[2]!) * 1e4) / 1e4, verdict: 'a protocol on more chains is seen by more indexers' },
      { term: 'category comps', coefficient: 0, verdict: `${categories.length} categories with at least four peers, shrunk n/(n+8), capped at +/- 0.8 in log-odds` },
    ],
    categories,
  };
}

/** The odds a protocol ever records a token, from the fitted model. */
export function oddsFor(p: SnapshotProtocol, asOf: string, model: OddsModel): number {
  const years = ageYears(asOf, p.listed_at) ?? 2.5;
  const z = [
    (Math.log(Math.max(1, p.tvl_usd)) - model.means[0]!) / model.sds[0]!,
    (Math.log(years) - model.means[1]!) / model.sds[1]!,
    (Math.log(1 + p.chains.length) - model.means[2]!) / model.sds[2]!,
  ];
  const logit = dot(model.beta, z) + (model.categories.find((c) => c.category === (p.category ?? 'Other'))?.adj ?? 0);
  return Math.min(0.99, Math.max(0.01, sigmoid(logit)));
}

// ------------------------------------------------------------------ the farm verdict

export interface FarmVerdict {
  ticket_usd: number;
  cost_usd: number;
  drop_usd: number;
  net_usd: number;
  net_hour_usd: number;
  label: 'worth' | 'marginal' | 'skip';
  break_even_value_usd: number;
}

/** A costed farm verdict: gas, weekly fees, a capital charge, a time cost and the modelled drop. */
export function farmVerdict(tvl: number, expectedValue: number, holdDays: number, gas: number, ticket = TICKET_USD): FarmVerdict {
  const weeks = Math.max(1, Math.ceil(holdDays / 7));
  const hours = 0.25 + 0.15 * weeks + 0.2;
  const cost = gas + 3 * weeks + ticket * CAPITAL_CHARGE * (holdDays / 365) + hours * HOUR_RATE;
  const share = Math.min(1, ticket / Math.max(1, tvl));
  const drop = expectedValue * share * DROP_SHARE;
  const net = drop - cost;
  const perHour = net / hours;
  const label = perHour >= HOUR_RATE ? 'worth' : net >= 0 ? 'marginal' : 'skip';
  return {
    ticket_usd: ticket,
    cost_usd: Math.round(cost),
    drop_usd: Math.round(drop),
    net_usd: Math.round(net),
    net_hour_usd: Math.round(perHour * 100) / 100,
    label,
    break_even_value_usd: Math.round(cost / Math.max(1e-9, share * DROP_SHARE)),
  };
}

// ------------------------------------------------------------------ the whole fit

export function fitRadar(snapshot: Snapshot): FitSummary {
  const rows = comps(snapshot);
  if (rows.length < 12) throw new SnapshotError(`only ${rows.length} live-token protocols with a tracking date: too few to fit a comps curve`);
  const y = rows.map((r) => r.y);
  const xs = rows.map((r) => r.x);
  const zs = rows.map((r) => r.z);
  const gs = rows.map((r) => r.growth);
  const features = [xs, zs, gs];
  const beta = leastSquares(features, y);
  const predictFull = rows.map((_, i) => cappedLog(beta, xs[i]!, zs[i]!, gs[i]!));
  const residuals = y.map((v, i) => v - predictFull[i]!);
  const meanY = y.reduce((s, v) => s + v, 0) / y.length;
  const ssTot = y.reduce((s, v) => s + (v - meanY) ** 2, 0);
  const ssRes = residuals.reduce((s, v) => s + v * v, 0);
  const sigma = Math.sqrt(ssRes / Math.max(1, y.length - 4));
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  const looFull: number[] = [];
  const looSize: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const keep = rows.map((_, j) => j).filter((j) => j !== i);
    const b = leastSquares(
      features.map((f) => f.filter((_, j) => j !== i)),
      keep.map((j) => y[j]!),
    );
    looFull.push(cappedLog(b, xs[i]!, zs[i]!, gs[i]!));
    const bSize = leastSquares([xs.filter((_, j) => j !== i)], keep.map((j) => y[j]!));
    looSize.push(bSize[0]! + bSize[1]! * xs[i]!);
  }
  const flatPred = rows.map((r) => FLAT_MULTIPLE * r.tvl);
  const flatMdape = median(rows.map((r, i) => Math.abs(flatPred[i]! / r.mcap - 1)));
  const flatRank = spearman(flatPred, rows.map((r) => r.mcap));

  // Bootstrap the non-size terms.
  const rand = mulberry32(0x5eed_1a7d);
  const bootSlope: number[] = [];
  const bootAge: number[] = [];
  const bootGrowth: number[] = [];
  for (let b = 0; b < 300; b++) {
    const pick = Array.from({ length: rows.length }, () => Math.floor(rand() * rows.length));
    const bb = leastSquares(
      features.map((f) => pick.map((i) => f[i]!)),
      pick.map((i) => y[i]!),
    );
    if (Number.isFinite(bb[1]!)) bootSlope.push(bb[1]!);
    if (Number.isFinite(bb[2]!)) bootAge.push(bb[2]!);
    if (Number.isFinite(bb[3]!)) bootGrowth.push(bb[3]!);
  }
  const ageLow = percentile(bootAge, 0.05);
  const ageHigh = percentile(bootAge, 0.95);
  const growthLow = percentile(bootGrowth, 0.05);
  const growthHigh = percentile(bootGrowth, 0.95);
  const keepVerdict = (low: number, high: number): string => (low > 0 || high < 0 ? 'kept: the interval excludes zero' : 'capped: the interval straddles zero');

  // Category comps from the value model's residuals.
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
      return {
        category,
        n: list.length,
        residual: Math.round(residual * 1e4) / 1e4,
        shrunk: Math.round(Math.max(-0.5, Math.min(0.5, (residual * list.length) / (list.length + 4))) * 1e4) / 1e4,
      };
    })
    .sort((a, b) => b.n - a.n || a.category.localeCompare(b.category));
  const adjustment = new Map(categories.map((c) => [c.category, c]));

  // Calibration by TVL bucket.
  const bucketDefs = [
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

  // The live-token table: the 24 largest by TVL, in or out of the fit.
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

  // Blind tests: leave-one-out, and two directions across the listing-date split.
  const actual = rows.map((r) => r.mcap);
  const blinds: BlindTest[] = [
    { name: 'Leave-one-out', n: rows.length, ...scorePredictions(actual, looFull.map((v) => Math.exp(v)), flatPred) },
  ];
  const order = [...rows.keys()].sort((a, b) => (rows[a]!.listed < rows[b]!.listed ? -1 : rows[a]!.listed > rows[b]!.listed ? 1 : a - b));
  const half = Math.floor(order.length / 2);
  for (const [name, trainIdx, testIdx] of [
    ['Oldest half → newest half', order.slice(0, half), order.slice(half)],
    ['Newest half → oldest half', order.slice(half), order.slice(0, half)],
  ] as [string, number[], number[]][]) {
    const b = leastSquares(features.map((f) => trainIdx.map((i) => f[i]!)), trainIdx.map((i) => y[i]!));
    const trainResid = new Map<string, number[]>();
    for (const i of trainIdx) {
      const key = rows[i]!.category ?? 'Other';
      const list = trainResid.get(key) ?? [];
      list.push(y[i]! - cappedLog(b, xs[i]!, zs[i]!, gs[i]!));
      trainResid.set(key, list);
    }
    const adj = new Map([...trainResid.entries()].filter(([, v]) => v.length >= 2).map(([k, v]) => [k, Math.max(-0.5, Math.min(0.5, (median(v) * v.length) / (v.length + 4)))]));
    const predicted = testIdx.map((i) => Math.exp(cappedLog(b, xs[i]!, zs[i]!, gs[i]!) + (adj.get(rows[i]!.category ?? 'Other') ?? 0)));
    const truth = testIdx.map((i) => actual[i]!);
    const flat = testIdx.map((i) => flatPred[i]!);
    blinds.push({ name, n: testIdx.length, ...scorePredictions(truth, predicted, flat) });
  }

  // Coverage of the 10-90% band on the leave-one-out predictions.
  const coverage = rows.filter((r, i) => Math.abs(Math.log(Math.exp(looFull[i]!) / r.mcap)) <= Z80 * sigma).length / rows.length;

  const odds = fitOdds(snapshot);

  // The value model's own evidence, for the method page.
  const mdape = (predicted: number[]): number => median(rows.map((r, i) => Math.abs(Math.exp(predicted[i]! - r.y) - 1)));
  const sizeOnlyRank = spearman(looSize, y);

  const nLive = rows.length;
  const nExcluded = snapshot.protocols.filter((p) =>
    p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 &&
    ageYears(snapshot.as_of, p.listed_at) !== null &&
    p.mcap_usd > OUTLIER_MULTIPLE * p.tvl_usd).length;
  const nPre = snapshot.protocols.filter((p) => p.mcap_usd === null).length;
  const nTokens = snapshot.protocols.filter((p) => p.mcap_usd !== null).length;

  return {
    version: MODEL_VERSION,
    n_live: nLive,
    n_excluded: nExcluded,
    n_pre_token: nPre,
    n_watchlist: snapshot.watchlist.length,
    outlier_multiple: OUTLIER_MULTIPLE,
    intercept: Math.round(beta[0]! * 1e4) / 1e4,
    slope: Math.round(beta[1]! * 1e4) / 1e4,
    r2: Math.round(r2 * 1e3) / 1e3,
    sigma: Math.round(sigma * 1e4) / 1e4,
    loo_mdape: Math.round(mdape(looFull) * 1e3) / 1e3,
    loo_rank: Math.round(spearman(looFull, y) * 1e3) / 1e3,
    flat_mdape: Math.round(flatMdape * 1e3) / 1e3,
    flat_rank: Math.round(flatRank * 1e3) / 1e3,
    size_only_mdape: Math.round(mdape(looSize) * 1e3) / 1e3,
    size_only_rank: Math.round(sizeOnlyRank * 1e3) / 1e3,
    age_cap: AGE_CAP,
    growth_cap: GROWTH_CAP,
    coverage: Math.round(coverage * 1e3) / 1e3,
    terms: [
      {
        term: 'ln(TVL): the size curve',
        coefficient: Math.round(beta[1]! * 1e4) / 1e4,
        low: Math.round(percentile(bootSlope, 0.05) * 1e4) / 1e4,
        high: Math.round(percentile(bootSlope, 0.95) * 1e4) / 1e4,
        verdict: 'kept: the interval excludes zero on every fold',
      },
      { term: 'ln(age in years)', coefficient: Math.round(beta[2]! * 1e4) / 1e4, low: Math.round(ageLow * 1e4) / 1e4, high: Math.round(ageHigh * 1e4) / 1e4, verdict: keepVerdict(ageLow, ageHigh) },
      { term: '7-day TVL change (%)', coefficient: Math.round(beta[3]! * 1e4) / 1e4, low: Math.round(growthLow * 1e4) / 1e4, high: Math.round(growthHigh * 1e4) / 1e4, verdict: keepVerdict(growthLow, growthHigh) },
    ],
    categories,
    buckets,
    scatter,
    live,
    odds,
    blinds,
    ledger: {
      groups: [
        { key: 'watch', label: 'Ranked watchlist', n: snapshot.watchlist.length },
        { key: 'early', label: 'Ranked early, below the floor', n: Math.max(0, BOARD_ROWS - snapshot.watchlist.length) },
        { key: 'comp', label: 'Live token, in the comp set', n: nLive },
        { key: 'live-out', label: 'Live token, outside the fit', n: Math.max(0, nTokens - nLive) },
        { key: 'pre-out', label: 'Pre-token, not ranked', n: Math.max(0, nPre - BOARD_ROWS) },
      ],
      total: snapshot.protocols.length,
      ranked: BOARD_ROWS,
      total_implied_usd: 0,
      checksum: '',
    },
  };
}

// ------------------------------------------------------------------ the board

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Check the protocol's own page before you sign.`;
  return s;
}

export function capitalFor(_p: SnapshotProtocol): number {
  return TICKET_USD;
}

export function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** Gas for the first transaction, from the protocol's chains and size. */
export function gasFor(p: SnapshotProtocol): number {
  if (p.chains.includes('Ethereum')) return p.tvl_usd >= 1_000_000_000 ? 18 : 12;
  if (p.chains.includes('Solana')) return 2;
  return 4;
}

/** The category's concrete action on this protocol. One sentence a farmer can follow. */
export function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $${capital.toLocaleString('en-US')} USDC to ${name} on ${chain}, then borrow $${Math.round(capital / 3).toLocaleString('en-US')} of the chain's major asset against it and keep the loan-to-value under 40%.`;
  }
  if (c.includes('dex') || c.includes('liquidity manager')) {
    return `Add $${capital.toLocaleString('en-US')} of liquidity to ${name}'s deepest USDC pair on ${chain}, then stake the LP receipt if the app offers it.`;
  }
  if (c.includes('leveraged farm') || c.includes('yield')) {
    return `Deposit $${capital.toLocaleString('en-US')} USDC into ${name}'s top vault on ${chain}; read its fee and lock-up before you sign, then leave the shares in the vault.`;
  }
  if (c.includes('bridge')) {
    return `Bridge $${capital.toLocaleString('en-US')} USDC to ${chain} through ${name}, then use the bridged balance in its app at least once so the bridge counts a real user.`;
  }
  if (c.includes('staking') || c.includes('restak')) {
    return `Stake $${capital.toLocaleString('en-US')} of ${chain}'s native asset through ${name} and keep the liquid receipt token in the same wallet.`;
  }
  if (c.includes('rwa') || c.includes('tokenized')) {
    return `Finish ${name}'s KYC first, then mint or subscribe $${capital.toLocaleString('en-US')} of its yield asset on ${chain} and hold the receipt.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option') || c.includes('basis')) {
    return `Deposit $${capital.toLocaleString('en-US')} USDC as margin on ${name} on ${chain} and open one small delta-neutral position.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital.toLocaleString('en-US')} on ${name} on ${chain} and place one position in a market that resolves within 30 days.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital.toLocaleString('en-US')} of cover from ${name} on ${chain} and keep the policy receipt in the farming wallet.`;
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('fund')) {
    return `Deposit $${capital.toLocaleString('en-US')} USDC into a ${name} vault on ${chain}, note its curator, fee and redemption window, then leave it open.`;
  }
  return `Deposit $${capital.toLocaleString('en-US')} USDC into ${name} on ${chain} and keep the position open through the snapshot window.`;
}

/** The six actions, plus the seventh: a verdict with its own arithmetic. */
export function farmSteps(p: SnapshotProtocol, age: number | null, verdict?: FarmVerdict): FarmStep[] {
  const chain = p.chains[0] ?? 'its main chain';
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(p);
  const steps: FarmStep[] = [
    { text: `Create a fresh ${chain} wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`, cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
    { text: actionFor(p, capital, chain), cost: `$${capital.toLocaleString('en-US')} of capital and about $${gas} of gas`, time: '20 minutes to set up' },
    { text: `Make one qualifying action each week from that wallet: a deposit, a borrow, a swap or a vote in ${p.name}'s governance.`, cost: 'about $2-5 of gas a week', time: '10 minutes a week' },
    { text: `Keep the position open for at least ${hold} days so two snapshot dates see it, and do not move the wallet's funds in between.`, cost: `the $${capital.toLocaleString('en-US')} stays deployed`, time: `${hold} days` },
    { text: `Before you withdraw, check ${p.name}'s own site and X for a points or claim page; never pay a fee or sign a blind permit to claim.`, cost: 'no fee to check, and never a fee to claim', time: '10 minutes' },
    { text: `Write the wallet address, every date, the gas and each transaction hash in a farm log so you can repeat the position or unwind it.`, cost: 'nothing but the log', time: '5 minutes' },
  ];
  if (verdict !== undefined) {
    const word = verdict.label === 'worth' ? 'worth it at the $25/hour bar' : verdict.label === 'marginal' ? 'marginal: it clears its costs but not the time bar' : 'skip: the expected drop does not cover the cost';
    steps.push({
      text: `Farm verdict at a $${verdict.ticket_usd.toLocaleString('en-US')} ticket: $${verdict.cost_usd} of gas, fees and a 2%/yr capital charge over ${hold} days, against a $${verdict.drop_usd} expected drop (10% of the expected value for your share of TVL) — net $${verdict.net_usd}, $${verdict.net_hour_usd.toFixed(2)}/hour, ${word}. It breaks even if the expected value is worth $${verdict.break_even_value_usd.toLocaleString('en-US')}.`,
      cost: `$${verdict.cost_usd} all in`,
      time: `${hold} days, about ${(0.25 + 0.15 * Math.max(1, Math.ceil(hold / 7)) + 0.2).toFixed(2)} hours of work`,
    });
  }
  return steps;
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
  launch_value_usd: number;
  odds: number;
  implied_value_usd: number;
  expected_value_usd: number;
  slice_1k_usd: number;
  fees_usd: number;
  setup_minutes: number;
  range: { low_usd: number; high_usd: number };
  verdict: FarmVerdict;
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
    gas_usd: number;
    hours: number;
  };
  farm_steps: string[];
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
  launch_value_usd: number;
  odds: number;
  implied_value_usd: number;
  expected_value_usd: number;
  slice_1k_usd: number;
  fees_usd: number;
  setup_minutes: number;
  range_low_usd: number;
  range_high_usd: number;
  size_multiple: number;
  age_multiplier: number;
  growth_multiplier: number;
  category_multiplier: number;
  budget_usd: number;
  hold_days: number;
  gas_usd: number;
  verdict: 'worth' | 'marginal' | 'skip';
  net_hour_usd: number;
  cost_usd: number;
  drop_usd: number;
  break_even_value_usd: number;
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
    checksum: string;
    total_implied_usd: number;
  };
  rows: RadarRow[];
}

/** The value of one pre-token protocol and every term that made it. */
function valueRow(p: SnapshotProtocol, snapshot: Snapshot, beta: number[], sigma: number, adjustment: Map<string, CategoryAdjustment>, odds: OddsModel) {
  const age = ageDays(snapshot.as_of, p.listed_at);
  const years = ageYears(snapshot.as_of, p.listed_at) ?? 1.5;
  const growth = p.change_7d ?? 0;
  const cat = adjustment.get(p.category ?? 'Other');
  const catShrunk = cat?.shrunk ?? 0;
  const sizeBase = Math.exp(beta[0]!) * p.tvl_usd ** beta[1]!;
  const ageMultiplier = Math.exp(Math.max(-AGE_CAP, Math.min(AGE_CAP, beta[2]! * Math.log(years))));
  const growthMultiplier = Math.exp(Math.max(-GROWTH_CAP, Math.min(GROWTH_CAP, beta[3]! * growth)));
  const categoryMultiplier = Math.exp(catShrunk);
  const launch = Math.min(1e11, Math.max(1, Math.round(sizeBase * ageMultiplier * growthMultiplier * categoryMultiplier)));
  const launchLow = Math.max(1, Math.round(launch * Math.exp(-Z80 * sigma)));
  const launchHigh = Math.min(1e11, Math.round(launch * Math.exp(Z80 * sigma)));
  const chance = oddsFor(p, snapshot.as_of, odds);
  const expected = Math.max(1, Math.round(launch * chance));
  const hold = holdDaysFor(age);
  const gas = gasFor(p);
  const weeks = Math.max(1, Math.ceil(hold / 7));
  const hours = 0.25 + 0.15 * weeks + 0.2;
  const slice = Math.round(expected * Math.min(1, TICKET_USD / Math.max(1, p.tvl_usd)) * DROP_SHARE * 100) / 100;
  return {
    age,
    launch,
    chance,
    implied: launch,
    expected,
    low: launchLow,
    high: launchHigh,
    launchLow,
    launchHigh,
    hold,
    gas,
    slice,
    fees: Math.round((gas + 3 * weeks) * 100) / 100,
    setupMinutes: Math.round(hours * 60),
    verdict: farmVerdict(p.tvl_usd, expected, hold, gas),
    sizeMultiple: Math.round((sizeBase / p.tvl_usd) * 1e4) / 1e4,
    ageMultiplier: Math.round(ageMultiplier * 1e4) / 1e4,
    growthMultiplier: Math.round(growthMultiplier * 1e4) / 1e4,
    categoryMultiplier: Math.round(categoryMultiplier * 1e4) / 1e4,
  };
}

/** A deterministic FNV-1a checksum of the board, shown on the page and recounted there. */
function boardChecksum(rows: { slug: string; implied_value_usd: number }[]): string {
  let hash = 0x811c9dc5;
  for (const r of rows) {
    const text = `${r.slug}:${r.implied_value_usd}`;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, '0');
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData; summary: FitSummary } {
  const summary = fitRadar(snapshot);
  const rows = comps(snapshot);
  const beta = leastSquares(
    [rows.map((r) => r.x), rows.map((r) => r.z), rows.map((r) => r.growth)],
    rows.map((r) => r.y),
  );
  const sigma = Math.sqrt(
    rows.reduce((s, r) => s + (r.y - cappedLog(beta, r.x, r.z, r.growth)) ** 2, 0) / Math.max(1, rows.length - 4),
  );
  const adjustment = new Map(summary.categories.map((c) => [c.category, c]));
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

  const scored = [...chosen.values()].map((p) => ({ p, v: valueRow(p, snapshot, beta, sigma, adjustment, summary.odds) }));
  scored.sort((a, b) => b.v.launch - a.v.launch || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  const board: BoardRow[] = scored.map(({ p, v }, i) => ({
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
    age_days: v.age,
    watchlist: snapshot.watchlist.includes(p.slug),
    launch_value_usd: v.launch,
    odds: Math.round(v.chance * 1e4) / 1e4,
    implied_value_usd: v.implied,
    expected_value_usd: v.expected,
    slice_1k_usd: v.slice,
    fees_usd: v.fees,
    setup_minutes: v.setupMinutes,
    range: { low_usd: v.low, high_usd: v.high },
    verdict: v.verdict,
    model: {
      size_multiple: v.sizeMultiple,
      age_multiplier: v.ageMultiplier,
      growth_multiplier: v.growthMultiplier,
      category_multiplier: v.categoryMultiplier,
      category_n: adjustment.get(p.category ?? 'Other')?.n ?? 0,
      age_years: v.age === null ? null : Math.round((v.age / 365.25) * 100) / 100,
      growth_pct: p.change_7d ?? 0,
      budget_usd: capitalFor(p),
      hold_days: v.hold,
      gas_usd: v.gas,
      hours: Math.round((0.25 + 0.15 * Math.max(1, Math.ceil(v.hold / 7)) + 0.2) * 100) / 100,
    },
    farm_steps: farmSteps(p, v.age, v.verdict).map(stepText),
  }));

  const checksum = boardChecksum(board);
  const total = board.reduce((s, r) => s + r.implied_value_usd, 0);
  const nTokens = snapshot.protocols.filter((p) => p.mcap_usd !== null).length;
  const nPre = snapshot.protocols.filter((p) => p.mcap_usd === null).length;
  const watchCount = board.filter((r) => r.watchlist).length;
  summary.ledger = {
    groups: [
      { key: 'watch', label: 'Ranked watchlist', n: watchCount },
      { key: 'early', label: 'Ranked early, below the floor', n: board.length - watchCount },
      { key: 'comp', label: 'Live token, in the comp set', n: summary.n_live },
      { key: 'live-out', label: 'Live token, outside the fit', n: Math.max(0, nTokens - summary.n_live) },
      { key: 'pre-out', label: 'Pre-token, not ranked', n: Math.max(0, nPre - board.length) },
    ],
    total: snapshot.protocols.length,
    ranked: board.length,
    total_implied_usd: total,
    checksum,
  };

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
        checksum,
        total_implied_usd: total,
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
        launch_value_usd: r.launch_value_usd,
        odds: r.odds,
        implied_value_usd: r.implied_value_usd,
        expected_value_usd: r.expected_value_usd,
        slice_1k_usd: r.slice_1k_usd,
        fees_usd: r.fees_usd,
        setup_minutes: r.setup_minutes,
        range_low_usd: r.range.low_usd,
        range_high_usd: r.range.high_usd,
        size_multiple: r.model.size_multiple,
        age_multiplier: r.model.age_multiplier,
        growth_multiplier: r.model.growth_multiplier,
        category_multiplier: r.model.category_multiplier,
        budget_usd: r.model.budget_usd,
        hold_days: r.model.hold_days,
        gas_usd: r.model.gas_usd,
        verdict: r.verdict.label,
        net_hour_usd: r.verdict.net_hour_usd,
        cost_usd: r.verdict.cost_usd,
        drop_usd: r.verdict.drop_usd,
        break_even_value_usd: r.verdict.break_even_value_usd,
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
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const sort = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < sort.length; i++) if (sort[i] !== i + 1) return `rank ${i + 1} is ${sort[i]}`;
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

/** The page's dataset: one script, no fetch, no network. */
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
  const verdictCode = (v: string): number => (v === 'worth' ? 2 : v === 'marginal' ? 1 : 0);
  const rows = radar.rows.map((r) => [
    r.rank, r.slug, r.name, catId(r.category), chainIds(r.chains), r.tvl_usd,
    r.change_7d === null ? null : round3(r.change_7d), r.age_days, r.watchlist ? 1 : 0,
    r.implied_value_usd, Math.round(r.odds * 1e4), r.range_low_usd, r.range_high_usd, r.expected_value_usd,
    r.slice_1k_usd, r.fees_usd, r.setup_minutes, r.size_multiple, r.age_multiplier, r.growth_multiplier, r.category_multiplier,
    r.budget_usd, r.hold_days, r.gas_usd, verdictCode(r.verdict), r.net_hour_usd, r.cost_usd, r.drop_usd, r.break_even_value_usd,
  ]);
  const meta = {
    as_of: radar.meta.as_of,
    floor_usd: radar.meta.floor_usd,
    version: radar.meta.version,
    rows: rows.length,
    early: radar.meta.early,
    watchlist: radar.meta.watchlist,
    checksum: radar.meta.checksum,
    total_implied_usd: radar.meta.total_implied_usd,
    ledger_total: fit.ledger.total,
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
      coverage: fit.coverage,
      terms: fit.terms.map((t) => [t.term, t.coefficient, t.low, t.high, t.verdict]),
      buckets: fit.buckets.map((b) => [b.label, b.n, b.observed, b.predicted]),
      cats: fit.categories.map((c) => [catId(c.category), c.n, c.residual, c.shrunk]),
      odds: {
        n: fit.odds.n, base_rate: fit.odds.base_rate, brier: fit.odds.brier, base_brier: fit.odds.base_brier,
        auc: fit.odds.auc, cv_brier: fit.odds.cv_brier, cv_auc: fit.odds.cv_auc,
        blind_brier: fit.odds.blind_brier, blind_auc: fit.odds.blind_auc, blind_base: fit.odds.blind_base,
        terms: fit.odds.terms.map((t) => [t.term, t.coefficient, t.verdict]),
        cats: fit.odds.categories.map((c) => [catId(c.category), c.n, c.adj]),
      },
      blinds: fit.blinds.map((b) => [b.name, b.n, b.mdape, b.flat_mdape, b.rank, b.flat_rank, b.miss, b.flat_miss]),
      ledger: fit.ledger.groups.map((g) => [g.key, g.label, g.n]),
    },
  };
  return `window.RADAR=${JSON.stringify({ meta, categories, chains, rows, live, scatter })};\n`;
}
