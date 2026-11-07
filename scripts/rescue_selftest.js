#!/usr/bin/env node
'use strict';
/**
 * rescue_selftest.js - prove the rescue path works before you need it.
 *
 * Creates a throwaway SPL token, mints units straight into the compromised address
 * (the same shape as a real arrival) and lets the running bot try to move it.
 * Rent is recoverable: burn, then close the accounts.
 *
 *   node scripts/rescue_selftest.js create
 *   node scripts/rescue_selftest.js status
 *   node scripts/rescue_selftest.js cleanup
 */

const fs = require('fs');
const path = require('path');
const {
  Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
  MINT_SIZE, TOKEN_PROGRAM_ID, getMinimumBalanceForRentExemptMint, createInitializeMintInstruction,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createMintToInstruction,
  createCloseAccountInstruction, getAccount, createBurnInstruction,
} = require('@solana/spl-token');
const { config } = require('../lib/config');
const { primary, victimKeypair, feePayerKeypair } = require('../lib/rescue');

const STATE = path.join(__dirname, '..', '.selftest-state.json');
const VICTIM = new PublicKey(config.victim);
const DEST = new PublicKey(config.destination);

async function create() {
  const payer = feePayerKeypair();
  const mint = Keypair.generate();
  const rent = await getMinimumBalanceForRentExemptMint(primary);
  const victimAta = getAssociatedTokenAddressSync(mint.publicKey, VICTIM);

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey,
      lamports: rent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mint.publicKey, 0, payer.publicKey, payer.publicKey),
    createAssociatedTokenAccountInstruction(payer.publicKey, victimAta, VICTIM, mint.publicKey),
    createMintToInstruction(mint.publicKey, victimAta, payer.publicKey, 1000),
  );

  const sig = await sendAndConfirmTransaction(primary, tx, [payer, mint], { commitment: 'confirmed' });
  fs.writeFileSync(STATE, JSON.stringify({ mint: mint.publicKey.toBase58(), rent, sig }));
  console.log('test mint   :', mint.publicKey.toBase58());
  console.log('victim ata  :', victimAta.toBase58(), '(1000 units minted)');
  console.log('tx          :', sig);
  console.log('rent locked :', rent / 1e9, 'SOL (recoverable)');
  console.log('watch the rescue log; the bot should move it within a couple of seconds');
}

async function status() {
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const mint = new PublicKey(st.mint);
  for (const [label, owner] of [['victim', VICTIM], ['destination', DEST]]) {
    const ata = getAssociatedTokenAddressSync(mint, owner);
    try {
      const acc = await getAccount(primary, ata, 'confirmed', TOKEN_PROGRAM_ID);
      console.log(label.padEnd(12), ata.toBase58(), 'amount', acc.amount.toString());
    } catch (_) {
      console.log(label.padEnd(12), ata.toBase58(), 'none');
    }
  }
}

async function cleanup() {
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const mint = new PublicKey(st.mint);
  const payer = feePayerKeypair();
  const victim = victimKeypair();
  const victimAta = getAssociatedTokenAddressSync(mint, VICTIM);
  const destAta = getAssociatedTokenAddressSync(mint, DEST);

  const steps = [
    ['burn destination', [payer], async (tx) => {
      const acc = await getAccount(primary, destAta, 'confirmed', TOKEN_PROGRAM_ID);
      if (acc.amount > 0n) tx.add(createBurnInstruction(destAta, mint, DEST, acc.amount));
    }],
    ['close destination ata', [payer], async (tx) => {
      await getAccount(primary, destAta, 'confirmed', TOKEN_PROGRAM_ID);
      tx.add(createCloseAccountInstruction(destAta, payer.publicKey, DEST));
    }],
    ['close victim ata', [payer, victim], async (tx) => {
      await getAccount(primary, victimAta, 'confirmed', TOKEN_PROGRAM_ID);
      tx.add(createCloseAccountInstruction(victimAta, payer.publicKey, VICTIM));
    }],
    ['close mint', [payer], async (tx) => {
      tx.add(createCloseAccountInstruction(mint, payer.publicKey, payer.publicKey));
    }],
  ];

  for (const [label, signers, build] of steps) {
    try {
      const tx = new Transaction();
      await build(tx);
      if (tx.instructions.length === 0) { console.log(label, '- skip'); continue; }
      const sig = await sendAndConfirmTransaction(primary, tx, signers, { commitment: 'confirmed' });
      console.log(label, '- ok', sig.slice(0, 24) + '...');
    } catch (e) {
      console.log(label, '-', e.message.replace(/\s+/g, ' ').slice(0, 110));
    }
  }
  console.log('SOL now', (await primary.getBalance(payer.publicKey)) / 1e9);
}

const mode = process.argv[2] || 'create';
const fn = { create, status, cleanup }[mode];
if (!fn) { console.error('usage: create|status|cleanup'); process.exit(2); }
fn().catch((e) => { console.error('fatal', e.message); process.exit(1); });
