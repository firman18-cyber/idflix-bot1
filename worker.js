const GENRES = [
  ["action", "Action"], ["adventure", "Adventure"],
  ["animation", "Animation"], ["comedy", "Comedy"],
  ["crime", "Crime"], ["documentary", "Documentary"],
  ["drama", "Drama"], ["family", "Family"],
  ["fantasy", "Fantasy"], ["horror", "Horror"],
  ["mystery", "Mystery"], ["romance", "Romance"],
  ["scifi", "Sci-Fi"], ["thriller", "Thriller"],
  ["war", "War"], ["western", "Western"]
];

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" }
});

function isAdmin(user, env) {
  const ids = String(env.ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
  return ids.includes(String(user?.id || ""));
}

async function telegram(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description || "Telegram API error"}`);
  return data.result;
}

async function sendMessage(env, chatId, text, extra = {}) {
  return telegram(env, "sendMessage", { chat_id: chatId, text, ...extra });
}

async function editMessage(env, chatId, messageId, text, extra = {}) {
  return telegram(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...extra
  });
}

async function answerCallback(env, callbackQueryId, text = "") {
  return telegram(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {})
  });
}

function keySession(chatId) {
  return `session:${chatId}`;
}

function keyTopic(genreKey) {
  return `genre:${genreKey}`;
}

function keyMovie(id) {
  return `movie:${id}`;
}

async function getSession(env, chatId) {
  if (!env.TOPIC_KV) return null;
  const raw = await env.TOPIC_KV.get(keySession(chatId));
  return raw ? JSON.parse(raw) : null;
}

async function putSession(env, chatId, session) {
  if (!env.TOPIC_KV) throw new Error("TOPIC_KV belum terpasang.");
  await env.TOPIC_KV.put(keySession(chatId), JSON.stringify(session), { expirationTtl: 86400 });
}

async function deleteSession(env, chatId) {
  if (env.TOPIC_KV) await env.TOPIC_KV.delete(keySession(chatId));
}

function genreName(key) {
  return GENRES.find(([k]) => k === key)?.[1] || key;
}

function genreKeyboard(selected = []) {
  const rows = [];
  for (let i = 0; i < GENRES.length; i += 2) {
    rows.push(GENRES.slice(i, i + 2).map(([key, label]) => ({
      text: selected.includes(key) ? `☑️ ${label}` : `☐ ${label}`,
      callback_data: `genre:${key}`
    })));
  }
  rows.push([{ text: "✅ Selesai", callback_data: "genre:done" }]);
  return { inline_keyboard: rows };
}

function selectedGenreText(selected) {
  return selected.length
    ? selected.map(genreName).join(", ")
    : "Belum ada";
}

async function showGenreMenu(env, chatId, messageId, selected) {
  const text = [
    "🎭 PILIH GENRE FILM",
    "",
    "Pilih satu atau beberapa genre.",
    "Genre yang dipilih akan ditandai dengan ☑️",
    "",
    `Terpilih: ${selectedGenreText(selected)}`
  ].join("\n");

  return editMessage(env, chatId, messageId, text, {
    reply_markup: genreKeyboard(selected)
  });
}

async function startSave(env, chatId, title, userId) {
  if (!env.TOPIC_KV) {
    await sendMessage(env, chatId, "⚠️ TOPIC_KV belum tersedia di Worker.");
    return;
  }

  const cleanTitle = String(title || "").trim();
  const session = {
    ownerId: String(userId),
    step: cleanTitle ? "video" : "title",
    title: cleanTitle,
    genres: [],
    year: "",
    rating: "",
    duration: "",
    description: "",
    video: null,
    sourceChatId: null,
    sourceMessageId: null,
    createdAt: Date.now()
  };

  await putSession(env, chatId, session);

  if (!cleanTitle) {
    await sendMessage(env, chatId, "🎬 MASUKKAN JUDUL FILM\n\nContoh: Interstellar\n\nKetik /batal untuk membatalkan.");
    return;
  }

  await sendMessage(env, chatId, `🎬 Judul: ${cleanTitle}\n\n📹 Sekarang kirim video filmnya.\n\nKetik /batal untuk membatalkan.`);
}

async function processVideo(env, msg, session) {
  const file = msg.video || msg.document;
  if (msg.document && !(file.mime_type || "").startsWith("video/")) {
    await sendMessage(env, msg.chat.id, "⚠️ File tersebut bukan video. Kirim video atau dokumen video.");
    return;
  }

  session.video = {
    fileId: file.file_id,
    fileUniqueId: file.file_unique_id || "",
    duration: file.duration || 0,
    width: file.width || 0,
    height: file.height || 0,
    fileSize: file.file_size || 0
  };
  session.sourceChatId = msg.chat.id;
  session.sourceMessageId = msg.message_id;
  if (!session.title && msg.caption) session.title = msg.caption.trim();
  if (!session.title) {
    session.step = "title";
    await putSession(env, msg.chat.id, session);
    await sendMessage(env, msg.chat.id, "🎬 Judul belum ada. Kirim judul film sekarang.");
    return;
  }

  session.step = "year";
  await putSession(env, msg.chat.id, session);
  await sendMessage(env, msg.chat.id, `✅ Video berhasil dibaca.\n\n🎬 Judul: ${session.title}\n📂 Jenis: ${msg.video ? "video" : "document video"}\n🆔 Message ID: ${msg.message_id}\n\n📅 Masukkan tahun rilis film.\nContoh: 2014`);
}

async function showConfirm(env, chatId, session) {
  const genres = session.genres.map(genreName).join(", ");
  const text = [
    "📋 KONFIRMASI FILM",
    "",
    `🎬 Judul: ${session.title}`,
    `📅 Tahun: ${session.year}`,
    `🎭 Genre: ${genres}`,
    `⭐ Rating: ${session.rating}/10`,
    `⏱️ Durasi: ${session.duration}`,
    `📝 Deskripsi: ${session.description || "-"}`,
    "",
    "Semua data sudah benar?"
  ].join("\n");

  await sendMessage(env, chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Simpan", callback_data: "confirm:save" }],
        [{ text: "✏️ Ubah Genre", callback_data: "confirm:genre" }],
        [{ text: "❌ Batal", callback_data: "confirm:cancel" }]
      ]
    }
  });
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "film";
}

async function getOrCreateTopic(env, genreKey) {
  const cached = await env.TOPIC_KV.get(keyTopic(genreKey));
  if (cached) return Number(cached);

  if (!env.IDFLIX_GROUP_ID) throw new Error("IDFLIX_GROUP_ID belum diatur.");

  const topic = await telegram(env, "createForumTopic", {
    chat_id: env.IDFLIX_GROUP_ID,
    name: genreName(genreKey),
    icon_color: 7322096
  });

  const threadId = topic.message_thread_id;
  await env.TOPIC_KV.put(keyTopic(genreKey), String(threadId));
  return Number(threadId);
}

async function finalizeSave(env, chatId, session) {
  if (!session.genres.length) throw new Error("Genre belum dipilih.");
  if (!session.video?.fileId) throw new Error("Video belum diterima.");
  if (!env.IDFLIX_GROUP_ID) throw new Error("IDFLIX_GROUP_ID belum diatur.");

  const primaryGenre = session.genres[0];
  const threadId = await getOrCreateTopic(env, primaryGenre);

  // Copy the original Telegram message into the selected genre topic.
  await telegram(env, "copyMessage", {
    chat_id: env.IDFLIX_GROUP_ID,
    from_chat_id: session.sourceChatId,
    message_id: session.sourceMessageId,
    message_thread_id: threadId
  });

  const movieId = `${slug(session.title)}-${session.year}`;
  const movie = {
    id: movieId,
    title: session.title,
    year: Number(session.year),
    genres: session.genres.map(genreName),
    genreKeys: session.genres,
    primaryGenre: genreName(primaryGenre),
    rating: Number(session.rating),
    duration: session.duration,
    description: session.description,
    telegramFileId: session.video.fileId,
    sourceChatId: session.sourceChatId,
    sourceMessageId: session.sourceMessageId,
    topicId: threadId,
    addedAt: Date.now()
  };

  // Temporary persistence in KV. Firebase integration comes in the next step.
  await env.TOPIC_KV.put(keyMovie(movieId), JSON.stringify(movie));
  await deleteSession(env, chatId);

  await sendMessage(env, chatId, [
    "✅ BERHASIL DISIMPAN",
    "",
    `🎬 Judul: ${movie.title}`,
    `📅 Tahun: ${movie.year}`,
    `🎭 Genre: ${movie.genres.join(", ")}`,
    `⭐ Rating: ${movie.rating}/10`,
    `⏱️ Durasi: ${movie.duration}`,
    `🧵 Topic: ${movie.primaryGenre}`,
    `🆔 Topic ID: ${movie.topicId}`,
    `🆔 Message ID: ${movie.sourceMessageId}`,
    "",
    "☁️ Media tetap tersimpan di Telegram."
  ].join("\n"));
}

async function handleCallback(update, env) {
  const cq = update.callback_query;
  if (!cq?.from || !isAdmin(cq.from, env)) {
    if (cq?.id) await answerCallback(env, cq.id, "⛔ Kamu bukan admin.");
    return;
  }

  const data = String(cq.data || "");
  const msg = cq.message;
  if (!msg?.chat?.id) return;
  const chatId = msg.chat.id;
  const session = await getSession(env, chatId);

  if (!session || session.ownerId !== String(cq.from.id)) {
    await answerCallback(env, cq.id, "Sesi sudah tidak aktif.");
    return;
  }

  if (data.startsWith("genre:")) {
    const value = data.slice(6);
    if (value === "done") {
      if (!session.genres.length) {
        await answerCallback(env, cq.id, "Pilih minimal satu genre.");
        return;
      }
      session.step = "rating";
      await putSession(env, chatId, session);
      await answerCallback(env, cq.id);
      await editMessage(env, chatId, msg.message_id, `🎭 Genre terpilih: ${session.genres.map(genreName).join(", ")}`);
      await sendMessage(env, chatId, "⭐ Masukkan rating film (0–10).\nContoh: 8.6");
      return;
    }

    if (!GENRES.some(([key]) => key === value)) {
      await answerCallback(env, cq.id, "Genre tidak dikenal.");
      return;
    }

    session.genres = session.genres.includes(value)
      ? session.genres.filter(x => x !== value)
      : [...session.genres, value];
    await putSession(env, chatId, session);
    await answerCallback(env, cq.id);
    await showGenreMenu(env, chatId, msg.message_id, session.genres);
    return;
  }

  if (data === "confirm:save") {
    await answerCallback(env, cq.id, "Menyimpan film...");
    try {
      await finalizeSave(env, chatId, session);
    } catch (err) {
      await sendMessage(env, chatId, `❌ Gagal menyimpan.\n\n${err.message}`);
    }
    return;
  }

  if (data === "confirm:genre") {
    await answerCallback(env, cq.id);
    await showGenreMenu(env, chatId, msg.message_id, session.genres);
    return;
  }

  if (data === "confirm:cancel") {
    await answerCallback(env, cq.id, "Dibatalkan.");
    await deleteSession(env, chatId);
    await editMessage(env, chatId, msg.message_id, "❌ Penyimpanan film dibatalkan.");
  }
}

async function handleMessage(update, env) {
  const msg = update?.message;
  if (!msg?.chat?.id) return;

  const chatId = msg.chat.id;
  const from = msg.from;
  const text = String(msg.text || "").trim();

  if (text === "/id") {
    await sendMessage(env, chatId, `Telegram ID kamu: ${from?.id || "-"}`);
    return;
  }

  if (text === "/start") {
    await sendMessage(env, chatId, "IDFLIX Bot aktif.\n\n/id — lihat Telegram ID\n/ping — tes admin\n/simpan <judul> — mulai input film\n/batal — batalkan input film");
    return;
  }

  if (text === "/ping") {
    if (!isAdmin(from, env)) return sendMessage(env, chatId, "Kamu tidak punya akses admin.");
    await sendMessage(env, chatId, "✅ IDFLIX Bot aktif dan webhook berjalan.");
    return;
  }

  if (!isAdmin(from, env)) {
    if (msg.video || msg.document) await sendMessage(env, chatId, "⛔ Kamu bukan admin.");
    return;
  }

  if (text === "/batal") {
    await deleteSession(env, chatId);
    await sendMessage(env, chatId, "❌ Input film dibatalkan.");
    return;
  }

  if (text.startsWith("/simpan")) {
    const title = text.replace(/^\/simpan(?:@[^\s]+)?\s*/i, "").trim();
    await startSave(env, chatId, title, from.id);
    return;
  }

  const session = await getSession(env, chatId);
  if (!session || session.ownerId !== String(from?.id || "")) {
    if (msg.video || msg.document) {
      await sendMessage(env, chatId, "ℹ️ Gunakan /simpan <judul> terlebih dahulu sebelum mengirim video.");
    }
    return;
  }

  if (msg.video || msg.document) {
    if (session.step !== "video") {
      await sendMessage(env, chatId, "⚠️ Sekarang bot sedang menunggu input metadata, bukan video.");
      return;
    }
    await processVideo(env, msg, session);
    return;
  }

  if (!text) return;

  if (session.step === "title") {
    session.title = text;
    session.step = "video";
    await putSession(env, chatId, session);
    await sendMessage(env, chatId, `🎬 Judul disimpan: ${session.title}\n\n📹 Sekarang kirim video filmnya.`);
    return;
  }

  if (session.step === "year") {
    if (!/^\d{4}$/.test(text) || Number(text) < 1888 || Number(text) > new Date().getFullYear() + 1) {
      await sendMessage(env, chatId, "⚠️ Tahun tidak valid. Masukkan tahun 4 digit, contoh: 2014");
      return;
    }
    session.year = text;
    session.step = "genre";
    await putSession(env, chatId, session);
    await sendMessage(env, chatId, "🎭 Pilih satu atau beberapa genre:", { reply_markup: genreKeyboard(session.genres) });
    return;
  }

  if (session.step === "rating") {
    const rating = Number(text.replace(",", "."));
    if (!Number.isFinite(rating) || rating < 0 || rating > 10) {
      await sendMessage(env, chatId, "⚠️ Rating harus antara 0 dan 10. Contoh: 8.6");
      return;
    }
    session.rating = rating.toFixed(1).replace(/\.0$/, "");
    session.step = "duration";
    await putSession(env, chatId, session);
    await sendMessage(env, chatId, "⏱️ Masukkan durasi film.\nContoh: 2j 49m");
    return;
  }

  if (session.step === "duration") {
    session.duration = text;
    session.step = "description";
    await putSession(env, chatId, session);
    await sendMessage(env, chatId, "📝 Masukkan deskripsi film.\n\nJika tidak ingin mengisi, kirim: -");
    return;
  }

  if (session.step === "description") {
    session.description = text === "-" ? "" : text;
    session.step = "confirm";
    await putSession(env, chatId, session);
    await showConfirm(env, chatId, session);
  }
}

async function handleUpdate(update, env) {
  if (update?.callback_query) return handleCallback(update, env);
  return handleMessage(update, env);
}

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response("IDFLIX Telegram Bot Worker aktif.", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    if (!env.BOT_TOKEN) return json({ ok: false, error: "BOT_TOKEN belum diatur" }, 500);

    try {
      const update = await request.json();
      await handleUpdate(update, env);
      return json({ ok: true });
    } catch (err) {
      return json({ ok: false, error: String(err?.message || err) }, 400);
    }
  }
};
