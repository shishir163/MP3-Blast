// Internet radio: a station list for Bangladesh from the public Radio Browser directory,
// and a small player for live streams. Nothing is recorded or saved.
const SERVERS = [
  "https://de1.api.radio-browser.info",
  "https://de2.api.radio-browser.info",
  "https://fi1.api.radio-browser.info",
  "https://all.api.radio-browser.info",
];
const CACHE_KEY = "mb.radio";
const CACHE_DAYS = 7;
const QUERY = "/json/stations/search?countrycode=BD&hidebroken=true&order=clickcount&reverse=true&limit=300";

function readCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    return raw && Array.isArray(raw.list) ? raw : null;
  } catch {
    return null;
  }
}

function writeCache(list) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), list }));
  } catch {
    /* ignore */
  }
}

function clean(raw) {
  const seen = new Set();
  const out = [];
  for (const s of raw) {
    const url = String(s.url_resolved || s.url || "").trim();
    const name = String(s.name || "").trim();
    // Phones only play secure streams inside a secure page.
    if (!name || !url.startsWith("https://") || s.lastcheckok === 0) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: String(s.stationuuid || url), name, url, tags: String(s.tags || ""), custom: false });
  }
  return out;
}

async function fetchJson(url, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`radio ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Returns { list, stale }. Uses the saved copy when it is fresh, unless `force` is set.
export async function loadStations({ force = false } = {}) {
  const cached = readCache();
  if (cached && !force && Date.now() - cached.at < CACHE_DAYS * 86400000) return { list: cached.list, stale: false };
  let lastError = null;
  for (const host of SERVERS) {
    try {
      const raw = await fetchJson(host + QUERY);
      const list = clean(Array.isArray(raw) ? raw : []);
      if (list.length) {
        writeCache(list);
        return { list, stale: false };
      }
    } catch (err) {
      lastError = err;
    }
  }
  if (cached) return { list: cached.list, stale: true };
  throw lastError || new Error("radio");
}

export class Radio {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = "none";
    this.audio.setAttribute("playsinline", "");
    this.station = null;
    this.status = "idle"; // idle | loading | playing | paused | error
    this.listeners = {};
    this.wireAudio();
  }

  on(name, fn) {
    (this.listeners[name] ||= []).push(fn);
    return this;
  }

  emit(name) {
    (this.listeners[name] || []).forEach((fn) => fn());
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    if ("mediaSession" in navigator && this.station) {
      navigator.mediaSession.playbackState = status === "playing" ? "playing" : "paused";
    }
    this.emit("state");
  }

  wireAudio() {
    const a = this.audio;
    a.addEventListener("playing", () => this.setStatus("playing"));
    a.addEventListener("waiting", () => {
      if (this.station && this.status !== "paused") this.setStatus("loading");
    });
    a.addEventListener("pause", () => {
      if (this.station && this.status !== "loading" && this.status !== "error") this.setStatus("paused");
    });
    a.addEventListener("error", () => {
      if (this.station && a.getAttribute("src")) this.setStatus("error");
    });
  }

  wireMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const set = (action, fn) => {
      try {
        navigator.mediaSession.setActionHandler(action, fn);
      } catch {
        /* not supported */
      }
    };
    set("play", () => this.resume());
    set("pause", () => this.pause());
    set("previoustrack", null);
    set("nexttrack", null);
    set("seekto", null);
    if (typeof MediaMetadata !== "undefined" && this.station) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: this.station.name,
        artist: "রেডিও",
        album: "MP3 Blast",
        artwork: [{ src: new URL("icons/icon-512.png", document.baseURI).href, sizes: "512x512", type: "image/png" }],
      });
    }
  }

  play(station) {
    this.station = station;
    this.status = "loading";
    this.emit("state");
    this.wireMediaSession();
    this.audio.src = station.url;
    const attempt = this.audio.play();
    if (attempt && attempt.catch) {
      attempt.catch(() => {
        if (this.station === station && this.status === "loading") this.setStatus("error");
      });
    }
  }

  pause() {
    if (!this.station) return;
    this.audio.pause();
    this.setStatus("paused");
  }

  // A live stream has no "position", so resuming reconnects to the live broadcast.
  resume() {
    if (this.station) this.play(this.station);
  }

  toggle() {
    if (!this.station) return;
    if (this.status === "playing" || this.status === "loading") this.pause();
    else this.resume();
  }

  stop() {
    if (!this.station) return;
    this.station = null;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.status = "idle";
    this.emit("state");
    this.emit("release");
  }
}
