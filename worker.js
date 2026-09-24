export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response("IDFLIX Telegram Bot Worker aktif.", {
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let update;
    try {
      update = await request.json();
    } catch (error) {
      console.error("Invalid Telegram update:", error);
      return new Response("Bad Request", { status: 400 });
    }

    try {
      const message = update?.message;
      if (!message) return new Response("OK");

      const chatId = message.chat?.id;
      if (!chatId || !env.BOT_TOKEN) {
        console.error("Missing chatId or BOT_TOKEN");
        return new Response("OK");
      }

      const text = String(message.text || "").trim();

      if (text === "/id" || text.startsWith("/id@")) {
        await sendTelegram(
          env.BOT_TOKEN,
          chatId,
          `Telegram ID kamu: ${chatId}`
        );
        return new Response("OK");
      }

      if (text === "/start" || text.startsWith("/start@")) {
        await sendTelegram(
          env.BOT_TOKEN,
          chatId,
          "🎬 IDFLIX Bot aktif.\n\n/id — melihat Telegram ID\n/ping — tes koneksi admin"
        );
        return new Response("OK");
      }

      if (text === "/ping" || text.startsWith("/ping@")) {
        if (!isAdmin(chatId, env.ADMIN_IDS)) {
          await sendTelegram(env.BOT_TOKEN, chatId, "⛔ Kamu bukan admin.");
          return new Response("OK");
        }

        await sendTelegram(
          env.BOT_TOKEN,
          chatId,
          "✅ IDFLIX Bot aktif dan webhook berjalan."
        );
        return new Response("OK");
      }

      const isVideo = Boolean(message.video || message.document);
      if (isVideo) {
        if (!isAdmin(chatId, env.ADMIN_IDS)) {
          await sendTelegram(
            env.BOT_TOKEN,
            chatId,
            "⛔ Hanya admin yang dapat mengirim video."
          );
          return new Response("OK");
        }

        await sendTelegram(
          env.BOT_TOKEN,
          chatId,
          "✅ Video diterima.\n\nIntegrasi Firebase akan ditambahkan pada Step 2."
        );
        return new Response("OK");
      }

      return new Response("OK");
    } catch (error) {
      console.error("Webhook error:", error);
      return new Response("OK");
    }
  }
};

function isAdmin(chatId, adminIds) {
  const ids = String(adminIds || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return ids.includes(String(chatId));
}

async function sendTelegram(token, chatId, text) {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text
      })
    }
  );

  const result = await response.text();

  if (!response.ok) {
    console.error("Telegram API error:", response.status, result);
  } else {
    console.log("Telegram API success:", result);
  }
}
