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
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const message = update?.message;
    if (!message) return new Response("OK");

    const chatId = message.chat?.id;
    const text = String(message.text || "").trim();

    // Basic commands
    if (text === "/id") {
      await sendTelegram(env.BOT_TOKEN, chatId, `Telegram ID kamu: ${chatId}`);
      return new Response("OK");
    }

    if (text === "/idgrup") {
      const title = message.chat?.title || "(bukan grup)";
      await sendTelegram(
        env.BOT_TOKEN,
        chatId,
        `🆔 Chat ID: ${chatId}\n📌 Nama: ${title}`
      );
      return new Response("OK");
    }

    if (text === "/start") {
      await sendTelegram(
        env.BOT_TOKEN,
        chatId,
        "🎬 IDFLIX Bot aktif.\\n\\n/id — melihat Telegram ID\\n/idgrup — melihat Chat ID\\n/ping — tes admin"
      );
      return new Response("OK");
    }

    if (text === "/ping") {
      if (!isAdmin(chatId, env.ADMIN_IDS)) {
        await sendTelegram(env.BOT_TOKEN, chatId, "⛔ Kamu bukan admin.");
        return new Response("OK");
      }

      await sendTelegram(env.BOT_TOKEN, chatId, "✅ IDFLIX Bot aktif dan webhook berjalan.");
      return new Response("OK");
    }

    // This stage expects movie uploads to be sent privately to the bot by an admin.
    const media = getMovieMedia(message);
    if (media) {
      if (!isAdmin(chatId, env.ADMIN_IDS)) {
        await sendTelegram(env.BOT_TOKEN, chatId, "⛔ Hanya admin yang dapat mengupload film.");
        return new Response("OK");
      }

      const groupId = String(env.IDFLIX_GROUP_ID || "").trim();
      if (!groupId) {
        await sendTelegram(
          env.BOT_TOKEN,
          chatId,
          "⚠️ IDFLIX_GROUP_ID belum dikonfigurasi di Cloudflare."
        );
        return new Response("OK");
      }

      if (!env.TOPIC_KV) {
        await sendTelegram(
          env.BOT_TOKEN,
          chatId,
          "⚠️ TOPIC_KV belum dikonfigurasi di Cloudflare. Buat KV namespace lalu bind dengan nama TOPIC_KV."
        );
        return new Response("OK");
      }

      const parsed = parseMovieCaption(
        String(message.caption || media.fileName || "").trim()
      );

      if (!parsed.title || parsed.genres.length === 0) {
        await sendTelegram(
          env.BOT_TOKEN,
          chatId,
          "⚠️ Format film belum terbaca.\\n\\nGunakan:\\nJudul | Tahun | Genre1, Genre2 | Durasi | Rating | Deskripsi"
        );
        return new Response("OK");
      }

      const normalizedGenres = unique(
        parsed.genres.map(normalizeGenre).filter(Boolean)
      );

      if (normalizedGenres.length === 0) {
        await sendTelegram(env.BOT_TOKEN, chatId, "⚠️ Genre film tidak ditemukan.");
        return new Response("OK");
      }

      const results = [];

      for (const genre of normalizedGenres) {
        try {
          const topic = await getOrCreateTopic(env, groupId, genre);
          if (!topic?.message_thread_id) {
            results.push(`❌ ${genre}: topic tidak tersedia`);
            continue;
          }

          const copy = await telegramApi(env.BOT_TOKEN, "copyMessage", {
            chat_id: groupId,
            from_chat_id: chatId,
            message_id: message.message_id,
            message_thread_id: topic.message_thread_id
          });

          if (!copy.ok) {
            results.push(`❌ ${genre}: ${copy.description || "gagal posting"}`);
          } else {
            results.push(`✅ ${genre}`);
          }
        } catch (error) {
          console.error("Genre processing error:", error);
          results.push(`❌ ${genre}: ${error.message || "error"}`);
        }
      }

      await sendTelegram(
        env.BOT_TOKEN,
        chatId,
        `🎬 ${parsed.title}${parsed.year ? ` (${parsed.year})` : ""}\\n\\n` +
        results.join("\\n")
      );

      return new Response("OK");
    }

    return new Response("OK");
  }
};

function getMovieMedia(message) {
  if (message.video) {
    return {
      type: "video",
      fileId: message.video.file_id,
      fileName: message.video.file_name || ""
    };
  }

  if (message.document) {
    const mime = String(message.document.mime_type || "");
    const fileName = String(message.document.file_name || "");
    const looksLikeVideo =
      mime.startsWith("video/") ||
      /\.(mp4|mkv|webm|mov|avi|m4v)$/i.test(fileName);

    if (looksLikeVideo) {
      return {
        type: "document",
        fileId: message.document.file_id,
        fileName
      };
    }
  }

  return null;
}

function parseMovieCaption(input) {
  const parts = input
    .split("|")
    .map(v => v.trim());

  if (parts.length < 3) {
    return {
      title: input.trim(),
      year: "",
      genres: []
    };
  }

  return {
    title: parts[0],
    year: parts[1] || "",
    genres: parts[2]
      .split(",")
      .map(v => v.trim())
      .filter(Boolean),
    duration: parts[3] || "",
    rating: parts[4] || "",
    description: parts.slice(5).join(" | ").trim()
  };
}

function normalizeGenre(value) {
  const raw = String(value || "").trim().replace(/\s+/g, " ");
  if (!raw) return "";

  const aliases = {
    "sci fi": "Sci-Fi",
    "sci-fi": "Sci-Fi",
    "science fiction": "Sci-Fi",
    "action": "Action",
    "adventure": "Adventure",
    "animation": "Animation",
    "comedy": "Comedy",
    "crime": "Crime",
    "documentary": "Documentary",
    "drama": "Drama",
    "family": "Family",
    "fantasy": "Fantasy",
    "horror": "Horror",
    "mystery": "Mystery",
    "romance": "Romance",
    "thriller": "Thriller",
    "war": "War",
    "western": "Western",
    "music": "Music",
    "history": "History",
    "biography": "Biography",
    "musical": "Musical",
    "sport": "Sport",
    "sports": "Sport"
  };

  return aliases[raw.toLowerCase()] || titleCase(raw);
}

function titleCase(value) {
  return value
    .toLowerCase()
    .split(" ")
    .map(word => word ? word[0].toUpperCase() + word.slice(1) : word)
    .join(" ");
}

async function getOrCreateTopic(env, groupId, genre) {
  const key = `topic:${groupId}:${genre.toLowerCase()}`;
  const cached = await env.TOPIC_KV.get(key, "json");

  if (cached?.message_thread_id) {
    return cached;
  }

  const created = await telegramApi(env.BOT_TOKEN, "createForumTopic", {
    chat_id: groupId,
    name: genre,
    icon_color: iconColorForGenre(genre)
  });

  if (!created.ok) {
    throw new Error(created.description || "Gagal membuat topic");
  }

  const topic = created.result;

  await env.TOPIC_KV.put(
    key,
    JSON.stringify({
      message_thread_id: topic.message_thread_id,
      name: genre
    })
  );

  return topic;
}

function iconColorForGenre(genre) {
  const colors = {
    "Action": 16749490,
    "Adventure": 9367192,
    "Animation": 16766590,
    "Comedy": 16766590,
    "Crime": 13338331,
    "Documentary": 9367192,
    "Drama": 13338331,
    "Family": 16766590,
    "Fantasy": 13338331,
    "Horror": 16478047,
    "Mystery": 13338331,
    "Romance": 16766590,
    "Sci-Fi": 7322096,
    "Thriller": 16478047,
    "War": 16478047,
    "Western": 9367192
  };

  return colors[genre] || 7322096;
}

async function telegramApi(token, method, payload) {
  if (!token) {
    throw new Error("BOT_TOKEN belum dikonfigurasi");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({
    ok: false,
    description: "Respons Telegram bukan JSON"
  }));

  if (!response.ok) {
    console.error(`Telegram HTTP ${response.status}:`, data);
  }

  return data;
}

async function sendTelegram(token, chatId, text) {
  try {
    const result = await telegramApi(token, "sendMessage", {
      chat_id: chatId,
      text
    });

    if (!result.ok) {
      console.error("sendMessage failed:", result.description);
    }
  } catch (error) {
    console.error("sendTelegram error:", error);
  }
}

function isAdmin(chatId, adminIds) {
  const ids = String(adminIds || "")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);

  return ids.includes(String(chatId));
}

function unique(items) {
  return [...new Set(items)];
}
