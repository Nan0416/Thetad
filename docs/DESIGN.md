# thetad — Design Document

This document distills the design discussion behind thetad: what the system
trades, why that has positive expectancy, how risk is controlled, and why the
software is shaped the way it is.

## 1. Mission

An open-source, local-first daemon that automates options premium selling for
an individual account. The honest value proposition of automation at retail is
**discipline, not speed**: the machine enforces pre-committed rules every time,
watches positions continuously, never forgets an event date, and never
negotiates with itself about a stop. We do not compete with market makers on
latency; our counterparty is the volatility outcome over days and weeks.

## 2. Strategy foundations

### 2.1 The edge: the volatility risk premium (VRP)

Implied volatility systematically trades above subsequently realized
volatility because option buyers are buying insurance and insurance sellers
demand compensation. Every strategy thetad runs is a harvest of this premium.
Corollaries we design around:

- **Win rate is not edge.** A 16-delta short put wins ~84% of the time with
  zero edge, by construction. Only expectancy after costs matters.
- **Selling premium = selling insurance.** Many small wins, rare large losses.
  The P&L distribution's left tail is the central design problem — every risk
  rule below exists because of it.
- **Costs are first-class.** The edge is thin; bid-ask spread and slippage on
  multi-leg structures can consume it. Execution quality and fill-realistic
  backtests are strategy features, not plumbing.

### 2.2 v1 strategy: the banded covered strangle

Per liquid underlying: long 100+ shares, short an OTM call (covered by the
shares), short an OTM put (cash-secured). Key structural fact: the shares are
simultaneously the call's collateral and the delta dial, so the position is
inherently long-biased — **delta is managed to a positive band, not to zero**
(a "delta-neutral covered strangle" is an oxymoron; neutrality would require
selling shares below the collateral floor).

Management rules (the pre-committed plan, enforced by the engine):

| Rule          | Default                                                  | Rationale                                                                          |
| ------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Profit target | close options at 50% of credit                           | risk-adjusted decay: the last 50% of profit costs most of the gamma risk           |
| Time exit     | close/roll at 21 DTE                                     | leave before the gamma bell becomes a spike                                        |
| Stop loss     | cost-to-close ≥ 3x credit, debounced                     | cap the tail; debounce because wide overnight quotes produce false marks           |
| Event exit    | flat before earnings/binary events                       | unintended binaries are how condors and strangles die                              |
| Delta band    | daily pre-close adjustment toward band mid               | never below 100 shares per short call                                              |
| Rolls         | credit-only, must pass entry screen, hard max-roll count | a roll is a close + a new trade; without these constraints rolling is a martingale |

Roadmap strategies reuse the same machinery: beta-weighted portfolio hedge
(SPY overlay), iron condors + residual delta hedge (the defined-risk replica
of a delta-hedged short strangle), delta-hedged long straddles for
earnings/event trades.

### 2.3 Screener (build order of signals)

1. **Liquidity gate** (hard filter, defines the universe): bid-ask % of
   premium, open interest, volume.
2. **IV Rank / percentile** per underlying (needs a year of stored IV — the
   dataset builds itself daily).
3. **IV vs realized (Yang-Zhang)** — the direct VRP measurement.
4. **Event calendar** — veto and, later, signal (implied vs historical
   earnings moves).
5. Term structure & skew (second wave).

Instrument-selection logic worth encoding: direction + rich IV → sell premium
on that side; direction + cheap IV → debit structures; no direction + rich IV
→ symmetric premium structures. The system should never buy expensive
optionality or sell cheap optionality by accident.

## 3. Risk framework

Two separate layers with different scopes and one-way authority:

- **Position manager** (per position): executes each position's pre-committed
  plan. If every trade were the only trade, this layer alone would suffice.
- **Risk layer** (whole account): knows nothing of theses; enforces
  invariants — net delta/vega caps, per-underlying and per-expiration
  concentration, margin ceiling, drawdown circuit breaker, kill switch. It
  can veto entries, force closes, and scale sizes; **nothing can override
  it**, and it can never trap the book (closes always pass). The failure mode
  it prevents — ten individually-healthy positions forming one concentrated
  bet — is invisible from inside any single position.

Sizing rule: positions are sized against the gap scenario (underlying gaps
15-20% overnight and IV doubles), not against margin or daily vol. Overnight
gaps are the one thing no management rule can hedge; sizing is the only
defense.

Autonomy posture: fully automated (chosen deliberately), with the paper phase
serving as the trust-building period. Consequence: the risk layer and
monitoring are the most safety-critical code and get built and tested first.

## 4. Architecture

### 4.1 One engine, three worlds

The same pure evaluation path runs backtest, paper, and live; only the
bindings differ:

```
MarketData (historical | alpaca)  ->  snapshot
Evaluator.evaluate(state, snapshot) -> intents      (pure, no IO)
RiskManager.apply(state, intents)   -> allowed      (pure, no IO)
OrderManager -> Broker (sim | alpaca-paper | alpaca-live)
```

- **Time is injected.** `snapshot.asof` is the only clock; core never calls
  `Date.now()`. All stored timestamps derive from it. This is what makes
  backtests honest and live decisions replayable.
- **Level-triggered reconcile loop** (~1 min tick): every rule is a predicate
  on current state, never a transition. A missed tick cannot miss a trigger;
  restart recovery is just "run the loop." Kubernetes-style reconciliation.
- **Streams are cache-warmers only.** SSE/websockets refresh data; all
  decisions happen in the loop. One decision path, never two.
- **Record-replay:** journaled snapshots make any past decision reproducible
  in a debugger.

### 4.2 Backtester

Event-driven replay through the same engine. Canonical data is 1-minute bars
(strategies aggregate up); wide parameter sweeps run at EOD resolution, final
candidates validate at minute resolution — chiefly for **intraday stop-hit
realism**, which EOD backtests systematically miss. Fills are modeled
pessimistically (never at mid); the slippage model is calibrated against our
own live fill journal over time. Options daily marks come from consistent
late-session quote snapshots, never trade-based OHLC (most contracts barely
trade). Backtests run as child processes so they cannot block the live loop.

### 4.3 State, journal, market data

- `state.json` — atomic writes (tmp + fsync + rename), synchronous so the
  event loop cannot interleave them. Holds only what the broker cannot know
  (plans, roll counters, theses); **broker truth is re-fetched and reconciled
  on every boot**, so losing state is an inconvenience, not a disaster.
- Append-only JSONL journal — every trigger evaluation and decision, not just
  actions.
- Market data — JSONL(.gz) partitioned `data/bars/SYM/YYYY-MM`; upgrade path
  to Parquet behind the MarketData interface if scan speed demands it.
- Every file carries a schema `v` field; zod-validate on load; migrations are
  zod transforms.

### 4.4 Market sessions and option hours

The bundled calendar holds equity sessions (09:30-16:00 ET, 13:00 half days).
Options add three static rules, encoded in code rather than data:

- Standard equity options trade RTH only — no pre/post market. Overnight gap
  risk is therefore unhedgeable; sizing is the only defense.
- SPY/QQQ/IWM/DIA options trade until 16:15 ET (expiring series stop at
  16:00 on expiration day), but Alpaca only accepts options orders in RTH —
  so the engine (a) makes all option decisions inside 09:30-16:00, and
  (b) treats post-16:00 option marks as stale for triggers: quotes move in
  16:00-16:15 while we cannot act, and a "stop" firing then is a false alarm.
- Expiration mechanics: OCC auto-exercises anything >= $0.01 ITM off the
  16:00 underlying close; exercise cutoff ~17:30 ET. The 21-DTE exit means we
  never intentionally reach expiration; assignment handling still encodes
  these times as defense in depth.

### 4.5 Safety rails

Port binding doubles as the single-daemon guard (EADDRINUSE → refuse to run a
second engine). Every order carries a `client_order_id` idempotency key.
Stale-data guards refuse to act on missing/old quotes. Kill switch flattens
and halts.

## 5. Stack decisions and rationale

| Decision      | Choice                                                     | Why                                                                                                             |
| ------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Language      | TypeScript/Node (npm workspaces)                           | maintainer preference; discriminated unions fit intents/state machines; one language across daemon+UI           |
| Money         | integer cents everywhere, bps for percentages              | floats drift in ledgers; comparisons must be exact; one rounding function                                       |
| Storage       | files (JSON/JSONL), no database                            | local-first, zero ops, `cat`-able; models change fast early; interfaces allow LMDB/Parquet later                |
| UI            | daemon serves built React app; Vite dev server only in dev | the product is an always-on process; Electron (if ever) is a thin shell later, not the architecture             |
| Push          | SSE, not websockets                                        | one-directional needs; plain HTTP; auto-reconnect                                                               |
| Broker client | thin owned HTTP client + zod, no SDK                       | Alpaca's JS SDKs lag (esp. options/mleg); we own retries, rate limits, idempotency; ~15 endpoints               |
| CLI           | pure client of the daemon's HTTP API                       | one writer (daemon), many readers; same API the cloud version would expose                                      |
| Calendar      | bundled JSON (2016-2027), no runtime queries               | generated from NYSE rules (`generate:calendar`), overwritable with broker-authoritative data (`fetch:calendar`) |
| Concurrency   | single-threaded; backtests as child processes              | the loop is IO-bound; simplicity wins until sweeps demand workers                                               |

## 6. Coding conventions

- **OOD**: domain logic lives in classes (`MarketCalendar`, `OccSymbol`,
  `Evaluator`, `RiskManager`) with injected collaborators; classes stay
  stateless where the semantics are pure.
- **Immutability**: interface properties are `readonly`; collections are
  `readonly T[]` / `Readonly<Record>`.
- **Client style**: every client method takes exactly one `XxxRequest` and
  returns exactly one `XxxResponse`, even when empty — uniform shape, and new
  fields never break signatures.
- **Boundaries**: zod-validate everything that crosses the process boundary
  (broker responses, config, files on load).
- **core is pure**: no Node APIs, no IO, no wall clock, no randomness.

## 7. Known gaps / future work

- Alpaca options history only reaches back to ~Feb 2024 — multi-regime
  backtest validation will need a chain-history vendor (ThetaData or Polygon
  options).
- Earnings-calendar feed not yet chosen; event exits depend on it.
- Order manager (work-from-mid limit ladder, partial fills), position
  manager lifecycle (entry, rolls, assignment handling), screener, and
  backtester are scaffolded but not yet implemented — see README roadmap.

## 8. Glossary

- **VRP** — volatility risk premium; implied vol's persistent excess over
  realized vol.
- **Covered strangle** — long stock + short OTM call + short OTM put.
- **DTE** — days to expiration (calendar days).
- **Delta band** — target range for net position delta in share-equivalents.
- **bps** — basis points; 10000 = 100%.
- **Level-triggered** — rules fire on state ("mark ≤ target now"), not on
  transitions ("mark crossed target").
