# compromised-wallet-rescue

When a seed phrase leaks, a bot usually gets there first: it watches the address, tops it up
with a little gas, and moves every arriving token out within seconds. This is a small,
tested toolkit for the one thing that is still winnable — **rescuing tokens that arrive after
the leak**.

It does not recover anything already taken. Nothing can.

## How the rescue works

The part people get wrong is funding. If you send SOL to the drained wallet so it can move its
own tokens, the sweeper takes that gas first.

So the transaction has **two signers**:

| role | wallet | why |
|---|---|---|
| authority | the compromised key | it is the authority on the token account; nothing replaces this |
| fee payer | a **clean** wallet you control | pays the network, so nothing ever sits in the swept wallet |

The destination token account is created idempotently inside the same transaction, so the whole
rescue is a single send. The signed bytes are then fired at **every configured endpoint at once**
and the first acceptance wins — re-sending is safe, because a transaction is identified by its
signature, so it raises the odds of reaching a leader first without any double-spend risk.

## Install

```bash
git clone https://github.com/<you>/compromised-wallet-rescue.git
cd compromised-wallet-rescue
npm install
cp .env.example .env      # set VICTIM and DESTINATION
```

Secrets are read from files under `SECRETS_DIR` (default `~/.hermes/.secrets`), never from the
environment, so they cannot leak through `ps` or a log line:

```
~/.hermes/.secrets/helius_key          # RPC
~/.hermes/.secrets/helius_key.prev     # optional, a second independent quota
~/.hermes/.secrets/quicknode_sol_url   # optional
~/.hermes/.secrets/NEW_ALCHEMY_KEY     # optional
~/.hermes/.secrets/quarantine/dead_sol_keypair.json   # the compromised keypair, 0600
```

Every endpoint you configure is a separate send budget, so more of them means more chances of
landing first. One is enough to work; five is better.

## Use

```bash
npm run test       # show balances, endpoints, tokens held
npm run auto       # watch and rescue every arrival
npm run watch      # read-only watcher with timestamps, no signing
npm run selftest   # prove the path works with a throwaway token
npm run verify     # syntax + secret scan; run before every commit
```

## Measure before you promise anything

`npm run watch` records both arrivals and departures with timestamps. That gap is the answer to
"can this be won":

- an observed **17 second** window is comfortably actionable
- an observed **+0 second** window is not, and no amount of endpoint tuning fixes it

Both turn up on the same wallet. Report the measurement, not an opinion.

## Prove it, then trust it

An untested rescue is a stub. `npm run selftest` creates a throwaway SPL token, mints units
straight into the compromised address, and lets the bot try to move them. Measured on this
setup: **arrival to rescued in ~1.1 s, accepted by all five endpoints**. Then burn and close the
accounts to reclaim the rent; the test costs cents.

## Derivation gotcha

Solana derivation libraries disagree. Standard SLIP-0010 `m/44'/501'/i'/0'` is what Phantom
shows; some wrappers produce a different key for the same path. Funding an address your code
cannot sign for is the most expensive mistake here — **derive with the same library you sign
with, and check the address before sending money to it**.

## Running it as a service

Background processes die with a shell session. Add a keepalive on a short cron interval; it
starts only what is down:

```cron
*/3 * * * * /path/to/compromised-wallet-rescue/scripts/keepalive.sh >/dev/null 2>&1
```

Keep both detectors. In practice the websocket `logsSubscribe` fired nothing on a transfer into
the watched address while the poll caught it — the socket is a bonus, the poll is the mechanism.

## Limits, stated plainly

- Only arrivals from now on. Everything already moved is gone.
- Only the slow sweeps. Anything taken in the same slot is unwinnable.
- The compromised key must be available locally to sign. That key is already in someone else's
  hands; the file does not make it worse, but treat the host as untrusted and rotate anything
  else derived from the same phrase.

## License

MIT
