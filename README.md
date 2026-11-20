# FairLaunch Studio

Independent GIWA Sepolia launchpad and trading application using Ammora SDK 0.3.9. This is a second participant's DevNet Builder project, separate from Pulse Launch Scout. It is preparing for Ammora Season 2 Builder Mission review; no submission has been made.

## Local run

Node 22 or 24: `npm install --ignore-scripts`, then `npm run dev`. Open `/create` and use **Use approved FLTEST details** for the reviewed test launch. Config #63 is the confirmed on-chain Config A. The screen performs a read-only FLTEST review before the separate manual wallet action. First-buy is disabled for FLTEST. Its exact metadata URL is `https://bittimesofficial.github.io/fairlaunch-token-metadata/metadata/v1/FLTEST.json` (SHA-256 `c8421af3a27fb87c1d29196a1039783062b1cd2c9da0f467b55be6c8c3a56d2e`). The server never signs. Only GIWA Sepolia (91342) is supported.

The production release is scoped to the already launched FLTEST token. Its catalog entry is derived from the canonical Factory receipt; the pinned external metadata URI needs no serverless write. Production disables new token creation and local metadata endpoints. General user-created metadata would require durable shared storage before it can be enabled.

## Trust boundaries

The catalog accepts the canonical FLTEST Factory launch event after at least 12 confirmations. Config #63 and the FLTEST launch, Wrap, Buy and Sell have live receipts recorded in project evidence. Hosted RPC and public pages still require checks at the actual deployment URL. See `PROJECT_STATUS.md` for the latest release evidence and limits.
