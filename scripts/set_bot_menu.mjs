#!/usr/bin/env node
/**
 * Points the bot's menu button at the customer Mini App.
 * Run once per bot (and again if the token rotates or Pages URL changes).
 *
 *   TELEGRAM_BOT_TOKEN=... node scripts/set_bot_menu.mjs
 *   MENU_URL / MENU_TEXT override the defaults.
 */
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MENU_URL = process.env.MENU_URL || "https://satmarketingplc-afk.github.io/salesman-gps/app/customer/";
const MENU_TEXT = process.env.MENU_TEXT || "New customer";

if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${TOKEN}/setChatMenuButton`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    menu_button: { type: "web_app", text: MENU_TEXT, web_app: { url: MENU_URL } },
  }),
});
const body = await res.json().catch(() => ({}));
console.log(body);
process.exit(body.ok ? 0 : 1);
