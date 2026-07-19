# θ thetad

**An open-source daemon that sells time.** Local-first automated options trading:
a screener finds rich premium, an always-on engine executes and manages positions
against pre-committed rules, and every decision is journaled and replayable.

> **Status: pre-alpha scaffold.** The architecture is in place; the strategy
> engine, screener, and backtester are being built. Not ready to trade.

> **Disclaimer:** thetad is software, not investment advice. Options trading
> involves substantial risk of loss. You run this against your own brokerage
> account, with your own keys, at your own risk.

## Design principles

- **Local-first.** Runs on your machine, binds to `127.0.0.1`, talks to nobody
  but your broker (Alpaca). Your keys and data never leave your box.
- **One engine, three worlds.** The same pure `evaluate(state, snapshot)`
  function runs the backtest, the paper account, and live trading — only the
  data/broker bindings differ. Time is injected via `snapshot.asof`; the engine
  never reads a wall clock.
- **Level-triggered reconcile loop.** Every tick (~1 min) the engine snapshots
  the world and re-derives what should happen. Triggers are predicates on
  state, never on transitions — a missed tick can never miss a trigger, and
  restart recovery is just "run the loop."
- **Pre-committed plans.** Every position carries its full exit/adjustment plan
  from entry (profit target, stop, time exit, delta band, roll budget). The
  engine enforces; it never improvises.
- **A risk layer that outranks everything.** Account-level invariants (drawdown
  circuit breaker, kill switch, concentration caps) veto any intent; closes
  always pass.
- **Integer cents.** Money is never a float. Percentages are basis points.
- **Files, not databases.** `state.json` (atomic tmp+rename writes), append-only
  JSONL journals, JSONL market data partitioned by symbol/month. Inspect
  everything with `cat` and `jq`.
- **Record–replay.** Journaled snapshots make any past decision reproducible in
  a debugger.

## v1 strategy

**Banded covered strangle:** sell cash-secured puts + covered calls on a few
liquid underlyings, keep net delta (share-equivalents) inside a positive band
with daily pre-close stock adjustments — never below the 100-shares-per-short-
call collateral floor. Management: close at 50% of credit, exit/roll at 21 DTE,
debounced 3x-credit stop, exit before earnings, credit-only rolls with a hard
roll budget.

## Layout

```
packages/core     pure engine: evaluate(), risk layer, calendar, Black-Scholes,
                  money (integer cents), OCC symbols — zero dependencies, no IO
packages/data     storage (atomic JSON, JSONL), Alpaca market data client
packages/broker   Broker interface: Alpaca trading client (paper/live), sim
packages/server   the daemon: Fastify API + SSE, reconcile loop, serves the UI
apps/web          React UI (Vite) — static files in prod, dev server in dev
apps/cli          CLI, a pure client of the daemon's HTTP API
```

## Quickstart

Requires Node >= 22.

```sh
npm install
cp .env.example .env     # add your Alpaca *paper* keys
npm test                 # unit tests
npm run check            # typecheck
npm start                # daemon on http://127.0.0.1:7777
```

Development (hot-reloading UI on :5173, proxying /api to the daemon):

```sh
npm run dev:server
npm run dev:web
```

## Roadmap

- [x] Repo scaffold: engine core, calendar, Black-Scholes, money, risk layer
- [ ] State store + startup reconciliation against broker truth
- [ ] Position manager: full covered-strangle lifecycle (entry, rolls, assignment)
- [ ] Order manager: atomic multi-leg limit orders worked from mid
- [ ] Market data cache: minute bars + chain snapshots to JSONL
- [ ] Backtester: event-driven replay through the same engine
- [ ] Screener: liquidity gate, IV rank, IV-vs-realized (Yang-Zhang), events
- [ ] Web UI: positions, journal tail, equity curve, kill switch
- [ ] Paper-trading burn-in, then live

## License

[MIT](LICENSE)
