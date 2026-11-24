# pumpfun-paper-sprint-boothlord

A momentum paper-trading bot for the make.fun "Pump.fun Paper Sprint: Any Bot Can
Win" bounty. It trades 10 SOL of paper money on a replay of pump.fun bonding-curve
data (agent-fun/replay/v2, Node 22, `main.ts`).

## Strategy

- **Entry:** a curve becomes a buy once it is mature (past a minimum age since its
  CreateEvent) and its recent tape shows accelerating buy pressure: net SOL inflow
  over a lookback window, several distinct buying wallets, price climbing and sitting
  near its window high, with newer-half inflow exceeding older-half inflow.
- **Sizing:** one small ticket (0.25 SOL) per coin. The bot can pyramid into
  strength, but tuning on the dev window showed scale-ins losing money there, so the
  shipped config takes a single ticket per coin.
- **Exits:** stop loss (-12% vs cost), take-profit (+12%), a tight trailing stop
  (6% pullback once up 3%), a single very large sell, or a maximum hold time
  (3,000 slots). A fade exit exists but is switched off by tuning.
- **Guardrails:** pace-based probe round trips keep the run above 200 fills across
  20+ coins.

Paper trading only — no real funds, no network access, fully deterministic.
