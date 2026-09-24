export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET") return new Response("IDFLIX Telegram Bot Worker aktif.", {headers:{"content-type":"text/plain; charset=utf-8"}});
    if (request.method !== "POST") return new Response("Method Not Allowed", {status:405});
    let update; try { update = await request.json(); } catch { return new Response("Bad Request", {status:400}); }
    const message = update?.message; if (!message) return new Response("OK");
    const chatId = message.chat?.id, text = String(message.text || "").trim();
    if (text === "/id") { await sendTelegram(env.BOT_TOKEN, chatId, `Telegram ID kamu: ${chatId}`); return new Response("OK"); }
    if (text === "/start") { await sendTelegram(env.BOT_TOKEN, chatId, "🎬 IDFLIX Bot aktif.\n\n/id — melihat Telegram ID\n/ping — tes koneksi admin"); return new Response("OK"); }
    if (text === "/ping") { if (!isAdmin(chatId, env.ADMIN_IDS)) await sendTelegram(env.BOT_TOKEN, chatId, "⛔ Kamu bukan admin."); else await sendTelegram(env.BOT_TOKEN, chatId, "✅ IDFLIX Bot aktif dan webhook berjalan."); return new Response("OK"); }
    if (message.video || message.document) { if (!isAdmin(chatId, env.ADMIN_IDS)) await sendTelegram(env.BOT_TOKEN, chatId, "⛔ Hanya admin yang dapat mengirim video."); else await sendTelegram(env.BOT_TOKEN, chatId, "✅ Video diterima.\n\nIntegrasi Firebase akan ditambahkan pada Step 2."); return new Response("OK"); }
    return new Response("OK");
  }
};
function isAdmin(chatId, adminIds) { return String(adminIds || "").split(",").map(v=>v.trim()).filter(Boolean).includes(String(chatId)); }
async function sendTelegram(token, chatId, text) { if (!token || !chatId) return; const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text})}); if(!r.ok) console.error("Telegram API error:",await r.text()); }
