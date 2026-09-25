const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {"content-type": "application/json; charset=utf-8"}
  });

const DB_URL = "https://idflix-219d7-default-rtdb.asia-southeast1.firebasedatabase.app";
const OAUTH_URL = "https://oauth2.googleapis.com/token";
const FB_SCOPE = "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email";
const QUALITIES = ["360p","480p","720p","1080p","1440p","2160p"];
const GENRES = ["Action","Adventure","Animation","Comedy","Crime","Documentary","Drama","Fantasy","Horror","Mystery","Romance","Sci-Fi","Thriller","War","Western","Family"];

function isAdmin(from, env) {
  const ids = String(env.ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
  return ids.includes(String(from?.id || ""));
}

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: {"content-type":"application/json"},
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || "unknown error"}`);
  return data.result;
}

async function sendMessage(env, chatId, text, extra = {}) {
  return tg(env, "sendMessage", {chat_id: chatId, text, ...extra});
}

async function answerCallback(env, id, text = "") {
  return tg(env, "answerCallbackQuery", {callback_query_id:id, text});
}

async function editMessage(env, chatId, messageId, text, extra = {}) {
  return tg(env, "editMessageText", {chat_id:chatId, message_id:messageId, text, ...extra});
}

function b64urlBytes(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i=0; i<bytes.length; i+=chunk) s += String.fromCharCode(...bytes.subarray(i, i+chunk));
  return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
function b64urlText(s) {
  return b64urlBytes(new TextEncoder().encode(s));
}
function pemToDer(pem) {
  let value = String(pem || "").trim();

  // Jika Secret tersimpan sebagai string JSON dengan tanda kutip,
  // lepaskan tanda kutip pembungkusnya.
  if (
    value.length >= 2 &&
    value.startsWith('"') &&
    value.endsWith('"')
  ) {
    value = value.slice(1, -1);
  }

  // Normalisasi literal "\n" menjadi newline asli.
  value = value.replace(/\\r?\\n/g, "\n");

  // Hilangkan header/footer PEM.
  value = value
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/-----BEGIN RSA PRIVATE KEY-----/g, "")
    .replace(/-----END RSA PRIVATE KEY-----/g, "");

  // Hilangkan whitespace.
  const b64 = value.replace(/\s/g, "");

  if (!b64) {
    throw new Error("FIREBASE_PRIVATE_KEY kosong.");
  }

  // Validasi karakter Base64 sebelum atob().
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    throw new Error(
      "FIREBASE_PRIVATE_KEY bukan Base64/PEM yang valid. Periksa Secret FIREBASE_PRIVATE_KEY."
    );
  }

  if (b64.length % 4 !== 0) {
    throw new Error(
      "FIREBASE_PRIVATE_KEY memiliki panjang Base64 yang tidak valid."
    );
  }

  const bin = atob(b64);
  const out = new Uint8Array(bin.length);

  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }

  return out;
}

let tokenCache = {token:"", exp:0};

async function googleAccessToken(env) {
  const now = Math.floor(Date.now()/1000);
  if (tokenCache.token && tokenCache.exp > now + 60) return tokenCache.token;
  if (!env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    throw new Error("Secret Firebase belum lengkap.");
  }

  const header = {alg:"RS256", typ:"JWT"};
  const claim = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: FB_SCOPE,
    aud: OAUTH_URL,
    iat: now,
    exp: now + 3600
  };
  const unsigned = `${b64urlText(JSON.stringify(header))}.${b64urlText(JSON.stringify(claim))}`;
  const key = await crypto.subtle.importKey(
  "pkcs8",
  pemToDer(env.FIREBASE_PRIVATE_KEY),
    {name:"RSASSA-PKCS1-v1_5", hash:"SHA-256"},
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${b64urlBytes(new Uint8Array(sig))}`;

  const r = await fetch(OAUTH_URL, {
    method:"POST",
    headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({
      grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) throw new Error(`OAuth Firebase gagal: ${data.error_description || data.error || "unknown"}`);
  tokenCache = {token:data.access_token, exp:now + Number(data.expires_in || 3600)};
  return tokenCache.token;
}

function dbPath(path) {
  return `${DB_URL}/${String(path).replace(/^\/+/,"").split("/").map(encodeURIComponent).join("/")}.json`;
}

async function firebaseRequest(env, method, path, body) {
  const token = await googleAccessToken(env);
  const r = await fetch(dbPath(path), {
    method,
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) throw new Error(`Firebase ${method} ${path}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}

async function getMovie(env, id) {
  return firebaseRequest(env, "GET", `movies/${id}`);
}

async function findMovieByTitle(env, title) {
  const movies = await firebaseRequest(env, "GET", "movies") || {};
  const target = title.trim().toLowerCase();
  for (const [id, movie] of Object.entries(movies)) {
    if (String(movie?.title || "").trim().toLowerCase() === target) return {id, movie};
  }
  return null;
}

function slugify(s) {
  const x = String(s).normalize("NFKD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"");
  return x || `film-${Date.now()}`;
}

async function uniqueMovieId(env, title) {
  const base = slugify(title);
  const exists = await getMovie(env, base);
  return exists ? `${base}-${Date.now().toString(36)}` : base;
}

function stateKey(userId) { return `state:${userId}`; }
async function getState(env, userId) {
  return env.TOPIC_KV ? await env.TOPIC_KV.get(stateKey(userId), "json") : null;
}
async function putState(env, userId, state) {
  if (env.TOPIC_KV) await env.TOPIC_KV.put(stateKey(userId), JSON.stringify(state), {expirationTtl: 86400});
}
async function delState(env, userId) {
  if (env.TOPIC_KV) await env.TOPIC_KV.delete(stateKey(userId));
}

function videoFileId(msg) {
  if (msg?.video?.file_id) return {type:"video", fileId:msg.video.file_id, duration:msg.video.duration || 0};
  if (msg?.document?.file_id) return {type:"document", fileId:msg.document.file_id, duration:0};
  return null;
}

function qualityKeyboard(selected = "") {
  return {
    inline_keyboard: [
      QUALITIES.slice(0,3).map(q => ({text:selected===q ? `☑️ ${q}` : `☐ ${q}`, callback_data:`q:${q}`})),
      QUALITIES.slice(3).map(q => ({text:selected===q ? `☑️ ${q}` : `☐ ${q}`, callback_data:`q:${q}`})),
      [{text:"➡️ Lanjut", callback_data:"qdone"}],
      [{text:"❌ Batal", callback_data:"cancel"}]
    ]
  };
}

function genreKeyboard(selected = []) {
  const set = new Set(selected);
  const rows = [];
  for (let i=0;i<GENRES.length;i+=2) {
    rows.push(GENRES.slice(i,i+2).map(g => ({
      text: `${set.has(g) ? "☑️" : "☐"} ${g}`,
      callback_data:`g:${g}`
    })));
  }
  rows.push([{text:"✅ Selesai", callback_data:"gdone"}]);
  rows.push([{text:"❌ Batal", callback_data:"cancel"}]);
  return {inline_keyboard:rows};
}

function confirmKeyboard() {
  return {inline_keyboard:[
    [{text:"✅ SIMPAN", callback_data:"confirm_save"}],
    [{text:"💾 SIMPAN DRAFT", callback_data:"draft_save"}],
    [{text:"❌ BATAL", callback_data:"cancel"}]
  ]};
}

function formatSummary(s) {
  return `🎬 KONFIRMASI FILM

Judul: ${s.title}
Kualitas: ${s.quality}
Tahun: ${s.year || "-"}
Genre: ${(s.genre || []).join(", ") || "-"}
Rating: ${s.rating || "-"}
Durasi: ${s.duration || "-"}
Deskripsi: ${s.description || "-"}

Video: ${s.videoType || "video"}
Media tetap tersimpan di Telegram.`;
}

async function askNext(env, state, chatId) {
  if (state.mode === "simpan") {
    if (!state.fileId) {
      await sendMessage(env, chatId, "📹 Silakan kirim/reply video yang akan disimpan.");
      return;
    }
    if (!state.quality) {
      await sendMessage(env, chatId, "🎞️ PILIH KUALITAS VIDEO", {reply_markup:qualityKeyboard()});
      return;
    }
    if (!state.year) {
      await sendMessage(env, chatId, "📅 Masukkan tahun film, contoh: 2026");
      return;
    }
    if (!state.genre) {
      state.genre = [];
      await putState(env, state.userId, state);
      await sendMessage(env, chatId, "🎭 PILIH GENRE FILM\n\nPilih satu atau beberapa genre.", {reply_markup:genreKeyboard([])});
      return;
    }
    if (state.rating === undefined) {
      await sendMessage(env, chatId, "⭐ Masukkan rating, contoh: 8.5");
      return;
    }
    if (!state.duration) {
      await sendMessage(env, chatId, "⏱️ Masukkan durasi, contoh: 2j 49m");
      return;
    }
    if (!state.description) {
      await sendMessage(env, chatId, "📝 Masukkan deskripsi film.");
      return;
    }
    await sendMessage(env, chatId, formatSummary(state), {reply_markup:confirmKeyboard()});
  } else if (state.mode === "tambah") {
    if (!state.fileId) {
      await sendMessage(env, chatId, "📹 Silakan kirim/reply video kualitas tambahan.");
      return;
    }
    if (!state.quality) {
      await sendMessage(env, chatId, "🎞️ PILIH KUALITAS VIDEO", {reply_markup:qualityKeyboard()});
      return;
    }
    await sendMessage(env, chatId,
      `🎬 ${state.title}\n\nKualitas: ${state.quality}\n\nKlik SIMPAN untuk menambahkan kualitas ini.`,
      {reply_markup:{inline_keyboard:[
        [{text:"✅ SIMPAN",callback_data:"confirm_add"}],
        [{text:"❌ Batal",callback_data:"cancel"}]
      ]}});
  }
}

async function handleAdminText(msg, env) {
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  const text = String(msg.text || "").trim();

  if (text === "/id") {
    await sendMessage(env, chatId, `Telegram ID kamu: ${msg.from.id}`);
    return;
  }
  if (text === "/start") {
    await sendMessage(env, chatId,
      "IDFLIX Bot aktif.\n\n/simpan <judul> — tambah film baru\n/tambah <judul> — tambah kualitas ke film\n/batal — batalkan proses\n/id — lihat Telegram ID\n/ping — tes bot");
    return;
  }
  if (text === "/ping") {
    await sendMessage(env, chatId, "✅ IDFLIX Bot aktif dan webhook berjalan.");
    return;
  }
  if (text === "/batal") {
    await delState(env, userId);
    await sendMessage(env, chatId, "❌ Proses dibatalkan.");
    return;
  }

  if (text.startsWith("/simpan ")) {
    const title = text.slice(8).trim();
    if (!title) return sendMessage(env, chatId, "Format: /simpan <judul>");
    const state = {userId, mode:"simpan", title, createdAt:Date.now(), chatId};
    await putState(env, userId, state);
    await sendMessage(env, chatId, `🎬 Judul: ${title}\n\nSekarang kirim/reply video film tersebut.`);
    return;
  }

  if (text.startsWith("/tambah ")) {
    const title = text.slice(8).trim();
    if (!title) return sendMessage(env, chatId, "Format: /tambah <judul>");
    const found = await findMovieByTitle(env, title);
    if (!found) return sendMessage(env, chatId, `❌ Film "${title}" belum ditemukan di Firebase.`);
    const state = {userId, mode:"tambah", title:found.movie.title, movieId:found.id, createdAt:Date.now(), chatId};
    await putState(env, userId, state);
    await sendMessage(env, chatId, `🎬 Film ditemukan: ${found.movie.title}\n\nKirim/reply video kualitas tambahan.`);
    return;
  }

  const state = await getState(env, userId);
  if (!state) return;

  if (msg.video || msg.document) {
    // Diagnostic acknowledgement: confirms Telegram reached the Worker.
    await sendMessage(env, chatId, "📥 Video terdeteksi. Memproses...");
    const f = videoFileId(msg);
    if (!f) {
      await sendMessage(env, chatId, "⚠️ Media terdeteksi tetapi file_id tidak ditemukan.");
      return;
    }
    state.fileId = f.fileId;
    state.videoType = f.type;
    state.telegramDuration = f.duration;
    await putState(env, userId, state);
    await askNext(env, state, chatId);
    return;
  }

  if (state.mode === "simpan" && !state.quality && state.fileId) {
    // Quality is selected with callback; fall through.
  } else if (state.mode === "simpan") {
    if (!state.year) {
      if (!/^\d{4}$/.test(text)) return sendMessage(env, chatId, "❌ Tahun harus 4 digit, contoh: 2026.");
      state.year = Number(text);
    } else if (state.rating === undefined) {
      const n = Number(text.replace(",","."));
      if (!Number.isFinite(n) || n < 0 || n > 10) return sendMessage(env, chatId, "❌ Rating harus angka 0–10.");
      state.rating = n;
    } else if (!state.duration) {
      state.duration = text;
    } else if (!state.description) {
      state.description = text;
    }
    await putState(env, userId, state);
    await askNext(env, state, chatId);
  }
}

async function handleCallback(q, env) {
  const data = String(q.data || "");
  const msg = q.message;
  const userId = String(q.from.id);
  const chatId = msg.chat.id;
  const state = await getState(env, userId);

  if (!state) {
    await answerCallback(env, q.id, "Sesi sudah tidak tersedia.");
    return;
  }

  if (data === "cancel") {
    await delState(env, userId);
    await answerCallback(env, q.id, "Dibatalkan");
    await editMessage(env, chatId, msg.message_id, "❌ Proses dibatalkan.");
    return;
  }

  if (data.startsWith("q:")) {
    state.quality = data.slice(2);
    await putState(env, userId, state);
    await answerCallback(env, q.id, `Kualitas ${state.quality}`);
    await editMessage(env, chatId, msg.message_id, `🎞️ Kualitas dipilih: ${state.quality}\n\nKlik Lanjut.`, {reply_markup:qualityKeyboard(state.quality)});
    return;
  }

  if (data === "qdone") {
    if (!state.quality) return answerCallback(env, q.id, "Pilih kualitas terlebih dahulu.");
    await answerCallback(env, q.id, "Lanjut");
    await editMessage(env, chatId, msg.message_id, `✅ Kualitas: ${state.quality}`);
    await askNext(env, state, chatId);
    return;
  }

  if (data.startsWith("g:")) {
    const g = data.slice(2);
    state.genre = Array.isArray(state.genre) ? state.genre : [];
    state.genre = state.genre.includes(g) ? state.genre.filter(x=>x!==g) : [...state.genre,g];
    await putState(env, userId, state);
    await answerCallback(env, q.id, state.genre.includes(g) ? `☑️ ${g}` : `☐ ${g}`);
    await editMessage(env, chatId, msg.message_id,
      `🎭 PILIH GENRE FILM\n\nTerpilih:\n${state.genre.length ? state.genre.join(", ") : "Belum ada"}`,
      {reply_markup:genreKeyboard(state.genre)});
    return;
  }

  if (data === "gdone") {
    if (!state.genre?.length) return answerCallback(env, q.id, "Pilih minimal satu genre.");
    await answerCallback(env, q.id, "Genre disimpan");
    await editMessage(env, chatId, msg.message_id, `✅ Genre: ${state.genre.join(", ")}`);
    await askNext(env, state, chatId);
    return;
  }

  if (data === "draft_save") {
    await env.TOPIC_KV?.put(`draft:${userId}`, JSON.stringify(state), {expirationTtl: 604800});
    await delState(env, userId);
    await answerCallback(env, q.id, "Draft disimpan 7 hari.");
    await editMessage(env, chatId, msg.message_id, "💾 Draft disimpan.\n\nMulai lagi dengan /simpan <judul>.");
    return;
  }

  if (data === "confirm_save") {
    if (!state.fileId || !state.quality || !state.year || !state.genre?.length || state.rating === undefined || !state.duration || !state.description) {
      return answerCallback(env, q.id, "Data belum lengkap.");
    }
    await answerCallback(env, q.id, "Menyimpan film...");
    const id = await uniqueMovieId(env, state.title);
    const fileUrl = `${new URL("https://idflix-bot1.firman-uke29.workers.dev").origin}/file/${encodeURIComponent(state.fileId)}`;
    const movie = {
      title: state.title,
      year: state.year,
      genre: state.genre,
      duration: state.duration,
      rating: Number(state.rating),
      description: state.description,
      addedAt: Date.now(),
      videos: {[state.quality]: {videoUrl:fileUrl, telegramFileId:state.fileId}},
      videoUrl: fileUrl
    };
    await firebaseRequest(env, "PUT", `movies/${id}`, movie);
    await delState(env);

    const lines = [];
    if (env.IDFLIX_GROUP_ID && env.TOPIC_KV) {
      for (const genre of state.genre) {
        const key = `genre:${slugify(genre)}`;
        let threadId = await env.TOPIC_KV.get(key);
        if (!threadId) {
          try {
            const topic = await tg(env, "createForumTopic", {
              chat_id:env.IDFLIX_GROUP_ID,
              name:genre
            });
            threadId = String(topic.message_thread_id);
            await env.TOPIC_KV.put(key, threadId);
          } catch (e) {
            // Keep movie save successful even if topic creation fails.
          }
        }
        if (threadId) lines.push(`${genre}: topic ${threadId}`);
      }
    }
    await sendMessage(env, chatId,
      `✅ FILM BERHASIL DISIMPAN\n\n🎬 Judul: ${state.title}\n🆔 ID: ${id}\n🎞️ Kualitas: ${state.quality}\n📂 Genre: ${state.genre.join(", ")}\n\n☁️ Media tetap tersimpan di Telegram.`);

    if (env.IDFLIX_GROUP_ID) {
      for (const genre of state.genre) {
        const threadId = await env.TOPIC_KV?.get(`genre:${slugify(genre)}`);
        if (threadId) {
          try {
            await sendMessage(env, env.IDFLIX_GROUP_ID,
              `🎬 ${state.title}\n🎞️ ${state.quality}\n⭐ ${state.rating}\n📅 ${state.year}`,
              {message_thread_id:Number(threadId)});
          } catch {}
        }
      }
    }
    return;
  }

  if (data === "confirm_add") {
    if (!state.movieId || !state.fileId || !state.quality) return answerCallback(env, q.id, "Data belum lengkap.");
    const movie = await getMovie(env, state.movieId);
    if (!movie) return answerCallback(env, q.id, "Film tidak ditemukan.");
    if (movie.videos?.[state.quality]) return answerCallback(env, q.id, "Kualitas itu sudah ada.");
    const fileUrl = `${new URL("https://idflix-bot1.firman-uke29.workers.dev").origin}/file/${encodeURIComponent(state.fileId)}`;
    const videos = {...(movie.videos || {})};
    videos[state.quality] = {videoUrl:fileUrl, telegramFileId:state.fileId};
    await firebaseRequest(env, "PATCH", `movies/${state.movieId}`, {videos, videoUrl:movie.videoUrl || fileUrl});
    await delState(env);
    await answerCallback(env, q.id, "Kualitas berhasil ditambahkan.");
    await editMessage(env, chatId, msg.message_id, `✅ Kualitas ${state.quality} berhasil ditambahkan ke ${movie.title}.`);
    return;
  }
}

async function handleUpdate(update, env) {
  if (update.callback_query) {
    if (!isAdmin(update.callback_query.from, env)) {
      await answerCallback(env, update.callback_query.id, "Kamu tidak punya akses admin.");
      return;
    }
    await handleCallback(update.callback_query, env);
    return;
  }

  const msg = update?.message;
  if (!msg?.chat?.id) return;

  if (!isAdmin(msg.from, env)) {
    if (msg.text === "/id") await sendMessage(env, msg.chat.id, `Telegram ID kamu: ${msg.from?.id || "-"}`);
    else await sendMessage(env, msg.chat.id, "Kamu tidak punya akses admin.");
    return;
  }

  await handleAdminText(msg, env);
}

async function proxyTelegramFile(request, env) {
  const url = new URL(request.url);
  const prefix = "/file/";
  const fileId = decodeURIComponent(url.pathname.slice(prefix.length));
  if (!fileId) return new Response("Missing file_id", {status:400});

  const meta = await tg(env, "getFile", {file_id:fileId});
  const filePath = meta.file_path;
  const upstream = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`, {
    headers: request.headers.get("range") ? {range:request.headers.get("range")} : {}
  });
  const headers = new Headers(upstream.headers);
  headers.set("cache-control","public, max-age=3600");
  return new Response(upstream.body, {status:upstream.status, headers});
}

async function diagnostic(env) {
  const result = {
    ok: true,
    service: "idflix-bot1",
    checkedAt: new Date().toISOString(),

    config: {
      BOT_TOKEN: !!env.BOT_TOKEN,
      ADMIN_IDS: !!env.ADMIN_IDS,
      IDFLIX_GROUP_ID: !!env.IDFLIX_GROUP_ID,
      TOPIC_KV: !!env.TOPIC_KV,
      FIREBASE_CLIENT_EMAIL: !!env.FIREBASE_CLIENT_EMAIL,
      FIREBASE_PRIVATE_KEY: !!env.FIREBASE_PRIVATE_KEY
    },

    webhook: null
  };

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/getWebhookInfo`
    );

    const data = await response.json();

    if (!data.ok) {
      result.ok = false;

      result.webhook = {
        ok: false,
        telegramError: data.description || "Telegram API error"
      };

      return result;
    }

    const w = data.result || {};

    result.webhook = {
      ok: true,
      url: w.url || "",
      pending_update_count: Number(w.pending_update_count || 0),
      max_connections: w.max_connections ?? null,
      ip_address: w.ip_address || null,
      allowed_updates: Array.isArray(w.allowed_updates)
        ? w.allowed_updates
        : null,
      last_error_date: w.last_error_date
        ? new Date(w.last_error_date * 1000).toISOString()
        : null,
      last_error_message: w.last_error_message || null
    };

  } catch (e) {
    result.ok = false;

    result.webhook = {
      ok: false,
      error: String(e?.message || e).slice(0, 500)
    };
  }

  return result;
}

export default {
  async fetch(request, env) {
    if (!env.BOT_TOKEN) return json({ok:false,error:"BOT_TOKEN belum diatur"},500);

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/diagnostic") {
    return json(await diagnostic(env));
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("IDFLIX Telegram Bot Worker aktif.", {
        headers: {"content-type":"text/plain; charset=utf-8"}
      });
    }
    if (request.method === "GET" && url.pathname.startsWith("/file/")) {
      try { return await proxyTelegramFile(request, env); }
      catch (e) { return new Response(String(e.message || e), {status:502}); }
    }
    if (request.method !== "POST") return new Response("Method Not Allowed",{status:405});

    try {
      const update = await request.json();
      await handleUpdate(update, env);
      return json({ok:true});
    } catch (e) {
      try {
        const adminIds = String(env.ADMIN_IDS || "")
          .split(",")
          .map(x => x.trim())
          .filter(Boolean);
    
        const errorText =
          `⚠️ WORKER ERROR\n\n` +
          `${String(e?.message || e).slice(0,1200)}`;
    
        for (const adminId of adminIds) {
          try {
            await sendMessage(env, adminId, errorText);
          } catch (_) {}
        }
      } catch (_) {}
    
      return json({
        ok: false,
        error: "internal_error"
      }, 500);
    }
  }
};

