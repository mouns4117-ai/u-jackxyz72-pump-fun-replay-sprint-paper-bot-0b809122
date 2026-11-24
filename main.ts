// Pump.fun Replay Sprint — Paper Bot: the entrypoint the grader runs.
//
// The grader runs `node /bot/main.ts` with this directory mounted at /bot. The bot
// speaks agent-fun/replay/v2 on stdin/stdout through the SDK shim in vendor/ (a
// byte-identical copy of the kit's sdk/ts/makefun-bot.ts), one reply per batch, and
// the strategy in strategy.ts decides the orders. It needs no network, no secrets
// and no install: Node 22.18+ runs the TypeScript as it is. Run it locally the same
// way the grader does — feed it hello/batch lines on stdin and read replies on
// stdout — or grade it with the kit: node cli/makefun.mjs grade-local --kit <kit>
// --bot <this repo> --driver docker --bundle <transcripts.tar.gz>.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
