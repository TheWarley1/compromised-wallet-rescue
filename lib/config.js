'use strict';
/**
 * config.js - every knob in one place, no secrets in the repo.
 *
 * Secrets are read from files under SECRETS_DIR (default ~/.hermes/.secrets), never
 * from the environment, so they cannot leak through `ps`, shell history or a log line.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SECRETS_DIR = process.env.SECRETS_DIR || path.join(os.homedir(), '.hermes', '.secrets');

function secret(name) {
  const p = path.join(SECRETS_DIR, name);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8').trim();
}

function required(name, value) {
  if (!value) {
    console.error(`missing required setting: ${name}`);
    process.exit(2);
  }
  return value;
}

const config = {
  secretsDir: SECRETS_DIR,

  // the compromised address you are protecting
  victim: required('VICTIM', process.env.VICTIM),

  // the clean wallet that receives rescued tokens and pays the fees
  destination: required('DESTINATION', process.env.DESTINATION),

  // keypair of the compromised wallet, solana cli format ([64 bytes] json)
  victimKeypairPath: process.env.VICTIM_KEYPAIR
    || path.join(SECRETS_DIR, 'quarantine', 'dead_sol_keypair.json'),

  // mnemonic or raw 32-byte seed that derives the fee payer wallet
  feePayerMnemonic: process.env.FEE_PAYER_MNEMONIC || null,
  feePayerMnemonicFile: process.env.FEE_PAYER_MNEMONIC_FILE || null,
  feePayerDerivation: process.env.FEE_PAYER_DERIVATION || "m/44'/501'/3'/0'",

  // aggressive priority fee - the only lever that decides a same-slot race
  priorityMicroLamports: Number(process.env.PRIORITY_MICRO_LAMPORTS || 3000000),

  // detection cadence
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 1500),

  // endpoints: every one is an independent send budget
  endpoints: {
    helius: secret('helius_key') ? `https://mainnet.helius-rpc.com/?api-key=${secret('helius_key')}` : null,
    heliusPrev: secret('helius_key.prev') ? `https://mainnet.helius-rpc.com/?api-key=${secret('helius_key.prev')}` : null,
    quicknode: secret('quicknode_sol_url'),
    alchemy: (secret('NEW_ALCHEMY_KEY') || process.env.NEW_ALCHEMY_KEY)
      ? `https://solana-mainnet.g.alchemy.com/v2/${secret('NEW_ALCHEMY_KEY') || process.env.NEW_ALCHEMY_KEY}` : null,
    public: process.env.PUBLIC_RPC || 'https://api.mainnet-beta.solana.com',
  },

  telegram: {
    token: secret('telegram_bot_token') || process.env.TELEGRAM_BOT_TOKEN || null,
    chat: process.env.TELEGRAM_CHAT || null,
  },
};

function endpointList() {
  return Object.entries(config.endpoints)
    .filter(([, url]) => Boolean(url))
    .map(([name, url]) => ({ name, url }));
}

module.exports = { config, endpointList, secret };
