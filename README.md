# Telebirr Verifier Bot

A Telegram bot that verifies Telebirr payment SMS messages against Ethio
Telecom's official receipt page (`https://transactioninfo.ethiotelecom.et/receipt/{txid}`),
so you can't be fooled by a fake or edited "payment received" screenshot/text.

## How it works

1. User sends `/start`.
2. Bot asks them to paste the full Telebirr SMS.
3. Bot extracts the transaction number(s) (`txid`) from the text with regex.
4. For each `txid`, the bot fetches the real Ethio Telecom receipt page and
   checks whether it mentions your target name/account and the same amount.
5. Bot replies ✅ VERIFIED or ❌ NOT VERIFIED with details.

## Local setup

```bash
cd telebirr-verifier-bot
npm install
cp .env.example .env
# edit .env and set BOT_TOKEN, TARGET_NAME, TARGET_ACCOUNT
npm start
```

## Deploying on Render

1. Push this folder to a GitHub repo.
2. In Render, create a **New Web Service** from that repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Environment:** Node
4. Add environment variables in the Render dashboard:
   - `BOT_TOKEN` — from [@BotFather](https://t.me/BotFather)
   - `TARGET_NAME` — e.g. `Yonatan`
   - `TARGET_ACCOUNT` — e.g. `0940072277`
   - Render sets `PORT` automatically, you don't need to add it.
5. Deploy. Render will give you a URL like `https://your-app.onrender.com` —
   this is just for the health check; the bot itself works over Telegram
   long polling, no webhook needed.

**Note on Render's free tier:** free web services spin down after ~15 minutes
of no HTTP traffic, which will also pause the bot. Either use a paid instance,
or ping the `/health` endpoint every few minutes with an external uptime
monitor (e.g. UptimeRobot, cron-job.org) to keep it awake.

## Important caveats (please read before relying on this in production)

- **The receipt page's exact layout is not officially documented and can
  change at any time.** This bot verifies by checking whether your name and
  account number appear anywhere in the receipt page's text — this is more
  resilient to layout changes than scraping specific HTML elements, but you
  should test it against a handful of real transactions before trusting it
  for real money decisions.
- **TLS certificate quirk:** `transactioninfo.ethiotelecom.et` is known to
  serve a certificate chain that fails default Node.js verification. The
  code disables certificate verification, but *only* for requests to this
  one specific host (via a scoped `https.Agent`) — not process-wide — to
  limit the security exposure. If Ethio Telecom fixes their cert, you can
  safely remove that agent.
- **Rate limiting:** if you expect high transaction volume, add delays or a
  queue between receipt lookups to avoid Ethio Telecom rate-limiting or
  blocking your server's IP.
- Always keep `BOT_TOKEN` secret — never commit `.env` to git.
