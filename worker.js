const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });

const QUALITIES = ["360p", "480p", "720p", "1080p", "1440p", "2160p"];

const GENRES = [
  ["action", "Action"],
  ["adventure", "Adventure"],
  ["animation", "Animation"],
  ["comedy", "Comedy"],
  ["crime", "Crime"],
  ["documentary", "Documentary"],
  ["drama", "Drama"],
  ["fantasy", "Fantasy"],
  ["horror", "Horror"],
  ["mystery", "Mystery"],
  ["romance", "Romance"],
  ["scifi", "Sci-Fi"],
  ["thriller", "Thriller"],
  ["war", "War"],
  ["western", "Western"],
  ["family", "Family"]
];

const SESSION_PREFIX = "session:";

function isAdmin(ctx, env) {
  const ids = String(env.ADMIN_IDS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
  return ids.includes(String(ctx?.from?.id || ""));
}

async function telegram(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || "request failed"}`);
  return data;
}

async function sendMessage(env, chatId, text, replyMarkup = undefined, extra = {}) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    ...extra
  });
}

async function answerCallback(env, callbackQueryId) {
  return telegram(env, "answerCallbackQuery", { callback_query_id: callbackQueryId });
}

async function editMessage(env, chatId, messageId, text, replyMarkup = undefined) {
  return telegram(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

async function kvGet(env, key) {
  if (!env.TOPIC_KV) throw new Error("TOPIC_KV belum tersedia.");
  const value = await env.TOPIC_KV.get(key);
  return value ? JSON.parse(value) : null;
}

async function kvPut(env, key, value) {
  if (!env.TOPIC_KV) throw new Error("TOPIC_KV belum tersedia.");
  await env.TOPIC_KV.put(key, JSON.stringify(value));
}

async function kvDelete(env, key) {
  if (!env.TOPIC_KV) throw new Error("TOPIC_KV belum tersedia.");
  await env.TOPIC_KV.delete(key);
}

function sessionKey(chatId, userId) {
  return `${SESSION_PREFIX}${chatId}:${userId}`;
}

function commandOf(text) {
  const first = String(text || "").trim().split(/\s+/)[0] || "";
  return first.split("@")[0].toLowerCase();
}

function commandArg(text) {
  const parts = String(text || "").trim().split(/\s+/);
  return parts.slice(1).join(" ").trim();
}

function getMedia(message) {
  if (message?.video?.file_id) {
    return {
      type: "video",
      fileId: message.video.file_id,
      fileUniqueId: message.video.file_unique_id || "",
      width: message.video.width || null,
      height: message.video.height || null,
      duration: message.video.duration || null,
      fileSize: message.video.file_size || null,
      messageId: message.message_id,
      chatId: message.chat?.id,
      threadId: message.message_thread_id || null
    };
  }

  if (message?.document?.file_id) {
    return {
      type: "document",
      fileId: message.document.file_id,
      fileUniqueId: message.document.file_unique_id || "",
      width: null,
      height: null,
      duration: null,
      fileSize: message.document.file_size || null,
      messageId: message.message_id,
      chatId: message.chat?.id,
      threadId: message.message_thread_id || null
    };
  }

  return null;
}

function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "film";
}

function genreLabel(slug) {
  return GENRES.find(([id]) => id === slug)?.[1] || slug;
}

function qualityKeyboard() {
  return {
    inline_keyboard: [
      ["360p", "480p"].map(q => ({ text: q, callback_data: `q:${q}` })),
      ["720p", "1080p"].map(q => ({ text: q, callback_data: `q:${q}` })),
      ["1440p", "2160p"].map(q => ({ text: q, callback_data: `q:${q}` })),
      [{ text: "❌ Batal", callback_data: "x:cancel" }]
    ]
  };
}

function genreKeyboard(selected) {
  const set = new Set(selected || []);
  const rows = [];
  for (let i = 0; i < GENRES.length; i += 2) {
    rows.push(
      GENRES.slice(i, i + 2).map(([id, label]) => ({
        text: `${set.has(id) ? "☑️" : "☐"} ${label}`,
        callback_data: `g:${id}`
      }))
    );
  }
  rows.push([
    { text: "✅ Selesai", callback_data: "g:done" },
    { text: "❌ Batal", callback_data: "x:cancel" }
  ]);
  return { inline_keyboard: rows };
}

function selectedGenreText(selected) {
  if (!selected?.length) return "Belum ada";
  return selected.map(genreLabel).join(", ");
}

function summary(session) {
  return [
    "📝 KONFIRMASI FILM",
    "",
    `🎬 Judul: ${session.title}`,
    `🎞️ Kualitas: ${session.quality || "-"}`,
    `📅 Tahun: ${session.year || "-"}`,
    `🎭 Genre: ${selectedGenreText(session.genres)}`,
    `⭐ Rating: ${session.rating ?? "-"}`,
    `⏱️ Durasi: ${session.duration || "-"}`,
    `📖 Deskripsi: ${session.description || "-"}`,
    "",
    `📂 Jenis media: ${session.media?.type || "-"}`,
    `🆔 Message ID: ${session.media?.messageId || "-"}`,
    "",
    "Tekan Simpan untuk menyelesaikan wizard."
  ].join("\n");
}

function confirmationKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "💾 Simpan", callback_data: "c:save" }],
      [{ text: "↩️ Batal", callback_data: "x:cancel" }]
    ]
  };
}

async function startSession(env, msg, mode, title, repliedMedia) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const key = sessionKey(chatId, userId);
  const session = {
    mode,
    chatId,
    userId,
    title,
    filmId: slugify(title),
    stage: repliedMedia ? "quality" : "video",
    genres: [],
    media: repliedMedia || null,
    createdAt: Date.now(),
    sourceThreadId: repliedMedia?.threadId || msg.message_thread_id || null
  };
  await kvPut(env, key, session);

  if (repliedMedia) {
    await sendMessage(
      env,
      chatId,
      `🎬 Judul: ${title}\n\n🎞️ Video berhasil dibaca.\nPilih kualitas video ini:`,
      qualityKeyboard(),
      { reply_to_message_id: msg.message_id }
    );
  } else {
    await sendMessage(
      env,
      chatId,
      `🎬 Judul: ${title}\n\n📤 Sekarang balas/reply pesan ini dengan 1 video yang akan disimpan.\n\nAtau kirim video setelah pesan ini.\n\nKetik /batal untuk membatalkan.`,
      undefined,
      { reply_to_message_id: msg.message_id }
    );
  }
}

async function cancelSession(env, chatId, userId) {
  await kvDelete(env, sessionKey(chatId, userId));
  await sendMessage(env, chatId, "❌ Wizard dibatalkan.");
}

async function showGenreStep(env, msg, session) {
  session.stage = "genre";
  await kvPut(env, sessionKey(msg.chat.id, msg.from.id), session);
  await sendMessage(
    env,
    msg.chat.id,
    `🎭 PILIH GENRE FILM\n\nPilih satu atau beberapa genre.\nGenre yang dipilih akan ditandai dengan ☑️\n\nTerpilih:\n${selectedGenreText(session.genres)}`,
    genreKeyboard(session.genres),
    { reply_to_message_id: msg.message_id }
  );
}

async function advanceAfterQuality(env, msg, session) {
  session.stage = "year";
  await kvPut(env, sessionKey(msg.chat.id, msg.from.id), session);
  await sendMessage(
    env,
    msg.chat.id,
    "📅 Masukkan tahun film.\nContoh: 2014\n\nKetik /batal untuk membatalkan.",
    undefined,
    { reply_to_message_id: msg.message_id }
  );
}

async function handleCallback(update, env) {
  const cq = update?.callback_query;
  if (!cq?.message?.chat?.id) return;

  if (!isAdmin(cq, env)) {
    await answerCallback(env, cq.id);
    return;
  }

  const chatId = cq.message.chat.id;
  const userId = cq.from.id;
  const key = sessionKey(chatId, userId);
  const session = await kvGet(env, key);
  await answerCallback(env, cq.id);

  if (!session) {
    await sendMessage(env, chatId, "⚠️ Sesi wizard sudah tidak ada. Jalankan /simpan lagi.");
    return;
  }

  const data = String(cq.data || "");

  if (data === "x:cancel") {
    await kvDelete(env, key);
    await editMessage(env, chatId, cq.message.message_id, "❌ Wizard dibatalkan.");
    return;
  }

  if (data.startsWith("q:")) {
    const quality = data.slice(2);
    if (!QUALITIES.includes(quality)) return;
    session.quality = quality;
    await advanceAfterQuality(env, cq.message, session);
    return;
  }

  if (data.startsWith("g:")) {
    const genre = data.slice(2);
    if (genre === "done") {
      if (!session.genres.length) {
        await editMessage(
          env,
          chatId,
          cq.message.message_id,
          `🎭 PILIH GENRE FILM\n\nMinimal pilih satu genre.\n\nTerpilih:\nBelum ada`,
          genreKeyboard(session.genres)
        );
        return;
      }
      session.stage = "rating";
      await kvPut(env, key, session);
      await editMessage(
        env,
        chatId,
        cq.message.message_id,
        `🎭 Genre tersimpan: ${selectedGenreText(session.genres)}\n\n⭐ Masukkan rating 0–10.\nContoh: 8.5`
      );
      return;
    }

    if (GENRES.some(([id]) => id === genre)) {
      const set = new Set(session.genres);
      if (set.has(genre)) set.delete(genre);
      else set.add(genre);
      session.genres = [...set];
      await kvPut(env, key, session);
      await editMessage(
        env,
        chatId,
        cq.message.message_id,
        `🎭 PILIH GENRE FILM\n\nPilih satu atau beberapa genre.\nGenre yang dipilih akan ditandai dengan ☑️\n\nTerpilih:\n${selectedGenreText(session.genres)}`,
        genreKeyboard(session.genres)
      );
    }
    return;
  }

  if (data === "c:save") {
    session.stage = "saved";
    session.savedAt = Date.now();
    await kvPut(env, `draft:${session.filmId}:${session.quality}`, session);
    await kvDelete(env, key);

    await editMessage(
      env,
      chatId,
      cq.message.message_id,
      [
        "✅ DRAFT FILM TERSIMPAN",
        "",
        `🎬 ${session.title}`,
        `🎞️ ${session.quality}`,
        `📅 ${session.year}`,
        `🎭 ${selectedGenreText(session.genres)}`,
        `⭐ ${session.rating}`,
        `⏱️ ${session.duration}`,
        "",
        "Media tetap tersimpan di Telegram.",
        "Data Firebase akan dihubungkan pada tahap berikutnya."
      ].join("\n")
    );
  }
}

async function handleVideoMessage(env, msg, session) {
  const media = getMedia(msg);
  if (!media) return false;
  session.media = media;
  session.stage = "quality";
  await kvPut(env, sessionKey(msg.chat.id, msg.from.id), session);
  await sendMessage(
    env,
    msg.chat.id,
    "🎞️ Video berhasil dibaca.\n\nPilih kualitas video ini:",
    qualityKeyboard(),
    { reply_to_message_id: msg.message_id }
  );
  return true;
}

async function handleTextStage(env, msg, session, text) {
  const key = sessionKey(msg.chat.id, msg.from.id);

  if (session.stage === "year") {
    const year = Number(text);
    if (!Number.isInteger(year) || year < 1888 || year > 2100) {
      await sendMessage(env, msg.chat.id, "⚠️ Tahun tidak valid. Masukkan 4 digit, contoh: 2014.");
      return;
    }
    session.year = year;
    await showGenreStep(env, msg, session);
    return;
  }

  if (session.stage === "rating") {
    const rating = Number(text.replace(",", "."));
    if (!Number.isFinite(rating) || rating < 0 || rating > 10) {
      await sendMessage(env, msg.chat.id, "⚠️ Rating harus angka 0–10. Contoh: 8.5");
      return;
    }
    session.rating = Math.round(rating * 10) / 10;
    session.stage = "duration";
    await kvPut(env, key, session);
    await sendMessage(env, msg.chat.id, "⏱️ Masukkan durasi.\nContoh: 169 menit");
    return;
  }

  if (session.stage === "duration") {
    if (text.length < 1 || text.length > 50) {
      await sendMessage(env, msg.chat.id, "⚠️ Durasi terlalu panjang. Contoh: 169 menit");
      return;
    }
    session.duration = text;
    session.stage = "description";
    await kvPut(env, key, session);
    await sendMessage(env, msg.chat.id, "📖 Masukkan deskripsi/sinopsis film.\nKetik - jika ingin kosong.");
    return;
  }

  if (session.stage === "description") {
    session.description = text === "-" ? "" : text;
    session.stage = "confirm";
    await kvPut(env, key, session);
    await sendMessage(env, msg.chat.id, summary(session), confirmationKeyboard());
    return;
  }

  if (session.stage === "video") {
    await sendMessage(env, msg.chat.id, "📤 Kirim/reply 1 video terlebih dahulu.");
    return;
  }

  if (session.stage === "genre") {
    await sendMessage(env, msg.chat.id, "🎭 Pilih genre lewat tombol di atas.");
    return;
  }

  if (session.stage === "confirm") {
    await sendMessage(env, msg.chat.id, "Gunakan tombol 💾 Simpan atau ↩️ Batal.");
  }
}

async function handleMessage(update, env) {
  const msg = update?.message;
  if (!msg?.chat?.id || !msg?.from?.id) return;
  if (!isAdmin(msg, env)) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = String(msg.text || msg.caption || "").trim();
  const cmd = commandOf(msg.text || "");

  if (cmd === "/id") {
    await sendMessage(env, chatId, `Telegram ID kamu: ${userId}`);
    return;
  }

  if (cmd === "/start") {
    await sendMessage(
      env,
      chatId,
      "IDFLIX Bot Wizard v1 aktif.\n\n/simpan <judul> — simpan 1 video sebagai film baru\n/tambah <judul> — tambah 1 kualitas video ke film\n/batal — batalkan wizard\n/id — lihat Telegram ID\n/ping — tes bot"
    );
    return;
  }

  if (cmd === "/ping") {
    await sendMessage(env, chatId, "✅ IDFLIX Bot aktif dan webhook berjalan.");
    return;
  }

  if (cmd === "/batal") {
    await cancelSession(env, chatId, userId);
    return;
  }

  if (cmd === "/simpan" || cmd === "/tambah") {
    const title = commandArg(msg.text || "");
    if (!title) {
      await sendMessage(env, chatId, `Format: ${cmd} Judul Film\n\nContoh:\n${cmd} Interstellar`);
      return;
    }

    const repliedMedia = getMedia(msg.reply_to_message);
    await startSession(env, msg, cmd === "/tambah" ? "add" : "create", title, repliedMedia);
    return;
  }

  const key = sessionKey(chatId, userId);
  const session = await kvGet(env, key);

  if (!session) {
    const directMedia = getMedia(msg);
    if (directMedia) {
      await sendMessage(env, chatId, "ℹ️ Mulai dengan /simpan <judul>, lalu kirim/reply video.");
    }
    return;
  }

  if (getMedia(msg)) {
    if (session.stage === "video") {
      await handleVideoMessage(env, msg, session);
    } else {
      await sendMessage(env, chatId, "⚠️ Video sudah diterima untuk sesi ini. Lanjutkan langkah wizard yang sedang diminta.");
    }
    return;
  }

  if (msg.text) {
    await handleTextStage(env, msg, session, text);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response("IDFLIX Telegram Bot Wizard v1 aktif.", {
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (!env.BOT_TOKEN) return json({ ok: false, error: "BOT_TOKEN belum diatur" }, 500);
    if (!env.ADMIN_IDS) return json({ ok: false, error: "ADMIN_IDS belum diatur" }, 500);

    try {
      const update = await request.json();
      if (update?.callback_query) await handleCallback(update, env);
      else if (update?.message) await handleMessage(update, env);
      return json({ ok: true });
    } catch (err) {
      return json({ ok: false, error: String(err?.message || err) }, 400);
    }
  }
};
