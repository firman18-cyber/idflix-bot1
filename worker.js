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

const SUBTITLE_TIMEOUT_MS = 12000;
const SUBTITLE_MAX_BYTES = 5 * 1024 * 1024;

function isAdmin(from, env) {
  const ids = String(env.ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
  return ids.includes(String(from?.id || ""));
}

// Error Telegram yang tidak fatal dan tidak boleh menggagalkan Worker.
const NON_FATAL_TG_ERROR = /message is not modified|query is too old|response timeout expired|query id is invalid/i;

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: {"content-type":"application/json"},
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!data.ok) {
    const desc = String(data.description || "unknown error");
    if (NON_FATAL_TG_ERROR.test(desc)) {
      // Non-fatal: jangan lempar error, biarkan alur tetap berjalan.
      return null;
    }
    throw new Error(`Telegram ${method}: ${desc}`);
  }
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

  // Jika Secret tersimpan sebagai string JSON dengan tanda kutip
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      value = JSON.parse(value);
    } catch (_) {
      value = value.slice(1, -1);
    }
  }

  // Ubah literal \n menjadi newline asli
  value = value.replace(/\\r\\n/g, "\n");
  value = value.replace(/\\n/g, "\n");
  value = value.replace(/\r/g, "");

  // Ambil isi di antara header/footer PEM
  const match = value.match(
    /-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/
  );

  if (!match) {
    throw new Error(
      "FIREBASE_PRIVATE_KEY tidak memiliki format -----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----."
    );
  }

  const b64 = match[1].replace(/\s/g, "");

  if (!b64) {
    throw new Error("Isi FIREBASE_PRIVATE_KEY kosong.");
  }

  // Decode Base64 tanpa validasi regex yang terlalu ketat
  let bin;

  try {
    bin = atob(b64);
  } catch (_) {
    throw new Error(
      "Isi FIREBASE_PRIVATE_KEY gagal di-decode sebagai Base64. Pastikan private_key berasal dari Firebase Service Account JSON."
    );
  }

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

// ---- Series (movies/<id>.type = "series", episodes/<epId>) -------------
// Struktur mengikuti web IDFLIX (lihat SERIES.md di repo web):
//   movies/<id>/episodes/s<musim>e<nomor> = {season, number, title?, duration?,
//     videos:{<quality>:{videoUrl, provider, subtitle?}}, addedAt}
const isSeriesMovie = m => m?.type === "series" || (!!m?.episodes && typeof m.episodes === "object");
const episodeId = (season, number) => `s${season}e${number}`;

function episodeList(movie) {
  const raw = movie?.episodes;
  if (!raw || typeof raw !== "object") return [];
  const entries = Array.isArray(raw) ? raw.map((e, i) => [String(i), e]) : Object.entries(raw);
  return entries
    .filter(([, e]) => e && typeof e === "object")
    .map(([id, e], i) => ({
      id,
      season: Number(e.season) || 1,
      number: Number(e.number ?? e.episode) || i + 1,
      title: String(e.title || ""),
      videos: (e.videos && typeof e.videos === "object") ? e.videos : {}
    }))
    .sort((a, b) => a.season - b.season || a.number - b.number);
}

// Terima ketikan bebas: "2", "season 2", "Season2", "musim 2", "s2"  /  "3", "eps 3", "episode 3", "ep3", "e3".
function parseSeasonInput(text) {
  const m = String(text || "").trim().match(/^(?:season|musim|s)?\s*0*(\d{1,2})$/i);
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= 99 ? n : 0;
}
function parseEpisodeInput(text) {
  const m = String(text || "").trim().match(/^(?:episode|eps|ep|e)?\s*\.?\s*0*(\d{1,3})$/i);
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= 999 ? n : 0;
}

// Kirim kartu singkat ke topic genre di grup (sama seperti alur /simpan).
async function announceGenreTopics(env, genres, text) {
  if (!env.TELEGRAM_CHAT_ID || !env.TOPIC_KV) return;
  for (const genre of genres || []) {
    const key = `genre:${slugify(genre)}`;
    let threadId = await env.TOPIC_KV.get(key);
    if (!threadId) {
      try {
        const topic = await tg(env, "createForumTopic", {chat_id: env.TELEGRAM_CHAT_ID, name: genre});
        threadId = topic ? String(topic.message_thread_id) : null;
        if (threadId) await env.TOPIC_KV.put(key, threadId);
      } catch (e) {
        // Penyimpanan tetap sukses walau topic gagal dibuat.
      }
    }
    if (threadId) {
      try { await sendMessage(env, env.TELEGRAM_CHAT_ID, text, {message_thread_id: Number(threadId)}); } catch {}
    }
  }
}

// ---- TOPIC_KV helpers -------------------------------------------------
// Semua state (percakapan admin, poster sementara, draft, topic genre)
// disimpan di binding KV bernama TOPIC_KV. Jika binding tidak terhubung,
// lempar error yang jelas alih-alih gagal diam-diam.
function requireKV(env) {
  if (!env.TOPIC_KV) {
    throw new Error("TOPIC_KV belum terhubung. Periksa binding KV di wrangler.jsonc.");
  }
}

function stateKey(userId) { return `state:${userId}`; }
async function getState(env, userId) {
  requireKV(env);
  return await env.TOPIC_KV.get(stateKey(userId), "json");
}
async function putState(env, userId, state) {
  requireKV(env);
  await env.TOPIC_KV.put(stateKey(userId), JSON.stringify(state), {expirationTtl: 86400});
}
async function delState(env, userId) {
  requireKV(env);
  await env.TOPIC_KV.delete(stateKey(userId));
}

// Poster sementara: file_id poster terakhir yang diupload tiap admin,
// menunggu dipakai oleh /simpan <judul>.
function posterKey(userId) { return `poster:${userId}`; }
async function putLastPoster(env, userId, fileId) {
  requireKV(env);
  await env.TOPIC_KV.put(posterKey(userId), fileId, {expirationTtl: 21600}); // 6 jam
}
async function getLastPoster(env, userId) {
  requireKV(env);
  return await env.TOPIC_KV.get(posterKey(userId));
}

// ---- Validasi URL video (generic, tidak dikunci ke provider tertentu) --
function isValidVideoUrl(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  if (!s.startsWith("https://")) return false;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !!u.hostname;
  } catch {
    return false;
  }
}


// ---- Subtitle manual (Bagian B) -----------------------------------------
// Migrasi runtime untuk film lama yang hanya punya {videoUrl, quality} di
// root (tanpa map "videos"). TIDAK menghapus field lama itu — hanya
// menyusun map "videos" yang setara untuk dipakai baca/tulis quality.
function migratedVideos(movie) {
  const videos = {...(movie?.videos || {})};
  if (movie?.quality && movie?.videoUrl && !videos[movie.quality] && QUALITIES.includes(movie.quality)) {
    videos[movie.quality] = {videoUrl: movie.videoUrl, provider: movie.provider || "custom"};
  }
  return videos;
}

// Quality yang tersedia untuk sebuah film, aman untuk film lama yang
// hanya punya {videoUrl, quality} tanpa map "videos". Hanya quality resmi
// (QUALITIES) yang ditawarkan — bukan CAM/UNKNOWN.
function getAvailableQualities(movie) {
  const videos = migratedVideos(movie);
  return QUALITIES.filter(q => videos[q]);
}

function subtitleQualityKeyboard(qualities) {
  const rows = [];
  for (let i = 0; i < qualities.length; i += 3) {
    rows.push(qualities.slice(i, i + 3).map(q => ({text: q, callback_data: `sub_q:${q}`})));
  }
  rows.push([{text: "❌ Batal", callback_data: "cancel"}]);
  return {inline_keyboard: rows};
}

// Konversi SRT sederhana ke WebVTT: ganti koma->titik pada timestamp,
// hapus nomor urutan cue, pastikan header WEBVTT.
function srtToVtt(srt) {
  let text = String(srt || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  text = text.replace(/^\uFEFF/, "");
  // Dukung jam 1 atau 2 digit (0:01:02,500 maupun 00:01:02,500); hasil
  // dinormalisasi ke jam 2 digit + titik desimal sesuai format WebVTT.
  text = text.replace(/(\d{1,2}):(\d{2}):(\d{2}),(\d{3})/g,
    (_, h, m, sec, ms) => `${h.padStart(2,"0")}:${m}:${sec}.${ms}`);
  text = text.replace(/^\d+\s*$/gm, "");
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return `WEBVTT\n\n${text}\n`;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range"
  };
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

function videoSourceKeyboard(mode) {
  return {inline_keyboard:[
    [{text:"🔗 Link Video", callback_data:`source:link:${mode}`}],
    [{text:"🎥 Upload Video", callback_data:`source:upload:${mode}`}],
    [{text:"❌ Batal", callback_data:"cancel"}]
  ]};
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

function addQualityKeyboard() {
  return {inline_keyboard:[
    [{text:"✅ SIMPAN", callback_data:"confirm_add"}],
    [{text:"❌ Batal", callback_data:"cancel"}]
  ]};
}

function seriesConfirmKeyboard() {
  return {inline_keyboard:[
    [{text:"✅ SIMPAN SERIES", callback_data:"series_save"}],
    [{text:"❌ BATAL", callback_data:"cancel"}]
  ]};
}

function epsSeasonKeyboard(seasons) {
  const next = (seasons.length ? Math.max(...seasons) : 0) + 1;
  const rows = [];
  for (let i = 0; i < seasons.length; i += 4) {
    rows.push(seasons.slice(i, i + 4).map(n => ({text: `Musim ${n}`, callback_data: `eps_season:${n}`})));
  }
  rows.push([{text: seasons.length ? `➕ Musim ${next} (baru)` : "Musim 1", callback_data: `eps_season:${next}`}]);
  rows.push([{text:"❌ Batal", callback_data:"cancel"}]);
  return {inline_keyboard: rows};
}

function epsNumberKeyboard(existingNumbers, next) {
  const rows = [[{text: `➕ Eps ${next} (berikutnya)`, callback_data: `eps_num:${next}`}]];
  const nums = [...existingNumbers].sort((a, b) => a - b).slice(-24);
  for (let i = 0; i < nums.length; i += 4) {
    rows.push(nums.slice(i, i + 4).map(n => ({text: `✅ Eps ${n}`, callback_data: `eps_num:${n}`})));
  }
  rows.push([{text:"❌ Batal", callback_data:"cancel"}]);
  return {inline_keyboard: rows};
}

function skipKeyboard(field) {
  return {inline_keyboard:[
    [{text:"⏭️ Lewati", callback_data:`eps_skip:${field}`}],
    [{text:"❌ Batal", callback_data:"cancel"}]
  ]};
}

function epsConfirmKeyboard(existing) {
  return {inline_keyboard:[
    [{text: existing ? "✅ TAMBAH KUALITAS" : "✅ SIMPAN EPISODE", callback_data:"eps_save"}],
    [{text:"❌ Batal", callback_data:"cancel"}]
  ]};
}

function afterEpsKeyboard(nextNumber) {
  return {inline_keyboard:[
    [{text:`➕ Episode berikutnya (Eps ${nextNumber})`, callback_data:"eps_next"}],
    [{text:"✅ Selesai", callback_data:"eps_done"}]
  ]};
}

function subtitleEpisodeKeyboard(eps, page = 0) {
  const PAGE = 24;
  const pages = Math.max(1, Math.ceil(eps.length / PAGE));
  const cur = Math.min(Math.max(0, page), pages - 1);
  const slice = eps.slice(cur * PAGE, cur * PAGE + PAGE);
  const rows = [];
  for (let i = 0; i < slice.length; i += 3) {
    rows.push(slice.slice(i, i + 3).map(e => ({text: `S${e.season} E${e.number}`, callback_data: `sub_ep:${e.id}`})));
  }
  if (pages > 1) {
    const nav = [];
    if (cur > 0) nav.push({text:"⬅️ Sebelumnya", callback_data:`sub_pg:${cur - 1}`});
    if (cur < pages - 1) nav.push({text:"Berikutnya ➡️", callback_data:`sub_pg:${cur + 1}`});
    rows.push(nav);
  }
  rows.push([{text:"❌ Batal", callback_data:"cancel"}]);
  return {inline_keyboard: rows};
}

function formatSeriesSummary(s) {
  return `📺 KONFIRMASI SERIES

Judul: ${s.title}
Tahun: ${s.year || "-"}
Genre: ${(s.genre || []).join(", ") || "-"}
Rating: ${s.rating ?? "-"}
Deskripsi: ${s.description || "-"}
🖼️ Poster: ${s.posterFileId ? "tersimpan (dari Telegram)" : "-"}

Episode ditambahkan setelah series disimpan.`;
}

function formatEpsSummary(s) {
  return `📺 KONFIRMASI EPISODE

Series: ${s.movieTitle}
Musim: ${s.season} • Eps: ${s.number}
${s.existing ? "Mode: tambah kualitas ke episode yang sudah ada" : `Judul episode: ${s.epTitle || "-"}\nDurasi: ${s.duration || "-"}`}
Kualitas: ${s.quality}

🔗 Video URL: ${s.videoUrl}`;
}

// Pilih nomor episode: cek apakah episode itu sudah ada (untuk tambah kualitas).
async function setEpisodeNumber(env, state, n) {
  const movie = await getMovie(env, state.movieId);
  const found = episodeList(movie).find(e => e.season === state.season && e.number === n);
  state.number = n;
  state.existing = !!found;
  state.existingQualities = found ? Object.keys(found.videos) : [];
  state.epId = found ? found.id : episodeId(state.season, n);
  state.epTitle = found ? found.title : undefined;
  for (const k of ["sourceType", "videoUrl", "videoMessageId", "videoProvider", "quality", "duration"]) delete state[k];
  state.step = "await_source";
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

🔗 Video URL: ${s.videoUrl}
🖼️ Poster: ${s.posterFileId ? "tersimpan (dari Telegram)" : "-"}`;
}

async function askNext(env, state, chatId) {
  if (state.mode === "simpan") {
    if (state.sourceType === "link" && !state.videoUrl) {
      await sendMessage(env, chatId, "🔗 Kirim link video (harus diawali https://, boleh dari hosting mana saja).");
      return;
    }
    if (state.sourceType === "upload" && !state.videoMessageId) {
      await sendMessage(env, chatId, "🎥 Kirim video Telegram sekarang.");
      return;
    }
    if (!state.sourceType) {
      await sendMessage(env, chatId, "🎬 Pilih sumber video:", {reply_markup:videoSourceKeyboard("simpan")});
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
  } else if (state.mode === "series") {
    if (!state.year) {
      await sendMessage(env, chatId, "📅 Masukkan tahun rilis series, contoh: 2026");
      return;
    }
    if (!state.genre) {
      state.genre = [];
      await putState(env, state.userId, state);
      await sendMessage(env, chatId, "🎭 PILIH GENRE SERIES\n\nPilih satu atau beberapa genre.", {reply_markup:genreKeyboard([])});
      return;
    }
    if (state.rating === undefined) {
      await sendMessage(env, chatId, "⭐ Masukkan rating, contoh: 8.5");
      return;
    }
    if (!state.description) {
      await sendMessage(env, chatId, "📝 Masukkan deskripsi series.");
      return;
    }
    await sendMessage(env, chatId, formatSeriesSummary(state), {reply_markup:seriesConfirmKeyboard()});
  } else if (state.mode === "eps") {
    if (!state.season) {
      const movie = await getMovie(env, state.movieId);
      const seasons = [...new Set(episodeList(movie).map(e => e.season))].sort((a, b) => a - b);
      await sendMessage(env, chatId,
        `📺 ${state.movieTitle}\n\nPilih musim lewat tombol, atau ketik langsung, contoh: season 1 / season 2`,
        {reply_markup: epsSeasonKeyboard(seasons)});
      return;
    }
    if (!state.number) {
      const movie = await getMovie(env, state.movieId);
      const inSeason = episodeList(movie).filter(e => e.season === state.season);
      const next = (inSeason.length ? Math.max(...inSeason.map(e => e.number)) : 0) + 1;
      await sendMessage(env, chatId,
        `📺 ${state.movieTitle} — Musim ${state.season}\n\nPilih nomor episode lewat tombol, atau ketik langsung, contoh: eps 3` +
        (inSeason.length ? "\nEpisode bertanda ✅ sudah ada (dipakai untuk menambah kualitas)." : ""),
        {reply_markup: epsNumberKeyboard(inSeason.map(e => e.number), next)});
      return;
    }
    if (!state.existing && state.epTitle === undefined) {
      await sendMessage(env, chatId,
        `📝 Judul episode (Musim ${state.season} Eps ${state.number}).\nKetik judulnya, atau lewati.`,
        {reply_markup: skipKeyboard("title")});
      return;
    }
    if (state.sourceType === "link" && !state.videoUrl) {
      await sendMessage(env, chatId, "🔗 Kirim link video episode (harus diawali https://).");
      return;
    }
    if (state.sourceType === "upload" && !state.videoMessageId) {
      await sendMessage(env, chatId, "🎥 Kirim video Telegram sekarang.");
      return;
    }
    if (!state.sourceType) {
      await sendMessage(env, chatId,
        `🎬 Musim ${state.season} Eps ${state.number}\n\nPilih sumber video:`,
        {reply_markup:videoSourceKeyboard("eps")});
      return;
    }
    if (!state.quality) {
      await sendMessage(env, chatId, "🎞️ PILIH KUALITAS VIDEO", {reply_markup:qualityKeyboard()});
      return;
    }
    if (!state.existing && state.duration === undefined) {
      await sendMessage(env, chatId,
        "⏱️ Durasi episode, contoh: 45m. Ketik durasinya, atau lewati.",
        {reply_markup: skipKeyboard("duration")});
      return;
    }
    await sendMessage(env, chatId, formatEpsSummary(state), {reply_markup: epsConfirmKeyboard(state.existing)});
  } else if (state.mode === "tambah") {
    if (state.sourceType === "link" && !state.videoUrl) {
      await sendMessage(env, chatId, "🔗 Kirim link video kualitas tambahan (harus diawali https://).");
      return;
    }
    if (state.sourceType === "upload" && !state.videoMessageId) {
      await sendMessage(env, chatId, "🎥 Kirim video Telegram sekarang.");
      return;
    }
    if (!state.sourceType) {
      await sendMessage(env, chatId, "🎬 Pilih sumber video:", {reply_markup:videoSourceKeyboard("tambah")});
      return;
    }
    if (!state.quality) {
      await sendMessage(env, chatId, "🎞️ PILIH KUALITAS VIDEO", {reply_markup:qualityKeyboard()});
      return;
    }
    await sendMessage(env, chatId,
      `🎬 ${state.title}\n\nKualitas: ${state.quality}\n🔗 URL: ${state.videoUrl}\n\nKlik SIMPAN untuk menambahkan kualitas ini.`,
      {reply_markup:addQualityKeyboard()});
  }
}

function buildTeleplayVideoUrl(env, messageId) {
  const base = String(env.TELEPLAY_BASE_URL || "https://idflix-teleplay.killua.blitz.cloud").trim().replace(/\/+$/, "");
  const token = String(env.TELEPLAY_STREAM_TOKEN || "").trim();
  if (!base || !messageId) return "";
  const url = `${base}/stream/${encodeURIComponent(String(messageId))}`;
  return token ? `${url}?token=${encodeURIComponent(token)}` : url;
}

async function storeUploadedVideo(env, msg, state, chatId) {
  if (!env.TELEGRAM_CHAT_ID) {
    await sendMessage(env, chatId, "❌ TELEGRAM_CHAT_ID belum dikonfigurasi untuk penyimpanan video.");
    return false;
  }

  if (!env.TELEPLAY_STREAM_TOKEN) {
    await sendMessage(env, chatId, "❌ TELEPLAY_STREAM_TOKEN belum dikonfigurasi.");
    return false;
  }

  try {
    // Salin media Telegram ke group storage. Teleplay mengambil media dari
    // message_id hasil copy tersebut melalui MTProto, jadi Worker tidak
    // pernah mengunduh file video ke memory/filesystem.
    const copied = await tg(env, "copyMessage", {
      chat_id: env.TELEGRAM_CHAT_ID,
      from_chat_id: msg.chat.id,
      message_id: msg.message_id
    });
    const messageId = copied?.message_id;
    const videoUrl = buildTeleplayVideoUrl(env, messageId);
    if (!messageId || !videoUrl) {
      throw new Error("copyMessage tidak mengembalikan message_id Teleplay.");
    }

    state.videoMessageId = messageId;
    state.videoProvider = "teleplay";
    state.videoUrl = videoUrl;
    state.step = "await_quality";
    await putState(env, state.userId, state);

    await sendMessage(env, chatId,
      `✅ Video berhasil disimpan ke Teleplay.\n\n🎞️ Sekarang pilih kualitas video:`,
      {reply_markup:qualityKeyboard()}
    );
    return true;
  } catch (e) {
    await sendMessage(env, chatId, `❌ Gagal menyimpan video ke Teleplay.\n\n${String(e?.message || e).slice(0, 500)}\n\nKirim ulang video untuk mencoba lagi.`);
    return false;
  }
}

async function handleAdminText(msg, env) {
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  const text = String(msg.text || "").trim();

  // /poster memiliki alur terpisah dari /simpan. Jika admin sedang
  // menunggu artwork, foto langsung diterapkan ke film yang dipilih.
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const posterState = await getState(env, userId);
    if (posterState?.mode === "poster" && posterState.step === "await_photo") {
      const largest = msg.photo[msg.photo.length - 1];
      const movie = await getMovie(env, posterState.movieId);
      if (!movie) {
        await delState(env, userId);
        await sendMessage(env, chatId, "❌ Film tidak ditemukan lagi di database.");
        return;
      }

      const field = posterState.artworkType === "backdrop" ? "backdrop" : "posterFileId";
      const label = field === "backdrop" ? "Backdrop" : "Poster";
      await firebaseRequest(env, "PATCH", `movies/${posterState.movieId}`, {
        [field]: largest.file_id
      });
      await delState(env, userId);
      await sendMessage(env, chatId,
        `✅ ${label} untuk ${movie.title} berhasil ${movie[field] ? "diperbarui" : "ditambahkan"}.`);
      return;
    }

    // Perilaku lama /simpan tetap dipertahankan: foto biasa menjadi
    // poster sementara untuk dipakai oleh /simpan <judul>.
    const largest = msg.photo[msg.photo.length - 1];
    await putLastPoster(env, userId, largest.file_id);
    await sendMessage(env, chatId, "🖼️ Poster diterima dan disimpan sementara.\n\nGunakan /simpan <judul> untuk melanjutkan.");
    return;
  }

  // Upload video untuk /simpan atau /tambah. Video langsung dicopy ke
  // group storage lalu URL streaming Teleplay disimpan di state.
  const stateForVideo = await getState(env, userId);
  const isVideoDocument = !!msg.document && String(msg.document.mime_type || "").toLowerCase().startsWith("video/");
  if ((msg.video || isVideoDocument) &&
      (stateForVideo?.mode === "simpan" || stateForVideo?.mode === "tambah" || stateForVideo?.mode === "eps") &&
      stateForVideo.sourceType === "upload" &&
      stateForVideo.step === "await_video_upload" &&
      !stateForVideo.videoMessageId) {
    const stored = await storeUploadedVideo(env, msg, stateForVideo, chatId);
    if (stored) return;
    return;
  }

  // File subtitle (.srt/.vtt) dikirim sebagai Telegram document, hanya
  // diproses jika admin sedang berada dalam alur /subtitle.
  if (msg.document) {
    const state = await getState(env, userId);
    if (state?.mode === "subtitle" && state.step === "await_subtitle_file") {
      const fileName = String(msg.document.file_name || "");
      const ext = (fileName.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
      if (ext !== "srt" && ext !== "vtt") {
        await sendMessage(env, chatId, "❌ Format subtitle tidak didukung.\nGunakan .srt atau .vtt");
        return;
      }
      const movie = await getMovie(env, state.movieId);
      if (!movie) {
        await delState(env, userId);
        await sendMessage(env, chatId, "❌ Film tidak ditemukan lagi di database.");
        return;
      }
      if (state.episodeId) {
        const ep = episodeList(movie).find(e => e.id === state.episodeId);
        if (!ep || !ep.videos[state.quality]) {
          await delState(env, userId);
          await sendMessage(env, chatId, "❌ Episode atau kualitas tersebut tidak lagi tersedia.");
          return;
        }
        const hadEpSubtitle = !!ep.videos[state.quality].subtitle;
        await firebaseRequest(env, "PATCH", `movies/${state.movieId}/episodes/${state.episodeId}/videos/${state.quality}`, {
          subtitle: {
            fileId: msg.document.file_id,
            fileName: fileName || `subtitle.${ext}`,
            language: "id",
            format: ext
          }
        });
        await delState(env, userId);
        await sendMessage(env, chatId, hadEpSubtitle
          ? `✅ Subtitle ${state.episodeLabel} (${state.quality}) berhasil diperbarui.`
          : `✅ Subtitle ${state.episodeLabel} (${state.quality}) berhasil disimpan.`);
        return;
      }
      const videos = migratedVideos(movie);
      if (!videos[state.quality]) {
        await delState(env, userId);
        await sendMessage(env, chatId, "❌ Kualitas tersebut tidak lagi tersedia pada film ini.");
        return;
      }
      const hadSubtitle = !!videos[state.quality].subtitle;
      videos[state.quality] = {
        ...videos[state.quality],
        subtitle: {
          fileId: msg.document.file_id,
          fileName: fileName || `subtitle.${ext}`,
          language: "id",
          format: ext
        }
      };
      await firebaseRequest(env, "PATCH", `movies/${state.movieId}`, {videos});
      await delState(env, userId);
      await sendMessage(env, chatId, hadSubtitle
        ? `✅ Subtitle ${state.quality} berhasil diperbarui.`
        : `✅ Subtitle ${state.quality} berhasil disimpan.`);
      return;
    }
    // Document di luar alur /subtitle: abaikan, jangan ganggu fitur lain.
    return;
  }

  if (text === "/id") {
    await sendMessage(env, chatId, `Telegram ID kamu: ${msg.from.id}`);
    return;
  }
  if (text === "/start") {
    await sendMessage(env, chatId,
      "IDFLIX Bot aktif.\n\n" +
      "1. /poster — tambah poster atau backdrop\n" +
      "2. /simpan <judul> — tambah film baru\n" +
      "3. /tambah <judul> — tambah kualitas video ke film yang sudah ada\n\n" +
      "Series:\n" +
      "4. /series <judul> — simpan series baru (lalu lanjut tambah episode)\n" +
      "5. /eps <judul series> — tambah episode, atau kualitas episode yang sudah ada\n\n" +
      "/subtitle <judul> — upload subtitle .srt/.vtt (film atau episode series)\n" +
      "/list — daftar film\n/batal — batalkan proses\n/id — lihat Telegram ID\n/ping — tes bot");
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

  if (text === "/list") {
    const movies = await firebaseRequest(env, "GET", "movies") || {};
    const entries = Object.entries(movies);
    if (!entries.length) {
      await sendMessage(env, chatId, "📭 Belum ada film di database.");
      return;
    }
    entries.sort((a,b) => (Number(b[1]?.addedAt)||0) - (Number(a[1]?.addedAt)||0));
    const top = entries.slice(0, 20);
    const lines = top.map(([id, m]) => {
      if (isSeriesMovie(m)) {
        const eps = episodeList(m);
        const seasons = new Set(eps.map(e => e.season)).size;
        return `• 📺 ${m.title || id} (${id})\n  Tahun: ${m.year || "-"} | Series: ${seasons} musim, ${eps.length} eps`;
      }
      const qualities = m.videos ? Object.keys(m.videos).join(", ") : (m.quality || "-");
      return `• ${m.title || id} (${id})\n  Tahun: ${m.year || "-"} | Kualitas: ${qualities || "-"}`;
    });
    const extra = entries.length > 20 ? `\n\n...dan ${entries.length - 20} film lainnya.` : "";
    await sendMessage(env, chatId, `📚 DAFTAR FILM (${entries.length})\n\n${lines.join("\n\n")}${extra}`);
    return;
  }

  if (text === "/poster") {
    await putState(env, userId, {
      userId, mode: "poster", step: "await_artwork_type", chatId, createdAt: Date.now()
    });
    await sendMessage(env, chatId, "🖼️ Tambah Artwork\n\nPilih yang ingin ditambahkan:", {
      reply_markup: {inline_keyboard: [
        [{text: "🖼️ Poster", callback_data: "art_type:poster"}],
        [{text: "🌄 Backdrop", callback_data: "art_type:backdrop"}],
        [{text: "❌ Batalkan", callback_data: "cancel"}]
      ]}
    });
    return;
  }

  if (text.startsWith("/simpan ")) {
    const title = text.slice(8).trim();
    if (!title) return sendMessage(env, chatId, "Format: /simpan <judul>");
    const posterFileId = await getLastPoster(env, userId);
    if (!posterFileId) {
      await sendMessage(env, chatId, "⚠️ Kirim poster film terlebih dahulu (upload gambar), lalu jalankan /simpan <judul> lagi.");
      return;
    }
    const state = {userId, mode:"simpan", title, posterFileId, createdAt:Date.now(), chatId, step:"await_source"};
    await putState(env, userId, state);
    await sendMessage(env, chatId, `🎬 Tambah Film\n\nJudul: ${title}\n🖼️ Poster: tersimpan\n\nPilih sumber video:`, {reply_markup:videoSourceKeyboard("simpan")});
    return;
  }

  if (text === "/series") {
    await sendMessage(env, chatId, "Format: /series <judul>\n\nKirim poster series dulu (upload gambar), lalu jalankan perintah ini.");
    return;
  }

  if (text.startsWith("/series ")) {
    const title = text.slice(8).trim();
    if (!title) return sendMessage(env, chatId, "Format: /series <judul>");
    const existing = await findMovieByTitle(env, title);
    if (existing) {
      if (!isSeriesMovie(existing.movie)) {
        return sendMessage(env, chatId, `❌ "${existing.movie.title}" sudah ada sebagai film (bukan series). Gunakan judul lain.`);
      }
      const st = {userId, mode:"eps", chatId, movieId:existing.id, movieTitle:existing.movie.title, createdAt:Date.now()};
      await putState(env, userId, st);
      await sendMessage(env, chatId, `📺 Series "${existing.movie.title}" sudah ada. Lanjut menambah episode.`);
      await askNext(env, st, chatId);
      return;
    }
    const posterFileId = await getLastPoster(env, userId);
    if (!posterFileId) {
      await sendMessage(env, chatId, "⚠️ Kirim poster series terlebih dahulu (upload gambar), lalu jalankan /series <judul> lagi.");
      return;
    }
    const st = {userId, mode:"series", title, posterFileId, createdAt:Date.now(), chatId, step:"await_year"};
    await putState(env, userId, st);
    await sendMessage(env, chatId, `📺 Tambah Series\n\nJudul: ${title}\n🖼️ Poster: tersimpan`);
    await askNext(env, st, chatId);
    return;
  }

  if (text === "/eps") {
    await sendMessage(env, chatId, "Format: /eps <judul series>");
    return;
  }

  if (text.startsWith("/eps ")) {
    const title = text.slice(5).trim();
    if (!title) return sendMessage(env, chatId, "Format: /eps <judul series>");
    const found = await findMovieByTitle(env, title);
    if (!found) return sendMessage(env, chatId, `❌ Series "${title}" belum ditemukan. Buat dulu dengan /series ${title}`);
    if (!isSeriesMovie(found.movie)) {
      return sendMessage(env, chatId, `❌ "${found.movie.title}" adalah film, bukan series. Untuk film gunakan /tambah.`);
    }
    const st = {userId, mode:"eps", chatId, movieId:found.id, movieTitle:found.movie.title, createdAt:Date.now()};
    await putState(env, userId, st);
    await askNext(env, st, chatId);
    return;
  }

  if (text.startsWith("/tambah ")) {
    const title = text.slice(8).trim();
    if (!title) return sendMessage(env, chatId, "Format: /tambah <judul>");
    const found = await findMovieByTitle(env, title);
    if (!found) return sendMessage(env, chatId, `❌ Film "${title}" belum ditemukan di Firebase.`);
    if (isSeriesMovie(found.movie)) {
      return sendMessage(env, chatId, `📺 "${found.movie.title}" adalah series. Gunakan /eps ${found.movie.title} untuk menambah episode atau kualitas episode.`);
    }
    const state = {userId, mode:"tambah", title:found.movie.title, movieId:found.id, createdAt:Date.now(), chatId, step:"await_source"};
    await putState(env, userId, state);
    await sendMessage(env, chatId, `🎬 Tambah Kualitas\n\nFilm: ${found.movie.title}\n\nPilih sumber video:`, {reply_markup:videoSourceKeyboard("tambah")});
    return;
  }


  if (text.startsWith("/subtitle ")) {
    const title = text.slice(10).trim();
    if (!title) return sendMessage(env, chatId, "Format: /subtitle <judul film>");
    const found = await findMovieByTitle(env, title);
    if (!found) return sendMessage(env, chatId, `❌ Film "${title}" tidak ditemukan di database.`);
    if (isSeriesMovie(found.movie)) {
      const eps = episodeList(found.movie).filter(e => QUALITIES.some(q => e.videos[q]));
      if (!eps.length) {
        return sendMessage(env, chatId, `⚠️ Series "${found.movie.title}" belum memiliki episode berkualitas video.`);
      }
      await putState(env, userId, {
        userId, mode: "subtitle", chatId, isSeries: true,
        movieId: found.id, movieTitle: found.movie.title, createdAt: Date.now()
      });
      await sendMessage(env, chatId, `📺 ${found.movie.title}\n\nPilih episode:`,
        {reply_markup: subtitleEpisodeKeyboard(eps, 0)});
      return;
    }
    const availableQualities = getAvailableQualities(found.movie);
    if (!availableQualities.length) {
      return sendMessage(env, chatId, `⚠️ Film "${found.movie.title}" belum memiliki kualitas video apapun.`);
    }
    const state = {
      userId, mode: "subtitle", chatId,
      movieId: found.id, movieTitle: found.movie.title,
      availableQualities, createdAt: Date.now()
    };
    await putState(env, userId, state);
    await sendMessage(env, chatId, `🎬 ${found.movie.title}\n\nPilih kualitas subtitle:`,
      {reply_markup: subtitleQualityKeyboard(availableQualities)});
    return;
  }

  const state = await getState(env, userId);
  if (!state) return;

  if (state.mode === "poster") {
    if (state.step === "await_title") {
      if (!text) {
        await sendMessage(env, chatId, "❌ Masukkan judul film.");
        return;
      }
      const found = await findMovieByTitle(env, text);
      if (!found) {
        await sendMessage(env, chatId, `❌ Film "${text}" tidak ditemukan di Firebase.\n\nMasukkan judul film yang sudah ada atau /batal.`);
        return;
      }
      state.movieId = found.id;
      state.movieTitle = found.movie.title;
      state.step = "await_photo";
      await putState(env, userId, state);
      const label = state.artworkType === "backdrop" ? "backdrop" : "poster";
      await sendMessage(env, chatId, `🎬 ${found.movie.title}\n\nKirim gambar ${label} sekarang.`);
    }
    return;
  }

  if (!text) return; // abaikan pesan non-teks lain di luar flow yang dikenal


  if (state.mode === "series") {
    if (!state.year) {
      if (!/^\d{4}$/.test(text)) return sendMessage(env, chatId, "❌ Tahun harus 4 digit, contoh: 2026.");
      state.year = Number(text);
    } else if (!state.genre?.length) {
      return; // genre dipilih lewat tombol
    } else if (state.rating === undefined) {
      const n = Number(text.replace(",", "."));
      if (!Number.isFinite(n) || n < 0 || n > 10) return sendMessage(env, chatId, "❌ Rating harus angka 0–10.");
      state.rating = n;
    } else if (!state.description) {
      state.description = text;
    } else {
      return;
    }
    await putState(env, userId, state);
    await askNext(env, state, chatId);
    return;
  }

  if (state.mode === "eps") {
    if (!state.season) {
      const sn = parseSeasonInput(text);
      if (!sn) return sendMessage(env, chatId, "❌ Tulis nomor musim, contoh: season 2 (atau cukup 2). Bisa 1–99.");
      state.season = sn;
    } else if (!state.number) {
      const en = parseEpisodeInput(text);
      if (!en) return sendMessage(env, chatId, "❌ Tulis nomor episode, contoh: eps 3 (atau cukup 3). Bisa 1–999.");
      await setEpisodeNumber(env, state, en);
    } else if (!state.existing && state.epTitle === undefined) {
      state.epTitle = text.slice(0, 120);
    } else if (!state.sourceType) {
      await sendMessage(env, chatId, "🎬 Pilih sumber video terlebih dahulu.", {reply_markup:videoSourceKeyboard("eps")});
      return;
    } else if (state.sourceType === "link" && state.step === "await_video_url" && !state.videoUrl) {
      if (!isValidVideoUrl(text)) {
        await sendMessage(env, chatId, "❌ URL tidak valid. URL harus diawali https:// dan berupa link yang valid.\n\n🔗 Kirim link video.");
        return;
      }
      state.videoUrl = text;
      state.step = "await_quality";
    } else if (!state.existing && state.quality && state.duration === undefined) {
      state.duration = text.slice(0, 30);
    } else {
      return;
    }
    await putState(env, userId, state);
    await askNext(env, state, chatId);
    return;
  }

  if ((state.mode === "simpan" || state.mode === "tambah") && !state.sourceType) {
    await sendMessage(env, chatId, "🎬 Pilih sumber video terlebih dahulu.", {reply_markup:videoSourceKeyboard(state.mode)});
    return;
  }

  if ((state.mode === "simpan" || state.mode === "tambah") &&
      state.sourceType === "link" &&
      state.step === "await_video_url" &&
      !state.videoUrl) {
    if (!isValidVideoUrl(text)) {
      await sendMessage(env, chatId, "❌ URL tidak valid. URL harus diawali https:// dan berupa link yang valid.\n\n🔗 Kirim link video.");
      return;
    }
    state.videoUrl = text;
    state.step = "await_quality";
    await putState(env, userId, state);
    await askNext(env, state, chatId);
    return;
  }

  if (state.mode === "simpan" && state.videoUrl && !state.quality) {
    // Kualitas dipilih lewat callback keyboard; abaikan teks di sini.
    return;
  }

  if (state.mode === "simpan" && state.quality) {
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

  if (data.startsWith("source:")) {
    const parts = data.split(":");
    const sourceType = parts[1];
    const sourceMode = parts[2];

    if ((sourceMode !== "simpan" && sourceMode !== "tambah" && sourceMode !== "eps") || state.mode !== sourceMode) {
      return answerCallback(env, q.id, "Sesi sumber video tidak valid.");
    }

    if (sourceType !== "link" && sourceType !== "upload") {
      return answerCallback(env, q.id, "Sumber video tidak valid.");
    }

    state.sourceType = sourceType;
    state.step = sourceType === "upload" ? "await_video_upload" : "await_video_url";
    delete state.videoUrl;
    delete state.videoMessageId;
    delete state.videoProvider;
    delete state.quality;
    await putState(env, userId, state);
    await answerCallback(env, q.id, sourceType === "upload" ? "Upload Video dipilih" : "Link Video dipilih");
    await editMessage(env, chatId, msg.message_id,
      sourceType === "upload"
        ? "🎥 Upload Video dipilih.\n\nKirim video Telegram sekarang."
        : (state.mode === "simpan"
          ? "🔗 Link Video dipilih.\n\nKirim URL video (harus diawali https://)."
          : state.mode === "eps"
            ? "🔗 Link Video dipilih.\n\nKirim URL video episode (harus diawali https://)."
            : "🔗 Link Video dipilih.\n\nKirim URL video kualitas tambahan (harus diawali https://).")
    );
    return;
  }

  if (data.startsWith("art_type:")) {
    if (state.mode !== "poster" || state.step !== "await_artwork_type") {
      return answerCallback(env, q.id, "Sesi artwork tidak valid.");
    }
    const artworkType = data.slice(9);
    if (artworkType !== "poster" && artworkType !== "backdrop") {
      return answerCallback(env, q.id, "Jenis artwork tidak valid.");
    }
    state.artworkType = artworkType;
    state.step = "await_title";
    await putState(env, userId, state);
    await answerCallback(env, q.id, artworkType === "backdrop" ? "Backdrop dipilih" : "Poster dipilih");
    await editMessage(env, chatId, msg.message_id,
      `${artworkType === "backdrop" ? "🌄 Backdrop" : "🖼️ Poster"} dipilih.\n\nKetik judul film yang ingin diperbarui.`);
    return;
  }

  if (data.startsWith("q:")) {
    const chosen = data.slice(2);

    if (state.mode === "eps" && state.existing && state.existingQualities?.includes(chosen)) {
      await answerCallback(env, q.id, `Kualitas ${chosen} sudah ada untuk episode ini. Pilih kualitas lain.`);
      return;
    }

    if (state.mode === "tambah" && state.movieId) {
      const movie = await getMovie(env, state.movieId);
      if (movie && migratedVideos(movie)[chosen]) {
        await answerCallback(env, q.id, `Kualitas ${chosen} sudah ada. Pilih kualitas lain.`);
        return;
      }
    }

    state.quality = chosen;
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

  // ---- Callback Series & Episode ----
  if (data === "series_save") {
    if (state.mode !== "series" || !state.year || !state.genre?.length || state.rating === undefined || !state.description) {
      return answerCallback(env, q.id, "Data belum lengkap.");
    }
    await answerCallback(env, q.id, "Menyimpan series...");
    const id = await uniqueMovieId(env, state.title);
    await firebaseRequest(env, "PUT", `movies/${id}`, {
      type: "series",
      title: state.title,
      year: state.year,
      genre: state.genre,
      rating: Number(state.rating),
      description: state.description,
      posterFileId: state.posterFileId || "",
      backdrop: "",
      addedAt: Date.now()
    });
    await announceGenreTopics(env, state.genre,
      `📺 ${state.title}\n⭐ ${state.rating}\n📅 ${state.year}\nSeries baru`);
    const next = {userId, mode:"eps", chatId, movieId:id, movieTitle:state.title, createdAt:Date.now()};
    await putState(env, userId, next);
    await editMessage(env, chatId, msg.message_id,
      `✅ SERIES BERHASIL DISIMPAN\n\n📺 Judul: ${state.title}\n🆔 ID: ${id}\n📂 Genre: ${state.genre.join(", ")}\n\nSekarang tambah episode pertama. Kirim /batal untuk berhenti.`);
    await askNext(env, next, chatId);
    return;
  }

  if (data.startsWith("eps_season:")) {
    if (state.mode !== "eps" || state.season) return answerCallback(env, q.id, "Sesi episode tidak valid.");
    const n = Number(data.slice(11));
    if (!Number.isInteger(n) || n < 1 || n > 99) return answerCallback(env, q.id, "Nomor musim tidak valid.");
    state.season = n;
    await putState(env, userId, state);
    await answerCallback(env, q.id, `Musim ${n}`);
    await editMessage(env, chatId, msg.message_id, `✅ Musim ${n}`);
    await askNext(env, state, chatId);
    return;
  }

  if (data.startsWith("eps_num:")) {
    if (state.mode !== "eps" || !state.season || state.number) return answerCallback(env, q.id, "Sesi episode tidak valid.");
    const n = Number(data.slice(8));
    if (!Number.isInteger(n) || n < 1 || n > 999) return answerCallback(env, q.id, "Nomor episode tidak valid.");
    await setEpisodeNumber(env, state, n);
    await putState(env, userId, state);
    await answerCallback(env, q.id, `Eps ${n}`);
    await editMessage(env, chatId, msg.message_id, `✅ Musim ${state.season} Eps ${n}${state.existing ? " (sudah ada, tambah kualitas)" : ""}`);
    await askNext(env, state, chatId);
    return;
  }

  if (data.startsWith("eps_skip:")) {
    if (state.mode !== "eps") return answerCallback(env, q.id, "Sesi episode tidak valid.");
    const field = data.slice(9);
    if (field === "title" && state.epTitle === undefined) state.epTitle = "";
    else if (field === "duration" && state.duration === undefined) state.duration = "";
    else return answerCallback(env, q.id, "Tidak ada yang dilewati.");
    await putState(env, userId, state);
    await answerCallback(env, q.id, "Dilewati");
    await editMessage(env, chatId, msg.message_id, field === "title" ? "⏭️ Judul episode dilewati." : "⏭️ Durasi dilewati.");
    await askNext(env, state, chatId);
    return;
  }

  if (data === "eps_save") {
    if (state.mode !== "eps" || !state.movieId || !state.season || !state.number || !state.videoUrl || !state.quality) {
      return answerCallback(env, q.id, "Data belum lengkap.");
    }
    const movie = await getMovie(env, state.movieId);
    if (!movie) return answerCallback(env, q.id, "Series tidak ditemukan.");
    const found = episodeList(movie).find(e => e.season === state.season && e.number === state.number);
    const epId = found ? found.id : episodeId(state.season, state.number);
    const video = {videoUrl: state.videoUrl, provider: state.videoProvider || "custom"};
    const label = `Musim ${state.season} Eps ${state.number}`;

    if (found) {
      if (found.videos[state.quality]) {
        await answerCallback(env, q.id, "Kualitas itu sudah ada.");
        await editMessage(env, chatId, msg.message_id, `⚠️ Kualitas ${state.quality} sudah ada untuk ${label}. Data lama tidak ditimpa.`);
        await delState(env, userId);
        return;
      }
      await firebaseRequest(env, "PATCH", `movies/${state.movieId}/episodes/${epId}/videos`, {[state.quality]: video});
    } else {
      const ep = {season: state.season, number: state.number, videos: {[state.quality]: video}, addedAt: Date.now()};
      if (state.epTitle) ep.title = state.epTitle;
      if (state.duration) ep.duration = state.duration;
      await firebaseRequest(env, "PUT", `movies/${state.movieId}/episodes/${epId}`, ep);
    }

    const nextNumber = state.number + 1;
    await putState(env, userId, {
      userId, mode: "eps", chatId, movieId: state.movieId, movieTitle: state.movieTitle,
      season: state.season, nextNumber, step: "after_save", createdAt: Date.now()
    });
    await answerCallback(env, q.id, "Tersimpan.");
    await editMessage(env, chatId, msg.message_id,
      `✅ ${found ? "KUALITAS DITAMBAHKAN" : "EPISODE DISIMPAN"}\n\n📺 ${state.movieTitle}\n${label}${state.epTitle ? ` — ${state.epTitle}` : ""}\n🎞️ Kualitas: ${state.quality}\n🔗 ${state.videoUrl}`,
      {reply_markup: afterEpsKeyboard(nextNumber)});
    return;
  }

  if (data === "eps_next") {
    if (state.mode !== "eps" || state.step !== "after_save") return answerCallback(env, q.id, "Sesi episode tidak valid.");
    const fresh = {userId, mode:"eps", chatId, movieId:state.movieId, movieTitle:state.movieTitle, season:state.season, createdAt:Date.now()};
    await setEpisodeNumber(env, fresh, state.nextNumber);
    await putState(env, userId, fresh);
    await answerCallback(env, q.id, `Eps ${fresh.number}`);
    await editMessage(env, chatId, msg.message_id, `➕ Menambah Musim ${fresh.season} Eps ${fresh.number}${fresh.existing ? " (sudah ada, tambah kualitas)" : ""}`);
    await askNext(env, fresh, chatId);
    return;
  }

  if (data === "eps_done") {
    await delState(env, userId);
    await answerCallback(env, q.id, "Selesai");
    await editMessage(env, chatId, msg.message_id, "✅ Selesai menambah episode.");
    return;
  }

  // ---- Subtitle episode series ----
  if (data.startsWith("sub_pg:")) {
    if (state.mode !== "subtitle" || !state.isSeries) return answerCallback(env, q.id, "Sesi subtitle tidak valid.");
    const movie = await getMovie(env, state.movieId);
    const eps = episodeList(movie).filter(e => QUALITIES.some(qq => e.videos[qq]));
    await answerCallback(env, q.id);
    await editMessage(env, chatId, msg.message_id, `📺 ${state.movieTitle}\n\nPilih episode:`,
      {reply_markup: subtitleEpisodeKeyboard(eps, Number(data.slice(7)) || 0)});
    return;
  }

  if (data.startsWith("sub_ep:")) {
    if (state.mode !== "subtitle" || !state.isSeries) return answerCallback(env, q.id, "Sesi subtitle tidak valid.");
    const movie = await getMovie(env, state.movieId);
    const ep = episodeList(movie).find(e => e.id === data.slice(7));
    if (!ep) return answerCallback(env, q.id, "Episode tidak ditemukan.");
    const qualities = QUALITIES.filter(qq => ep.videos[qq]);
    if (!qualities.length) return answerCallback(env, q.id, "Episode belum punya kualitas video.");
    state.episodeId = ep.id;
    state.episodeLabel = `Musim ${ep.season} Eps ${ep.number}`;
    state.availableQualities = qualities;
    await putState(env, userId, state);
    await answerCallback(env, q.id, state.episodeLabel);
    await editMessage(env, chatId, msg.message_id,
      `📺 ${state.movieTitle} — ${state.episodeLabel}\n\nPilih kualitas subtitle:`,
      {reply_markup: subtitleQualityKeyboard(qualities)});
    return;
  }

  if (data === "draft_save") {
    requireKV(env);
    await env.TOPIC_KV.put(`draft:${userId}`, JSON.stringify(state), {expirationTtl: 604800});
    await delState(env, userId);
    await answerCallback(env, q.id, "Draft disimpan 7 hari.");
    await editMessage(env, chatId, msg.message_id, "💾 Draft disimpan.\n\nMulai lagi dengan /simpan <judul>.");
    return;
  }

  if (data === "confirm_save") {
    if (!state.videoUrl || !state.quality || !state.year || !state.genre?.length || state.rating === undefined || !state.duration || !state.description) {
      return answerCallback(env, q.id, "Data belum lengkap.");
    }
    await answerCallback(env, q.id, "Menyimpan film...");
    const id = await uniqueMovieId(env, state.title);
    const movie = {
      type: "movie",
      title: state.title,
      year: state.year,
      genre: state.genre,
      rating: Number(state.rating),
      duration: state.duration,
      description: state.description,
      posterFileId: state.posterFileId || "",
      backdrop: "",
      videos: {[state.quality]: {videoUrl: state.videoUrl, provider: state.videoProvider || "custom"}},
      videoUrl: state.videoUrl,
      quality: state.quality,
      addedAt: Date.now()
    };
    await firebaseRequest(env, "PUT", `movies/${id}`, movie);
    await delState(env, userId);

    const lines = [];
    if (env.TELEGRAM_CHAT_ID && env.TOPIC_KV) {
      for (const genre of state.genre) {
        const key = `genre:${slugify(genre)}`;
        let threadId = await env.TOPIC_KV.get(key);
        if (!threadId) {
          try {
            const topic = await tg(env, "createForumTopic", {
              chat_id:env.TELEGRAM_CHAT_ID,
              name:genre
            });
            threadId = topic ? String(topic.message_thread_id) : null;
            if (threadId) await env.TOPIC_KV.put(key, threadId);
          } catch (e) {
            // Keep movie save successful even if topic creation fails.
          }
        }
        if (threadId) lines.push(`${genre}: topic ${threadId}`);
      }
    }
    await sendMessage(env, chatId,
      `✅ FILM BERHASIL DISIMPAN\n\n🎬 Judul: ${state.title}\n🆔 ID: ${id}\n🎞️ Kualitas: ${state.quality}\n📂 Genre: ${state.genre.join(", ")}\n🔗 Video: ${state.videoUrl}\n🖼️ Poster: tersimpan di Telegram (posterFileId)`);

    if (env.TELEGRAM_CHAT_ID) {
      for (const genre of state.genre) {
        const threadId = await env.TOPIC_KV?.get(`genre:${slugify(genre)}`);
        if (threadId) {
          try {
            await sendMessage(env, env.TELEGRAM_CHAT_ID,
              `🎬 ${state.title}\n🎞️ ${state.quality}\n⭐ ${state.rating}\n📅 ${state.year}`,
              {message_thread_id:Number(threadId)});
          } catch {}
        }
      }
    }
    return;
  }


  // ---- Callback Subtitle (Bagian B) ----
  if (data.startsWith("sub_q:")) {
    if (state.mode !== "subtitle") return answerCallback(env, q.id, "Sesi subtitle tidak valid.");
    const quality = data.slice(6);
    if (!state.availableQualities?.includes(quality)) return answerCallback(env, q.id, "Kualitas tidak tersedia untuk film ini.");
    state.quality = quality;
    state.step = "await_subtitle_file";
    await putState(env, userId, state);
    await answerCallback(env, q.id, `Kualitas ${quality}`);
    await editMessage(env, chatId, msg.message_id,
      `📄 Silakan kirim file subtitle untuk ${state.movieTitle}${state.episodeLabel ? ` — ${state.episodeLabel}` : ""} (${quality}).\n\nFormat:\n• .srt\n• .vtt\n\nBahasa default: Indonesia`);
    return;
  }

  if (data === "confirm_add") {
    if (!state.movieId || !state.videoUrl || !state.quality) return answerCallback(env, q.id, "Data belum lengkap.");
    const movie = await getMovie(env, state.movieId);
    if (!movie) return answerCallback(env, q.id, "Film tidak ditemukan.");
    if (migratedVideos(movie)[state.quality]) {
      await answerCallback(env, q.id, "Kualitas itu sudah ada.");
      await editMessage(env, chatId, msg.message_id, `⚠️ Kualitas ${state.quality} sudah ada untuk film ini. Data lama tidak ditimpa.`);
      await delState(env, userId);
      return;
    }
    const videos = migratedVideos(movie);
    videos[state.quality] = {videoUrl: state.videoUrl, provider: state.videoProvider || "custom"};
    const patch = {videos};
    if (!movie.videoUrl) patch.videoUrl = state.videoUrl; // hanya isi jika film lama belum punya videoUrl utama
    await firebaseRequest(env, "PATCH", `movies/${state.movieId}`, patch);
    await delState(env, userId);
    await answerCallback(env, q.id, "Kualitas berhasil ditambahkan.");
    await editMessage(env, chatId, msg.message_id, `✅ Kualitas ${state.quality} berhasil ditambahkan ke ${movie.title}.\n🔗 ${state.videoUrl}`);
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

// ---- Proxy media Telegram (video lama & poster) ------------------------
async function proxyTelegramMedia(request, env, prefix, defaultContentType, cacheControl) {
  const url = new URL(request.url);
  const fileId = decodeURIComponent(url.pathname.slice(prefix.length));

  if (!fileId) {
    return new Response("Missing file_id", { status: 400 });
  }

  // Ambil informasi file dari Telegram
  const meta = await tg(env, "getFile", {
    file_id: fileId
  });

  if (!meta?.file_path) {
    return new Response("Telegram file_path tidak tersedia", {
      status: 502
    });
  }

  const range = request.headers.get("Range");

  const upstreamHeaders = new Headers();

  if (range) {
    upstreamHeaders.set("Range", range);
  }

  // Ambil file dari Telegram
  const upstream = await fetch(
    `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${meta.file_path}`,
    {
      headers: upstreamHeaders
    }
  );

  if (!upstream.ok && upstream.status !== 206) {
    const text = await upstream.text().catch(() => "");

    return new Response(
      `Telegram file error: ${upstream.status} ${text.slice(0, 500)}`,
      {
        status: 502,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "access-control-allow-origin": "*"
        }
      }
    );
  }

  const headers = new Headers();

  // CORS
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Range");
  headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Type");

  headers.set(
    "Content-Type",
    upstream.headers.get("Content-Type") || defaultContentType
  );

  headers.set(
    "Accept-Ranges",
    upstream.headers.get("Accept-Ranges") || "bytes"
  );

  const contentLength = upstream.headers.get("Content-Length");
  const contentRange = upstream.headers.get("Content-Range");

  if (contentLength) {
    headers.set("Content-Length", contentLength);
  }

  if (contentRange) {
    headers.set("Content-Range", contentRange);
  }

  headers.set("Cache-Control", cacheControl);

  return new Response(upstream.body, {
    status: upstream.status,
    headers
  });
}

// Kompatibilitas film lama yang masih menyimpan video di Telegram.
async function proxyTelegramFile(request, env) {
  return proxyTelegramMedia(request, env, "/file/", "video/mp4", "public, max-age=3600");
}

// Poster film (baru maupun lama) selalu diambil dari Telegram lewat endpoint ini.
async function proxyTelegramPoster(request, env) {
  return proxyTelegramMedia(request, env, "/poster/", "image/jpeg", "public, max-age=86400");
}

// Backdrop landscape disimpan sebagai Telegram file_id dan diproxy lewat Worker.
// Browser tidak pernah menerima BOT_TOKEN.
async function proxyTelegramBackdrop(request, env) {
  return proxyTelegramMedia(request, env, "/backdrop/", "image/jpeg", "public, max-age=86400");
}

// ---- Endpoint subtitle: Firebase -> Telegram getFile -> SRT/VTT --------
// Browser tidak pernah melihat BOT_TOKEN. Path: /subtitle/<filmId>/<quality>
async function serveSubtitle(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean); // ["subtitle", filmId, quality]
  const filmId = decodeURIComponent(parts[1] || "");
  const quality = decodeURIComponent(parts[2] || "");
  if (!filmId || !quality) {
    return new Response("Missing filmId/quality", {status: 400, headers: corsHeaders()});
  }
  if (!QUALITIES.includes(quality)) {
    return new Response("Quality tidak valid", {status: 400, headers: corsHeaders()});
  }

  const movie = await getMovie(env, filmId);
  if (!movie) return new Response("Film tidak ditemukan", {status: 404, headers: corsHeaders()});

  // Series: web memanggil /subtitle/<filmId>/<quality>?ep=<epId>
  const epParam = url.searchParams.get("ep");
  const sub = epParam
    ? episodeList(movie).find(e => e.id === epParam)?.videos?.[quality]?.subtitle
    : migratedVideos(movie)[quality]?.subtitle;
  const fileId = sub?.fileId || sub?.file_id || "";
  if (!fileId) return new Response("Subtitle tidak tersedia", {status: 404, headers: corsHeaders()});

  const meta = await tg(env, "getFile", {file_id: fileId});
  if (!meta?.file_path) return new Response("Telegram file_path tidak tersedia", {status: 502, headers: corsHeaders()});

  let upstream;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUBTITLE_TIMEOUT_MS);
    try {
      upstream = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${meta.file_path}`, {
        signal: controller.signal,
        redirect: "follow"
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Telegram subtitle timeout" : "Telegram subtitle fetch gagal";
    return new Response(msg, {status: 504, headers: corsHeaders()});
  }

  if (!upstream.ok) {
    const t = await upstream.text().catch(() => "");
    return new Response(`Telegram file error: ${upstream.status} ${t.slice(0, 300)}`, {status: 502, headers: corsHeaders()});
  }

  const contentLength = Number(upstream.headers.get("content-length") || 0);
  if (contentLength > SUBTITLE_MAX_BYTES) {
    return new Response("Subtitle terlalu besar", {status: 413, headers: corsHeaders()});
  }

  const rawText = await upstream.text();
  if (new TextEncoder().encode(rawText).byteLength > SUBTITLE_MAX_BYTES) {
    return new Response("Subtitle terlalu besar", {status: 413, headers: corsHeaders()});
  }
  const fileName = String(sub.fileName || sub.file_name || "");
  const format = String(sub.format || "").toLowerCase();
  const isVtt = format === "vtt" || /\.vtt$/i.test(fileName);
  const trimmed = rawText.replace(/^\uFEFF/, "").trim();
  const vtt = isVtt
    ? (trimmed.startsWith("WEBVTT") ? trimmed + "\n" : `WEBVTT\n\n${trimmed}\n`)
    : srtToVtt(rawText);

  return new Response(vtt, {
    status: 200,
    headers: {
      ...corsHeaders(),
      "Content-Type": "text/vtt; charset=utf-8",
      "Cache-Control": "no-cache, max-age=0",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

async function diagnostic(env) {
  const envInfo = {
    BOT_TOKEN: !!env.BOT_TOKEN,
    ADMIN_IDS: !!env.ADMIN_IDS,
    TELEGRAM_CHAT_ID: !!env.TELEGRAM_CHAT_ID,
    TOPIC_KV: !!env.TOPIC_KV,
    FIREBASE_CLIENT_EMAIL: !!env.FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY: !!env.FIREBASE_PRIVATE_KEY
  };

  let webhook;
  if (env.BOT_TOKEN) {
    try {
      webhook = await tg(env, "getWebhookInfo", {});
    } catch (e) {
      webhook = {error: String(e?.message || e)};
    }
  } else {
    webhook = {error: "BOT_TOKEN belum diatur, tidak bisa mengambil webhook info."};
  }

  return {ok:true, env: envInfo, webhook};
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "Range",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    if (request.method === "GET" && url.pathname === "/diagnostic") {
      return json(await diagnostic(env));
    }

    if (!env.BOT_TOKEN) return json({ok:false,error:"BOT_TOKEN belum diatur"},500);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("IDFLIX Telegram Bot Worker aktif.", {
        headers: {"content-type":"text/plain; charset=utf-8"}
      });
    }
    if (request.method === "GET" && url.pathname.startsWith("/file/")) {
      try { return await proxyTelegramFile(request, env); }
      catch (e) { return new Response(String(e.message || e), {status:502}); }
    }
    if (request.method === "GET" && url.pathname.startsWith("/poster/")) {
      try { return await proxyTelegramPoster(request, env); }
      catch (e) { return new Response(String(e.message || e), {status:502}); }
    }
    if (request.method === "GET" && url.pathname.startsWith("/backdrop/")) {
      try { return await proxyTelegramBackdrop(request, env); }
      catch (e) { return new Response(String(e.message || e), {status:502}); }
    }
    if (request.method === "GET" && url.pathname.startsWith("/subtitle/")) {
      try { return await serveSubtitle(request, env); }
      catch (e) { return new Response(String(e.message || e), {status:502, headers: corsHeaders()}); }
    }
    if (request.method !== "POST") return new Response("Method Not Allowed",{status:405});

    try {
      const update = await request.json();

      // Telegram webhook harus segera mendapat HTTP 200 agar tidak memicu retry update.
      const task = Promise.resolve()
        .then(() => handleUpdate(update, env))
        .catch(async (e) => {
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
        });

      // Cloudflare Worker menjaga task tetap hidup setelah response dikirim.
      if (typeof request.cf !== "undefined") {
        // no-op: hanya menjaga kompatibilitas dengan runtime Cloudflare.
      }

      if (ctx?.waitUntil) ctx.waitUntil(task);
      else void task;

      return json({ok:true});
    } catch (e) {
      return json({ok:false,error:String(e?.message || e)},500);
    }
  }
};
