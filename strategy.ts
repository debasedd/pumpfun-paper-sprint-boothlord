// Hawk momentum bot for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea: fresh pump.fun curves mostly dump after launch, so only buy a curve once it
// has proven itself as an established grinder: real SOL reserves in the 20-70 band
// (already pumped 1.5-10x off its create price), at least 100 slots old, and a
// 300-slot tape showing strong, broad, still-accelerating buy pressure — 20+ SOL of
// net inflow, 30+ distinct buying wallets, price climbing and sitting near its
// recent high, with the newer half of the lookback window pulling in more than the
// older half. Most coins fail this bar; the few that pass are the ones that can
// still run to migration.
//
// Sizing is cautious on purpose. Each coin gets one small ticket (0.15 SOL); the bot
// can pyramid into strength (see scaleIn in the config), but tuning on the dev window
// showed scale-ins losing money there, so the shipped config takes one ticket per coin
// and lets the exits do the work. Every position leaves on the first of: a stop loss
// (-20% vs cost), a take-profit (+120% — bank the double, most runners dump after
// it), a wide trailing stop (30% pullback once up 20%), a single very large sell,
// or a maximum hold time. A curve that migrates (CompleteEvent) is closed by the
// replay.
//
// Exits are chunked: the harness rejects a sell whose SOL proceeds exceed the
// curve's live real SOL reserves, and a dumping coin's reserves collapse below a
// whole position's value, so a whole-position sell gets stuck and the position rides
// to zero. Each exit sells only the chunk whose proceeds stay under half the live
// real reserves; the rest follows on later batches.
//
// Guardrail probes: the run needs plenty of fills across at least 20 coins. When our
// own fills or distinct coins lag the pace implied by elapsed block time, we open tiny
// probe round trips (buy a little of a liquid traded coin, sell it as soon as it lands)
// until we are back on pace.
//
// Fully deterministic: no clock, no randomness, iteration only over insertion-ordered
// maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface HawkConfig {
  /** Lookback window for the entry signal, in slots. */
  lookbackSlots: number;
  /** Minimum net SOL inflow (buys minus sells) over the lookback. */
  minInflowSol: number;
  /** Minimum number of buy trades in the lookback. */
  minBuyTrades: number;
  /** Minimum distinct buying wallets in the lookback. */
  minBuyWallets: number;
  /** Minimum price rise over the lookback (fraction, e.g. 0.04 = +4%). */
  minClimb: number;
  /** Maximum price rise over the lookback; skip coins that already ran too far. */
  maxClimb: number;
  /** Newer-half inflow must be at least this multiple of the older half's. */
  accelRatio: number;
  /** Current price must be at least this fraction of the lookback high. */
  nearHighFrac: number;
  /** Largest single wallet's share of buy SOL in the lookback (0..1). */
  maxTopWalletShare: number;
  /** Real SOL reserve bounds for an entry. */
  minCurveSol: number;
  maxCurveSol: number;
  /** Price now over the CreateEvent price must lie in this band (0 / 1e12 = off). */
  minRunup: number;
  maxRunup: number;
  /** Slots since CreateEvent before an entry is allowed. */
  minCurveAgeSlots: number;
  /** Slots since CreateEvent after which an entry is no longer allowed (1e12 = off). */
  maxCurveAgeSlots: number;
  /** Total SOL committed to one coin at most. */
  maxPerCoinSol: number;
  /** Smallest buy worth sending. */
  minTicketSol: number;
  /** Slippage allowed on buys, in bps. Sells always go out at 10000. */
  buySlippageBps: number;
  /** Exit when the position value falls this fraction below cost. */
  stopLossFrac: number;
  /** Exit when the position value rises this fraction above cost (1000 = off). */
  takeProfitFrac: number;
  /** Trailing stop: exit when value falls this fraction below its peak. */
  trailFrac: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArmFrac). */
  trailArmFrac: number;
  /** Fade window in slots for the outflow exit. */
  fadeLookbackSlots: number;
  /** Exit when net SOL over the fade window drops below minus this. */
  fadeOutflowSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  whaleSellSol: number;
  /** Exit after holding this many slots (unless comfortably up). */
  maxHoldSlots: number;
  /** Hold-time exit is waived while the position is up at least this fraction. */
  holdWaivedIfUpFrac: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  reentryCooldownSlots: number;
  /** Most separate entries per coin over the run. */
  maxEntriesPerCoin: number;
  /** Add to a position while the signal holds, up to maxPerCoinSol. */
  scaleIn: boolean;
  /** First ticket into a coin (SOL). */
  firstTicketSol: number;
  /** Each scale-in ticket (SOL). */
  scaleTicketSol: number;
  /** Scale in only once the price is this fraction above the last buy's price. */
  scaleStepFrac: number;
  /** Scale in only while the position is up at least this fraction over cost. */
  scaleIfUpFrac: number;
  /** Scale in only while net SOL over the lookback is at least this. */
  scaleMinInflowSol: number;
  /** Most momentum positions open at once (rest of the cap is for probes). */
  maxOpenMain: number;
  /** Guardrail pacing targets. */
  paceTargetCoins: number;
  paceTargetFills: number;
  paceWindowSecs: number;
  probeTicketSol: number;
  maxOpenProbes: number;
  /** Most SOL at cost across all positions at once. */
  maxTotalExposureSol: number;
}

// Tuned on the dev window with the local sim port, preferring flat regions over a
// single peak cell: trail 0.06 and TP/SL 0.12 are positive across neighbouring cells
// and across failed-tx draws (mean +0.14 SOL, worst +0.11 over five draws). Single
// ticket per coin: scale-ins were tried and lost money on this window (pyramid code
// stays in the bot, switched off by scaleIn below).
export const DEFAULT_CONFIG: HawkConfig = {
  lookbackSlots: 300,
  minInflowSol: 20,
  minBuyTrades: 10,
  minBuyWallets: 30,
  minClimb: 0.05,
  maxClimb: 1.0,
  accelRatio: 0.5,
  nearHighFrac: 0.85,
  maxTopWalletShare: 0.4,
  minCurveSol: 20,
  maxCurveSol: 70,
  minCurveAgeSlots: 100,
  maxCurveAgeSlots: 1e12,
  minRunup: 1.5,
  maxRunup: 10,
  maxPerCoinSol: 0.15,
  minTicketSol: 0.01,
  buySlippageBps: 1500,
  stopLossFrac: 0.2,
  takeProfitFrac: 1.2,
  trailFrac: 0.3,
  trailArmFrac: 0.2,
  fadeLookbackSlots: 20,
  fadeOutflowSol: 1000,
  whaleSellSol: 5,
  maxHoldSlots: 10000,
  holdWaivedIfUpFrac: 1000,
  reentryCooldownSlots: 200,
  maxEntriesPerCoin: 1,
  scaleIn: false,
  firstTicketSol: 0.15,
  scaleTicketSol: 0,
  scaleStepFrac: 0,
  scaleIfUpFrac: -1,
  scaleMinInflowSol: 0,
  maxOpenMain: 5,
  paceTargetCoins: 25,
  paceTargetFills: 240,
  paceWindowSecs: 14400,
  probeTicketSol: 0.01,
  maxOpenProbes: 1,
  maxTotalExposureSol: 6,
};

const LAMPORTS_PER_SOL = 1e9;
/** Bonding-curve fee taken on sells (protocol + creator, ~1.25%). */
const CURVE_FEE_FRAC = 0.0125;
const BPS_DENOM = 10_000;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: number;
  wallet: string;
  price: number;
}

interface CoinBook {
  bornSlot: number | null;
  createPrice: number;
  ticks: Tick[];
  entriesUsed: number;
  lastExitSlot: number;
}

interface OpenTrade {
  openedSlot: number;
  bestValueSol: number;
  spentSol: number;
  wantsOut: boolean;
  sawFill: boolean;
  lastBuyPrice: number;
  latestValueSol: number;
}

export function createHawkBot(cfg: HawkConfig = DEFAULT_CONFIG): Bot {
  const books = new Map<Pubkey, CoinBook>();
  const open = new Map<Pubkey, OpenTrade>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  let ownFills = 0;
  const ownCoins = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  const keepSlots = Math.max(cfg.lookbackSlots, cfg.fadeLookbackSlots) + 5;

  const bookOf = (mint: Pubkey): CoinBook => {
    let b = books.get(mint);
    if (b === undefined) {
      b = { bornSlot: null, createPrice: 0, ticks: [], entriesUsed: 0, lastExitSlot: -1e12 };
      books.set(mint, b);
    }
    return b;
  };

  /** Net SOL (buys minus sells) on a coin over the last `span` slots. */
  const netFlow = (b: CoinBook, now: number, span: number): number => {
    let net = 0;
    for (let i = b.ticks.length - 1; i >= 0; i--) {
      const t = b.ticks[i]!;
      if (t.slot <= now - span) break;
      net += t.isBuy ? t.sol : -t.sol;
    }
    return net;
  };

  /**
   * Tokens to sell now when exiting a position: the harness rejects a sell whose
   * SOL proceeds exceed the curve's live real SOL reserves, and a dumping coin's
   * reserves collapse below a whole position's value — so a whole-position sell gets
   * stuck, retried every batch, while the position rides to zero. Sell only the
   * chunk whose proceeds stay under half the live real reserves; the rest follows
   * on later batches once the first chunk lands.
   */
  const exitChunk = (tokens: bigint, vq: number, vt: number, rqSol: number): bigint => {
    if (tokens <= 0n || rqSol <= 0 || vq <= 0 || vt <= 0) return 0n;
    const maxQuoteSol = rqSol * 0.5;
    if (maxQuoteSol <= 0) return 0n;
    // Solve T * vq / (vt + T) = maxQuote (all in SOL units) for T, in token units.
    const maxQuoteLamports = maxQuoteSol * LAMPORTS_PER_SOL;
    const tMax = (maxQuoteLamports * vt) / (vq - maxQuoteLamports);
    if (tMax <= 0) return 0n;
    const chunk = BigInt(Math.floor(tMax));
    return chunk >= tokens ? tokens : chunk;
  };

  /** Entry signal: true when the tape shows accelerating, broad-based buy pressure. */
  const entryOk = (b: CoinBook, now: number, realSol: number, priceNow: number): boolean => {
    if (realSol < cfg.minCurveSol || realSol > cfg.maxCurveSol) return false;
    if (b.bornSlot === null || now - b.bornSlot < cfg.minCurveAgeSlots || now - b.bornSlot > cfg.maxCurveAgeSlots) return false;
    if (b.createPrice > 0) {
      const runup = priceNow / b.createPrice;
      if (runup < cfg.minRunup || runup > cfg.maxRunup) return false;
    }
    const start = now - cfg.lookbackSlots;
    const mid = now - cfg.lookbackSlots / 2;
    let buySol = 0;
    let sellSol = 0;
    let buyTrades = 0;
    let flowOld = 0;
    let flowNew = 0;
    let firstPrice = -1;
    let high = 0;
    let lastPrice = 0;
    const perWallet = new Map<string, number>();
    for (const t of b.ticks) {
      if (t.slot <= start) {
        firstPrice = t.price;
        continue;
      }
      if (firstPrice < 0) firstPrice = t.price;
      const signed = t.isBuy ? t.sol : -t.sol;
      if (t.slot <= mid) flowOld += signed;
      else flowNew += signed;
      if (t.isBuy) {
        buySol += t.sol;
        buyTrades++;
        perWallet.set(t.wallet, (perWallet.get(t.wallet) ?? 0) + t.sol);
      } else {
        sellSol += t.sol;
      }
      if (t.price > high) high = t.price;
      lastPrice = t.price;
    }
    if (buyTrades < cfg.minBuyTrades || perWallet.size < cfg.minBuyWallets) return false;
    if (buySol - sellSol < cfg.minInflowSol) return false;
    if (firstPrice <= 0) return false;
    const climb = lastPrice / firstPrice - 1;
    if (climb < cfg.minClimb || climb > cfg.maxClimb) return false;
    if (lastPrice < high * cfg.nearHighFrac) return false;
    if (flowNew <= 0 || flowNew < cfg.accelRatio * flowOld) return false;
    let biggest = 0;
    for (const v of perWallet.values()) if (v > biggest) biggest = v;
    if (biggest > cfg.maxTopWalletShare * buySol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const whaleSold = new Set<Pubkey>();
      const active = new Set<Pubkey>();

      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          ownFills++;
          ownCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const b = bookOf(e.mint);
          b.bornSlot = e.slot;
          b.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const b = bookOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS_PER_SOL;
          b.ticks.push({
            slot: e.slot,
            isBuy: e.is_buy,
            sol,
            wallet: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          active.add(e.mint);
          if (!e.is_buy && sol >= cfg.whaleSellSol) whaleSold.add(e.mint);
        }
      }
      for (const mint of active) {
        const b = books.get(mint)!;
        let drop = 0;
        while (drop < b.ticks.length && b.ticks[drop]!.slot <= now - keepSlots) drop++;
        if (drop > 0) b.ticks.splice(0, drop);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }
      const pendingSell = (mint: Pubkey): boolean => {
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') return true;
        }
        return false;
      };

      const orders: OrderInput[] = [];
      const maxOrders = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS_PER_SOL;

      // ---- Exits first: sell a whole position on the first exit trigger. ----
      for (const [mint, tr] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            open.delete(mint);
            const b = bookOf(mint);
            if (tr.sawFill) b.lastExitSlot = now;
            else b.entriesUsed--;
          }
          continue;
        }
        tr.sawFill = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const realSol = (mk ? Number(mk.real_quote_reserves) : Number(curve.real_quote_reserves)) / LAMPORTS_PER_SOL;
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS_PER_SOL) * (1 - CURVE_FEE_FRAC) - txSol;
        const cost = Number(pos.cost_lamports) / LAMPORTS_PER_SOL;
        if (value > tr.bestValueSol) tr.bestValueSol = value;
        tr.latestValueSol = value;
        let out = tr.wantsOut;
        const b = bookOf(mint);
        if (!out && value < cost * (1 - cfg.stopLossFrac)) out = true;
        if (!out && value >= cost * (1 + cfg.takeProfitFrac)) out = true;
        if (!out && tr.bestValueSol >= cost * (1 + cfg.trailArmFrac) && value < tr.bestValueSol * (1 - cfg.trailFrac)) out = true;
        if (!out && netFlow(b, now, cfg.fadeLookbackSlots) < -cfg.fadeOutflowSol) out = true;
        if (!out && whaleSold.has(mint)) out = true;
        if (!out && now - tr.openedSlot > cfg.maxHoldSlots && value < cost * (1 + cfg.holdWaivedIfUpFrac)) out = true;
        if (!out) continue;
        tr.wantsOut = true;
        if (pendingSell(mint)) continue;
        if (orders.length >= maxOrders) break;
        const chunk = exitChunk(BigInt(pos.token_amount), vq, vt, realSol);
        if (chunk <= 0n) continue;
        orders.push({ side: 'sell', mint, token_amount: chunk.toString(), max_slippage_bps: 10_000 });
      }

      // ---- Probe round trips: sell the probe as soon as its buy has landed. ----
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= maxOrders) break;
        const pmk = marks.get(mint);
        const pvq = pmk ? Number(pmk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const pvt = pmk ? Number(pmk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const prq = (pmk ? Number(pmk.real_quote_reserves) : Number(curve.real_quote_reserves)) / LAMPORTS_PER_SOL;
        const pchunk = exitChunk(BigInt(pos.token_amount), pvq, pvt, prq);
        if (pchunk <= 0n) continue;
        orders.push({ side: 'sell', mint, token_amount: pchunk.toString(), max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // ---- Entries and scale-ins. ----
      let freeSol = Number(state.freeCashLamports()) / LAMPORTS_PER_SOL;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = cfg.maxOpenMain - open.size;
      let exposureSol = 0;
      for (const [mint, tr] of open) {
        exposureSol += Math.max(tr.spentSol, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS_PER_SOL);
      }
      for (const mint of active) {
        if (orders.length >= maxOrders) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const b = books.get(mint)!;
        const tr = open.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
        let ticket: number;
        if (tr === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (b.entriesUsed >= cfg.maxEntriesPerCoin || now - b.lastExitSlot < cfg.reentryCooldownSlots) continue;
          if (!entryOk(b, now, realSol, price)) continue;
          ticket = Math.min(cfg.firstTicketSol, cfg.maxPerCoinSol);
        } else {
          // Scale in only into strength: price stepped up from the last buy, the
          // position is up, and inflow over the lookback is still there.
          if (!cfg.scaleIn || tr.wantsOut || !tr.sawFill || tr.spentSol >= cfg.maxPerCoinSol - cfg.minTicketSol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < tr.lastBuyPrice * (1 + cfg.scaleStepFrac)) continue;
          if (tr.latestValueSol < Number(pos.cost_lamports) / LAMPORTS_PER_SOL * (1 + cfg.scaleIfUpFrac)) continue;
          if (netFlow(b, now, cfg.lookbackSlots) < cfg.scaleMinInflowSol) continue;
          if (realSol > cfg.maxCurveSol) continue;
          ticket = Math.min(cfg.scaleTicketSol, cfg.maxPerCoinSol - tr.spentSol);
        }
        const reserveCapSol = (Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS_PER_SOL) * 0.8;
        let amount = Math.min(reserveCapSol, ticket, cfg.maxTotalExposureSol - exposureSol);
        if (amount > freeSol - txSol) amount = freeSol - txSol;
        if (amount < cfg.minTicketSol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS_PER_SOL));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: cfg.buySlippageBps });
        freeSol -= amount + txSol;
        exposureSol += amount;
        if (tr === undefined) {
          open.set(mint, {
            openedSlot: now,
            bestValueSol: 0,
            spentSol: amount,
            wantsOut: false,
            sawFill: false,
            lastBuyPrice: price,
            latestValueSol: 0,
          });
          b.entriesUsed++;
          slotsLeft--;
          mainLeft--;
        } else {
          tr.spentSol += amount;
          tr.lastBuyPrice = price;
        }
      }

      // ---- Guardrail pacing: open a probe when fills or coins lag the pace. ----
      if (probes.size < cfg.maxOpenProbes && slotsLeft > 0 && firstBlockTime !== null && lastBlockTime !== null) {
        const pace = Math.min(1, (lastBlockTime - firstBlockTime) / cfg.paceWindowSecs);
        const coinsBehind = ownCoins.size < Math.ceil(cfg.paceTargetCoins * pace);
        const fillsBehind = ownFills < Math.ceil(cfg.paceTargetFills * pace);
        if (coinsBehind || fillsBehind) {
          const minRealSol = (cfg.probeTicketSol * BPS_DENOM) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of active) {
            if (orders.length >= maxOrders || probes.size >= cfg.maxOpenProbes) break;
            if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (coinsBehind && !fillsBehind && ownCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL < minRealSol * 1.5) continue;
            if (freeSol < cfg.probeTicketSol + 2 * txSol) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(cfg.probeTicketSol * LAMPORTS_PER_SOL)), max_slippage_bps: cfg.buySlippageBps });
            probes.set(mint, false);
            freeSol -= cfg.probeTicketSol + txSol;
          }
        }
      }
      return orders;
    },
  };
}
