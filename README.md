# pumpfun-paper-sprint-boothlord

A momentum paper-trading bot for the make.fun "Pump.fun Paper Sprint: Any Bot Can
Win" bounty. It trades 10 SOL of paper money on a replay of pump.fun bonding-curve
data (agent-fun/replay/v2, Node 22, `main.ts`).

## Strategy

- **Entry:** a curve becomes a buy once it is mature (past a minimum age since its
  CreateEvent) and its recent tape shows accelerating buy pressure: net SOL inflow
  over a lookback window, several distinct buying wallets, price climbing and sitting
  near its window high, with newer-half inflow exceeding older-half inflow.
- **Sizing:** first ticket is tiny; the bot scales into strength only (price stepped
  up from the last buy, position in profit, inflow still positive), up to a per-coin
  ceiling.
- **Exits:** stop loss vs cost, trailing stop once the position has run up, fade in
  buy flow, a single very large sell, or a maximum hold time.
- **Guardrails:** pace-based probe round trips keep the run above 200 fills across
  20+ coins.

Paper trading only — no real funds, no network access, fully deterministic.
