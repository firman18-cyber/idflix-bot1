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

// ---- Konfigurasi Scraper (Bagian A) ------------------------------------
const SCRAPE_TIMEOUT_MS = 12000;
const SCRAPE_MAX_HTML_CHARS = 3_000_000; // batas ukuran HTML yang diproses (~3MB)
const SCRAPE_MAX_CANDIDATES = 20;
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

// ---- Scraper media publik (Bagian A) -----------------------------------
// Hanya membaca HTML publik lewat fetch() biasa. Tidak ada bypass proteksi
// apapun: 401/403/429 langsung dilaporkan sebagai "tidak dapat diakses".

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; IDFLIXBot/1.0; +scraper)",
        "accept": "text/html,application/xhtml+xml"
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

// Deteksi kualitas dari string URL/file name. Tidak pernah menebak dari
// ukuran file atau resolusi asli — murni pattern matching string.
function detectQuality(url) {
  const s = String(url || "");
  const N = "(360|480|720|1080|1440|2160)";
  // Prioritas pola dengan delimiter jelas saja — tidak menebak dari angka
  // sembarang yang kebetulan muncul di URL (mis. id, timestamp, dsb).
  const patterns = [
    new RegExp(`${N}p\\b`, "i"),                                   // 720p
    new RegExp(`[\\/_-]${N}(?=[\\/_-])`, "i"),                     // /720/ _720_ -720-
    new RegExp(`${N}(?=\\.(?:mp4|m3u8)(?:[?#]|$))`, "i")           // 720.mp4 / 720.m3u8
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return `${m[1]}p`;
  }
  if (/cam/i.test(s)) return "CAM";
  return "UNKNOWN";
}

function mediaTypeFromUrl(u) {
  if (/\.m3u8(?:[?#]|$)/i.test(u)) return "M3U8";
  if (/\.mp4(?:[?#]|$)/i.test(u)) return "MP4";
  return null;
}

function resolveMediaUrl(candidate, baseUrl) {
  try {
    return new URL(candidate, baseUrl).toString();
  } catch {
    return null;
  }
}

// Ekstrak kandidat MP4/M3U8 dari HTML: URL absolut langsung di teks,
// atribut umum (src, data-src, data-video, dst pada <video>/<source>),
// dan pola JS/JSON inline seperti file:"..." atau source:"...".
// Menangani juga string yang di-escape ("\/" -> "/") dan URL
// protocol-relative ("//cdn..."), yang diresolve lewat resolveMediaUrl().
// Deduplikasi berdasarkan URL absolut hasil resolve.
function extractMediaUrls(html, pageUrl) {
  // Normalisasi escaped slash yang umum muncul di JSON/JS inline, contoh:
  // "https:\/\/cdn.example.com\/video.mp4", "\/video\/x.mp4", atau bentuk
  // unicode escape "https:\u002F\u002Fcdn.example.com\u002Fvideo.mp4".
  // Juga decode HTML entity "&amp;" yang umum muncul di query string URL.
  // Tidak menyentuh URL yang sudah valid (replace di sini idempoten).
  let normalized = String(html || "")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&");

  const found = new Map();
  const patterns = [
    /https?:\/\/[^\s"'<>\\]+?\.(?:mp4|m3u8)(?:\?[^\s"'<>\\]*)?/gi,
    /(?:src|data-src|data-video|data-url|data-file|data-source|data-stream|file|source|url)\s*[:=]\s*["']([^"']+?\.(?:mp4|m3u8)(?:\?[^"']*)?)["']/gi,
    // Fallback generik: string ter-quote apapun (property JSON/JS non-standar
    // termasuk) yang berakhir .mp4/.m3u8. Aman karena tetap difilter lewat
    // mediaTypeFromUrl() + resolveMediaUrl() dan dideduplikasi di bawah.
    /["']([^"']+?\.(?:mp4|m3u8)(?:\?[^"']*)?)["']/gi
  ];
  for (const re of patterns) {
    let match;
    let guard = 0;
    while ((match = re.exec(normalized)) && guard < 500) {
      guard++;
      const raw = match[1] || match[0];
      const abs = resolveMediaUrl(raw, pageUrl);
      if (!abs) continue;
      const type = mediaTypeFromUrl(abs);
      if (!type) continue;
      if (found.has(abs)) continue;
      found.set(abs, {url: abs, type, quality: detectQuality(abs)});
    }
  }
  return Array.from(found.values());
}

// Ambil HTML publik dan validasi. Mengembalikan {error:...} untuk setiap
// kondisi gagal, atau {ok:true, candidates:[...]} jika berhasil.
async function scrapePage(pageUrl) {
  let res;
  try {
    res = await fetchWithTimeout(pageUrl, SCRAPE_TIMEOUT_MS);
  } catch (e) {
    if (e?.name === "AbortError") return {error: "timeout"};
    return {error: "network", detail: String(e?.message || e)};
  }

  // 401/403/429 atau halaman yang meminta login/CAPTCHA: laporkan, jangan bypass.
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    return {error: "protected", status: res.status};
  }
  if (res.status === 404) return {error: "notfound-http"};
  if (res.status >= 500) return {error: "server", status: res.status};
  if (res.status === 400) return {error: "badrequest"};
  if (!res.ok) return {error: "http", status: res.status};

  const ct = res.headers.get("content-type") || "";
  if (!/text\/html|application\/xhtml\+xml/i.test(ct)) {
    return {error: "nothtml", contentType: ct};
  }

  let html;
  try {
    html = await res.text();
  } catch (e) {
    return {error: "network", detail: String(e?.message || e)};
  }
  if (!html || !html.trim()) return {error: "empty"};
  if (html.length > SCRAPE_MAX_HTML_CHARS) html = html.slice(0, SCRAPE_MAX_HTML_CHARS);

  const candidates = extractMediaUrls(html, res.url || pageUrl);
  if (!candidates.length) return {error: "notfound"};

  return {ok: true, candidates};
}

function scrapeKeyboard(candidates) {
  const rows = candidates.map((c, i) => [{text: `▶ ${c.quality} ${c.type}`, callback_data: `sc_pick:${i}`}]);
  rows.push([{text: "❌ Batal", callback_data: "cancel"}]);
  return {inline_keyboard: rows};
}

// Dipakai saat kandidat scrape terdeteksi CAM/UNKNOWN: admin WAJIB memilih
// quality database resmi (QUALITIES) — CAM/UNKNOWN tidak pernah menjadi key.
function dbQualityKeyboard() {
  const rows = [];
  for (let i = 0; i < QUALITIES.length; i += 3) {
    rows.push(QUALITIES.slice(i, i + 3).map(q => ({text: q, callback_data: `sc_qpick:${q}`})));
  }
  rows.push([{text: "❌ Batal", callback_data: "cancel"}]);
  return {inline_keyboard: rows};
}

// Bangun teks + keyboard konfirmasi (tambah baru vs overwrite) berdasarkan
// state.targetQuality yang SUDAH pasti berupa quality resmi (QUALITIES).
function buildScrapeDecision(movie, state) {
  const quality = state.targetQuality;
  const exists = !!migratedVideos(movie)[quality];
  const text = exists
    ? `⚠️ ${quality} sudah tersedia untuk film ${movie.title}.\n🔗 URL baru: ${state.pending.url}`
    : `🎬 ${movie.title}\n\nQuality: ${quality}\nType: ${state.pending.type}\n🔗 ${state.pending.url}\n\nTambahkan kualitas ini ke film?`;
  const keyboard = exists
    ? {inline_keyboard: [
        [{text: "♻️ Overwrite URL", callback_data: "sc_overwrite"}],
        [{text: "❌ Batal", callback_data: "cancel"}]
      ]}
    : {inline_keyboard: [
        [{text: "✅ Tambah ke Film", callback_data: "sc_confirmadd"}],
        [{text: "❌ Batal", callback_data: "cancel"}]
      ]};
  return {text, keyboard};
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
    if (!state.videoUrl) {
      await sendMessage(env, chatId, "🔗 Kirim link video (harus diawali https://, boleh dari hosting mana saja).");
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
    if (!state.videoUrl) {
      await sendMessage(env, chatId, "🔗 Kirim link video kualitas tambahan (harus diawali https://).");
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

async function handleAdminText(msg, env) {
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  const text = String(msg.text || "").trim();

  // Poster diupload kapan saja (biasanya sebelum /simpan). Selalu simpan
  // sebagai "poster terakhir" milik admin tersebut.
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const largest = msg.photo[msg.photo.length - 1];
    await putLastPoster(env, userId, largest.file_id);
    await sendMessage(env, chatId, "🖼️ Poster diterima dan disimpan sementara.\n\nGunakan /simpan <judul> untuk melanjutkan.");
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
      "1. Upload poster film (gambar)\n" +
      "2. /simpan <judul> — tambah film baru\n" +
      "3. /tambah <judul> — tambah kualitas video ke film yang sudah ada\n\n" +
      "/scrape <url> — cari URL MP4/M3U8 publik dari halaman\n" +
      "/subtitle <judul> — upload subtitle .srt/.vtt untuk film\n" +
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
      const qualities = m.videos ? Object.keys(m.videos).join(", ") : (m.quality || "-");
      return `• ${m.title || id} (${id})\n  Tahun: ${m.year || "-"} | Kualitas: ${qualities || "-"}`;
    });
    const extra = entries.length > 20 ? `\n\n...dan ${entries.length - 20} film lainnya.` : "";
    await sendMessage(env, chatId, `📚 DAFTAR FILM (${entries.length})\n\n${lines.join("\n\n")}${extra}`);
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
    const state = {userId, mode:"simpan", title, posterFileId, createdAt:Date.now(), chatId};
    await putState(env, userId, state);
    await sendMessage(env, chatId, `🎬 Judul: ${title}\n🖼️ Poster: tersimpan\n\n🔗 Kirim link video Dosya.at atau hosting lain (harus diawali https://)`);
    return;
  }

  if (text.startsWith("/tambah ")) {
    const title = text.slice(8).trim();
    if (!title) return sendMessage(env, chatId, "Format: /tambah <judul>");
    const found = await findMovieByTitle(env, title);
    if (!found) return sendMessage(env, chatId, `❌ Film "${title}" belum ditemukan di Firebase.`);
    const state = {userId, mode:"tambah", title:found.movie.title, movieId:found.id, createdAt:Date.now(), chatId};
    await putState(env, userId, state);
    await sendMessage(env, chatId, `🎬 Film ditemukan: ${found.movie.title}\n\n🔗 Kirim link video kualitas tambahan (harus diawali https://)`);
    return;
  }

  if (text.startsWith("/scrape ")) {
    const raw = text.slice(8).trim();
    if (!raw) return sendMessage(env, chatId, "Format: /scrape <URL>");
    let target;
    try {
      target = new URL(raw);
      if (!/^https?:$/.test(target.protocol)) throw new Error("bad-protocol");
    } catch {
      return sendMessage(env, chatId, "❌ URL tidak valid. Format: /scrape https://...");
    }

    await sendMessage(env, chatId, "🔍 Memindai halaman, mohon tunggu...");
    const result = await scrapePage(target.toString());

    if (result.error === "timeout") return sendMessage(env, chatId, "⏱️ Permintaan ke halaman timeout. Coba lagi nanti.");
    if (result.error === "protected") return sendMessage(env, chatId,
      `⚠️ Halaman tidak dapat diakses sebagai resource publik (status ${result.status}).\n\nScraper tidak melakukan bypass login/CAPTCHA/DRM/anti-bot.`);
    if (result.error === "notfound-http") return sendMessage(env, chatId, "❌ Halaman tidak ditemukan (404).");
    if (result.error === "server") return sendMessage(env, chatId, `❌ Server halaman mengalami error (status ${result.status}). Coba lagi nanti.`);
    if (result.error === "badrequest") return sendMessage(env, chatId, "❌ Permintaan tidak valid (400). Periksa kembali URL.");
    if (result.error === "http") return sendMessage(env, chatId, `❌ Gagal mengambil halaman (status ${result.status}).`);
    if (result.error === "nothtml") return sendMessage(env, chatId, `ℹ️ Resource bukan halaman HTML yang dapat dipindai (content-type: ${result.contentType || "-"}).`);
    if (result.error === "empty") return sendMessage(env, chatId, "❌ Halaman kosong, tidak ada konten untuk dipindai.");
    if (result.error === "network") return sendMessage(env, chatId, `❌ Gagal mengakses URL: ${result.detail || "unknown error"}`);
    if (result.error === "notfound") return sendMessage(env, chatId, "❌ Tidak ditemukan URL MP4/M3U8 publik pada halaman tersebut.");

    const candidates = result.candidates.slice(0, SCRAPE_MAX_CANDIDATES);
    const truncated = result.candidates.length > SCRAPE_MAX_CANDIDATES;
    const state = {userId, mode: "scrape", chatId, candidates, createdAt: Date.now()};
    await putState(env, userId, state);

    const lines = candidates.map((c, i) => `${i + 1}. 🎬 ${c.quality}\n   ${c.type}\n   ${c.url}`);
    const extra = truncated ? `\n\n...ditemukan lebih banyak, hanya ${SCRAPE_MAX_CANDIDATES} kandidat pertama yang ditampilkan.` : "";
    await sendMessage(env, chatId, `🔎 Hasil Scrape (${candidates.length})\n\n${lines.join("\n\n")}${extra}`,
      {reply_markup: scrapeKeyboard(candidates)});
    return;
  }

  if (text.startsWith("/subtitle ")) {
    const title = text.slice(10).trim();
    if (!title) return sendMessage(env, chatId, "Format: /subtitle <judul film>");
    const found = await findMovieByTitle(env, title);
    if (!found) return sendMessage(env, chatId, `❌ Film "${title}" tidak ditemukan di database.`);
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

  if (!text) return; // abaikan pesan non-teks lain di luar flow yang dikenal

  if (state.mode === "scrape" && state.step === "await_title") {
    const title = text.trim();
    if (!title) return;
    const found = await findMovieByTitle(env, title);
    if (!found) {
      await sendMessage(env, chatId,
        `❌ Film "${title}" belum ditemukan. Gunakan /tambah <judul> atau /simpan <judul> untuk membuat film ini terlebih dahulu, lalu ulangi memilih kandidat scrape.\n\nKetik judul lain atau /batal untuk membatalkan.`);
      return;
    }
    state.movieId = found.id;
    const detected = state.pending.quality;

    if (QUALITIES.includes(detected)) {
      // Quality terdeteksi valid (bukan CAM/UNKNOWN) — langsung dipakai.
      state.targetQuality = detected;
      delete state.step;
      await putState(env, userId, state);
      const decision = buildScrapeDecision(found.movie, state);
      await sendMessage(env, chatId, decision.text, {reply_markup: decision.keyboard});
    } else {
      // CAM/UNKNOWN: jangan pernah jadi key database. Admin wajib pilih
      // quality resmi dari daftar QUALITIES.
      state.step = "await_quality_pick";
      await putState(env, userId, state);
      await sendMessage(env, chatId,
        `ℹ️ Kualitas terdeteksi: ${detected} (bukan quality database resmi).\n\nPilih quality database yang sesuai untuk film ${found.movie.title}:`,
        {reply_markup: dbQualityKeyboard()});
    }
    return;
  }

  if ((state.mode === "simpan" || state.mode === "tambah") && !state.videoUrl) {
    if (!isValidVideoUrl(text)) {
      await sendMessage(env, chatId, "❌ URL tidak valid. URL harus diawali https:// dan berupa link yang valid.\n\n🔗 Kirim link video.");
      return;
    }
    state.videoUrl = text;
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

  if (data.startsWith("q:")) {
    const chosen = data.slice(2);

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
      videos: {[state.quality]: {videoUrl: state.videoUrl, provider: "custom"}},
      videoUrl: state.videoUrl,
      quality: state.quality,
      addedAt: Date.now()
    };
    await firebaseRequest(env, "PUT", `movies/${id}`, movie);
    await delState(env, userId);

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

  // ---- Callback Scraper (Bagian A) ----
  if (data.startsWith("sc_pick:")) {
    if (state.mode !== "scrape" || !Array.isArray(state.candidates)) {
      return answerCallback(env, q.id, "Sesi scrape tidak valid.");
    }
    const idx = Number(data.slice(8));
    const cand = state.candidates[idx];
    if (!cand) return answerCallback(env, q.id, "Kandidat tidak ditemukan.");
    state.pending = cand;
    delete state.step;
    delete state.movieId;
    await putState(env, userId, state);
    await answerCallback(env, q.id, `Dipilih: ${cand.quality} ${cand.type}`);
    await editMessage(env, chatId, msg.message_id,
      `🎬 URL ditemukan\n\nQuality: ${cand.quality}\nType: ${cand.type}\n🔗 ${cand.url}\n\nPilih tindakan:`, {
        reply_markup: {inline_keyboard: [
          [{text: "➕ Tambah ke Film", callback_data: "sc_addfilm"}],
          [{text: "❌ Batalkan", callback_data: "cancel"}]
        ]}
      });
    return;
  }

  if (data === "sc_addfilm") {
    if (state.mode !== "scrape" || !state.pending) return answerCallback(env, q.id, "Pilih kandidat terlebih dahulu.");
    state.step = "await_title";
    await putState(env, userId, state);
    await answerCallback(env, q.id, "Ketik judul film");
    await editMessage(env, chatId, msg.message_id,
      "📌 Ketik judul film tujuan (harus sudah ada di database, gunakan judul yang sama seperti /tambah).");
    return;
  }

  // CAM/UNKNOWN: admin memilih quality database resmi dari QUALITIES.
  if (data.startsWith("sc_qpick:")) {
    if (state.mode !== "scrape" || state.step !== "await_quality_pick" || !state.movieId || !state.pending) {
      return answerCallback(env, q.id, "Sesi scrape tidak valid.");
    }
    const chosen = data.slice(9);
    if (!QUALITIES.includes(chosen)) return answerCallback(env, q.id, "Quality tidak valid.");
    const movie = await getMovie(env, state.movieId);
    if (!movie) {
      await delState(env, userId);
      await answerCallback(env, q.id, "Film tidak ditemukan.");
      await editMessage(env, chatId, msg.message_id, "❌ Film tidak ditemukan lagi di database.");
      return;
    }
    state.targetQuality = chosen;
    delete state.step;
    await putState(env, userId, state);
    await answerCallback(env, q.id, `Quality dipilih: ${chosen}`);
    const decision = buildScrapeDecision(movie, state);
    await editMessage(env, chatId, msg.message_id, decision.text, {reply_markup: decision.keyboard});
    return;
  }

  if (data === "sc_confirmadd") {
    if (state.mode !== "scrape" || !state.pending || !state.movieId || !state.targetQuality) {
      return answerCallback(env, q.id, "Data belum lengkap.");
    }
    const movie = await getMovie(env, state.movieId);
    if (!movie) return answerCallback(env, q.id, "Film tidak ditemukan.");
    const quality = state.targetQuality;
    const videos = migratedVideos(movie);
    if (videos[quality]) {
      await answerCallback(env, q.id, "Kualitas sudah ada, gunakan Overwrite.");
      return;
    }
    // Quality baru: tidak ada object lama untuk dipertahankan, tapi tetap
    // pakai pola spread yang sama supaya konsisten dengan overwrite.
    videos[quality] = {
      ...(videos[quality] || {}),
      videoUrl: state.pending.url,
      provider: "scrape",
      format: state.pending.type
    };
    const patch = {videos};
    if (!movie.videoUrl) patch.videoUrl = state.pending.url;
    await firebaseRequest(env, "PATCH", `movies/${state.movieId}`, patch);
    await delState(env, userId);
    await answerCallback(env, q.id, "Ditambahkan.");
    await editMessage(env, chatId, msg.message_id,
      `✅ Kualitas ${quality} berhasil ditambahkan ke ${movie.title} dari hasil scrape.\n🔗 ${state.pending.url}`);
    return;
  }

  if (data === "sc_overwrite") {
    if (state.mode !== "scrape" || !state.pending || !state.movieId || !state.targetQuality) {
      return answerCallback(env, q.id, "Data belum lengkap.");
    }
    const movie = await getMovie(env, state.movieId);
    if (!movie) return answerCallback(env, q.id, "Film tidak ditemukan.");
    const quality = state.targetQuality;
    const videos = migratedVideos(movie);
    // PENTING: pertahankan metadata lama (termasuk subtitle) pada quality
    // ini — hanya videoUrl/provider/format yang diganti.
    videos[quality] = {
      ...(videos[quality] || {}),
      videoUrl: state.pending.url,
      provider: "scrape",
      format: state.pending.type
    };
    const patch = {videos};
    // Sinkronkan field legacy jika film lama masih menjadikan quality ini
    // sebagai video utama. Ini mencegah frontend lama membaca URL yang stale.
    if (movie.quality === quality) {
      patch.videoUrl = state.pending.url;
      patch.quality = quality;
      patch.provider = "scrape";
    }
    await firebaseRequest(env, "PATCH", `movies/${state.movieId}`, patch);
    await delState(env, userId);
    await answerCallback(env, q.id, "Diperbarui.");
    await editMessage(env, chatId, msg.message_id,
      `✅ ${quality} berhasil diperbarui (overwrite) untuk ${movie.title}. Subtitle & metadata lain pada quality ini tetap dipertahankan.\n🔗 ${state.pending.url}`);
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
      `📄 Silakan kirim file subtitle untuk ${state.movieTitle} (${quality}).\n\nFormat:\n• .srt\n• .vtt\n\nBahasa default: Indonesia`);
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
    videos[state.quality] = {videoUrl: state.videoUrl, provider: "custom"};
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

  const sub = migratedVideos(movie)[quality]?.subtitle;
  if (!sub?.fileId) return new Response("Subtitle tidak tersedia", {status: 404, headers: corsHeaders()});

  const meta = await tg(env, "getFile", {file_id: sub.fileId});
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
  const isVtt = (sub.format || "").toLowerCase() === "vtt" || /\.vtt$/i.test(sub.fileName || "");
  const vtt = isVtt
    ? (rawText.trim().startsWith("WEBVTT") ? rawText : `WEBVTT\n\n${rawText}`)
    : srtToVtt(rawText);

  return new Response(vtt, {
    status: 200,
    headers: {
      ...corsHeaders(),
      "Content-Type": "text/vtt; charset=utf-8",
      "Cache-Control": "public, max-age=3600"
    }
  });
}

async function diagnostic(env) {
  const envInfo = {
    BOT_TOKEN: !!env.BOT_TOKEN,
    ADMIN_IDS: !!env.ADMIN_IDS,
    IDFLIX_GROUP_ID: !!env.IDFLIX_GROUP_ID,
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
  async fetch(request, env) {
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
    if (request.method === "GET" && url.pathname.startsWith("/subtitle/")) {
      try { return await serveSubtitle(request, env); }
      catch (e) { return new Response(String(e.message || e), {status:502, headers: corsHeaders()}); }
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
