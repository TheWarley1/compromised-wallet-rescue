#!/usr/bin/env node
'use strict';
/**
 * sol_rescue.js - CLI for the rescue bot.
 *
 *   node scripts/sol_rescue.js test           show wallet state and endpoints
 *   node scripts/sol_rescue.js rescue <mint>  move one token now
 *   node scripts/sol_rescue.js auto           watch and rescue every arrival
 *
 * Required env: VICTIM, DESTINATION  (see .env.example)
 */

const { rescue, listTokens, feePayerKeypair, conns, primary } = require('../lib/rescue');
const { config } = require('../lib/config');
const { PublicKey } = require('@solana/web3.js');

async function main() {
  const mode = process.argv[2] || 'test';

  if (mode === 'test') {
    const payer = feePayerKeypair();
    console.log('victim      :', config.victim);
    console.log('fee payer   :', payer.publicKey.toBase58(), 'SOL', (await primary.getBalance(payer.publicKey)) / 1e9);
    console.log('destination :', config.destination, 'SOL', (await primary.getBalance(new PublicKey(config.destination))) / 1e9);
    console.log('endpoints   :', conns.map((c) => c.name).join(', '));
    console.log('priority    :', config.priorityMicroLamports, 'micro-lamports/CU');
    const toks = await listTokens();
    console.log('tokens held :', toks.length);
    toks.forEach((t) => console.log('   ', t.mint, t.ui));
    return;
  }

  if (mode === 'rescue') {
    if (!process.argv[3]) {
      console.error('usage: sol_rescue.js rescue <mint> [amountRaw]');
      process.exit(2);
    }
    console.log(JSON.stringify(await rescue(process.argv[3], process.argv[4])));
    return;
  }

  if (mode === 'auto') {
    const done = new Set();
    const busy = new Set();

    const handle = async (why) => {
      let toks = [];
      try { toks = await listTokens(); } catch (e) { return; }
      for (const t of toks) {
        if (done.has(t.mint) || busy.has(t.mint)) continue;
        busy.add(t.mint);
        const t0 = Date.now();
        console.log(`[${new Date().toISOString()}] ${why} -> ${t.ui} ${t.mint}`);
        try {
          const r = await rescue(t.mint, t.amount);
          console.log('   ', JSON.stringify(r));
          if (r.sig) done.add(t.mint);
        } catch (e) {
          console.log('    FAILED', e.message.slice(0, 160));
        } finally {
          busy.delete(t.mint);
        }
        console.log('    elapsed', Date.now() - t0, 'ms');
      }
    };

    console.log('[auto] endpoints:', conns.map((c) => c.name).join(', '));
    try {
      primary.onLogs(new PublicKey(config.victim), () => { handle('ws'); }, 'processed');
      console.log('[auto] websocket armed (bonus path)');
    } catch (e) {
      console.log('[auto] websocket unavailable:', e.message.slice(0, 80));
    }
    // the poll is the mechanism; the socket is a bonus
    setInterval(() => handle('poll'), config.pollIntervalMs);
    handle('startup');
    for (;;) await new Promise((r) => setTimeout(r, 60000));
  }

  console.error('unknown mode:', mode);
  process.exit(2);
}

main().catch((e) => { console.error('fatal', e.message); process.exit(1); });
