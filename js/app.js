import { store } from "./store.js";
import { icon } from "./icons.js";
import { isConfigured, onAuth, signIn, signOutUser, finishRedirect, getToken } from "./auth.js";
import { parseFolderId, getFolderInfo, scanFolder, displayTitle, renameFile, extOf, AuthError, DriveError } from "./drive.js";
import { Player } from "./player.js";
import { MetaStore, TAG_COLORS } from "./meta.js";
import * as cloud from "./cloud.js";
import { Radio, loadStations } from "./radio.js";
import { tr, setLang, getLang, applyStatic, LANGS } from "./i18n.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const THEME_GROUPS = ["color", "pastel", "blend", "rainbow", "night"];
// `preview` is what the round swatch shows when the page background is a gradient.
const THEMES = [
  { id: "yellow", bg: "#FFD42E", accent: "#17130A", group: "color" },
  { id: "red", bg: "#D92B3A", accent: "#FFFFFF", group: "color" },
  { id: "green", bg: "#14804A", accent: "#FFFFFF", group: "color" },
  { id: "teal", bg: "#0B7F7A", accent: "#FFFFFF", group: "color" },
  { id: "blue", bg: "#2B4FD8", accent: "#FFFFFF", group: "color" },
  { id: "blush", bg: "#FFD9E4", accent: "#B83A63", group: "pastel" },
  { id: "butter", bg: "#FFF1A8", accent: "#7A5C00", group: "pastel" },
  { id: "sky", bg: "#D6EBFF", accent: "#2F6FA8", group: "pastel" },
  { id: "pistachio", bg: "#DDF3C8", accent: "#4B7F23", group: "pastel" },
  { id: "lavender", bg: "#E6DDFF", accent: "#6A4FC4", group: "pastel" },
  { id: "peach", bg: "#FFDFC9", accent: "#B4531F", group: "pastel" },
  { id: "sunset", bg: "#FFD9C0", accent: "#B8472E", group: "blend", preview: "linear-gradient(135deg,#FFB8D1,#FFD9B8 50%,#FFF09A)" },
  { id: "ocean", bg: "#CDEAF2", accent: "#1F7A8C", group: "blend", preview: "linear-gradient(135deg,#BFF3DF,#C9E6FF 50%,#D9D0FF)" },
  { id: "candy", bg: "#EBD3F5", accent: "#A23890", group: "blend", preview: "linear-gradient(135deg,#FFC2E0,#E1CCFF 50%,#BFE3FF)" },
  { id: "lemonade", bg: "#E4F5C2", accent: "#4F7D12", group: "blend", preview: "linear-gradient(135deg,#FFF3A0,#E3F6B8 50%,#BDF1D6)" },
  { id: "rainbow-soft", bg: "#E9E3FF", accent: "#6F46D9", group: "rainbow", preview: "linear-gradient(135deg,#FFB3B3,#FFD6A5 18%,#FDFFB6 36%,#CAFFBF 54%,#9BF6FF 72%,#BDB2FF)" },
  { id: "rainbow-bright", bg: "#FFC857", accent: "#1B1033", group: "rainbow", preview: "linear-gradient(135deg,#FF6B6B,#FFA94D 20%,#FFE066 40%,#69DB7C 60%,#4DABF7 80%,#9775FA)" },
  { id: "night", bg: "#000000", accent: "#F4F4F4", group: "night" },
  { id: "gold", bg: "#0C0A06", accent: "#FFB81F", group: "night" },
  { id: "violet", bg: "#0A0710", accent: "#A58BFF", group: "night" },
  { id: "mint", bg: "#050B0A", accent: "#3DE3B0", group: "night" },
  { id: "aurora", bg: "#0B1020", accent: "#FF8AD8", group: "night", preview: "linear-gradient(135deg,#1B1450,#0C3A52 50%,#4A1450)" },
];

const FONTS = [
  { id: "lato", key: "font.lato" },
  { id: "lato-bold", key: "font.lato-bold" },
  { id: "roboto", name: "Roboto" },
  { id: "poppins", name: "Poppins" },
  { id: "nunito", name: "Nunito" },
  { id: "quicksand", name: "Quicksand" },
  { id: "hind", name: "Hind Siliguri" },
  { id: "baloo", name: "Baloo Da 2" },
  { id: "tiro", name: "Tiro Bangla" },
];

const TABS = [
  { id: "now", key: "tab.now", icon: "disc" },
  { id: "songs", key: "tab.songs", icon: "note" },
  { id: "radio", key: "tab.radio", icon: "radio" },
  { id: "folders", key: "tab.folders", icon: "folder" },
  { id: "look", key: "tab.look", icon: "palette" },
];

const collator = new Intl.Collator(["bn", "en"], { numeric: true, sensitivity: "base" });
const CHUNK = 150;

// ---------- state ----------
let prefs = store.prefs();
let folders = store.folders();
let tracks = store.tracks();
let filter = { q: "" };
let mode = "all"; // all | fav | artist | album | movie | tag | folder
let sub = null; // chosen group inside a group mode (null = show the group list)
let editing = null; // song details being edited
let selecting = false; // multi-select mode in the songs list
const selected = new Set(); // ids of selected songs
let plReorder = false; // reorder mode inside a playlist
let plTarget = null; // songs waiting to be put in a playlist
let plEditing = null; // playlist being created or renamed
let songsViewPos = null; // inside a playlist: position of each listed song in the playlist
let radioList = [];
let radioState = "idle"; // idle | loading | ready | error
let radioStale = false;
let radioQuery = "";
let reconciling = false;
let grabOpened = false;
let tagEditing = null;
let cloudUid = null;
let syncWarned = false;
let syncState = "";
const meta = new MetaStore();
let tab = "now";
let songsView = [];
let songsShown = 0;
let sheetTrack = null;
let busy = false;
let dragging = false;
let dragTimer = 0;
let appReady = false;
let toastTimer = 0;

const player = new Player();
player.shuffle = !!prefs.shuffle;
player.repeat = prefs.repeat || "off";
const radio = new Radio();

// ---------- small helpers ----------
const folderName = (id) => (folders.find((f) => f.id === id) || {}).name || "";
const trackSub = (t) => {
  const m = meta.get(t.id);
  const about = [m.artist, m.movie || m.album].filter(Boolean);
  if (about.length) return about.join(", ");
  return [folderName(t.root), t.path].filter(Boolean).join(" › ");
};
player.describe = (t) => ({ title: displayTitle(t), artist: trackSub(t) });

function fmt(sec) {
  let s = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  s %= 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function firstGlyph(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const seg = new Intl.Segmenter("bn", { granularity: "grapheme" }).segment(t)[Symbol.iterator]().next();
    return seg.value ? seg.value.segment : "";
  }
  return Array.from(t)[0];
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3800);
}

function persist() {
  store.saveFolders(folders);
  if (!store.saveTracks(tracks)) toast(tr("songs.saveFail"));
}

function sortTracks(list) {
  const order = new Map(folders.map((f, i) => [f.id, i]));
  return list.slice().sort((a, b) => {
    const fa = order.has(a.root) ? order.get(a.root) : 999;
    const fb = order.has(b.root) ? order.get(b.root) : 999;
    if (fa !== fb) return fa - fb;
    return collator.compare(a.path, b.path) || collator.compare(a.name, b.name);
  });
}

// ---------- theme and font ----------
function applyTheme(id) {
  const theme = THEMES.find((t) => t.id === id) || THEMES[0];
  document.documentElement.dataset.theme = theme.id;
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = theme.bg;
}

function applyFont(id) {
  document.documentElement.dataset.font = FONTS.some((f) => f.id === id) ? id : "lato";
}

function savePrefs() {
  store.savePrefs(prefs);
}

function renderLook() {
  const swatch = (t) => `
    <button class="theme-btn" type="button" data-theme-id="${t.id}" aria-pressed="${prefs.theme === t.id}">
      <span class="swatch" style="background:${t.preview || t.bg};--sw-accent:${t.accent};--sw-ink:${t.accent}">${
        prefs.theme === t.id ? icon("check") : ""
      }</span>
      <span>${esc(tr("theme." + t.id))}</span>
    </button>`;
  $("#themes").innerHTML = THEME_GROUPS.map(
    (g) => `
    <p class="group-label">${esc(tr("group." + g))}</p>
    <div class="themes">${THEMES.filter((t) => t.group === g).map(swatch).join("")}</div>`
  ).join("");

  $("#fonts").innerHTML = FONTS.map(
    (f) => `
    <button class="font-row fs-${f.id}" type="button" data-font-id="${f.id}" aria-pressed="${prefs.font === f.id}">
      <span class="font-text">
        <span class="font-name">${esc(f.key ? tr(f.key) : f.name)}</span>
        <span class="font-sample">${esc(tr("font.sample"))}</span>
      </span>
      ${prefs.font === f.id ? icon("check") : ""}
    </button>`
  ).join("");

  $("#langs").innerHTML = LANGS.map(
    (l) =>
      `<button class="btn" type="button" data-lang="${l}" aria-pressed="${getLang() === l}">${l === "en" ? "English" : "বাংলা"}</button>`
  ).join("");
}

// ---------- tabs ----------
function renderNav() {
  $$(".nav-btn").forEach((btn) => {
    const t = TABS.find((x) => x.id === btn.dataset.tab);
    btn.innerHTML = `<span class="nav-ic">${icon(t.icon)}</span><span>${esc(tr(t.key))}</span>`;
  });
}

function showTab(name) {
  tab = name;
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${name}`));
  $$(".nav-btn").forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  $("#main").scrollTop = 0;
  renderMini();
  renderSelbar();
  if (name === "radio") ensureRadioList();
}

function renderMini() {
  const mini = $("#mini");
  mini.hidden = !player.current || tab === "now";
}

// ---------- now playing ----------
function renderControls() {
  $("#btn-shuffle").innerHTML = icon("shuffle");
  $("#btn-prev").innerHTML = icon("prev");
  $("#btn-next").innerHTML = icon("next");
  $("#mini-next").innerHTML = icon("next");
  $("#search-ic").innerHTML = icon("search");
  $("#vol-ic").innerHTML = icon("volume");
  $$("[data-ic]").forEach((el) => (el.innerHTML = icon(el.dataset.ic)));
  $("#btn-undo").innerHTML = icon("undo");
  $("#btn-redo").innerHTML = icon("redo");
  renderMode();
  renderState();
}

function renderMode() {
  $("#btn-shuffle").setAttribute("aria-pressed", String(player.shuffle));
  const rep = $("#btn-repeat");
  rep.innerHTML = icon(player.repeat === "one" ? "repeat-one" : "repeat");
  rep.setAttribute("aria-pressed", String(player.repeat !== "off"));
  rep.setAttribute(
    "aria-label",
    player.repeat === "off" ? tr("ctl.repeatOff") : player.repeat === "all" ? tr("ctl.repeatAll") : tr("ctl.repeatOne")
  );
}

function renderState() {
  const playing = player.status === "playing";
  const label = playing ? tr("ctl.pause") : tr("ctl.play");
  const main = $("#btn-play");
  main.innerHTML = icon(playing ? "pause" : "play");
  main.setAttribute("aria-label", label);
  const mini = $("#mini-play");
  mini.innerHTML = icon(playing ? "pause" : "play");
  mini.setAttribute("aria-label", label);
  $("#disc").classList.toggle("playing", playing);
  $("#eq").classList.toggle("on", playing);
  if (player.status === "loading") $("#now-status").textContent = tr("now.loading");
  else if (player.status !== "idle" || !player.current) $("#now-status").textContent = "";
}

function renderTrack() {
  const t = player.current;
  const letter = $("#disc-letter");
  if (!t) {
    $("#now-title").textContent = tr("now.nothing");
    $("#now-sub").textContent = tr("now.pick");
    letter.innerHTML = icon("note");
    document.title = "MP3 Blast";
  } else {
    const title = displayTitle(t);
    $("#now-title").textContent = title;
    $("#now-sub").textContent = trackSub(t);
    letter.textContent = firstGlyph(title);
    $("#mini-title").textContent = title;
    $("#mini-sub").textContent = trackSub(t);
    document.title = `${title} — MP3 Blast`;
  }
  renderMini();
  highlightCurrent();
  renderTime();
}

function renderTime() {
  const a = player.audio;
  const dur = Number.isFinite(a.duration) ? a.duration : 0;
  const cur = a.currentTime || 0;
  $("#t-cur").textContent = fmt(cur);
  $("#t-dur").textContent = fmt(dur);
  if (!dragging) {
    const per = dur ? Math.min(1000, (cur / dur) * 1000) : 0;
    const seek = $("#seek");
    seek.value = String(per);
    seek.style.setProperty("--pct", `${per / 10}%`);
  }
  noteTime();
}

function renderQueue() {
  const list = $("#queue-list");
  const up = player.upNext;
  list.textContent = "";
  $("#btn-clear-queue").hidden = up.length === 0;
  if (!up.length) {
    list.innerHTML = `<li class="list-note">${tr("queue.empty")}</li>`;
    return;
  }
  const frag = document.createDocumentFragment();
  up.slice(0, QUEUE_SHOWN).forEach((entry, k) => {
    const li = document.createElement("li");
    li.className = "row";
    li.dataset.pos = String(player.index + 1 + k);
    li.dataset.uid = String(entry.uid);
    li.innerHTML = `
      <button class="row-main" type="button">
        <span class="row-idx">${k + 1}</span>
        <span class="row-text">
          <span class="row-title">${esc(displayTitle(entry.track))}</span>
          <span class="row-sub">${esc(trackSub(entry.track))}</span>
        </span>
      </button>
      <button class="row-more" type="button" data-remove aria-label="${esc(tr("queue.remove"))}">${icon("close")}</button>`;
    frag.append(li);
  });
  list.append(frag);
  if (up.length > QUEUE_SHOWN) {
    const more = document.createElement("li");
    more.className = "list-note";
    more.textContent = tr("queue.more", { n: up.length - QUEUE_SHOWN });
    list.append(more);
  }
}

// ---------- dashboard (Now Playing extras) ----------
const QUEUE_SHOWN = 10;
const SLEEP_OPTIONS = [0, 15, 30, 60];
let userName = "";
let statsData = store.stats(); // play counts and recent songs, kept on this device only
let countedFor = null; // queue entry already counted as a play
let dashRecent = [];
let dashMost = [];
let sleepMin = 0;
let sleepEnd = 0;
let sleepTimer = 0;
let sleepTick = 0;

function buildEq() {
  const n = 28;
  $("#eq").innerHTML = Array.from({ length: n }, (_, i) => {
    const a = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
    const b = Math.abs(Math.sin(i * 78.233) * 12345.6789) % 1;
    const style = `--s:${(0.35 + a * 0.65).toFixed(2)};--d:${(0.45 + b * 0.8).toFixed(2)}s;--dl:-${(a * 1.5).toFixed(2)}s;--hc:${Math.round((i / n) * 300)}`;
    return `<i style="${style}"></i>`;
  }).join("");
}

function greetingKey(hour) {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 15) return "noon";
  if (hour >= 15 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 21) return "evening";
  return "night";
}

function renderGreeting() {
  const word = tr("greet." + greetingKey(new Date().getHours()));
  $("#greet-title").textContent = userName ? `${word}, ${userName}` : word;
  const favs = tracks.filter((t) => meta.get(t.id).fav).length;
  $("#greet-sub").textContent = tracks.length
    ? `${tr("songs.n", { n: tracks.length })} · ${tr("dash.favs", { n: favs })}`
    : tr("dash.add");
}

function hueOf(text) {
  let h = 0;
  for (const c of String(text)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function cardsHtml(list, subOf) {
  if (!list.length) return `<p class="list-note">${esc(tr("dash.nostats"))}</p>`;
  return list
    .map((t, i) => {
      const title = displayTitle(t);
      return `<button class="card" type="button" data-i="${i}">
        <span class="card-tile" style="--h:${hueOf(t.id)}">${esc(firstGlyph(title))}</span>
        <span class="card-title">${esc(title)}</span>
        <span class="card-sub">${esc(subOf(t, i))}</span>
      </button>`;
    })
    .join("");
}

function renderCards() {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  dashRecent = statsData.recent.map((id) => byId.get(id)).filter(Boolean).slice(0, 12);
  const ranked = Object.entries(statsData.plays)
    .filter(([id, n]) => byId.has(id) && n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  dashMost = ranked.map(([id]) => byId.get(id));
  $("#cards-recent").innerHTML = cardsHtml(dashRecent, (t) => trackSub(t));
  $("#cards-most").innerHTML = cardsHtml(dashMost, (t, i) => tr("dash.plays", { n: ranked[i][1] }));
}

function renderQuick() {
  $("#q-radio-sub").textContent = prefs.lastStation ? prefs.lastStation.name : "";
}

function updateSleepLeft() {
  const el = $("#sleep-left");
  if (!sleepEnd) {
    el.textContent = "";
    return;
  }
  el.textContent = tr("sleep.left", { t: fmt(Math.max(0, Math.ceil((sleepEnd - Date.now()) / 1000))) });
}

function renderSleep() {
  $("#sleep-opts").innerHTML = SLEEP_OPTIONS.map(
    (m) =>
      `<button class="chip" type="button" data-sleep="${m}" aria-pressed="${sleepMin === m}">${esc(
        m ? tr("sleep.min", { n: m }) : tr("sleep.off")
      )}</button>`
  ).join("");
  updateSleepLeft();
}

function setSleep(min) {
  clearTimeout(sleepTimer);
  clearInterval(sleepTick);
  sleepMin = min;
  sleepEnd = 0;
  if (min) {
    sleepEnd = Date.now() + min * 60000;
    sleepTimer = setTimeout(sleepFire, min * 60000);
    sleepTick = setInterval(() => {
      if (Date.now() >= sleepEnd) sleepFire();
      else updateSleepLeft();
    }, 1000);
  }
  renderSleep();
}

function sleepFire() {
  setSleep(0);
  player.audio.pause();
  if (radio.station) radio.pause();
  toast(tr("sleep.done"));
}

function renderDash() {
  renderGreeting();
  renderCards();
  renderQuick();
  renderSleep();
}

function recordPlay(id) {
  statsData.plays[id] = (statsData.plays[id] || 0) + 1;
  statsData.recent = [id, ...statsData.recent.filter((x) => x !== id)].slice(0, 30);
  store.saveStats(statsData);
  renderCards();
}

// A song counts as played once it has run for 10 seconds.
function noteTime() {
  const entry = player.currentEntry;
  if (!entry || player.status !== "playing") return;
  const at = player.audio.currentTime || 0;
  if (at < 2) countedFor = null;
  else if (at >= 10 && countedFor !== entry.uid) {
    countedFor = entry.uid;
    recordPlay(entry.track.id);
  }
}

function shuffledCopy(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function quickPlay(kind) {
  if (kind === "radio") {
    if (!prefs.lastStation) return showTab("radio");
    if (player.status === "playing") player.audio.pause();
    radio.play(prefs.lastStation);
    return;
  }
  if (!tracks.length) return toast(tr("songs.none"));
  if (kind === "fav") {
    const favs = tracks.filter((t) => meta.get(t.id).fav);
    if (!favs.length) return toast(tr("songs.noFav"));
    player.setQueue(shuffledCopy(favs), 0);
  } else {
    player.setQueue(shuffledCopy(tracks).slice(0, 50), 0);
  }
}

// ---------- songs ----------
const MODES = ["all", "fav", "playlist", "artist", "album", "movie", "tag", "folder"].map((id) => ({ id }));
const GROUP_MODES = new Set(["playlist", "artist", "album", "movie", "tag", "folder"]);

const modeLabel = (id) => tr("mode." + id);
const isGroupList = () => GROUP_MODES.has(mode) && sub === null && !filter.q.trim();

function subLabel() {
  if (mode === "tag") return (meta.tag(sub) || {}).name || "";
  if (mode === "playlist") return (meta.playlist(sub) || {}).name || "";
  if (mode === "folder") return folderName(sub);
  return sub === "" ? tr("novalue") : sub;
}

function inScope(t) {
  const m = meta.get(t.id);
  if (mode === "fav") return m.fav;
  if (!GROUP_MODES.has(mode) || sub === null) return true;
  if (mode === "playlist") return true; // handled in filteredTracks
  if (mode === "tag") return m.tags.includes(sub);
  if (mode === "folder") return t.root === sub;
  return m[mode] === sub;
}

const reorderOn = () => plReorder && mode === "playlist" && sub !== null && !selecting && !filter.q.trim();

function matchesQuery(t, q) {
  if (!q) return true;
  const m = meta.get(t.id);
  return `${displayTitle(t)} ${t.path} ${folderName(t.root)} ${m.artist} ${m.album} ${m.movie}`.toLowerCase().includes(q);
}

function filteredTracks() {
  const q = filter.q.trim().toLowerCase();
  songsViewPos = null;
  if (mode === "playlist" && sub !== null) {
    const pl = meta.playlist(sub);
    const byId = new Map(tracks.map((t) => [t.id, t]));
    const out = [];
    const pos = [];
    (pl ? pl.ids : []).forEach((id, p) => {
      const t = byId.get(id);
      if (t && matchesQuery(t, q)) {
        out.push(t);
        pos.push(p);
      }
    });
    songsViewPos = pos;
    return out;
  }
  return tracks.filter((t) => inScope(t) && matchesQuery(t, q));
}

function songRow(track, i) {
  const li = document.createElement("li");
  const isCurrent = player.current && player.current.id === track.id;
  li.className = "row" + (isCurrent ? " is-current" : "") + (selecting && selected.has(track.id) ? " is-selected" : "");
  li.dataset.i = String(i);
  const m = meta.get(track.id);
  const dots = m.tags
    .slice(0, 3)
    .map((id) => meta.tag(id))
    .filter(Boolean)
    .map((tg) => `<span class="tag-dot" style="--c:${esc(tg.color)}" title="${esc(tg.name)}"></span>`)
    .join("");
  const flags = (m.fav ? icon("heart") : "") + dots;
  li.innerHTML = `
    <button class="row-main" type="button">
      <span class="row-idx"><span class="idx-num">${i + 1}</span><span class="idx-now">${icon("note")}</span><span class="idx-check">${icon("check")}</span></span>
      <span class="row-text">
        <span class="row-title">${esc(displayTitle(track))}</span>
        <span class="row-sub">${esc(trackSub(track))}</span>
      </span>
      ${flags ? `<span class="row-flags">${flags}</span>` : ""}
    </button>
    ${
      reorderOn()
        ? `<span class="row-acts">
            <button class="row-act" type="button" data-pl-up aria-label="${esc(tr("pl.up"))}" ${i === 0 ? "disabled" : ""}>${icon("up")}</button>
            <button class="row-act" type="button" data-pl-down aria-label="${esc(tr("pl.down"))}" ${i === songsView.length - 1 ? "disabled" : ""}>${icon("down")}</button>
            <button class="row-act" type="button" data-pl-del aria-label="${esc(tr("pl.remove"))}">${icon("close")}</button>
          </span>`
        : `<button class="row-more" type="button" data-more aria-label="${esc(tr("songs.more"))}">${icon("more")}</button>`
    }`;
  return li;
}

function appendSongs() {
  const list = $("#songs-list");
  const end = Math.min(songsShown + CHUNK, songsView.length);
  const frag = document.createDocumentFragment();
  for (let i = songsShown; i < end; i++) frag.append(songRow(songsView[i], i));
  list.append(frag);
  songsShown = end;
  $("#songs-sentinel").hidden = songsShown >= songsView.length;
}

function renderChips() {
  $("#chips").innerHTML = MODES.map(
    (m) => `<button class="chip" type="button" data-mode="${m.id}" aria-pressed="${mode === m.id}">${esc(modeLabel(m.id))}</button>`
  ).join("");
}

function renderCrumb() {
  const show = GROUP_MODES.has(mode) && sub !== null;
  $("#crumb").hidden = !show;
  if (show) $("#crumb-back").innerHTML = `${icon("back")}<span>${esc(modeLabel(mode))}: ${esc(subLabel())}</span>`;
}

function renderUndoRedo() {
  $("#btn-undo").disabled = !meta.canUndo;
  $("#btn-redo").disabled = !meta.canRedo;
}

function buildGroups() {
  if (mode === "folder") {
    return folders.map((f) => ({ key: f.id, label: f.name, count: tracks.filter((t) => t.root === f.id).length }));
  }
  if (mode === "playlist") {
    const have = new Set(tracks.map((t) => t.id));
    return meta.data.playlists.map((p) => ({
      key: p.id,
      label: p.name,
      count: p.ids.filter((id) => have.has(id)).length,
    }));
  }
  if (mode === "tag") {
    return meta.tags.map((tg) => ({
      key: tg.id,
      label: tg.name,
      color: tg.color,
      count: tracks.filter((t) => meta.get(t.id).tags.includes(tg.id)).length,
    }));
  }
  const counts = new Map();
  tracks.forEach((t) => {
    const value = meta.get(t.id)[mode];
    counts.set(value, (counts.get(value) || 0) + 1);
  });
  return [...counts]
    .map(([key, count]) => ({ key, label: key || tr("novalue"), count }))
    .sort((a, b) => (a.key === "") - (b.key === "") || collator.compare(a.label, b.label));
}

function renderGroups() {
  const list = $("#songs-list");
  const groups = buildGroups();
  songsView = [];
  songsShown = 0;
  $("#songs-sentinel").hidden = true;
  $("#songs-empty").hidden = true;
  $("#songs-count").textContent = groups.length ? tr("count." + mode, { n: groups.length }) : "";
  const frag = document.createDocumentFragment();
  if (mode === "tag" || mode === "playlist") {
    const add = document.createElement("li");
    add.className = "group-add";
    add.innerHTML =
      mode === "tag"
        ? `<button class="btn" type="button" data-new-tag>${icon("plus")}${tr("tag.new")}</button>`
        : `<button class="btn" type="button" data-new-pl>${icon("plus")}${tr("pl.newBtn")}</button>`;
    frag.append(add);
  }
  groups.forEach((g) => {
    const li = document.createElement("li");
    li.className = "row group-row";
    li.dataset.key = g.key;
    const lead =
      mode === "tag"
        ? `<span class="tag-dot" style="--c:${esc(g.color)}"></span>`
        : icon(mode === "folder" ? "folder" : mode === "playlist" ? "queue" : "note");
    li.innerHTML =
      `<button class="row-main" type="button">
        <span class="row-idx">${lead}</span>
        <span class="row-text">
          <span class="row-title">${esc(g.label)}</span>
          <span class="row-sub">${tr("songs.n", { n: g.count })}</span>
        </span>
        <span class="ic-chev">${icon("chevron")}</span>
      </button>` +
      (mode === "tag"
        ? `<button class="row-more" type="button" data-edit-tag aria-label="${esc(tr("tag.edit"))}">${icon("edit")}</button>`
        : "");
    frag.append(li);
  });
  if (!groups.length) {
    const note = document.createElement("li");
    note.className = "list-note";
    note.textContent =
      mode === "tag"
        ? tr("empty.tag")
        : mode === "playlist"
        ? tr("empty.playlist")
        : mode === "folder"
        ? tr("empty.folder")
        : tr("empty.other");
    frag.append(note);
  }
  list.textContent = "";
  list.append(frag);
}

function renderSelbar() {
  const n = selected.size;
  $("#selbar").hidden = !(selecting && tab === "songs");
  $("#sel-count").textContent = n ? tr("sel.count", { n }) : tr("sel.hint");
  $("#sel-edit").disabled = n === 0;
  const all = songsView.length > 0 && songsView.every((t) => selected.has(t.id));
  $("#sel-all").textContent = all ? tr("sel.none") : tr("sel.all");
  $("#sel-all").disabled = songsView.length === 0;
}

function setSelecting(on) {
  selecting = on;
  if (!on) selected.clear();
  renderSongs();
}

function renderSongs() {
  renderSongsInner();
  renderSelbar();
}

function renderPlBar() {
  const show = mode === "playlist" && sub !== null && !!meta.playlist(sub);
  $("#pl-bar").hidden = !show;
  if (!show) return;
  $("#pl-play").innerHTML = icon("play") + tr("pl.playAll");
  $("#pl-reorder").setAttribute("aria-pressed", String(plReorder));
  $("#pl-reorder").textContent = plReorder ? tr("pl.reorderDone") : tr("pl.reorder");
  $("#pl-reorder").disabled = selecting || !!filter.q.trim();
}

function renderSongsInner() {
  if (mode === "playlist" && sub !== null && !meta.playlist(sub)) sub = null;
  if (!(mode === "playlist" && sub !== null)) plReorder = false;
  renderChips();
  renderPlBar();
  renderCrumb();
  renderUndoRedo();
  const empty = $("#songs-empty");
  const selBtn = $("#btn-select");
  selBtn.hidden = isGroupList() || !tracks.length;
  selBtn.setAttribute("aria-pressed", String(selecting));
  selBtn.textContent = selecting ? tr("sel.end") : tr("sel.start");
  $("#songs-list").classList.toggle("selecting", selecting && !isGroupList());
  $("#songs-list").textContent = "";
  songsShown = 0;
  if (!tracks.length) {
    songsView = [];
    empty.hidden = false;
    empty.innerHTML = `<p>${tr("songs.none")}</p><p style="margin-top:14px"><button class="btn btn-primary" type="button" data-go="folders">${tr("songs.addFolder")}</button></p>`;
    $("#songs-count").textContent = "";
    $("#songs-sentinel").hidden = true;
    return;
  }
  if (isGroupList()) {
    renderGroups();
    return;
  }
  songsView = filteredTracks();
  $("#songs-count").textContent = tr("songs.n", { n: songsView.length });
  if (!songsView.length) {
    empty.hidden = false;
    empty.textContent =
      mode === "fav" && !filter.q.trim()
        ? tr("songs.noFav")
        : mode === "playlist" && sub !== null && !filter.q.trim()
        ? tr("songs.plEmpty")
        : tr("songs.nothing");
    $("#songs-sentinel").hidden = true;
    return;
  }
  empty.hidden = true;
  appendSongs();
}

function highlightCurrent() {
  const id = player.current ? player.current.id : null;
  $$("#songs-list .row").forEach((row) => {
    const t = songsView[Number(row.dataset.i)];
    row.classList.toggle("is-current", !!t && t.id === id);
  });
}

// ---------- folders ----------
function syncFoldersToMeta() {
  meta.setFolders(folders.map((f) => ({ id: f.id, name: f.name })));
}

function renderFolders() {
  renderGrab();
  const list = $("#folder-list");
  list.innerHTML = folders
    .map(
      (f) => `
    <li class="folder-card" data-id="${esc(f.id)}">
      <span class="ic-lead">${icon("folder")}</span>
      <div class="folder-info">
        <span class="folder-name">${esc(f.name)}</span>
        <span class="folder-meta">${tr("songs.n", { n: f.count })}</span>
      </div>
      <button class="icon-btn" type="button" data-act="rescan" aria-label="${esc(tr("folders.rescan"))}">${icon("refresh")}</button>
      <button class="icon-btn" type="button" data-act="remove" aria-label="${esc(tr("folders.remove"))}">${icon("delete")}</button>
    </li>`
    )
    .join("");
}

function setBusy(text) {
  const el = $("#folder-busy");
  el.hidden = !text;
  el.textContent = text || "";
  $("#folder-add").disabled = !!text;
}

function handleDriveError(err) {
  if (err instanceof AuthError) {
    updateBanner();
    toast(tr("folders.noauth"));
  } else if (err instanceof DriveError) {
    if (err.message === "not-a-folder") toast(tr("folders.notFolder"));
    else if (err.status === 404) toast(tr("folders.404"));
    else if (err.status === 403)
      toast(tr("folders.403"));
    else toast(tr("folders.code", { code: err.status }));
  } else {
    toast(tr("common.online"));
  }
}

async function scanInto(info, isNew) {
  const found = await scanFolder(info, (n) => setBusy(tr("folders.scanning", { n })));
  const record = { id: info.id, name: info.name, count: found.length, scannedAt: Date.now() };
  folders = isNew ? [...folders, record] : folders.map((f) => (f.id === info.id ? record : f));
  tracks = sortTracks([...tracks.filter((t) => t.root !== info.id), ...found]);
  persist();
  return found.length;
}

async function addFolder(raw) {
  const id = parseFolderId(raw);
  if (!id) return toast(tr("folders.noId"));
  if (folders.some((f) => f.id === id)) return toast(tr("folders.dup"));
  busy = true;
  setBusy(tr("folders.opening"));
  try {
    const info = await getFolderInfo(id);
    const n = await scanInto(info, true);
    $("#folder-input").value = "";
    syncFoldersToMeta();
    renderAll();
    toast(n ? tr("folders.addedN", { n }) : tr("folders.empty"));
  } catch (err) {
    handleDriveError(err);
  } finally {
    busy = false;
    setBusy("");
  }
}

async function rescanFolder(folder) {
  busy = true;
  setBusy(tr("folders.opening"));
  try {
    const info = await getFolderInfo(folder.id);
    const n = await scanInto(info, false);
    renderAll();
    toast(tr("songs.found", { n }));
  } catch (err) {
    handleDriveError(err);
  } finally {
    busy = false;
    setBusy("");
  }
}

function removeFolder(folder) {
  if (!confirm(tr("folders.confirmRemove", { name: folder.name }))) return;
  folders = folders.filter((f) => f.id !== folder.id);
  tracks = tracks.filter((t) => t.root !== folder.id);
  if (mode === "folder" && sub === folder.id) sub = null;
  persist();
  syncFoldersToMeta();
  renderAll();
}

// ---------- sheet ----------
function openSheet(track) {
  sheetTrack = track;
  const fav = meta.get(track.id).fav;
  $("#sheet-title").textContent = displayTitle(track);
  $("#sheet-fav").innerHTML = icon(fav ? "heart" : "heart-outline") + (fav ? tr("sheet.unfav") : tr("sheet.fav"));
  $("#sheet").hidden = false;
}

function closeSheet() {
  $("#sheet").hidden = true;
  sheetTrack = null;
}

// ---------- song details dialog ----------
function fillDatalist(selector, key) {
  const values = new Set();
  tracks.forEach((t) => {
    const v = meta.get(t.id)[key];
    if (v) values.add(v);
  });
  $(selector).innerHTML = [...values]
    .sort(collator.compare)
    .map((v) => `<option value="${esc(v)}"></option>`)
    .join("");
}

function renderEditTags() {
  const chips = meta.tags.map(
    (tg) =>
      `<button class="tagchip" type="button" data-tag="${esc(tg.id)}" aria-pressed="${editing.tags.has(tg.id)}"><span class="tag-dot" style="--c:${esc(tg.color)}"></span>${esc(tg.name)}</button>`
  );
  chips.push(`<button class="tagchip tagchip-add" type="button" data-new-tag>${icon("plus")}${tr("tag.new")}</button>`);
  $("#f-tags").innerHTML = chips.join("");
}

function renderEditFav() {
  const btn = $("#f-fav");
  btn.setAttribute("aria-pressed", String(editing.fav));
  const bulk = !!editing.bulk;
  const label = editing.fav
    ? bulk ? tr("edit.favBulkOn") : tr("edit.favOn")
    : bulk ? tr("edit.favBulkOff") : tr("edit.favOff");
  btn.innerHTML = icon(editing.fav ? "heart" : "heart-outline") + label;
}

const baseName = (name) => String(name || "").replace(/\.[^./\\]+$/, "");

function setEditFieldHints(bulk) {
  $("#name-field").hidden = bulk;
  ["#f-artist", "#f-album", "#f-movie"].forEach((sel) => {
    $(sel).placeholder = bulk ? tr("edit.wontChange") : "";
  });
  $("#edit-hint").hidden = !bulk;
}

function openBulkEdit() {
  const ids = tracks.filter((t) => selected.has(t.id)).map((t) => t.id);
  if (!ids.length) {
    toast(tr("sel.first"));
    return;
  }
  editing = { bulk: ids, tags: new Set(), fav: false };
  $("#edit-title").textContent = tr("edit.bulkTitle", { n: ids.length });
  ["#f-artist", "#f-album", "#f-movie"].forEach((sel) => ($(sel).value = ""));
  setEditFieldHints(true);
  fillDatalist("#dl-artist", "artist");
  fillDatalist("#dl-album", "album");
  fillDatalist("#dl-movie", "movie");
  renderEditTags();
  renderEditFav();
  $("#edit").hidden = false;
}

function openEdit(track) {
  const m = meta.get(track.id);
  editing = { id: track.id, track, tags: new Set(m.tags), fav: m.fav, before: m };
  setEditFieldHints(false);
  $("#f-name").value = baseName(track.name);
  $("#edit-title").textContent = displayTitle(track);
  $("#f-artist").value = m.artist;
  $("#f-album").value = m.album;
  $("#f-movie").value = m.movie;
  fillDatalist("#dl-artist", "artist");
  fillDatalist("#dl-album", "album");
  fillDatalist("#dl-movie", "movie");
  renderEditTags();
  renderEditFav();
  $("#edit").hidden = false;
}

function closeEdit() {
  $("#edit").hidden = true;
  editing = null;
}

function saveBulkEdit() {
  const patch = {};
  for (const [key, sel] of [["artist", "#f-artist"], ["album", "#f-album"], ["movie", "#f-movie"]]) {
    const v = $(sel).value.trim();
    if (v) patch[key] = v;
  }
  const ids = editing.bulk;
  const addTags = [...editing.tags];
  const fav = editing.fav;
  closeEdit();
  if (!Object.keys(patch).length && !addTags.length && !fav) {
    toast(tr("edit.nothing"));
    return;
  }
  selected.clear();
  selecting = false;
  meta.setMany(ids, { patch, addTags, fav });
  toast(tr("edit.bulkDone", { n: ids.length }));
}

function saveEdit() {
  if (!editing) return;
  if (editing.bulk) {
    saveBulkEdit();
    return;
  }
  const next = {
    artist: $("#f-artist").value.trim(),
    album: $("#f-album").value.trim(),
    movie: $("#f-movie").value.trim(),
    tags: [...editing.tags],
    fav: editing.fav,
  };
  const before = editing.before;
  const same =
    before.artist === next.artist &&
    before.album === next.album &&
    before.movie === next.movie &&
    before.fav === next.fav &&
    before.tags.length === next.tags.length &&
    before.tags.every((id) => next.tags.includes(id));
  const id = editing.id;
  const track = editing.track;
  const newBase = $("#f-name").value.replace(/[\\/]/g, "").trim();
  const wantsRename = !!newBase && newBase !== baseName(track.name);
  closeEdit();
  if (!same) {
    meta.setTrack(id, next);
    toast(tr("common.saved"));
  }
  if (wantsRename) renameTrack(track, newBase);
}

function renameErrorText(err) {
  if (err instanceof AuthError) return tr("rename.noauth");
  if (err instanceof DriveError && err.status === 403)
    return tr("rename.noperm");
  if (err instanceof DriveError && err.status === 404) return tr("rename.gone");
  if (err instanceof DriveError) return tr("rename.code", { code: err.status });
  return tr("common.online");
}

async function renameTrack(track, base) {
  const ext = extOf(track.name);
  const full = ext ? `${base}.${ext}` : base;
  try {
    await renameFile(track.id, full);
    const mine = tracks.find((t) => t.id === track.id);
    if (mine) mine.name = full;
    tracks = sortTracks(tracks);
    persist();
    renderAll();
    renderQueue();
    renderTrack();
    toast(tr("rename.ok"));
  } catch (err) {
    if (err instanceof AuthError) updateBanner();
    toast(renameErrorText(err));
  }
}

// ---------- tag dialog ----------
function renderTagColors() {
  $("#tag-colors").innerHTML = TAG_COLORS.map(
    (c) =>
      `<button class="color-btn" type="button" data-color="${c}" style="--c:${c}" aria-pressed="${tagEditing.color === c}" aria-label="${esc(tr("tag.pickColor"))}"></button>`
  ).join("");
}

function openTagDialog(tagId) {
  const existing = tagId ? meta.tag(tagId) : null;
  tagEditing = { id: existing ? existing.id : null, color: existing ? existing.color : TAG_COLORS[0] };
  $("#tag-title").textContent = existing ? tr("tag.edit") : tr("tag.new");
  $("#tag-name").value = existing ? existing.name : "";
  $("#tag-delete").hidden = !existing;
  renderTagColors();
  $("#tagdlg").hidden = false;
  setTimeout(() => $("#tag-name").focus(), 60);
}

function closeTagDialog() {
  $("#tagdlg").hidden = true;
  tagEditing = null;
}

function saveTag() {
  const name = $("#tag-name").value.trim();
  if (!name || !tagEditing) return;
  const clash = meta.tags.some((t) => t.name.toLowerCase() === name.toLowerCase() && t.id !== tagEditing.id);
  if (clash) {
    toast(tr("tag.exists"));
    return;
  }
  if (tagEditing.id) {
    meta.updateTag(tagEditing.id, { name, color: tagEditing.color });
  } else {
    const id = meta.addTag(name, tagEditing.color);
    if (editing) {
      editing.tags.add(id);
      renderEditTags();
    }
  }
  closeTagDialog();
}

function deleteTag() {
  const tag = tagEditing && meta.tag(tagEditing.id);
  if (!tag) return;
  if (!confirm(tr("tag.confirmDelete", { name: tag.name }))) return;
  meta.deleteTag(tag.id);
  if (mode === "tag" && sub === tag.id) sub = null;
  if (editing) {
    editing.tags.delete(tag.id);
    renderEditTags();
  }
  closeTagDialog();
}

// ---------- playlists ----------
function closePlPicker() {
  $("#plpick").hidden = true;
  plTarget = null;
}

function finishSelecting() {
  if (selecting) {
    selected.clear();
    selecting = false;
  }
}

function renderPlPicker() {
  const n = plTarget.ids.length;
  $("#plpick-title").textContent = n === 1 ? tr("plpick.one") : tr("plpick.many", { n });
  $("#plpick-list").innerHTML = meta.data.playlists
    .map(
      (p) =>
        `<button class="sheet-btn" type="button" data-pl="${esc(p.id)}">${icon("queue")}${esc(p.name)}<span class="muted"> · ${tr("plpick.songs", { n: p.ids.length })}</span></button>`
    )
    .join("");
  $("#plpick-new").innerHTML = icon("plus") + tr("plpick.new");
}

function openPlPicker(ids) {
  if (!ids.length) {
    toast(tr("sel.first"));
    return;
  }
  plTarget = { ids };
  renderPlPicker();
  $("#plpick").hidden = false;
}

function openPlDialog(id, addIds = []) {
  const existing = id ? meta.playlist(id) : null;
  plEditing = { id: existing ? existing.id : null, addIds };
  $("#pl-title").textContent = existing ? tr("pl.editTitle") : tr("pl.newBtn");
  $("#pl-name").value = existing ? existing.name : "";
  $("#pldlg").hidden = false;
  setTimeout(() => $("#pl-name").focus(), 60);
}

function closePlDialog() {
  $("#pldlg").hidden = true;
  plEditing = null;
}

function savePlaylist() {
  const name = $("#pl-name").value.trim();
  if (!name || !plEditing) return;
  const clash = meta.data.playlists.some((p) => p.name.toLowerCase() === name.toLowerCase() && p.id !== plEditing.id);
  if (clash) {
    toast(tr("pl.exists"));
    return;
  }
  const { id, addIds } = plEditing;
  closePlDialog();
  if (id) {
    meta.renamePlaylist(id, name);
    return;
  }
  finishSelecting();
  meta.createPlaylist(name, addIds);
  toast(addIds.length ? tr("pl.added", { name, n: addIds.length }) : tr("pl.created", { name }));
}

function addToPlaylistAndClose(plId) {
  if (!plTarget) return;
  const ids = plTarget.ids;
  const pl = meta.playlist(plId);
  closePlPicker();
  if (!pl) return;
  finishSelecting();
  const n = meta.addToPlaylist(plId, ids);
  if (!n) {
    renderSongs();
    toast(tr("pl.already"));
  } else toast(tr("pl.added", { name: pl.name, n }));
}

function deleteCurrentPlaylist() {
  const pl = meta.playlist(sub);
  if (!pl) return;
  if (!confirm(tr("pl.confirmDelete", { name: pl.name }))) return;
  sub = null;
  plReorder = false;
  meta.deletePlaylist(pl.id);
}

function handlePlaylistRowAction(btn, i) {
  const pos = songsViewPos && songsViewPos[i];
  if (pos === undefined || pos === null) return;
  if (btn.matches("[data-pl-del]")) meta.removeFromPlaylist(sub, pos);
  else if (btn.matches("[data-pl-up]") && i > 0) meta.movePlaylistItem(sub, pos, songsViewPos[i - 1]);
  else if (btn.matches("[data-pl-down]") && i < songsViewPos.length - 1) meta.movePlaylistItem(sub, pos, songsViewPos[i + 1]);
}

// ---------- folder list shared between devices ----------
async function reconcileFolders() {
  if (reconciling || busy || !appReady) return;
  const list = meta.data.folders;
  if (!Array.isArray(list)) {
    if (folders.length) {
      prefs.foldersSynced = true;
      savePrefs();
      syncFoldersToMeta();
    }
    return;
  }
  const have = new Set(folders.map((f) => f.id));
  const want = new Set(list.map((f) => f.id));
  const extra = folders.filter((f) => !want.has(f.id));
  if (extra.length && !prefs.foldersSynced) {
    // First time on this device: keep what is here and add it to the shared list.
    prefs.foldersSynced = true;
    savePrefs();
    meta.setFolders([...list, ...extra.map((f) => ({ id: f.id, name: f.name }))]);
  } else if (extra.length) {
    const gone = new Set(extra.map((f) => f.id));
    folders = folders.filter((f) => !gone.has(f.id));
    tracks = tracks.filter((t) => !gone.has(t.root));
    if (mode === "folder" && gone.has(sub)) sub = null;
    persist();
    renderAll();
  }
  const missing = list.filter((f) => !have.has(f.id));
  if (!missing.length) {
    if (!prefs.foldersSynced) {
      prefs.foldersSynced = true;
      savePrefs();
    }
    return;
  }
  if (!getToken()) {
    updateBanner();
    return;
  }
  reconciling = true;
  busy = true;
  try {
    for (const f of missing) {
      setBusy(tr("folders.syncScan", { name: f.name }));
      const info = await getFolderInfo(f.id);
      await scanInto(info, true);
    }
    prefs.foldersSynced = true;
    savePrefs();
    renderAll();
    toast(tr("folders.syncDone"));
  } catch (err) {
    if (err instanceof DriveError && (err.status === 404 || err.message === "not-a-folder")) {
      toast(tr("folders.syncFail"));
    } else handleDriveError(err);
  } finally {
    reconciling = false;
    busy = false;
    setBusy("");
  }
}

// ---------- radio ----------
const stationKey = (s) => s.id;
const isLive = (s) => !!radio.station && radio.station.id === s.id && radio.status !== "idle";

function radioRow(s, saved, mine) {
  const li = document.createElement("li");
  li.className = "row" + (isLive(s) ? " is-live" : "");
  li.dataset.id = stationKey(s);
  const sub = mine ? (s.custom ? tr("radio.custom") : "") : s.tags.split(",").slice(0, 3).filter(Boolean).join(", ");
  li.innerHTML = `
    <button class="row-main" type="button" data-play>
      <span class="row-idx">${icon("radio")}</span>
      <span class="row-text">
        <span class="row-title">${esc(s.name)}</span>
        ${sub ? `<span class="row-sub">${esc(sub)}</span>` : ""}
      </span>
    </button>
    <button class="row-more" type="button" ${mine ? "data-unsave" : "data-save"} aria-label="${
      mine ? tr("radio.unsave") : saved ? tr("radio.saved") : tr("radio.save")
    }" ${!mine && saved ? "disabled" : ""}>${icon(mine ? "close" : saved ? "star" : "star-outline")}</button>`;
  return li;
}

function stationById(id) {
  return meta.data.radio.find((r) => r.id === id) || radioList.find((r) => r.id === id) || null;
}

function renderRadioNow() {
  const box = $("#radio-now");
  const st = radio.station;
  box.hidden = !st;
  document.querySelector('.nav-btn[data-tab="radio"]').classList.toggle("live", !!st && radio.status === "playing");
  if (!st) return;
  $("#radio-now-name").textContent = st.name;
  const label = {
    loading: tr("radio.connecting"),
    playing: tr("radio.live"),
    paused: tr("radio.paused"),
    error: tr("radio.error"),
  }[radio.status];
  $("#radio-now-state").textContent = label || "";
  const playing = radio.status === "playing" || radio.status === "loading";
  $("#radio-toggle").innerHTML = icon(playing ? "pause" : "play");
  $("#radio-toggle").setAttribute("aria-label", playing ? tr("ctl.pause") : tr("ctl.play"));
  $("#radio-stop").innerHTML = icon("stop");
}

function renderRadio() {
  renderRadioNow();
  const savedIds = new Set(meta.data.radio.map((r) => r.id));
  const mine = $("#radio-mine");
  mine.textContent = "";
  if (!meta.data.radio.length) {
    const note = document.createElement("li");
    note.className = "list-note";
    note.textContent = tr("radio.noneSaved");
    mine.append(note);
  }
  meta.data.radio.forEach((r) => mine.append(radioRow(r, true, true)));

  const q = radioQuery.trim().toLowerCase();
  const list = $("#radio-list");
  list.textContent = "";
  const shown = radioList.filter((s) => !q || s.name.toLowerCase().includes(q) || s.tags.toLowerCase().includes(q));
  shown.forEach((s) => list.append(radioRow(s, savedIds.has(s.id), false)));
  const msg = $("#radio-msg");
  if (radioState === "loading") msg.textContent = tr("radio.loading");
  else if (radioState === "error")
    msg.textContent = tr("radio.loadFail");
  else if (radioState === "ready" && !shown.length) msg.textContent = q ? tr("songs.nothing") : tr("radio.emptyList");
  else if (radioStale) msg.textContent = tr("radio.stale");
  else msg.textContent = radioState === "ready" ? tr("radio.n", { n: shown.length }) : "";
}

async function ensureRadioList(force = false) {
  if (radioState === "loading") return;
  if (radioState === "ready" && !force) return;
  radioState = "loading";
  renderRadio();
  try {
    const { list, stale } = await loadStations({ force });
    radioList = list;
    radioStale = stale;
    radioState = "ready";
  } catch {
    radioState = "error";
  }
  renderRadio();
}

function playStation(id) {
  const st = stationById(id);
  if (!st) return;
  if (player.status === "playing") player.audio.pause();
  radio.play(st);
  prefs.lastStation = { id: st.id, name: st.name, url: st.url, tags: st.tags || "", custom: !!st.custom };
  savePrefs();
  renderQuick();
}

function addCustomStation() {
  const name = $("#radio-name").value.trim();
  const url = $("#radio-url").value.trim();
  if (!name) return;
  if (!/^https:\/\//i.test(url)) {
    toast(tr("radio.https"));
    return;
  }
  meta.saveStation({ id: `c${Date.now().toString(36)}`, name, url, custom: true });
  $("#radio-name").value = "";
  $("#radio-url").value = "";
  toast(tr("radio.added", { name }));
}

// ---------- link to Drive ----------
const BLOCKED_HOSTS = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|spotify\.com|soundcloud\.com|music\.apple\.com|deezer\.com|jiosaavn\.com|gaana\.com)$/i;

function renderGrab() {
  const select = $("#grab-folder");
  const keep = select.value || prefs.grabFolder || "";
  select.innerHTML = folders.length
    ? folders.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("")
    : `<option value="">${tr("folders.noneYet")}</option>`;
  if (folders.some((f) => f.id === keep)) select.value = keep;
  if (document.activeElement !== $("#grab-script")) $("#grab-script").value = prefs.scriptUrl || "";
  if (document.activeElement !== $("#grab-key")) $("#grab-key").value = prefs.scriptKey || "";
  if (!grabOpened) {
    grabOpened = true;
    $("#grab-settings").open = !prefs.scriptUrl;
  }
}

function setGrabBusy(text) {
  const el = $("#grab-busy");
  el.hidden = !text;
  el.textContent = text || "";
  $("#grab-btn").disabled = !!text;
}

function saveGrabSettings() {
  const url = $("#grab-script").value.trim();
  const key = $("#grab-key").value.trim();
  if (url && !/^https:\/\/script\.google\.com\//i.test(url)) {
    toast(tr("grab.badAddress"));
    return;
  }
  prefs.scriptUrl = url;
  prefs.scriptKey = key;
  savePrefs();
  toast(tr("common.saved"));
}

function grabErrorText(err) {
  const code = String((err && err.message) || "");
  if (code === "secret") return tr("grab.eSecret");
  if (code === "not-audio") return tr("grab.eNotAudio");
  if (code === "too-big") return tr("grab.eBig");
  if (code === "folder") return tr("grab.eFolder");
  if (code === "url") return tr("grab.eUrl");
  if (/^http \d+/.test(code)) return tr("grab.eHttp", { code: tr("grab.httpCode", { code: code.replace("http ", "") }) });
  if (err instanceof SyntaxError)
    return tr("grab.eScript");
  if (err instanceof TypeError) return tr("grab.eNet");
  return tr("grab.eOther");
}

async function grabLink() {
  if (busy) return;
  const raw = $("#grab-url").value.trim();
  const name = $("#grab-name").value.trim();
  const folderId = $("#grab-folder").value;
  let host = "";
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) throw new Error("scheme");
    host = u.hostname;
  } catch {
    toast(tr("grab.needHttp"));
    return;
  }
  if (BLOCKED_HOSTS.test(host)) {
    toast(tr("grab.noStreaming"));
    return;
  }
  if (!prefs.scriptUrl || !prefs.scriptKey) {
    $("#grab-settings").open = true;
    toast(tr("grab.needSetup"));
    return;
  }
  const folder = folders.find((f) => f.id === folderId);
  if (!folder) {
    toast(tr("folders.addFirst"));
    return;
  }
  prefs.grabFolder = folderId;
  savePrefs();
  busy = true;
  setGrabBusy(tr("grab.busy"));
  let savedName = "";
  try {
    const res = await fetch(prefs.scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ secret: prefs.scriptKey, url: raw, name, folderId }),
      redirect: "follow",
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "unknown");
    savedName = data.name || name || tr("grab.song");
    $("#grab-url").value = "";
    $("#grab-name").value = "";
  } catch (err) {
    toast(grabErrorText(err));
  } finally {
    busy = false;
    setGrabBusy("");
  }
  if (savedName) {
    toast(tr("grab.done", { name: savedName }));
    await rescanFolder(folder);
  }
}

// ---------- cloud sync ----------
function setSyncStatus(state) {
  syncState = state;
  const el = $("#sync-status");
  if (state === "ok") el.textContent = tr("sync.ok");
  else if (state === "error")
    el.textContent = tr("sync.error");
  else el.textContent = "";
}

function connectCloud(user) {
  if (!user.uid || cloudUid === user.uid) return;
  cloudUid = user.uid;
  cloud.connect(user.uid, {
    onRemote: (remote) => {
      if (!remote) {
        if (meta.data.updatedAt) cloud.push(meta.data);
        reconcileFolders();
        return;
      }
      if (meta.adoptRemote(remote)) return;
      if ((remote.updatedAt || 0) < (meta.data.updatedAt || 0)) cloud.push(meta.data);
      reconcileFolders();
    },
    onStatus: (state) => {
      setSyncStatus(state);
      if (state === "error" && !syncWarned) {
        syncWarned = true;
        toast(tr("sync.toast"));
      }
    },
  });
}

// ---------- auth and banner ----------
function updateBanner() {
  $("#banner").hidden = !!getToken();
}

function loginError(err) {
  const code = err && err.code;
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return;
  const msg = $("#login-msg");
  if (code === "auth/unauthorized-domain") msg.textContent = tr("login.unauth");
  else if (code === "auth/network-request-failed") msg.textContent = tr("login.offline");
  else msg.textContent = tr("login.failed", { code: code || tr("login.unknown") });
  toast(msg.textContent);
}

async function startSignIn() {
  $("#login-msg").textContent = "";
  try {
    await signIn();
    updateBanner();
  } catch (err) {
    loginError(err);
  }
}

async function reconnect() {
  try {
    const user = await signIn();
    updateBanner();
    if (user) toast(tr("account.reconnected"));
    if (player.awaitingAuth) player.retry();
    reconcileFolders();
  } catch (err) {
    loginError(err);
  }
}

function showLogin() {
  player.stop();
  radio.stop();
  cloud.disconnect();
  cloudUid = null;
  $("#splash").hidden = true;
  $("#app").hidden = true;
  $("#login").hidden = false;
}

function showApp(user) {
  $("#splash").hidden = true;
  $("#login").hidden = true;
  $("#app").hidden = false;
  $("#account-email").textContent = user.email || user.displayName || "";
  userName = String(user.displayName || "").trim().split(/\s+/)[0] || "";
  renderGreeting();
  connectCloud(user);
  if (!appReady) {
    appReady = true;
    renderAll();
    renderTrack();
    renderQueue();
  }
  updateBanner();
}

// ---------- language ----------
function setLanguage(next) {
  setLang(next);
  prefs.lang = getLang();
  savePrefs();
  applyStatic();
  renderNav();
  renderControls();
  renderTrack();
  renderQueue();
  renderAll();
  setSyncStatus(syncState);
  if (radio.station) radio.wireMediaSession();
}

// ---------- rendering everything ----------
function renderAll() {
  renderSongs();
  renderFolders();
  renderRadio();
  renderLook();
  renderDash();
}

// ---------- events ----------
function wireEvents() {
  $("#btn-login").addEventListener("click", startSignIn);
  $("#btn-reconnect").addEventListener("click", reconnect);
  $("#btn-account-reconnect").addEventListener("click", reconnect);
  $("#btn-logout").addEventListener("click", () => signOutUser().catch(() => {}));

  $$(".nav-btn").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("#mini-open").addEventListener("click", () => showTab("now"));
  $("#mini-play").addEventListener("click", () => player.toggle());
  $("#mini-next").addEventListener("click", () => player.next());

  $("#btn-play").addEventListener("click", () => {
    if (!player.current) {
      toast(tr("now.pickFirst"));
      showTab("songs");
      return;
    }
    player.toggle();
  });
  $("#disc").addEventListener("click", () => $("#btn-play").click());
  $("#btn-next").addEventListener("click", () => player.next());
  $("#btn-prev").addEventListener("click", () => player.prev());
  $("#btn-shuffle").addEventListener("click", () => {
    player.setShuffle(!player.shuffle);
    prefs.shuffle = player.shuffle;
    savePrefs();
  });
  $("#btn-repeat").addEventListener("click", () => {
    player.cycleRepeat();
    prefs.repeat = player.repeat;
    savePrefs();
  });

  const seek = $("#seek");
  seek.addEventListener("input", () => {
    dragging = true;
    clearTimeout(dragTimer);
    dragTimer = setTimeout(() => (dragging = false), 1500);
    seek.style.setProperty("--pct", `${Number(seek.value) / 10}%`);
    const dur = player.audio.duration;
    if (Number.isFinite(dur)) $("#t-cur").textContent = fmt((Number(seek.value) / 1000) * dur);
  });
  seek.addEventListener("change", () => {
    const dur = player.audio.duration;
    if (Number.isFinite(dur)) player.seek((Number(seek.value) / 1000) * dur);
    dragging = false;
  });

  const vol = $("#vol");
  vol.value = String(Math.round((prefs.volume ?? 1) * 100));
  vol.style.setProperty("--pct", `${vol.value}%`);
  player.setVolume(Number(vol.value) / 100);
  vol.addEventListener("input", () => {
    vol.style.setProperty("--pct", `${vol.value}%`);
    player.setVolume(Number(vol.value) / 100);
    prefs.volume = Number(vol.value) / 100;
    savePrefs();
  });
  const probe = new Audio();
  probe.volume = 0.5;
  $("#vol-wrap").hidden = probe.volume !== 0.5; // phones keep the volume under hardware control

  let searchTimer = 0;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      filter.q = e.target.value;
      renderSongs();
    }, 120);
  });

  $("#chips").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-mode]");
    if (!chip) return;
    mode = chip.dataset.mode;
    sub = null;
    plReorder = false;
    renderSongs();
    $("#main").scrollTop = 0;
  });
  $("#crumb-back").addEventListener("click", () => {
    sub = null;
    plReorder = false;
    renderSongs();
  });
  $("#pl-play").addEventListener("click", () => {
    if (!songsView.length) return toast(tr("pl.empty"));
    player.setQueue(songsView, 0);
  });
  $("#pl-reorder").addEventListener("click", () => {
    plReorder = !plReorder;
    renderSongs();
  });
  $("#pl-rename").addEventListener("click", () => openPlDialog(sub));
  $("#pl-delete").addEventListener("click", deleteCurrentPlaylist);
  $("#pl-form").addEventListener("submit", (e) => {
    e.preventDefault();
    savePlaylist();
  });
  $$("#pldlg [data-close]").forEach((el) => el.addEventListener("click", closePlDialog));
  $$("#plpick [data-close]").forEach((el) => el.addEventListener("click", closePlPicker));
  $("#plpick-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-pl]");
    if (btn) addToPlaylistAndClose(btn.dataset.pl);
  });
  $("#plpick-new").addEventListener("click", () => {
    const ids = plTarget ? plTarget.ids : [];
    closePlPicker();
    openPlDialog(null, ids);
  });
  $("#sheet-playlist").addEventListener("click", () => {
    const track = sheetTrack;
    closeSheet();
    if (track) openPlPicker([track.id]);
  });
  $("#btn-select").addEventListener("click", () => {
    plReorder = false;
    setSelecting(!selecting);
  });
  $("#sel-playlist").addEventListener("click", () => openPlPicker(tracks.filter((t) => selected.has(t.id)).map((t) => t.id)));
  $("#sel-done").addEventListener("click", () => setSelecting(false));
  $("#sel-all").addEventListener("click", () => {
    const all = songsView.length > 0 && songsView.every((t) => selected.has(t.id));
    songsView.forEach((t) => (all ? selected.delete(t.id) : selected.add(t.id)));
    renderSongs();
  });
  $("#sel-edit").addEventListener("click", openBulkEdit);
  $("#btn-undo").addEventListener("click", () => {
    if (meta.undo()) toast(tr("undo.done"));
  });
  $("#btn-redo").addEventListener("click", () => {
    if (meta.redo()) toast(tr("redo.done"));
  });

  $("#songs-list").addEventListener("click", (e) => {
    if (e.target.closest("[data-new-tag]")) {
      openTagDialog(null);
      return;
    }
    if (e.target.closest("[data-new-pl]")) {
      openPlDialog(null);
      return;
    }
    const row = e.target.closest(".row");
    if (!row) return;
    if (row.classList.contains("group-row")) {
      if (e.target.closest("[data-edit-tag]")) {
        openTagDialog(row.dataset.key);
      } else {
        sub = row.dataset.key;
        renderSongs();
        $("#main").scrollTop = 0;
      }
      return;
    }
    const track = songsView[Number(row.dataset.i)];
    if (!track) return;
    const act = e.target.closest("[data-pl-up],[data-pl-down],[data-pl-del]");
    if (act) {
      handlePlaylistRowAction(act, Number(row.dataset.i));
      return;
    }
    if (selecting) {
      if (selected.has(track.id)) selected.delete(track.id);
      else selected.add(track.id);
      row.classList.toggle("is-selected", selected.has(track.id));
      renderSelbar();
      return;
    }
    if (e.target.closest("[data-more]")) openSheet(track);
    else player.setQueue(songsView, Number(row.dataset.i));
  });
  $("#panel-now").addEventListener("click", (e) => {
    const quick = e.target.closest("[data-quick]");
    if (quick) return quickPlay(quick.dataset.quick);
    const sleep = e.target.closest("[data-sleep]");
    if (sleep) return setSleep(Number(sleep.dataset.sleep));
    const card = e.target.closest(".card");
    if (!card) return;
    const list = card.parentElement.id === "cards-recent" ? dashRecent : dashMost;
    player.setQueue(list, Number(card.dataset.i));
  });

  // press and hold a song to start selecting
  const songList = $("#songs-list");
  let pressTimer = 0;
  let pressAt = null;
  let swallowClick = false;
  songList.addEventListener("pointerdown", (e) => {
    const row = e.target.closest(".row:not(.group-row)");
    if (!row || selecting || reorderOn() || e.target.closest("[data-more],[data-pl-up],[data-pl-down],[data-pl-del]")) return;
    pressAt = { x: e.clientX, y: e.clientY };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      const track = songsView[Number(row.dataset.i)];
      if (!track) return;
      swallowClick = true;
      plReorder = false;
      selected.add(track.id);
      setSelecting(true);
      if (navigator.vibrate) navigator.vibrate(15);
    }, 500);
  });
  songList.addEventListener("pointermove", (e) => {
    if (pressAt && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > 10) clearTimeout(pressTimer);
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((name) =>
    songList.addEventListener(name, () => {
      clearTimeout(pressTimer);
      setTimeout(() => (swallowClick = false), 300);
    })
  );
  songList.addEventListener("contextmenu", (e) => e.preventDefault());
  songList.addEventListener(
    "click",
    (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopImmediatePropagation();
    },
    true
  );

  $("#songs-empty").addEventListener("click", (e) => {
    const go = e.target.closest("[data-go]");
    if (go) showTab(go.dataset.go);
  });
  new IntersectionObserver(
    (entries) => {
      if (entries.some((en) => en.isIntersecting) && songsShown < songsView.length) appendSongs();
    },
    { root: $("#main"), rootMargin: "400px" }
  ).observe($("#songs-sentinel"));

  $("#queue-list").addEventListener("click", (e) => {
    const row = e.target.closest(".row");
    if (!row || !row.dataset.pos) return;
    if (e.target.closest("[data-remove]")) player.removeUpcoming(Number(row.dataset.uid));
    else player.playIndex(Number(row.dataset.pos));
  });
  $("#btn-clear-queue").addEventListener("click", () => player.clearUpcoming());

  $("#folder-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!busy) addFolder($("#folder-input").value);
  });
  $("#folder-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn || busy) return;
    const folder = folders.find((f) => f.id === btn.closest(".folder-card").dataset.id);
    if (!folder) return;
    if (btn.dataset.act === "remove") removeFolder(folder);
    else rescanFolder(folder);
  });

  $("#themes").addEventListener("click", pickTheme);
  $("#langs").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-lang]");
    if (btn) setLanguage(btn.dataset.lang);
  });
  $("#btn-lang").addEventListener("click", () => setLanguage(getLang() === "en" ? "bn" : "en"));
  $("#btn-lang-login").addEventListener("click", () => setLanguage(getLang() === "en" ? "bn" : "en"));
  $("#fonts").addEventListener("click", (e) => {
    const row = e.target.closest("[data-font-id]");
    if (!row) return;
    prefs.font = row.dataset.fontId;
    applyFont(prefs.font);
    savePrefs();
    renderLook();
  });

  $("#sheet-backdrop").addEventListener("click", closeSheet);
  $("#sheet-close").addEventListener("click", closeSheet);
  $("#sheet-next").addEventListener("click", () => {
    if (sheetTrack) player.playNext(sheetTrack);
    closeSheet();
    toast(tr("queue.playNext"));
  });
  $("#sheet-queue").addEventListener("click", () => {
    if (sheetTrack) player.enqueue(sheetTrack);
    closeSheet();
    toast(tr("queue.added"));
  });
  $("#sheet-fav").addEventListener("click", () => {
    if (sheetTrack) {
      const on = !meta.get(sheetTrack.id).fav;
      meta.toggleFav(sheetTrack.id);
      toast(on ? tr("fav.added") : tr("fav.removed"));
    }
    closeSheet();
  });
  $("#sheet-edit").addEventListener("click", () => {
    const track = sheetTrack;
    closeSheet();
    if (track) openEdit(track);
  });

  $("#edit-form").addEventListener("submit", (e) => {
    e.preventDefault();
    saveEdit();
  });
  $$("#edit [data-close]").forEach((el) => el.addEventListener("click", closeEdit));
  $("#f-tags").addEventListener("click", (e) => {
    if (e.target.closest("[data-new-tag]")) {
      openTagDialog(null);
      return;
    }
    const btn = e.target.closest("[data-tag]");
    if (!btn || !editing) return;
    const id = btn.dataset.tag;
    if (editing.tags.has(id)) editing.tags.delete(id);
    else editing.tags.add(id);
    renderEditTags();
  });
  $("#f-fav").addEventListener("click", () => {
    if (!editing) return;
    editing.fav = !editing.fav;
    renderEditFav();
  });

  $("#tag-form").addEventListener("submit", (e) => {
    e.preventDefault();
    saveTag();
  });
  $$("#tagdlg [data-close]").forEach((el) => el.addEventListener("click", closeTagDialog));
  $("#tag-colors").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-color]");
    if (!btn || !tagEditing) return;
    tagEditing.color = btn.dataset.color;
    renderTagColors();
  });
  $("#tag-delete").addEventListener("click", deleteTag);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("#pldlg").hidden) closePlDialog();
      else if (!$("#plpick").hidden) closePlPicker();
      else if (!$("#tagdlg").hidden) closeTagDialog();
      else if (!$("#edit").hidden) closeEdit();
      else if (!$("#sheet").hidden) closeSheet();
    }
    if (e.code === "Space" && document.activeElement === document.body && player.current) {
      e.preventDefault();
      player.toggle();
    }
  });

  meta.onChange((source) => {
    const top = $("#main").scrollTop;
    renderSongs();
    $("#main").scrollTop = top;
    renderQueue();
    renderTrack();
    renderRadio();
    if (!$("#plpick").hidden && plTarget) renderPlPicker();
    if (source === "local") cloud.push(meta.data);
    else reconcileFolders();
  });

  // radio
  $("#radio-search-ic").innerHTML = icon("search");
  $("#radio-refresh").innerHTML = icon("refresh");
  let radioTimer = 0;
  $("#radio-search").addEventListener("input", (e) => {
    clearTimeout(radioTimer);
    radioTimer = setTimeout(() => {
      radioQuery = e.target.value;
      renderRadio();
    }, 120);
  });
  $("#radio-refresh").addEventListener("click", () => ensureRadioList(true));
  $("#radio-form").addEventListener("submit", (e) => {
    e.preventDefault();
    addCustomStation();
  });
  $("#radio-toggle").addEventListener("click", () => radio.toggle());
  $("#radio-stop").addEventListener("click", () => radio.stop());
  $("#panel-radio").addEventListener("click", (e) => {
    const row = e.target.closest("#radio-mine .row, #radio-list .row");
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.closest("[data-save]")) {
      const st = stationById(id);
      if (st) {
        meta.saveStation(st);
        toast(tr("radio.kept", { name: st.name }));
      }
    } else if (e.target.closest("[data-unsave]")) {
      if (radio.station && radio.station.id === id) radio.stop();
      meta.removeStation(id);
    } else if (e.target.closest("[data-play]")) {
      playStation(id);
    }
  });
  radio.on("state", () => {
    renderRadioNow();
    $$("#radio-mine .row, #radio-list .row").forEach((row) => {
      const st = stationById(row.dataset.id);
      row.classList.toggle("is-live", !!st && isLive(st));
    });
    if (radio.status === "error") toast(tr("radio.errorToast"));
  });
  radio.on("release", () => player.wireMediaSession());

  // link to Drive
  $("#grab-form").addEventListener("submit", (e) => {
    e.preventDefault();
    grabLink();
  });
  $("#grab-save").addEventListener("click", saveGrabSettings);

  setInterval(() => {
    if (!$("#app").hidden) updateBanner();
  }, 30000);
}

function pickTheme(e) {
  const btn = e.target.closest("[data-theme-id]");
  if (!btn) return;
  prefs.theme = btn.dataset.themeId;
  applyTheme(prefs.theme);
  savePrefs();
  renderLook();
}

// ---------- player events ----------
function wirePlayer() {
  player
    .on("track", renderTrack)
    .on("state", () => {
      renderState();
      if (player.status === "loading" || player.status === "playing") radio.stop();
    })
    .on("time", renderTime)
    .on("queue", renderQueue)
    .on("mode", renderMode)
    .on("progress", ({ id, loaded, total }) => {
      if (player.status !== "loading" || !player.current || player.current.id !== id) return;
      const pct = total ? Math.min(99, Math.round((loaded / total) * 100)) : 0;
      $("#now-status").textContent = pct ? tr("now.loadingPct", { pct }) : tr("now.loading");
    })
    .on("error", () => {
      const more = player.index + 1 < player.order.length;
      toast(more ? tr("player.badFileNext") : tr("player.badFile"));
    })
    .on("needauth", () => {
      updateBanner();
      $("#banner").hidden = false;
      toast(tr("player.expired"));
    })
    .on("blocked", () => toast(tr("player.blocked")));
}

// ---------- boot ----------
async function boot() {
  setLang(prefs.lang);
  applyStatic();
  applyTheme(prefs.theme);
  applyFont(prefs.font);
  buildEq();
  renderNav();
  renderControls();
  wireEvents();
  wirePlayer();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  if (!isConfigured) {
    $("#splash").hidden = true;
    $("#login").hidden = false;
    $("#btn-login").disabled = true;
    $("#login-msg").textContent = tr("login.noconfig");
    return;
  }
  try {
    await finishRedirect();
  } catch (err) {
    loginError(err);
  }
  onAuth((user) => {
    if (user) showApp(user);
    else showLogin();
  });
}

boot();
