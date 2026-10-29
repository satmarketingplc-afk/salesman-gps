#!/usr/bin/env node
/**
 * Configures the bot side (run once, and again if the token rotates):
 *   - menu button  -> the customer Mini App
 *   - /start, /help -> command list
 *   - short description + description -> shown on first open
 *
 *   TELEGRAM_BOT_TOKEN=... node scripts/set_bot_menu.mjs
 */
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MENU_URL = process.env.MENU_URL || "https://satmarketingplc-afk.github.io/salesman-gps/app/customer/";
const MENU_TEXT = process.env.MENU_TEXT || "New customer";

if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}

const call = async (method, payload, attempt = 1) => {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.json().catch(() => ({}));
    console.log(`${method}: ${body.ok ? "ok" : JSON.stringify(body)}`);
    return body.ok;
  } catch (err) {
    if (attempt < 3) {
      console.warn(`${method}: ${err.message} — retry ${attempt}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      return call(method, payload, attempt + 1);
    }
    console.error(`${method}: ${err.message}`);
    return false;
  }
};

const short = "Live location + customer cards for the SAT sales team.";
const description = [
  "Share live location: 📎 → Location → Share Live Location → 8 hours. The office sees you on the map.",
  "New customer: tap the menu button, fill the card, save — it lands in the encrypted office archive.",
  "",
  "ቀጥታ አካባቢ ያጋሩ: 📎 → አካባቢ → ቀጥታ አካባቢ → 8 ሰዓት።",
  "አዲስ ደንበኛ: የምናሌውን ቁልፍ ይጫኑ፣ ካርዱን ሞልተው ያስቀምጡ።",
].join("\n");

const results = [];
results.push(await call("setChatMenuButton", {
  menu_button: { type: "web_app", text: MENU_TEXT, web_app: { url: MENU_URL } },
}));
results.push(await call("setMyCommands", {
  commands: [
    { command: "start", description: "Welcome · እንኳን ደህና መጡ" },
    { command: "help", description: "How to use · እንዴት እንደሚጠቀሙ" },
    { command: "join", description: "Link your account · ታገናኙ (SM-001)" },
    { command: "pin", description: "Pin this spot on the map · አካባቢ ይመልክቱ" },
    { command: "unpin", description: "Remove my pins · ማስታወሻዎችን ያጥፉ" },
  ],
}));
results.push(await call("setMyShortDescription", { short_description: short }));
results.push(await call("setMyDescription", { description }));

process.exit(results.every(Boolean) ? 0 : 1);
