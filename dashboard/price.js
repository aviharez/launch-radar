/* The offline browser and the entrypoint refit from the same comparable-token observations. */
(function (root) {
  'use strict';
  const PIVOT = Math.log(50e6), AGE_CAP = .25, GROWTH_CAP = .10, CURVE_CAP = .35;
  const logAge = (days) => Math.log(days === null ? 1.5 : Math.max(days / 365.25, .06));
  const clamp = (n, cap) => Math.max(-cap, Math.min(cap, n));

  function fit(records, age = true, growth = true, curve = true) {
    const matrix = Array.from({ length: 5 }, () => [0, 0, 0, 0, 0, 0]);
    const penalty = [0, 0, age ? 4 : 1, growth ? 40 : 1, curve ? 50 : 1];
    const v = [1, 0, 0, 0, 0];
    for (const [tvl, cap, days, weekly] of records) {
      v[1] = Math.log(tvl) - PIVOT;
      v[2] = age ? logAge(days) : 0;
      v[3] = growth ? weekly ?? 0 : 0;
      v[4] = curve ? v[1] ** 2 : 0;
      const y = Math.log(cap);
      for (let i = 0; i < 5; i++) {
        const row = matrix[i];
        for (let j = 0; j < 5; j++) row[j] += v[i] * v[j];
        row[5] += v[i] * y;
      }
    }
    for (let i = 0; i < 5; i++) matrix[i][i] += penalty[i];
    for (let i = 0; i < 5; i++) {
      let pivot = i;
      for (let j = i + 1; j < 5; j++) if (Math.abs(matrix[j][i]) > Math.abs(matrix[pivot][i])) pivot = j;
      if (Math.abs(matrix[pivot][i]) < 1e-12) throw new Error('Singular valuation fit');
      [matrix[i], matrix[pivot]] = [matrix[pivot], matrix[i]];
      const row = matrix[i], norm = row[i];
      for (let k = i; k <= 5; k++) row[k] /= norm;
      for (let j = 0; j < 5; j++) if (j !== i) {
        const other = matrix[j], factor = other[i];
        for (let k = i; k <= 5; k++) other[k] -= factor * row[k];
      }
    }
    return matrix.map((row) => row[5]);
  }

  function factors(beta, tvl, age, growth) {
    const x = Math.log(tvl) - PIVOT;
    const base = Math.exp(beta[0] + beta[1] * x + clamp(beta[4] * x * x, CURVE_CAP));
    const a = Math.exp(clamp(beta[2] * logAge(age), AGE_CAP));
    const g = Math.exp(clamp(beta[3] * (growth ?? 0), GROWTH_CAP));
    const raw = base * a * g;
    return { base, a, g, raw, cap: Math.min(1e11, Math.max(1, Math.round(raw))) };
  }

  function errorFactors(records) {
    const errors = records.map(([tvl, cap, age, growth], i) => {
      const heldOut = fit(records.filter((_, j) => i !== j));
      return Math.log(cap) - Math.log(factors(heldOut, tvl, age, growth).raw);
    }).sort((a, b) => a - b);
    return [.1, .9].map((p) => {
      const at = (errors.length - 1) * p;
      const i = Math.floor(at);
      return Math.exp(errors[i] + (errors[Math.ceil(at)] - errors[i]) * (at - i));
    });
  }

  const api = { fit, factors, errorFactors };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Price = api;
})(globalThis);
