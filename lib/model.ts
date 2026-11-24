// Launch Radar: a launch-value comps model and a peer-odds model, both fitted on one frozen snapshot.
//
// The sealed snapshot lists 758 protocols, including 40 watchlist slugs. A conditional
// log-cap regression uses TVL, a bounded TVL curvature term, listing age, and 7-day
// TVL change. The browser refits it from the same priced comparables as the entrypoint.
//
//   2. HOW COMMON IS A RECORDED TOKEN AMONG SIMILAR PROTOCOLS?
//      Ridge logistic regression of observed token markers on size, listing age and chain count,
//      with a shrunk category effect learned inside each training fold. This is prevalence at
//      the snapshot date, not a launch probability or an estimate of time to launch.
//
// Rank is conditional circulating market cap, not FDV or price per token. Farm figures are
// scenarios, not claims about allocations, and never determine the protocol's valuation rank.

import farm from '../dashboard/farm.js';
import type { FarmScenario } from '../dashboard/farm.js';
import pricing from '../dashboard/price.js';

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

export const MODEL_VERSION = 'launch-radar/6';
/** Every watchlist slug and the largest pre-token protocols below the floor. */
export const BOARD_ROWS = 198;
/** The house's flat multiple, the baseline every fitted curve has to beat. */
export const FLAT_MULTIPLE = 0.25;
/** A live token priced above this multiple of its TVL is not a comparable. */
const OUTLIER_MULTIPLE = 10;

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

function dot(beta: number[], x: number[]): number {
  return beta[0]! + x.reduce((s, v, i) => s + beta[i + 1]! * v, 0);
}

function sigmoid(z: number): number {
  if (z > 30) return 1;
  if (z < -30) return 0;
  return 1 / (1 + Math.exp(-z));
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
  tvl: number;
  mcap: number;
  age: number;
  growth: number | null;
  listed: string;
  y: number;
}

interface CategoryAdjustment {
  category: string;
  n: number;
  residual: number;
  shrunk: number;
}

type PricingObservation = [tvl: number, cap: number, age: number, change7d: number | null];

interface LiveRow {
  name: string;
  category: string | null;
  tvl: number;
  mcap: number;
  multiple: number;
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

type ValueFit = { beta: number[]; ratios: [number, number] };
type EvidenceRow = { label: string; loo: number; forward: number };

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
  outlier_multiple: number;
  intercept: number;
  slope: number;
  r2: number;
  loo_mdape: number;
  loo_rank: number;
  flat_mdape: number;
  flat_rank: number;
  coverage: number;
  observations: PricingObservation[];
  live: LiveRow[];
  odds: OddsModel;
  blinds: BlindTest[];
  ledger: Ledger;
  valueFit: ValueFit;
  evidence: EvidenceRow[];
}

function comps(snapshot: Snapshot): Comp[] {
  const rows: Comp[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    if (p.mcap_usd > OUTLIER_MULTIPLE * p.tvl_usd) continue;
    const age = ageDays(snapshot.as_of, p.listed_at);
    if (age === null || p.listed_at === null) continue;
    rows.push({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl: p.tvl_usd,
      mcap: p.mcap_usd,
      age,
      growth: p.change_7d,
      listed: p.listed_at,
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

/** Fit the very same pricing function used on the board, with an explicit ablation mask. */
function fitValue(rows: Comp[], useAge = true, useGrowth = true, useCategory = false, useCurve = true) {
  const beta = pricing.fit(rows.map((r) => [r.tvl, r.mcap, r.age, r.growth]), useAge, useGrowth, useCurve);
  const capLog = (r: Comp) => Math.log(pricing.factors(beta, r.tvl, r.age, r.growth).raw);
  const groups = new Map<string, number[]>();
  if (useCategory) for (const r of rows) {
    const key = r.category ?? 'Other';
    const residuals = groups.get(key) ?? [];
    residuals.push(r.y - capLog(r));
    groups.set(key, residuals);
  }
  const categories: CategoryAdjustment[] = [...groups]
    .filter(([, values]) => values.length >= 2)
    .map(([category, values]) => {
      const n = values.length;
      const residual = median(values);
      return { category, n, residual, shrunk: Math.max(-0.5, Math.min(0.5, n * residual / (n + 4))) };
    })
    .sort((a, b) => b.n - a.n || a.category.localeCompare(b.category));
  const adjustment = new Map(categories.map((c) => [c.category, c.shrunk]));
  const predict = (r: Comp) => capLog(r) + (adjustment.get(r.category ?? 'Other') ?? 0);
  return { beta, predict };
}

/** Empirical error quantiles from predictions made without the target row. */
function errorBand(rows: Comp[], predicted: number[]): [number, number] {
  const errors = rows.map((row, i) => row.y - predicted[i]!);
  return [Math.exp(percentile(errors, 0.1)), Math.exp(percentile(errors, 0.9))];
}

/** Fit the odds model on the eligible protocols that carry a tracking date. */
function fitOdds(snapshot: Snapshot): OddsModel {
  const rows: { p: SnapshotProtocol; x: number; z: number; c: number; tok: number; listed: string }[] = [];
  for (const p of snapshot.protocols) {
    if (!eligible(p)) continue;
    const years = ageYears(snapshot.as_of, p.listed_at);
    if (years === null || p.listed_at === null) continue;
    rows.push({ p, x: Math.log(p.tvl_usd), z: Math.log(years), c: Math.log(1 + p.chains.length), tok: isPreToken(p) ? 0 : 1, listed: p.listed_at });
  }
  const features = rows.map((r) => [r.x, r.z, r.c]);
  const y = rows.map((r) => r.tok);
  const fit = (train: number[]) => {
    const k = 4;
    const means = [0, 1, 2].map((j) => train.reduce((s, i) => s + features[i]![j]!, 0) / train.length);
    const sds = means.map((mean, j) => Math.sqrt(train.reduce((s, i) => s + (features[i]![j]! - mean) ** 2, 0) / train.length) || 1);
    const z = features.map((x) => x.map((v, j) => (v - means[j]!) / sds[j]!));
    let beta = new Array<number>(k).fill(0);
    for (let iter = 0; iter < 60; iter++) {
      const xtwx = Array.from({ length: k }, () => new Array<number>(k).fill(0));
      const grad = new Array<number>(k).fill(0);
      for (const i of train) {
        const x = [1, ...z[i]!];
        const p = sigmoid(dot(beta, z[i]!));
        const w = Math.max(p * (1 - p), 1e-6);
        for (let a = 0; a < k; a++) {
          grad[a] += x[a]! * (y[i]! - p);
          for (let b = 0; b < k; b++) xtwx[a]![b] += x[a]! * x[b]! * w;
        }
      }
      for (let a = 1; a < k; a++) {
        grad[a] -= 20 * beta[a]!;
        xtwx[a]![a] += 20;
      }
      const step = solve(xtwx, grad);
      if (step.some((v) => !Number.isFinite(v))) break;
      beta = beta.map((v, i) => v + step[i]!);
      if (step.every((v) => Math.abs(v) < 1e-9)) break;
    }
    const groups = new Map<string, { n: number; residual: number; variance: number }>();
    for (const i of train) {
      const category = rows[i]!.p.category ?? 'Other';
      const g = groups.get(category) ?? { n: 0, residual: 0, variance: 0 };
      const p = sigmoid(dot(beta, z[i]!));
      g.n++;
      g.residual += y[i]! - p;
      g.variance += p * (1 - p);
      groups.set(category, g);
    }
    const categories: OddsCategory[] = [...groups]
      .filter(([, g]) => g.n >= 4)
      .map(([category, g]) => ({ category, n: g.n, adj: Math.max(-0.8, Math.min(0.8, g.residual / (g.variance + 4))) }))
      .sort((a, b) => b.n - a.n || a.category.localeCompare(b.category));
    const catAdj = new Map(categories.map((c) => [c.category, c.adj]));
    const predict = (i: number): number =>
      Math.min(0.99, Math.max(0.01, sigmoid(dot(beta, z[i]!) + (catAdj.get(rows[i]!.p.category ?? 'Other') ?? 0))));
    return { beta, means, sds, categories, predict };
  };
  const index = rows.map((_, i) => i);
  const { beta, means, sds, categories, predict } = fit(index);
  const pAdj = index.map(predict);
  const brier = index.reduce((s, i) => s + (pAdj[i]! - y[i]!) ** 2, 0) / rows.length;
  const base = y.reduce((s, v) => s + v, 0) / rows.length;
  const baseBrier = index.reduce((s, i) => s + (base - y[i]!) ** 2, 0) / rows.length;

  // 5-fold cross-validation, by index, deterministic.
  const cvP = new Array<number>(rows.length).fill(base);
  for (let k = 0; k < 5; k++) {
    const train = index.filter((i) => i % 5 !== k);
    const test = index.filter((i) => i % 5 === k);
    const fold = fit(train);
    for (const i of test) cvP[i] = fold.predict(i);
  }
  const cvBrier = index.reduce((s, i) => s + (cvP[i]! - y[i]!) ** 2, 0) / rows.length;

  // Temporal blind test: the older two thirds train, the newer third is scored.
  const order = [...rows.keys()].sort((a, b) => (rows[a]!.listed < rows[b]!.listed ? -1 : rows[a]!.listed > rows[b]!.listed ? 1 : a - b));
  const cut = Math.floor(order.length * 0.66);
  const trainT = order.slice(0, cut);
  const testT = order.slice(cut);
  const older = fit(trainT);
  const blindP = testT.map(older.predict);
  const blindBrier = testT.reduce((s, i, j) => s + (blindP[j]! - y[i]!) ** 2, 0) / testT.length;
  const trainRate = trainT.reduce((sum, i) => sum + y[i]!, 0) / trainT.length;
  const blindBase = testT.reduce((sum, i) => sum + (trainRate - y[i]!) ** 2, 0) / testT.length;

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
    beta,
    means,
    sds,
    terms: [
      { term: 'ln(TVL)', coefficient: Math.round((beta[1]! / sds[0]!) * 1e4) / 1e4, verdict: beta[1]! > 0 ? 'larger protocols record tokens more often, all else equal' : 'after age, the largest protocols are the ones DefiLlama indexes without a token' },
      { term: 'ln(age in years)', coefficient: Math.round((beta[2]! / sds[1]!) * 1e4) / 1e4, verdict: 'cross-sectional association with listing age, not time to launch' },
      { term: 'ln(1 + chains)', coefficient: Math.round((beta[3]! / sds[2]!) * 1e4) / 1e4, verdict: 'association with breadth of deployment' },
      { term: 'category effect', coefficient: 0, verdict: `${categories.length} categories with at least four peers; ridge-shrunk and capped at ±0.8 log-odds` },
    ],
    categories,
  };
}

/** Fitted prevalence of a recorded token among snapshot peers. */
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

// ------------------------------------------------------------------ the whole fit

function fitRadar(snapshot: Snapshot): Omit<FitSummary, 'ledger'> {
  const rows = comps(snapshot);
  if (rows.length < 12) throw new SnapshotError(`only ${rows.length} live-token protocols with a tracking date: too few to fit a comps curve`);
  const y = rows.map((r) => r.y);
  const { beta, predict } = fitValue(rows);
  const residuals = rows.map((r) => r.y - predict(r));
  const meanY = y.reduce((s, v) => s + v, 0) / y.length;
  const ssTot = y.reduce((s, v) => s + (v - meanY) ** 2, 0);
  const ssRes = residuals.reduce((s, v) => s + v * v, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  const actual = rows.map((r) => r.mcap);
  const flatPred = rows.map((r) => FLAT_MULTIPLE * r.tvl);
  const order = rows.slice().sort((a, b) => a.listed.localeCompare(b.listed));
  // Keep listing-day ties together; caps still come from the same frozen date.
  const boundary = order[Math.floor(order.length * 0.6)]!.listed;
  const older = order.filter((r) => r.listed < boundary);
  const newer = order.filter((r) => r.listed >= boundary);
  const folds = rows.map((_, hold) => rows.filter((_, i) => i !== hold));
  const stage = [
    { label: 'Deployed · TVL curve, age, 7-day change' },
    { label: 'Without TVL curvature', curve: false },
    { label: 'Without listing age', age: false },
    { label: 'Without 7-day change', growth: false },
    { label: 'With category residual', category: true },
  ].map(({ label, age, growth, category, curve }) => {
    const loo = folds.map((train, i) => fitValue(train, age, growth, category, curve).predict(rows[i]!));
    const forward = newer.map(fitValue(older, age, growth, category, curve).predict);
    return {
      label, loo, forward,
      looScore: scorePredictions(actual, loo.map(Math.exp), flatPred),
      forwardScore: scorePredictions(newer.map((r) => r.mcap), forward.map(Math.exp), newer.map((r) => FLAT_MULTIPLE * r.tvl)),
    };
  });
  const deployed = stage[0]!;
  const ratios = errorBand(rows, deployed.loo);
  const olderLoo = older.map((r, i) => fitValue(older.filter((_, j) => i !== j)).predict(r));
  const [forwardLow, forwardHigh] = errorBand(older, olderLoo);
  const forwardCoverage = newer.filter((r, i) => {
    const ratio = Math.exp(r.y - deployed.forward[i]!);
    return ratio >= forwardLow && ratio <= forwardHigh;
  }).length / newer.length;
  const evidence = stage.map((s) => ({ label: s.label, loo: s.looScore.miss, forward: s.forwardScore.miss }));
  evidence.push({ label: 'Flat 0.25× TVL', loo: deployed.looScore.flat_miss, forward: deployed.forwardScore.flat_miss });

  const observations: PricingObservation[] = rows.map((r) => [r.tvl, r.mcap, r.age, r.growth]);

  const compSlugs = new Set(rows.map((r) => r.slug));
  // The live-token table: the 24 largest by TVL, in or out of the fit.
  const live: LiveRow[] = snapshot.protocols
    .filter((p): p is SnapshotProtocol & { mcap_usd: number } => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || b.mcap_usd - a.mcap_usd)
    .slice(0, 24)
    .map((p) => {
      return {
        name: p.name,
        category: p.category,
        tvl: p.tvl_usd,
        mcap: p.mcap_usd,
        multiple: Math.round((p.mcap_usd / p.tvl_usd) * 1e3) / 1e3,
        comp: compSlugs.has(p.slug),
      };
    });

  const blinds: BlindTest[] = [
    { name: 'Leave-one-out', n: rows.length, ...deployed.looScore },
    { name: 'Older → newer cohort', n: newer.length, ...deployed.forwardScore },
  ];

  const odds = fitOdds(snapshot);

  const nLive = rows.length;
  return {
    version: MODEL_VERSION,
    n_live: nLive,
    outlier_multiple: OUTLIER_MULTIPLE,
    intercept: Math.round(beta[0]! * 1e4) / 1e4,
    slope: Math.round(beta[1]! * 1e4) / 1e4,
    r2: Math.round(r2 * 1e3) / 1e3,
    loo_mdape: deployed.looScore.mdape,
    loo_rank: deployed.looScore.rank,
    flat_mdape: deployed.looScore.flat_mdape,
    flat_rank: deployed.looScore.flat_rank,
    coverage: Math.round(forwardCoverage * 1e3) / 1e3,
    observations,
    live,
    odds,
    blinds,
    valueFit: { beta, ratios },
    evidence,
  };
}

// ------------------------------------------------------------------ the board

/** The exported checklist and the detail view are both produced by dashboard/farm.js. */
function exportFarmSteps(steps: FarmScenario['steps']): string[] {
  return steps.map(([when, text, cost, time]) => `${when}: ${text} Cost: ${cost}. Time: ${time}.`);
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
  farm_cost_usd: number;
  farm_minutes: number;
  range: { low_usd: number; high_usd: number };
  verdict: Omit<FarmScenario, 'steps'>;
  model: {
    size_multiple: number;
    age_multiplier: number;
    growth_multiplier: number;
    age_years: number | null;
    growth_pct: number;
  };
  farm_steps: string[];
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
    watchlist_slugs: string[];
    fit: FitSummary;
    checksum: string;
    total_implied_usd: number;
  };
  rows: BoardRow[];
}

/** The value of one pre-token protocol and every term that made it. */
function valueRow(p: SnapshotProtocol, snapshot: Snapshot, fit: ValueFit, odds: OddsModel) {
  const { beta, ratios } = fit;
  const age = ageDays(snapshot.as_of, p.listed_at);
  const { base: sizeBase, a: ageMultiplier, g: growthMultiplier, cap: launch } = pricing.factors(beta, p.tvl_usd, age, p.change_7d);
  const launchLow = Math.max(1, Math.round(launch * ratios[0]));
  const launchHigh = Math.min(1e11, Math.round(launch * ratios[1]));
  const chance = Math.round(oddsFor(p, snapshot.as_of, odds) * 1e6) / 1e6;
  const expected = Math.max(1, Math.round(launch * chance));
  const { steps, ...verdict } = farm.evaluate({ name: p.name, category: p.category, chains: p.chains, tvl: p.tvl_usd, expected });
  return {
    age,
    launch,
    chance,
    implied: launch,
    expected,
    low: launchLow,
    high: launchHigh,
    verdict,
    steps,
    sizeMultiple: sizeBase / p.tvl_usd,
    ageMultiplier,
    growthMultiplier,
  };
}

/** A deterministic FNV-1a checksum of the board, shown on the page and recounted there. */
function boardChecksum(rows: BoardRow[]): string {
  let hash = 0x811c9dc5;
  for (const r of rows) {
    const text = `${r.slug}:${r.implied_value_usd}:${r.range.low_usd}:${r.range.high_usd};`;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, '0');
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData; summary: FitSummary } {
  const fit = fitRadar(snapshot);
  const watch = new Set(snapshot.watchlist);
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

  const scored = [...chosen.values()].map((p) => ({ p, v: valueRow(p, snapshot, fit.valueFit, fit.odds) }));
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
    watchlist: watch.has(p.slug),
    launch_value_usd: v.launch,
    odds: v.chance,
    implied_value_usd: v.implied,
    expected_value_usd: v.expected,
    farm_cost_usd: v.verdict.cost,
    farm_minutes: Math.round(v.verdict.hours * 60),
    range: { low_usd: v.low, high_usd: v.high },
    verdict: v.verdict,
    model: {
      size_multiple: v.sizeMultiple,
      age_multiplier: v.ageMultiplier,
      growth_multiplier: v.growthMultiplier,
      age_years: v.age === null ? null : Math.round((v.age / 365.25) * 100) / 100,
      growth_pct: p.change_7d ?? 0,
    },
    farm_steps: exportFarmSteps(v.steps),
  }));

  const checksum = boardChecksum(board);
  const total = board.reduce((s, r) => s + r.implied_value_usd, 0);
  const tokenWithCap = snapshot.protocols.filter((p) => (p.mcap_usd ?? 0) > 0).length;
  const tokenNoCap = snapshot.protocols.filter((p) => !isPreToken(p) && !(p.mcap_usd! > 0)).length;
  const unranked = snapshot.protocols.filter((p) => isPreToken(p) && !chosen.has(p.slug));
  const watchCount = board.filter((r) => r.watchlist).length;
  const ledger: Ledger = {
    groups: [
      { key: 'watch', label: 'Ranked watchlist', n: watchCount },
      { key: 'early', label: 'Ranked early, below the floor', n: board.length - watchCount },
      { key: 'comp', label: 'Live token, in the comp set', n: fit.n_live },
      { key: 'live-out', label: 'Priced, outside fit', n: tokenWithCap - fit.n_live },
      { key: 'marked', label: 'Token marker, no cap', n: tokenNoCap },
      { key: 'excluded', label: 'Exchange, wrapper or version', n: unranked.filter((p) => !eligible(p)).length },
      { key: 'pre-out', label: 'No marker, not on allowlist', n: unranked.filter(eligible).length },
    ],
    total: snapshot.protocols.length,
    ranked: board.length,
    total_implied_usd: total,
    checksum,
  };
  const summary = { ...fit, ledger };

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
        watchlist_slugs: snapshot.watchlist,
        fit: summary,
        checksum,
        total_implied_usd: total,
      },
      rows: board,
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
  const live = fit.live.map((l) => [l.name, catId(l.category), l.tvl, l.mcap, l.multiple, l.comp]);
  const rows = radar.rows.map((r) => [
    r.slug, r.name, catId(r.category), chainIds(r.chains), r.tvl_usd, r.change_7d,
    r.age_days, r.watchlist ? 1 : 0, r.implied_value_usd, r.odds,
  ]);
  const meta = {
    as_of: radar.meta.as_of,
    source: radar.meta.source,
    floor_usd: radar.meta.floor_usd,
    version: radar.meta.version,
    rows: rows.length,
    early: radar.meta.early,
    watchlist_slugs: radar.meta.watchlist_slugs,
    checksum: radar.meta.checksum,
    ledger_total: fit.ledger.total,
    fit: {
      outlier_multiple: fit.outlier_multiple,
      coverage: fit.coverage,
      odds: {
        n: fit.odds.n, cv_brier: fit.odds.cv_brier, cv_auc: fit.odds.cv_auc,
        blind_brier: fit.odds.blind_brier, blind_base: fit.odds.blind_base,
      },
      blinds: fit.blinds.map((b) => [b.name, b.n, b.mdape, b.flat_mdape, b.rank, b.flat_rank, b.miss, b.flat_miss]),
      evidence: fit.evidence.map((e) => [e.label, e.loo, e.forward]),
      ledger: fit.ledger.groups.map((g) => [g.key, g.label, g.n]),
    },
  };
  return `window.RADAR=${JSON.stringify({ meta, categories, chains, rows, live, observations: fit.observations })};\n`;
}
