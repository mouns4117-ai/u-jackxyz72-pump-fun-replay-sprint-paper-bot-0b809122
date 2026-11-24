// Paper bot for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea: buy fresh coins early and let the runners pay. A curve's price only rises
// while fresh SOL keeps flowing in, so the bot watches every coin from its
// CreateEvent and buys only in its first 100 slots, once a few real buys have
// landed and the price has not already run more than 3x. It builds each position
// gradually — every reply can spend at most 1% of the curve's real SOL reserve, so
// size only arrives while the reserve itself grows — up to 0.10 SOL per coin. It
// then holds for the big move: half the position is banked at +200%, the rest rides
// under a trailing stop, and losers are cut at -30% against cost. Exits on faded
// flow or a creator sell were tried and turned off: on the dev window they only
// realised losses early, while holding to the end (or to completion) let prices
// stabilise. A drawdown guard halts new entries past -30% equity.
//
// Tuned on the kit's dev window with the local replay engine: +0.20 SOL mean net
// PnL over six failed-tx draws (worst +0.05), 25-28 qualifying coins (bought
// >= 0.01 SOL each), max drawdown under 3%, still +0.02 SOL at 2x fees. The
// momentum-chasing and fast-exit variants tried first all lost money; what works
// here is small, early, patient size on fresh curves.
//
// Deterministic by construction: no clock, no randomness, no I/O — every decision is
// a pure function of the batches the harness feeds in. Iteration is only over
// insertion-ordered maps fed by that same batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Lookback window (slots) for flow and price checks. */
  window: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Price now over the create price, minus 1, at least this. */
  minPriceUp: number;
  /** Net buy SOL (buys minus sells) over the window, at least this. */
  minNetSol: number;
  /** Buy trades in the window, at least this many. */
  minBuys: number;
  /** Distinct buying wallets in the window, at least this many. */
  minBuyers: number;
  /** Largest single wallet's share of the window's buy SOL, at most this. */
  maxBuyerShare: number;
  /** Price now at least this share of the window's high. */
  nearHigh: number;
  /** Real SOL reserve bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** SOL to put into one position in total. */
  stakeSol: number;
  /** Most SOL in a single buy order. */
  buyStepSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exit when the position's close value falls this far under its cost. */
  stopLoss: number;
  /** Sell half the position once it is worth this much over its cost. */
  takeProfit: number;
  /** Trailing stop: exit when value falls this far under its peak. */
  trail: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Exit after this many slots held (unless the trailing stop already fired). */
  maxHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Oldest age (slots since create) at which a first buy may still be decided. */
  maxAge: number;
  /** Price now over the create price, at most this (skip coins that already ran too far). */
  maxPriceUp: number;
  /** Exit when net SOL over the exit window falls below this. */
  exitFlowSol: number;
  /** Exit window (slots) for the flow exit. */
  exitWindow: number;
  /** Exit at once on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Stop opening new positions once the run's drawdown passes this. */
  haltDrawdown: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 10,
  minAge: 0,
  minPriceUp: 0,
  minNetSol: 0,
  minBuys: 3,
  minBuyers: 0,
  maxBuyerShare: 1,
  nearHigh: 0,
  minRqSol: 0.05,
  maxRqSol: 40,
  stakeSol: 0.1,
  buyStepSol: 0.02,
  minBuySol: 0.008,
  buySlipBps: 1500,
  stopLoss: 0.3,
  takeProfit: 2,
  trail: 0.4,
  trailArm: 0.3,
  maxHold: 100000,
  cooldown: 120,
  maxEntries: 2,
  maxAge: 100,
  maxPriceUp: 2,
  exitFlowSol: -1000,
  exitWindow: 30,
  bigSellSol: 1000,
  maxExposureSol: 2.5,
  haltDrawdown: 0.3,
};

const LAMPORTS = 1e9;
/** Curve fees on a trade: protocol 95 bps + creator 30 bps. */
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string;
  createPrice: number;
  trades: Trade[];
  entries: number;
  lastExit: number;
  devSold: boolean;
}

interface Held {
  opened: number;
  /** Best close value seen (SOL). */
  peak: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  /** A sell order for the whole position is already in flight. */
  exiting: boolean;
  /** Some buy of this position filled. */
  filled: boolean;
  /** The half take-profit already happened. */
  banked: boolean;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  let peakEquity = 10;
  const keep = p.window + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: '', createPrice: 0, trades: [], entries: 0, lastExit: -1e12, devSold: false };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Entry signal on a curve's tape at slot `now`. */
  const entryOk = (t: Tape, now: number, rqSol: number, price: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    if (t.devSold) return false;
    if (t.createPrice <= 0 || price < t.createPrice * (1 + p.minPriceUp)) return false;
    if (price > t.createPrice * (1 + p.maxPriceUp)) return false;
    const from = now - p.window;
    let buySol = 0;
    let buys = 0;
    let high = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) continue;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      }
      if (tr.price > high) high = tr.price;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (flow(t, now, p.window) < p.minNetSol) return false;
    if (high > 0 && price < high * p.nearHigh) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (buySol > 0 && top > p.maxBuyerShare * buySol) return false;
    return true;
  };

  /** Close value of `tokens` on this curve now (SOL, after curve and tx fees). */
  const closeValue = (tokens: number, vq: number, vt: number, tx: number): number => {
    if (tokens <= 0 || vt <= 0) return 0;
    return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
          t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves) });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
          if (!e.is_buy && e.user === t.creator) t.devSold = true;
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      // Track the run's equity peak so new entries halt past the drawdown guard.
      let equity = Number(state.cash) / LAMPORTS;
      for (const [mint, pos] of state.positions) {
        const c = state.curves.get(mint);
        if (c !== undefined) equity += closeValue(Number(pos.token_amount), Number(c.virtual_quote_reserves), Number(c.virtual_token_reserves), 0);
      }
      if (equity > peakEquity) peakEquity = equity;
      const halted = peakEquity > 0 && (peakEquity - equity) / peakEquity > p.haltDrawdown;

      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;

      // Exits first: stop loss, trailing stop, half take-profit, flow exit, big sell, time limit.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const tokens = Number(pos.token_amount);
        const value = closeValue(tokens, Number(curve.virtual_quote_reserves), Number(curve.virtual_token_reserves), tx);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peak) h.peak = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        if (!h.banked && value >= cost * (1 + p.takeProfit)) {
          // Bank half at the take-profit, keep the rest running under the trailing stop.
          if (orders.length < cap && !pendingByMint.has(mint)) {
            orders.push({ side: 'sell', mint, token_amount: BigInt(Math.floor(tokens / 2)), max_slippage_bps: 10_000 });
            h.banked = true;
          }
          continue;
        }
        let exit = h.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peak >= cost * (1 + p.trailArm) && value < h.peak * (1 - p.trail)) exit = true;
        if (!exit && flow(t, now, p.exitWindow) < p.exitFlowSol) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Then entries and adds: buy while the signal holds, up to the per-coin stake.
      if (!halted) {
        let free = Number(state.freeCashLamports()) / LAMPORTS;
        let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
        let exposure = 0;
        for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
        for (const mint of traded) {
          if (orders.length >= cap) break;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (pendingByMint.has(mint)) continue;
          const t = tapes.get(mint)!;
          const h = held.get(mint);
          const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
          let want: number;
          if (h === undefined) {
            if (slotsLeft <= 0) continue;
            if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
            if (t.created === null || now - t.created > p.maxAge) continue;
            if (!entryOk(t, now, rqSol, price)) continue;
            want = p.stakeSol;
          } else {
            if (h.exiting || !h.filled || h.invested >= p.stakeSol - p.minBuySol) continue;
            if (!entryOk(t, now, rqSol, price)) continue;
            want = p.stakeSol - h.invested;
          }
          const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
          let amount = Math.min(capSol, want, p.buyStepSol, p.maxExposureSol - exposure);
          if (amount > free - tx) amount = free - tx;
          if (amount < p.minBuySol) continue;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          exposure += amount;
          if (h === undefined) {
            held.set(mint, { opened: now, peak: 0, invested: amount, exiting: false, filled: false, banked: false, lastValue: 0 });
            t.entries++;
            slotsLeft--;
          } else {
            h.invested += amount;
          }
        }
      }
      return orders;
    },
  };
}
