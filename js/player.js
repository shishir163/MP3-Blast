import { fetchAudioBlob, AuthError } from "./drive.js";

const MAX_CACHE = 5; // songs kept in memory (current, next and a few recent ones)
let uidSeq = 0;

const makeEntry = (track) => ({ uid: ++uidSeq, track });

function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Player {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.audio.setAttribute("playsinline", "");
    this.base = []; // queue in its original order
    this.order = []; // queue in play order (differs from base when shuffled)
    this.index = -1;
    this.shuffle = false;
    this.repeat = "off"; // off | all | one
    this.status = "idle"; // idle | loading | playing | paused
    this.awaitingAuth = false;
    this.cache = new Map(); // track id -> object URL
    this.inflight = new Map(); // track id -> promise
    this.loadSeq = 0;
    this.errorStreak = 0;
    this.listeners = {};
    this.describe = (track) => ({ title: track.name, artist: "" });
    this.lastPositionUpdate = 0;
    this.wireAudio();
    this.wireMediaSession();
  }

  on(name, fn) {
    (this.listeners[name] ||= []).push(fn);
    return this;
  }

  emit(name, data) {
    (this.listeners[name] || []).forEach((fn) => fn(data));
  }

  get currentEntry() {
    return this.order[this.index] || null;
  }

  get current() {
    return this.currentEntry ? this.currentEntry.track : null;
  }

  get upNext() {
    return this.index >= 0 ? this.order.slice(this.index + 1) : [];
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit("state");
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = status === "playing" ? "playing" : "paused";
    }
  }

  // ---- audio element wiring ----
  wireAudio() {
    const a = this.audio;
    a.addEventListener("playing", () => {
      this.errorStreak = 0;
      this.setStatus("playing");
    });
    a.addEventListener("play", () => {
      if (this.status !== "loading") this.setStatus("playing");
    });
    a.addEventListener("pause", () => {
      if (!a.ended && this.status !== "loading") this.setStatus("paused");
    });
    a.addEventListener("timeupdate", () => {
      this.emit("time");
      this.updatePosition();
    });
    a.addEventListener("loadedmetadata", () => {
      this.emit("time");
      this.updatePosition(true);
    });
    a.addEventListener("durationchange", () => this.emit("time"));
    a.addEventListener("ended", () => this.onEnded());
    a.addEventListener("error", () => {
      if (!a.getAttribute("src")) return;
      this.handleFailure(new Error("decode"));
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
    set("pause", () => this.audio.pause());
    set("previoustrack", () => this.prev());
    set("nexttrack", () => this.next());
    set("seekto", (d) => {
      if (typeof d.seekTime === "number") this.seek(d.seekTime);
    });
  }

  updateMediaMetadata(track) {
    if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
    const info = this.describe(track);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: info.title,
      artist: info.artist || "",
      album: "MP3 Blast",
      artwork: [
        {
          src: new URL("icons/icon-512.png", document.baseURI).href,
          sizes: "512x512",
          type: "image/png",
        },
      ],
    });
  }

  updatePosition(force = false) {
    if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
    const now = Date.now();
    if (!force && now - this.lastPositionUpdate < 1000) return;
    this.lastPositionUpdate = now;
    const a = this.audio;
    if (Number.isFinite(a.duration) && a.duration > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration: a.duration,
          playbackRate: a.playbackRate || 1,
          position: Math.min(a.currentTime, a.duration),
        });
      } catch {
        /* ignore */
      }
    }
  }

  // ---- loading songs ----
  getUrl(track) {
    const hit = this.cache.get(track.id);
    if (hit) {
      this.cache.delete(track.id);
      this.cache.set(track.id, hit); // mark as recently used
      return Promise.resolve(hit);
    }
    let pending = this.inflight.get(track.id);
    if (!pending) {
      pending = fetchAudioBlob(track, (loaded, total) =>
        this.emit("progress", { id: track.id, loaded, total })
      )
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          this.cache.set(track.id, url);
          this.trimCache();
          return url;
        })
        .finally(() => this.inflight.delete(track.id));
      this.inflight.set(track.id, pending);
    }
    return pending;
  }

  trimCache() {
    const keep = new Set();
    if (this.current) keep.add(this.current.id);
    const nxt = this.peekNext();
    if (nxt) keep.add(nxt.track.id);
    for (const [id, url] of this.cache) {
      if (this.cache.size <= MAX_CACHE) break;
      if (keep.has(id)) continue;
      URL.revokeObjectURL(url);
      this.cache.delete(id);
    }
  }

  peekNext() {
    if (!this.order.length) return null;
    if (this.index + 1 < this.order.length) return this.order[this.index + 1];
    if (this.repeat === "all") return this.order[0];
    return null;
  }

  prefetchNext() {
    const nxt = this.peekNext();
    if (!nxt || this.cache.has(nxt.track.id) || this.inflight.has(nxt.track.id)) return;
    this.getUrl(nxt.track).catch(() => {});
  }

  // Runs synchronously when the song is already in memory, so the next song can start
  // right inside the "ended" event (important for screen-off playback on iPhone).
  playIndex(i) {
    if (i < 0 || i >= this.order.length) return Promise.resolve();
    this.index = i;
    this.awaitingAuth = false;
    const track = this.order[i].track;
    const seq = ++this.loadSeq;
    this.updateMediaMetadata(track);
    this.emit("track", this.order[i]);
    this.emit("queue");

    const cached = this.cache.get(track.id);
    if (cached) return this.startUrl(cached, seq);

    this.audio.pause();
    this.setStatus("loading");
    return this.getUrl(track)
      .then((url) => {
        if (seq !== this.loadSeq) return undefined;
        return this.startUrl(url, seq);
      })
      .catch((err) => {
        if (seq !== this.loadSeq) return;
        if (err instanceof AuthError) {
          this.awaitingAuth = true;
          this.setStatus("paused");
          this.emit("needauth");
          return;
        }
        this.handleFailure(err);
      });
  }

  startUrl(url, seq) {
    this.audio.src = url;
    const attempt = this.audio.play();
    this.prefetchNext();
    this.trimCache();
    if (!attempt || !attempt.catch) return Promise.resolve();
    return attempt.catch((err) => {
      if (seq !== this.loadSeq) return;
      if (err && err.name === "NotAllowedError") {
        this.setStatus("paused");
        this.emit("blocked");
      } else if (!err || err.name !== "AbortError") {
        this.handleFailure(err);
      }
    });
  }

  handleFailure(err) {
    this.errorStreak += 1;
    this.emit("error", { track: this.current, error: err });
    const canSkip = this.errorStreak < 5 && this.index + 1 < this.order.length;
    if (canSkip) {
      this.setStatus("loading");
      const seq = this.loadSeq;
      setTimeout(() => {
        if (seq === this.loadSeq) this.next(true);
      }, 900);
    } else {
      this.setStatus("paused");
    }
  }

  // ---- public controls ----
  setQueue(tracks, startAt = 0) {
    if (!tracks.length) return Promise.resolve();
    this.base = tracks.map(makeEntry);
    const startEntry = this.base[startAt];
    if (this.shuffle) {
      const rest = this.base.filter((e) => e !== startEntry);
      this.order = [startEntry, ...shuffled(rest)];
      this.index = 0;
    } else {
      this.order = this.base.slice();
      this.index = startAt;
    }
    return this.playIndex(this.index);
  }

  resume() {
    if (!this.current) return;
    if (this.awaitingAuth || !this.audio.getAttribute("src")) {
      this.playIndex(this.index);
      return;
    }
    const attempt = this.audio.play();
    if (attempt && attempt.catch) attempt.catch(() => {});
  }

  toggle() {
    if (!this.current || this.status === "loading") return;
    if (this.status === "playing") this.audio.pause();
    else this.resume();
  }

  retry() {
    if (this.current) this.playIndex(this.index);
  }

  next(auto = false) {
    if (!this.order.length) return Promise.resolve();
    if (this.index + 1 < this.order.length) return this.playIndex(this.index + 1);
    if (this.repeat === "all" || !auto) {
      if (this.shuffle) {
        const first = this.order[0];
        this.order = [first, ...shuffled(this.order.slice(1))];
      }
      return this.playIndex(0);
    }
    // end of the queue with repeat off
    this.audio.pause();
    this.audio.currentTime = 0;
    this.setStatus("paused");
    return Promise.resolve();
  }

  prev() {
    if (!this.order.length) return Promise.resolve();
    if (this.audio.currentTime > 3 || (this.index === 0 && this.repeat !== "all")) {
      this.seek(0);
      return Promise.resolve();
    }
    if (this.index > 0) return this.playIndex(this.index - 1);
    return this.playIndex(this.order.length - 1);
  }

  onEnded() {
    if (this.repeat === "one") {
      this.audio.currentTime = 0;
      const attempt = this.audio.play();
      if (attempt && attempt.catch) attempt.catch(() => {});
      return;
    }
    this.next(true);
  }

  seek(seconds) {
    if (Number.isFinite(seconds)) this.audio.currentTime = Math.max(0, seconds);
  }

  setVolume(v) {
    this.audio.volume = Math.min(1, Math.max(0, v));
  }

  setShuffle(on) {
    this.shuffle = !!on;
    const cur = this.currentEntry;
    if (cur) {
      if (this.shuffle) {
        const head = this.order.slice(0, this.index + 1);
        this.order = [...head, ...shuffled(this.order.slice(this.index + 1))];
      } else {
        this.order = this.base.slice();
        this.index = Math.max(0, this.order.indexOf(cur));
      }
      this.prefetchNext();
      this.emit("queue");
    }
    this.emit("mode");
  }

  cycleRepeat() {
    this.repeat = this.repeat === "off" ? "all" : this.repeat === "all" ? "one" : "off";
    this.prefetchNext();
    this.emit("mode");
  }

  playNext(track) {
    const entry = makeEntry(track);
    if (!this.current) return this.setQueue([track], 0);
    this.order.splice(this.index + 1, 0, entry);
    const basePos = this.base.indexOf(this.currentEntry);
    this.base.splice(basePos >= 0 ? basePos + 1 : this.base.length, 0, entry);
    this.prefetchNext();
    this.emit("queue");
    return Promise.resolve();
  }

  enqueue(track) {
    if (!this.current) return this.setQueue([track], 0);
    const entry = makeEntry(track);
    this.order.push(entry);
    this.base.push(entry);
    this.prefetchNext();
    this.emit("queue");
    return Promise.resolve();
  }

  removeUpcoming(uid) {
    const at = this.order.findIndex((e, i) => i > this.index && e.uid === uid);
    if (at < 0) return;
    this.order.splice(at, 1);
    this.base = this.base.filter((e) => e.uid !== uid);
    this.prefetchNext();
    this.emit("queue");
  }

  clearUpcoming() {
    if (this.index < 0) return;
    const keep = new Set(this.order.slice(0, this.index + 1));
    this.order = this.order.slice(0, this.index + 1);
    this.base = this.base.filter((e) => keep.has(e));
    this.emit("queue");
  }

  stop() {
    this.loadSeq += 1;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.base = [];
    this.order = [];
    this.index = -1;
    this.awaitingAuth = false;
    this.setStatus("idle");
    this.emit("track", null);
    this.emit("queue");
  }
}
