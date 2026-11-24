# launch-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/aviharez/launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/aviharez/launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

**Before the ticker** ranks protocols by implied circulating market cap conditional on a launch. It covers all 40 sealed watchlist members and 138 below-floor candidates. Priced tokens and records with a token marker but no cap are accounted for separately.

The cap model uses a ridge-fitted TVL curve, listing age and seven-day TVL change. The Model lab shows leave-one-out and older-to-newer cohort ablations against a flat TVL multiple. Cohort dates are listing dates, not historical caps or launch dates. The browser refits the model from the 90 priced observations and rederives the intervals from leave-one-out errors, then verifies the export fingerprint over ranks, caps and ranges.

The peer token share is a cross-sectional statistic, not a launch probability. Farm routes show steps, selected-network costs, time and net outcomes under four allocation assumptions without implying eligibility. Research-only routes commit no principal. Export the current filter and sort as a CSV with the selected network and budget's modeled costs.

## Run it

```sh
node main.ts --input ../token-radar-01-kit/input/snapshot.json --output out
```

Open `out/dashboard/index.html` directly in a browser. The generated `radar-data.js` stays inside `dashboard/`, so the whole directory works offline. `out/board.json` carries every ranked protocol and its default farm checklist. `out/dossier.json` contains the complete dashboard source and the four captured views.

---

<sub>Entered on [make.fun](https://make.fun/?ref=cfngrw1d&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
