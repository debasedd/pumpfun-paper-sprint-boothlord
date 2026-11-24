# pumpfun-paper-sprint-boothlord

A momentum paper-trading bot for the make.fun "Pump.fun Paper Sprint: Any Bot Can
Win" bounty. It trades 10 SOL of paper money on a replay of pump.fun bonding-curve
data (agent-fun/replay/v2, Node 22, `main.ts`).

## Strategy

- **Entry:** a curve becomes a buy once it is an established grinder: real SOL
  reserves in the 20–70 band (already pumped 1.5–10x off its create price), at
  least 100 slots old, and a 300-slot tape showing strong, broad, still-rising
  buy pressure: 20+ SOL net inflow, 30+ distinct buying wallets, price climbing
  and sitting near its window high, with newer-half inflow exceeding older-half
  inflow. Most coins fail this bar; the few that pass are the ones that can still
  run to migration.
- **Sizing:** one small ticket (0.15 SOL) per coin. The bot can pyramid into
  strength, but tuning on the dev window showed scale-ins losing money there, so the
  shipped config takes a single ticket per coin.
- **Exits:** stop loss (-20% vs cost), take-profit (+120% — bank the double, most
  runners dump after it), a wide trailing stop (30% pullback once up 20%), a single
  very large sell, or a maximum hold time (10,000 slots). A fade exit exists but is
  switched off by tuning. Exits are chunked: each sell's proceeds stay under half
  the curve's live real SOL reserves, so a dumping coin's collapsed reserves can't
  trap the position (the harness rejects oversized sells).
- **Guardrails:** pace-based probe round trips keep the run above 200 fills across
  20+ coins.

Paper trading only — no real funds, no network access, fully deterministic.
