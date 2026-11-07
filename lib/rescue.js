'use strict';
/**
 * rescue.js - build, sign and broadcast the rescue transaction.
 *
 * The victim key signs because it is the authority on its token account; the FEE
 * PAYER is a separate clean wallet so nothing ever sits in the swept wallet.
 * The signed bytes are then fired at every configured endpoint at once.
 */

const { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } = require('@solana/web3.js');
const {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAccount,
} = require('@solana/spl-token');
const { derivePath } = require('ed25519-hd-key');
const bip39 = require('bip39');
const fs = require('fs');
const { config, endpointList } = require('./config');

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

const conns = endpointList().map((e) => ({ ...e, conn: new Connection(e.url, 'confirmed') }));
if (conns.length === 0) {
  console.error('no endpoints configured');
  process.exit(2);
}
const primary = conns[0].conn;

function victimKeypair() {
  const raw = JSON.parse(fs.readFileSync(config.victimKeypairPath, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function feePayerKeypair() {
  if (process.env.FEE_PAYER_SECRET_KEY) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.FEE_PAYER_SECRET_KEY)));
  }
  const mnemonic = config.feePayerMnemonic
    || (config.feePayerMnemonicFile && fs.readFileSync(config.feePayerMnemonicFile, 'utf8').trim());
  if (!mnemonic) throw new Error('no fee payer key: set FEE_PAYER_MNEMONIC(_FILE) or FEE_PAYER_SECRET_KEY');
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const { key } = derivePath(config.feePayerDerivation, seed.toString('hex'));
  return Keypair.fromSeed(key);
}

async function listTokens(conn) {
  const c = conn || primary;
  const res = await c.getParsedTokenAccountsByOwner(new PublicKey(config.victim), { programId: TOKEN_PROGRAM });
  return res.value.map((a) => ({
    mint: a.account.data.parsed.info.mint,
    amount: a.account.data.parsed.info.tokenAmount.amount,
    ui: a.account.data.parsed.info.tokenAmount.uiAmount,
  }));
}

/** fire identical signed bytes at every endpoint; first acceptance wins */
async function broadcast(rawBytes) {
  const b64 = Buffer.from(rawBytes).toString('base64');
  const attempts = conns.map(async ({ name, url }) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'sendTransaction',
        params: [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }],
      }),
    });
    const j = await res.json();
    if (j.error) throw new Error(`${name}: ${j.error.message}`);
    return { endpoint: name, sig: j.result };
  });
  const settled = await Promise.allSettled(attempts);
  const ok = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  if (ok.length) return { ...ok[0], accepted_by: ok.length };
  return { error: settled.map((s) => s.reason && s.reason.message).join(' | ') };
}

async function rescue(mintStr, amountStr) {
  const mint = new PublicKey(mintStr);
  const victim = victimKeypair();
  const payer = feePayerKeypair();
  const victimPk = new PublicKey(config.victim);
  const destPk = new PublicKey(config.destination);

  const srcAta = getAssociatedTokenAddressSync(mint, victimPk);
  const dstAta = getAssociatedTokenAddressSync(mint, destPk);

  let amount = amountStr ? BigInt(amountStr) : null;
  if (amount === null) {
    const acc = await getAccount(primary, srcAta, 'confirmed', TOKEN_PROGRAM);
    amount = acc.amount;
  }
  if (amount <= 0n) return { ok: false, reason: 'zero balance' };

  const { blockhash } = await primary.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash });
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityMicroLamports }));
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
  tx.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, dstAta, destPk, mint, TOKEN_PROGRAM));
  tx.add(createTransferInstruction(srcAta, dstAta, victimPk, amount, [], TOKEN_PROGRAM));
  tx.sign(payer, victim);

  const t0 = Date.now();
  const out = await broadcast(tx.serialize());
  return { ...out, ms: Date.now() - t0, mint: mintStr, amount: amount.toString() };
}

module.exports = { rescue, listTokens, victimKeypair, feePayerKeypair, conns, primary };
