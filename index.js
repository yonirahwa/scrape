require('dotenv').config();

const express = require('express');
const axios = require('axios');
const https = require('https');
const cheerio = require('cheerio');
const { Telegraf } = require('telegraf');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const TARGET_NAME = process.env.TARGET_NAME || 'Yonatan';
const TARGET_ACCOUNT = process.env.TARGET_ACCOUNT || '0940072277';
const PORT = process.env.PORT || 3000;
const RECEIPT_BASE_URL = 'https://transactioninfo.ethiotelecom.et/receipt';

if (!BOT_TOKEN) {
  console.error('FATAL: BOT_TOKEN environment variable is missing.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// The Ethio Telecom receipt host is known to serve a certificate chain that
// Node's default TLS verifier rejects (UNABLE_TO_VERIFY_LEAF_SIGNATURE).
// We scope the relaxed verification to ONLY this specific https.Agent
// instance (used only for requests to this one host) instead of disabling
// TLS verification process-wide, which would be far more dangerous.
const receiptAgent = new https.Agent({ rejectUnauthorized: false });

// ---------------------------------------------------------------------------
// Parsing the pasted Telebirr SMS text
// ---------------------------------------------------------------------------
// Matches blocks like:
// "Dear Yonatan
//  You have received ETB 500.00 from Natnael Hailesilassie(2519****4586)  on 06/07/2026 14:29:07.
//  Your transaction number is DG69L8TR6X. Your current E-Money Account balance is ETB 1,377.94."
const FULL_MESSAGE_REGEX =
  /Dear\s+([^\n]+?)\s*\n\s*You have received ETB\s*([\d,]+\.\d{2})\s*from\s+(.+?)\((\+?[\d*]+)\)\s*on\s*([\d/]{6,10}\s+[\d:]{5,8})\.\s*Your transaction number is\s*([A-Za-z0-9]+)\.\s*Your current E-Money Account balance is ETB\s*([\d,]+\.\d{2})/g;

// Fallback: just grab the transaction number if the message text is slightly
// different / reformatted (e.g. forwarded, extra whitespace, missing lines).
const TXID_ONLY_REGEX = /transaction number is\s*([A-Za-z0-9]{6,15})/gi;

function parsePastedText(text) {
  const results = [];
  const seen = new Set();

  FULL_MESSAGE_REGEX.lastIndex = 0;
  let match;
  while ((match = FULL_MESSAGE_REGEX.exec(text)) !== null) {
    const txid = match[6].trim();
    seen.add(txid);
    results.push({
      recipientName: match[1].trim(),
      amount: match[2].trim(),
      senderName: match[3].trim(),
      senderPhone: match[4].trim(),
      date: match[5].trim(),
      txid,
      balance: match[7].trim(),
    });
  }

  // Catch any transaction numbers the full-message regex missed
  TXID_ONLY_REGEX.lastIndex = 0;
  let idMatch;
  while ((idMatch = TXID_ONLY_REGEX.exec(text)) !== null) {
    const txid = idMatch[1].trim();
    if (!seen.has(txid)) {
      seen.add(txid);
      results.push({ txid });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Fetching + verifying against Ethio Telecom's receipt page
// ---------------------------------------------------------------------------
async function fetchReceiptText(txid) {
  const url = `${RECEIPT_BASE_URL}/${encodeURIComponent(txid)}`;
  const response = await axios.get(url, {
    httpsAgent: receiptAgent,
    timeout: 15000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    },
    validateStatus: (status) => status < 500,
  });

  if (response.status === 404) {
    throw new Error('Transaction not found (invalid or unrecognized transaction number).');
  }
  if (response.status >= 400) {
    throw new Error(`Receipt server returned status ${response.status}.`);
  }

  const $ = cheerio.load(response.data);
  return $('body').text().replace(/\s+/g, ' ').trim();
}

function normalizeDigits(str) {
  return (str || '').replace(/\D/g, '');
}

function verifyReceipt(receiptText, parsed) {
  const lowerText = receiptText.toLowerCase();

  const accountDigits = normalizeDigits(TARGET_ACCOUNT); // e.g. 0940072277
  const altCountryCodeAccount = '251' + accountDigits.replace(/^0/, ''); // e.g. 251940072277
  const shortAccount = accountDigits.replace(/^0/, ''); // e.g. 940072277

  const nameMatch = lowerText.includes(TARGET_NAME.toLowerCase());
  const accountMatch =
    lowerText.includes(accountDigits) ||
    lowerText.includes(altCountryCodeAccount) ||
    lowerText.includes(shortAccount);

  let amountMatch = true;
  if (parsed && parsed.amount) {
    const plainAmount = parsed.amount.replace(/,/g, '');
    amountMatch = receiptText.includes(parsed.amount) || receiptText.includes(plainAmount);
  }

  return {
    nameMatch,
    accountMatch,
    amountMatch,
    verified: nameMatch && accountMatch && amountMatch,
  };
}

// ---------------------------------------------------------------------------
// Telegram bot
// ---------------------------------------------------------------------------
bot.start((ctx) => {
  ctx.reply(
    "👋 Welcome to the Telebirr Payment Verifier.\n\n" +
      "When you receive a payment, copy the *full* Telebirr SMS message and paste it here.\n\n" +
      "I'll pull out the transaction number, check it against Ethio Telecom's official " +
      `receipt page, and confirm whether the payment actually went to your account (${TARGET_NAME}, ${TARGET_ACCOUNT}).`,
    { parse_mode: 'Markdown' }
  );
});

bot.help((ctx) => {
  ctx.reply('Just paste the full Telebirr SMS text you received. I will verify it automatically.');
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;

  const parsedList = parsePastedText(text);

  if (parsedList.length === 0) {
    return ctx.reply(
      "⚠️ I couldn't find a transaction number in that message.\n" +
        'Please paste the full Telebirr SMS exactly as you received it.'
    );
  }

  await ctx.reply(
    `🔍 Found ${parsedList.length} transaction${parsedList.length > 1 ? 's' : ''}. Checking with Ethio Telecom...`
  );

  for (const parsed of parsedList) {
    try {
      const receiptText = await fetchReceiptText(parsed.txid);
      const result = verifyReceipt(receiptText, parsed);

      let reply = `📄 *Transaction:* \`${parsed.txid}\`\n`;
      if (parsed.amount) reply += `💰 *Amount:* ETB ${parsed.amount}\n`;
      if (parsed.senderName) reply += `👤 *From:* ${parsed.senderName}\n`;
      if (parsed.date) reply += `📅 *Date:* ${parsed.date}\n`;
      reply += '\n';

      if (result.verified) {
        reply += `✅ *VERIFIED*\nConfirmed on Ethio Telecom's official receipt as paid to *${TARGET_NAME}* (${TARGET_ACCOUNT}).`;
      } else {
        reply += '❌ *NOT VERIFIED*\n';
        if (!result.nameMatch) reply += `• Receiver name "${TARGET_NAME}" not found on receipt.\n`;
        if (!result.accountMatch) reply += `• Receiver account "${TARGET_ACCOUNT}" not found on receipt.\n`;
        if (!result.amountMatch) reply += '• Amount does not match the receipt.\n';
        reply += '\n⚠️ Do not release goods/services based on this message alone.';
      }

      await ctx.reply(reply, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error(`Verification error for ${parsed.txid}:`, err.message);
      await ctx.reply(
        `⚠️ Couldn't verify transaction \`${parsed.txid}\`.\n` +
          `Reason: ${err.message}\n\n` +
          'This can happen if the transaction number is wrong, the receipt has expired, ' +
          "or Ethio Telecom's server is temporarily unavailable. Try again in a few minutes.",
        { parse_mode: 'Markdown' }
      );
    }
  }
});

bot.catch((err) => {
  console.error('Unhandled bot error:', err);
});

// ---------------------------------------------------------------------------
// Web server (required by Render for a Web Service, also doubles as a
// health check / uptime-monitor endpoint)
// ---------------------------------------------------------------------------
const app = express();

app.get('/', (req, res) => {
  res.status(200).send('Telebirr Verifier Bot is running.');
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

bot
  .launch()
  .then(() => console.log('Telegram bot started (long polling).'))
  .catch((err) => {
    console.error('Failed to start bot:', err);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
