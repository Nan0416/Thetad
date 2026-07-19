# thetad — Agent & Contributor Guide

Coding preferences for this repo. These are maintainer decisions, not
suggestions — follow them unless a change is explicitly agreed first.
Architecture and rationale live in [docs/DESIGN.md](docs/DESIGN.md).

## Commands

```sh
npm test                 # vitest, all packages
npm run check            # tsc --noEmit, all packages + web
npm start                # daemon on http://127.0.0.1:7777
npm run dev:server       # daemon with watch
npm run dev:web          # Vite dev server (proxies /api to daemon)
npm run verify:alpaca    # contract test vs paper API (-- --orders for order round-trips)
npm run calendar:fetch   # refresh bundled NYSE calendar from Alpaca
```

## Style: object-oriented design

- Domain logic lives in **classes** (`MarketCalendar`, `OccSymbol`,
  `Evaluator`, `RiskManager`), not free functions. Collaborators are injected
  via the constructor (e.g. `Evaluator` takes a `MarketCalendar`).
- Classes carry collaborators and configuration, **not mutable state**, when
  the semantics are pure — `Evaluator.evaluate()` must stay a pure function
  of its arguments so backtest replay and record-replay debugging work.
- Small math/utility helpers (Black-Scholes, money) may remain functions;
  anything with identity, configuration, or a swappable implementation is a
  class behind an interface.

## Style: immutability

- Every interface property is `readonly`. Collections are `readonly T[]` and
  `Readonly<Record<K, V>>`.
- Build objects immutably (spread, `Object.fromEntries`) instead of mutating
  after construction. Conditional optional fields use
  `...(x !== undefined && { x })` (the tsconfig sets
  `exactOptionalPropertyTypes`).
- Internal private state inside a class (caches, maps) may mutate; anything
  that crosses a public boundary must not.

## Style: Request/Response client methods

Every client method (broker, data provider, any future service) takes exactly
**one `XxxRequest` object** and returns exactly **one `XxxResponse` object**,
even when either is empty:

```ts
getAccount(request: GetAccountRequest): Promise<GetAccountResponse>;
cancelOrder(request: CancelOrderRequest): Promise<CancelOrderResponse>; // {} is fine
```

Uniform call shape; adding a field later never breaks a signature.

## Money and numbers

- Money is **integer cents** (`Cents` branded type), never floats. Percentages
  are **basis points** (integers). All rounding goes through the single
  helper in `packages/core/src/money.ts` (half away from zero).
- Threshold comparisons use integer cross-multiplication, not division:
  `profit * 10_000 >= targetBps * credit`.
- Floats are only for estimates: greeks, vols, theoretical prices.

## Purity of core

`packages/core` has **zero dependencies and no side effects**: no Node APIs,
no IO, no network, no `Date.now()`, no randomness. Time enters only through
`snapshot.asof`. Static data (the NYSE calendar) is bundled JSON imported at
compile time — never fetched at runtime.

## Engine semantics

- **Level-triggered, not edge-triggered:** every rule is a predicate on
  current state ("mark <= target now"), never on a transition. A missed tick
  must never miss a trigger.
- Actions are **idempotent** ("ensure a closing order is working").
- Streams (SSE/websocket) only refresh caches; **all decisions happen in the
  reconcile loop**. One decision path, never two.
- The broker is the source of truth for positions/orders; local files hold
  only what the broker cannot know (plans, counters, theses). Reconcile on
  every boot.

## Data and persistence

- Files, not databases: `state.json` via atomic write (tmp + fsync + rename,
  synchronous), append-only JSONL journals, JSONL(.gz) market data
  partitioned `data/bars/SYM/YYYY-MM`.
- Every persisted file carries a schema version field `v`; validate with zod
  on load; migrations are zod transforms.
- Cache/bundle data locally; no remote queries for static data at runtime.

## Boundaries and dependencies

- **zod-validate everything** that crosses the process boundary: broker/API
  responses, config, files on load.
- No vendor SDKs — thin owned HTTP clients (`fetch` + zod) with typed error
  taxonomy (auth / rejected / retry-exhausted), jittered backoff on 429/5xx,
  fail-fast on other 4xx.
- Every order carries a `client_order_id` idempotency key.
- Prefer zero new dependencies; justify each addition.

## Naming conventions

- `xxxCents` for money, `xxxBps` for basis points, `xxxIso` for `YYYY-MM-DD`
  dates, `xxxUtc` for ISO instants / `Date` fields.
- npm workspaces: `@thetad/<package>`; ESM everywhere (`"type": "module"`).

## Testing

- Vitest; tests live in `packages/<pkg>/test/*.test.ts`.
- Prefer known-value spot checks (textbook Black-Scholes numbers, real NYSE
  calendar dates, hand-computed lifecycle fixtures) over tautological tests.
- New engine rules need a fixture test before wiring into the loop.

## Process

- Keep it simple first: single-threaded, no workers, no queues; long CPU work
  (backtests) runs as a child process, never in the daemon's loop.
- Never commit `.env`, `state/`, `data/`, `journal/`, or `.claude/`.
- Trading-safety invariants (risk-layer veto, collateral floor, stale-data
  guards, singleton port guard) must never be weakened to make a test or
  feature easier.
