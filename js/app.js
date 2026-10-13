import { store } from "./store.js";
import { icon } from "./icons.js";
import { isConfigured, onAuth, signIn, signOutUser, finishRedirect, getToken } from "./auth.js";
import { parseFolderId, getFolderInfo, scanFolder, displayTitle, renameFile, extOf, AuthError, DriveError } from "./drive.js";
import { Player } from "./player.js";
import { MetaStore, TAG_COLORS } from "./meta.js";
import * as cloud from "./cloud.js";
import { Radio, loadStations } from "./radio.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const THEMES = [
  { id: "yellow", name: "হলুদ", bg: "#FFD42E", accent: "#17130A", group: "color" },
  { id: "red", name: "লাল", bg: "#D92B3A", accent: "#FFFFFF", group: "color" },
  { id: "green", name: "সবুজ", bg: "#14804A", accent: "#FFFFFF", group: "color" },
  { id: "teal", name: "টিল", bg: "#0B7F7A", accent: "#FFFFFF", group: "color" },
  { id: "blue", name: "নীল", bg: "#2B4FD8", accent: "#FFFFFF", group: "color" },
  { id: "night", name: "রাত্রি", bg: "#000000", accent: "#F4F4F4", group: "night" },
  { id: "gold", name: "রাতের সোনালি", bg: "#0C0A06", accent: "#FFB81F", group: "night" },
  { id: "violet", name: "রাতের বেগুনি", bg: "#0A0710", accent: "#A58BFF", group: "night" },
  { id: "mint", name: "রাতের পুদিনা", bg: "#050B0A", accent: "#3DE3B0", group: "night" },
];

const FONTS = [
  { id: "lato", name: "Lato সাধারণ" },
  { id: "lato-bold", name: "Lato মোটা" },
  { id: "roboto", name: "Roboto" },
  { id: "poppins", name: "Poppins" },
  { id: "nunito", name: "Nunito" },
  { id: "quicksand", name: "Quicksand" },
  { id: "hind", name: "Hind Siliguri" },
  { id: "baloo", name: "Baloo Da 2" },
  { id: "tiro", name: "Tiro Bangla" },
];

const TABS = [
  { id: "now", label: "বাজছে", icon: "disc" },
  { id: "songs", label: "গান", icon: "note" },
  { id: "radio", label: "রেডিও", icon: "radio" },
  { id: "folders", label: "ফোল্ডার", icon: "folder" },
  { id: "look", label: "সাজসজ্জা", icon: "palette" },
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
  if (!store.saveTracks(tracks)) toast("গানের তালিকা সংরক্ষণ করা গেল না। ফোনের জায়গা কম হতে পারে।");
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
      <span class="swatch" style="background:${t.bg};--sw-accent:${t.accent};--sw-ink:${t.accent}">${
        prefs.theme === t.id ? icon("check") : ""
      }</span>
      <span>${esc(t.name)}</span>
    </button>`;
  $("#themes-color").innerHTML = THEMES.filter((t) => t.group === "color").map(swatch).join("");
  $("#themes-night").innerHTML = THEMES.filter((t) => t.group === "night").map(swatch).join("");

  $("#fonts").innerHTML = FONTS.map(
    (f) => `
    <button class="font-row fs-${f.id}" type="button" data-font-id="${f.id}" aria-pressed="${prefs.font === f.id}">
      <span class="font-text">
        <span class="font-name">${esc(f.name)}</span>
        <span class="font-sample">আমার প্রিয় গান / My favourite song</span>
      </span>
      ${prefs.font === f.id ? icon("check") : ""}
    </button>`
  ).join("");
}

// ---------- tabs ----------
function renderNav() {
  $$(".nav-btn").forEach((btn) => {
    const t = TABS.find((x) => x.id === btn.dataset.tab);
    btn.innerHTML = `<span class="nav-ic">${icon(t.icon)}</span><span>${t.label}</span>`;
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
    player.repeat === "off" ? "পুনরাবৃত্তি বন্ধ" : player.repeat === "all" ? "সব গান আবার বাজবে" : "এই গান আবার বাজবে"
  );
}

function renderState() {
  const playing = player.status === "playing";
  const label = playing ? "থামাও" : "চালাও";
  const main = $("#btn-play");
  main.innerHTML = icon(playing ? "pause" : "play");
  main.setAttribute("aria-label", label);
  const mini = $("#mini-play");
  mini.innerHTML = icon(playing ? "pause" : "play");
  mini.setAttribute("aria-label", label);
  $("#disc").classList.toggle("playing", playing);
  if (player.status === "loading") $("#now-status").textContent = "গান লোড হচ্ছে…";
  else if (player.status !== "idle" || !player.current) $("#now-status").textContent = "";
}

function renderTrack() {
  const t = player.current;
  const letter = $("#disc-letter");
  if (!t) {
    $("#now-title").textContent = "কিছু বাজছে না";
    $("#now-sub").textContent = "গান ট্যাবে গিয়ে একটি গান বেছে নাও।";
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
}

function renderQueue() {
  const list = $("#queue-list");
  const up = player.upNext;
  list.textContent = "";
  $("#btn-clear-queue").hidden = up.length === 0;
  if (!up.length) {
    list.innerHTML = `<li class="list-note">এরপর কোনো গান নেই।</li>`;
    return;
  }
  const frag = document.createDocumentFragment();
  up.slice(0, 40).forEach((entry, k) => {
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
      <button class="row-more" type="button" data-remove aria-label="কিউ থেকে সরাও">${icon("close")}</button>`;
    frag.append(li);
  });
  list.append(frag);
  if (up.length > 40) {
    const more = document.createElement("li");
    more.className = "list-note";
    more.textContent = `আরও ${up.length - 40}টি গান আছে।`;
    list.append(more);
  }
}

// ---------- songs ----------
const MODES = [
  { id: "all", label: "সব" },
  { id: "fav", label: "পছন্দ" },
  { id: "playlist", label: "প্লেলিস্ট" },
  { id: "artist", label: "আর্টিস্ট" },
  { id: "album", label: "অ্যালবাম" },
  { id: "movie", label: "সিনেমা" },
  { id: "tag", label: "ট্যাগ" },
  { id: "folder", label: "ফোল্ডার" },
];
const GROUP_MODES = new Set(["playlist", "artist", "album", "movie", "tag", "folder"]);
const NO_VALUE = "ঠিক করা হয়নি";

const modeLabel = (id) => MODES.find((m) => m.id === id).label;
const isGroupList = () => GROUP_MODES.has(mode) && sub === null && !filter.q.trim();

function subLabel() {
  if (mode === "tag") return (meta.tag(sub) || {}).name || "";
  if (mode === "playlist") return (meta.playlist(sub) || {}).name || "";
  if (mode === "folder") return folderName(sub);
  return sub === "" ? NO_VALUE : sub;
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
            <button class="row-act" type="button" data-pl-up aria-label="ওপরে তোলো" ${i === 0 ? "disabled" : ""}>${icon("up")}</button>
            <button class="row-act" type="button" data-pl-down aria-label="নিচে নামাও" ${i === songsView.length - 1 ? "disabled" : ""}>${icon("down")}</button>
            <button class="row-act" type="button" data-pl-del aria-label="প্লেলিস্ট থেকে সরাও">${icon("close")}</button>
          </span>`
        : `<button class="row-more" type="button" data-more aria-label="আরও বিকল্প">${icon("more")}</button>`
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
    (m) => `<button class="chip" type="button" data-mode="${m.id}" aria-pressed="${mode === m.id}">${m.label}</button>`
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
    .map(([key, count]) => ({ key, label: key || NO_VALUE, count }))
    .sort((a, b) => (a.key === "") - (b.key === "") || collator.compare(a.label, b.label));
}

function renderGroups() {
  const list = $("#songs-list");
  const groups = buildGroups();
  songsView = [];
  songsShown = 0;
  $("#songs-sentinel").hidden = true;
  $("#songs-empty").hidden = true;
  $("#songs-count").textContent = groups.length ? `${groups.length}টি ${modeLabel(mode)}` : "";
  const frag = document.createDocumentFragment();
  if (mode === "tag" || mode === "playlist") {
    const add = document.createElement("li");
    add.className = "group-add";
    add.innerHTML =
      mode === "tag"
        ? `<button class="btn" type="button" data-new-tag>${icon("plus")}নতুন ট্যাগ</button>`
        : `<button class="btn" type="button" data-new-pl>${icon("plus")}নতুন প্লেলিস্ট</button>`;
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
          <span class="row-sub">${g.count}টি গান</span>
        </span>
        <span class="ic-chev">${icon("chevron")}</span>
      </button>` +
      (mode === "tag"
        ? `<button class="row-more" type="button" data-edit-tag aria-label="ট্যাগ বদলাও">${icon("edit")}</button>`
        : "");
    frag.append(li);
  });
  if (!groups.length) {
    const note = document.createElement("li");
    note.className = "list-note";
    note.textContent =
      mode === "tag"
        ? "এখনো কোনো ট্যাগ নেই।"
        : mode === "playlist"
        ? "এখনো কোনো প্লেলিস্ট নেই। ওপরের বোতামে নতুন প্লেলিস্ট বানাও।"
        : mode === "folder"
        ? "এখনো কোনো ফোল্ডার যোগ করা হয়নি।"
        : "এখনো কিছু ঠিক করা হয়নি। গানের পাশের ⋯ চেপে বিবরণ বদলাও।";
    frag.append(note);
  }
  list.textContent = "";
  list.append(frag);
}

function renderSelbar() {
  const n = selected.size;
  $("#selbar").hidden = !(selecting && tab === "songs");
  $("#sel-count").textContent = n ? `${n}টি গান বাছাই করা` : "গানের ওপর চাপ দিয়ে বাছাই করো";
  $("#sel-edit").disabled = n === 0;
  const all = songsView.length > 0 && songsView.every((t) => selected.has(t.id));
  $("#sel-all").textContent = all ? "বাছাই তোলো" : "সব বাছাই";
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
  $("#pl-play").innerHTML = icon("play") + "সব বাজাও";
  $("#pl-reorder").setAttribute("aria-pressed", String(plReorder));
  $("#pl-reorder").textContent = plReorder ? "ক্রম বদল শেষ" : "ক্রম বদলাও";
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
  selBtn.textContent = selecting ? "বাছাই শেষ" : "বাছাই করো";
  $("#songs-list").classList.toggle("selecting", selecting && !isGroupList());
  $("#songs-list").textContent = "";
  songsShown = 0;
  if (!tracks.length) {
    songsView = [];
    empty.hidden = false;
    empty.innerHTML = `<p>এখনো কোনো গান নেই।</p><p style="margin-top:14px"><button class="btn btn-primary" type="button" data-go="folders">ড্রাইভের ফোল্ডার যোগ করো</button></p>`;
    $("#songs-count").textContent = "";
    $("#songs-sentinel").hidden = true;
    return;
  }
  if (isGroupList()) {
    renderGroups();
    return;
  }
  songsView = filteredTracks();
  $("#songs-count").textContent = `${songsView.length}টি গান`;
  if (!songsView.length) {
    empty.hidden = false;
    empty.textContent =
      mode === "fav" && !filter.q.trim()
        ? "পছন্দের কোনো গান নেই। গানের পাশের ⋯ চেপে পছন্দ করো।"
        : mode === "playlist" && sub !== null && !filter.q.trim()
        ? "এই প্লেলিস্টে এখনো গান নেই। যেকোনো গানের ⋯ চেপে \"প্লেলিস্টে যোগ করো\" বেছে নাও।"
        : "কিছু পাওয়া যায়নি।";
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
        <span class="folder-meta">${f.count}টি গান</span>
      </div>
      <button class="icon-btn" type="button" data-act="rescan" aria-label="আবার স্ক্যান করো">${icon("refresh")}</button>
      <button class="icon-btn" type="button" data-act="remove" aria-label="তালিকা থেকে সরাও">${icon("delete")}</button>
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
    toast('ড্রাইভের সঙ্গে সংযোগ নেই। "আবার যুক্ত করো" চাপো।');
  } else if (err instanceof DriveError) {
    if (err.message === "not-a-folder") toast("এটি ফোল্ডারের লিংক নয়।");
    else if (err.status === 404) toast("ফোল্ডারটি পাওয়া যায়নি। লিংকটি ঠিক আছে কি না দেখো।");
    else if (err.status === 403)
      toast("ড্রাইভ অনুমতি দিচ্ছে না। ফোল্ডারটি তোমার ড্রাইভে আছে কি না আর Google Drive API চালু আছে কি না দেখো।");
    else toast(`ড্রাইভ থেকে ঠিক উত্তর আসেনি (কোড ${err.status})।`);
  } else {
    toast("ইন্টারনেট সংযোগ দেখো, তারপর আবার চেষ্টা করো।");
  }
}

async function scanInto(info, isNew) {
  const found = await scanFolder(info, (n) => setBusy(`স্ক্যান হচ্ছে… ${n}টি গান পাওয়া গেছে`));
  const record = { id: info.id, name: info.name, count: found.length, scannedAt: Date.now() };
  folders = isNew ? [...folders, record] : folders.map((f) => (f.id === info.id ? record : f));
  tracks = sortTracks([...tracks.filter((t) => t.root !== info.id), ...found]);
  persist();
  return found.length;
}

async function addFolder(raw) {
  const id = parseFolderId(raw);
  if (!id) return toast("এই লিংক থেকে ফোল্ডার চেনা যায়নি।");
  if (folders.some((f) => f.id === id)) return toast("এই ফোল্ডার আগেই যোগ করা আছে।");
  busy = true;
  setBusy("ফোল্ডার খোলা হচ্ছে…");
  try {
    const info = await getFolderInfo(id);
    const n = await scanInto(info, true);
    $("#folder-input").value = "";
    syncFoldersToMeta();
    renderAll();
    toast(n ? `${n}টি গান যোগ হয়েছে।` : "এই ফোল্ডারে কোনো গান পাওয়া যায়নি।");
  } catch (err) {
    handleDriveError(err);
  } finally {
    busy = false;
    setBusy("");
  }
}

async function rescanFolder(folder) {
  busy = true;
  setBusy("ফোল্ডার খোলা হচ্ছে…");
  try {
    const info = await getFolderInfo(folder.id);
    const n = await scanInto(info, false);
    renderAll();
    toast(`${n}টি গান পাওয়া গেছে।`);
  } catch (err) {
    handleDriveError(err);
  } finally {
    busy = false;
    setBusy("");
  }
}

function removeFolder(folder) {
  if (!confirm(`"${folder.name}" তালিকা থেকে সরানো হবে। ড্রাইভের ফাইল মুছবে না। সরাবে?`)) return;
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
  $("#sheet-fav").innerHTML = icon(fav ? "heart" : "heart-outline") + (fav ? "পছন্দ থেকে সরাও" : "পছন্দ করো");
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
  chips.push(`<button class="tagchip tagchip-add" type="button" data-new-tag>${icon("plus")}নতুন ট্যাগ</button>`);
  $("#f-tags").innerHTML = chips.join("");
}

function renderEditFav() {
  const btn = $("#f-fav");
  btn.setAttribute("aria-pressed", String(editing.fav));
  const bulk = !!editing.bulk;
  const label = editing.fav
    ? bulk ? "সবগুলো পছন্দের তালিকায় যাবে" : "পছন্দের তালিকায় আছে"
    : bulk ? "সবগুলো পছন্দের তালিকায় রাখো" : "পছন্দের তালিকায় রাখো";
  btn.innerHTML = icon(editing.fav ? "heart" : "heart-outline") + label;
}

const baseName = (name) => String(name || "").replace(/\.[^./\\]+$/, "");

function setEditFieldHints(bulk) {
  $("#name-field").hidden = bulk;
  ["#f-artist", "#f-album", "#f-movie"].forEach((sel) => {
    $(sel).placeholder = bulk ? "বদলাবে না" : "";
  });
  $("#edit-hint").hidden = !bulk;
}

function openBulkEdit() {
  const ids = tracks.filter((t) => selected.has(t.id)).map((t) => t.id);
  if (!ids.length) {
    toast("আগে কিছু গান বাছাই করো।");
    return;
  }
  editing = { bulk: ids, tags: new Set(), fav: false };
  $("#edit-title").textContent = `${ids.length}টি গানের বিবরণ`;
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
    toast("কিছু বদলানো হয়নি।");
    return;
  }
  selected.clear();
  selecting = false;
  meta.setMany(ids, { patch, addTags, fav });
  toast(`${ids.length}টি গানের বিবরণ বদলানো হয়েছে।`);
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
    toast("সংরক্ষণ করা হয়েছে।");
  }
  if (wantsRename) renameTrack(track, newBase);
}

function renameErrorText(err) {
  if (err instanceof AuthError) return 'ড্রাইভের সঙ্গে সংযোগ নেই। "আবার যুক্ত করো" চেপে আবার চেষ্টা করো।';
  if (err instanceof DriveError && err.status === 403)
    return 'নাম বদলের অনুমতি নেই। "সাজসজ্জা" ট্যাবে "ড্রাইভ আবার যুক্ত করো" চেপে নতুন অনুমতি দাও।';
  if (err instanceof DriveError && err.status === 404) return "ফাইলটি ড্রাইভে আর পাওয়া যাচ্ছে না।";
  if (err instanceof DriveError) return `ড্রাইভ নাম বদলায়নি (কোড ${err.status})।`;
  return "ইন্টারনেট সংযোগ দেখো, তারপর আবার চেষ্টা করো।";
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
    toast("ড্রাইভে নামটি বদলানো হয়েছে।");
  } catch (err) {
    if (err instanceof AuthError) updateBanner();
    toast(renameErrorText(err));
  }
}

// ---------- tag dialog ----------
function renderTagColors() {
  $("#tag-colors").innerHTML = TAG_COLORS.map(
    (c) =>
      `<button class="color-btn" type="button" data-color="${c}" style="--c:${c}" aria-pressed="${tagEditing.color === c}" aria-label="রং বেছে নাও"></button>`
  ).join("");
}

function openTagDialog(tagId) {
  const existing = tagId ? meta.tag(tagId) : null;
  tagEditing = { id: existing ? existing.id : null, color: existing ? existing.color : TAG_COLORS[0] };
  $("#tag-title").textContent = existing ? "ট্যাগ বদলাও" : "নতুন ট্যাগ";
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
    toast("এই নামে একটি ট্যাগ আগেই আছে।");
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
  if (!confirm(`"${tag.name}" ট্যাগটি সব গান থেকে সরানো হবে। সরাবে?`)) return;
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
  $("#plpick-title").textContent = `${n === 1 ? "গানটি" : `${n}টি গান`} কোন প্লেলিস্টে যোগ করবে?`;
  $("#plpick-list").innerHTML = meta.data.playlists
    .map(
      (p) =>
        `<button class="sheet-btn" type="button" data-pl="${esc(p.id)}">${icon("queue")}${esc(p.name)}<span class="muted"> · ${p.ids.length}টি গান</span></button>`
    )
    .join("");
  $("#plpick-new").innerHTML = icon("plus") + "নতুন প্লেলিস্ট বানিয়ে যোগ করো";
}

function openPlPicker(ids) {
  if (!ids.length) {
    toast("আগে কিছু গান বাছাই করো।");
    return;
  }
  plTarget = { ids };
  renderPlPicker();
  $("#plpick").hidden = false;
}

function openPlDialog(id, addIds = []) {
  const existing = id ? meta.playlist(id) : null;
  plEditing = { id: existing ? existing.id : null, addIds };
  $("#pl-title").textContent = existing ? "প্লেলিস্টের নাম বদলাও" : "নতুন প্লেলিস্ট";
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
    toast("এই নামে একটি প্লেলিস্ট আগেই আছে।");
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
  toast(addIds.length ? `"${name}" প্লেলিস্টে ${addIds.length}টি গান যোগ হয়েছে।` : `"${name}" প্লেলিস্ট বানানো হয়েছে।`);
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
    toast("গানগুলো আগেই এই প্লেলিস্টে আছে।");
  } else toast(`"${pl.name}" প্লেলিস্টে ${n}টি গান যোগ হয়েছে।`);
}

function deleteCurrentPlaylist() {
  const pl = meta.playlist(sub);
  if (!pl) return;
  if (!confirm(`"${pl.name}" প্লেলিস্টটি মোছা হবে। গানগুলো মুছবে না। মুছবে?`)) return;
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
      setBusy(`অন্য ডিভাইসের ফোল্ডার "${f.name}" স্ক্যান হচ্ছে…`);
      const info = await getFolderInfo(f.id);
      await scanInto(info, true);
    }
    prefs.foldersSynced = true;
    savePrefs();
    renderAll();
    toast("অন্য ডিভাইসের ফোল্ডারগুলো যোগ হয়েছে।");
  } catch (err) {
    if (err instanceof DriveError && (err.status === 404 || err.message === "not-a-folder")) {
      toast("অন্য ডিভাইসে যোগ করা একটি ফোল্ডার এখানে খোলা যায়নি।");
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
  const sub = mine ? (s.custom ? "নিজের যোগ করা" : "") : s.tags.split(",").slice(0, 3).filter(Boolean).join(", ");
  li.innerHTML = `
    <button class="row-main" type="button" data-play>
      <span class="row-idx">${icon("radio")}</span>
      <span class="row-text">
        <span class="row-title">${esc(s.name)}</span>
        ${sub ? `<span class="row-sub">${esc(sub)}</span>` : ""}
      </span>
    </button>
    <button class="row-more" type="button" ${mine ? "data-unsave" : "data-save"} aria-label="${
      mine ? "আমার রেডিও থেকে সরাও" : saved ? "আমার রেডিওতে আছে" : "আমার রেডিওতে রাখো"
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
    loading: "যুক্ত হচ্ছে…",
    playing: "সরাসরি বাজছে",
    paused: "থামানো আছে",
    error: "এই রেডিও এখন বাজছে না",
  }[radio.status];
  $("#radio-now-state").textContent = label || "";
  const playing = radio.status === "playing" || radio.status === "loading";
  $("#radio-toggle").innerHTML = icon(playing ? "pause" : "play");
  $("#radio-toggle").setAttribute("aria-label", playing ? "থামাও" : "চালাও");
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
    note.textContent = "এখনো কোনো রেডিও রাখা হয়নি। নিচের তালিকার তারা চিহ্নে চাপো।";
    mine.append(note);
  }
  meta.data.radio.forEach((r) => mine.append(radioRow(r, true, true)));

  const q = radioQuery.trim().toLowerCase();
  const list = $("#radio-list");
  list.textContent = "";
  const shown = radioList.filter((s) => !q || s.name.toLowerCase().includes(q) || s.tags.toLowerCase().includes(q));
  shown.forEach((s) => list.append(radioRow(s, savedIds.has(s.id), false)));
  const msg = $("#radio-msg");
  if (radioState === "loading") msg.textContent = "তালিকা আনা হচ্ছে…";
  else if (radioState === "error")
    msg.textContent = "তালিকা আনা যায়নি। ইন্টারনেট দেখে ওপরের নতুন করে আনার বোতাম চাপো। চাইলে নিজের রেডিওর লিংক যোগ করে নিতে পারো।";
  else if (radioState === "ready" && !shown.length) msg.textContent = q ? "কিছু পাওয়া যায়নি।" : "তালিকা খালি।";
  else if (radioStale) msg.textContent = "ইন্টারনেটে নতুন তালিকা আনা যায়নি, আগের সংরক্ষণ করা তালিকা দেখানো হচ্ছে।";
  else msg.textContent = radioState === "ready" ? `${shown.length}টি রেডিও` : "";
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
}

function addCustomStation() {
  const name = $("#radio-name").value.trim();
  const url = $("#radio-url").value.trim();
  if (!name) return;
  if (!/^https:\/\//i.test(url)) {
    toast("লিংকটি https দিয়ে শুরু হতে হবে। http লিংক ফোনে বাজে না।");
    return;
  }
  meta.saveStation({ id: `c${Date.now().toString(36)}`, name, url, custom: true });
  $("#radio-name").value = "";
  $("#radio-url").value = "";
  toast(`"${name}" আমার রেডিওতে যোগ হয়েছে।`);
}

// ---------- link to Drive ----------
const BLOCKED_HOSTS = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|spotify\.com|soundcloud\.com|music\.apple\.com|deezer\.com|jiosaavn\.com|gaana\.com)$/i;

function renderGrab() {
  const select = $("#grab-folder");
  const keep = select.value || prefs.grabFolder || "";
  select.innerHTML = folders.length
    ? folders.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("")
    : `<option value="">আগে একটি ফোল্ডার যোগ করো</option>`;
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
    toast("ঠিকানাটি https://script.google.com/ দিয়ে শুরু হওয়া উচিত।");
    return;
  }
  prefs.scriptUrl = url;
  prefs.scriptKey = key;
  savePrefs();
  toast("সংরক্ষণ করা হয়েছে।");
}

function grabErrorText(err) {
  const code = String((err && err.message) || "");
  if (code === "secret") return "গোপন শব্দ মেলেনি। সেটিংয়ে Apps Script-এর শব্দটাই বসাও।";
  if (code === "not-audio") return "লিংকটি গানের ফাইল মনে হচ্ছে না। সরাসরি MP3 ফাইলের লিংক দিতে হবে।";
  if (code === "too-big") return "ফাইলটি খুব বড়। ৫০ মেগাবাইটের বেশি নামানো যায় না।";
  if (code === "folder") return "ড্রাইভের ফোল্ডারটি পাওয়া যায়নি।";
  if (code === "url") return "লিংকটি ঠিক নয়।";
  if (/^http \d+/.test(code)) return `সাইটটি ফাইল দিতে রাজি হয়নি (${code.replace("http ", "কোড ")})।`;
  if (err instanceof SyntaxError)
    return 'Apps Script ঠিকমতো চালু হয়নি। "Anyone" অ্যাক্সেস দিয়ে Deploy করেছ কি না দেখো।';
  if (err instanceof TypeError) return "Apps Script-এর ঠিকানা ঠিক আছে কি না আর ইন্টারনেট দেখো।";
  return "গানটি ড্রাইভে রাখা যায়নি।";
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
    toast("লিংকটি http বা https দিয়ে শুরু হতে হবে।");
    return;
  }
  if (BLOCKED_HOSTS.test(host)) {
    toast("ইউটিউব, স্পটিফাই বা এই ধরনের সাইটের লিংক থেকে গান নামানো যায় না। সরাসরি MP3 ফাইলের লিংক দাও।");
    return;
  }
  if (!prefs.scriptUrl || !prefs.scriptKey) {
    $("#grab-settings").open = true;
    toast("আগে নিচের সেটিংয়ে Apps Script-এর ঠিকানা আর গোপন শব্দ বসাও।");
    return;
  }
  const folder = folders.find((f) => f.id === folderId);
  if (!folder) {
    toast("আগে একটি ড্রাইভ ফোল্ডার যোগ করো।");
    return;
  }
  prefs.grabFolder = folderId;
  savePrefs();
  busy = true;
  setGrabBusy("ড্রাইভে নামানো হচ্ছে… বড় ফাইলে কিছুক্ষণ লাগতে পারে।");
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
    savedName = data.name || name || "গান";
    $("#grab-url").value = "";
    $("#grab-name").value = "";
  } catch (err) {
    toast(grabErrorText(err));
  } finally {
    busy = false;
    setGrabBusy("");
  }
  if (savedName) {
    toast(`"${savedName}" ড্রাইভে জমা হয়েছে।`);
    await rescanFolder(folder);
  }
}

// ---------- cloud sync ----------
function setSyncStatus(state) {
  const el = $("#sync-status");
  if (state === "ok") el.textContent = "ক্লাউডে সংরক্ষণ চালু আছে।";
  else if (state === "error")
    el.textContent = "ক্লাউডে সংরক্ষণ বন্ধ। বিবরণ, ট্যাগ আর প্লেলিস্ট শুধু এই ফোনে থাকছে (SETUP-bn.md-এর ৬ নম্বর ধাপ দেখো)।";
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
        toast("ক্লাউডে সংরক্ষণ চালু নেই, তাই পরিবর্তন শুধু এই ফোনে থাকছে।");
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
  if (code === "auth/unauthorized-domain") msg.textContent = "এই ঠিকানা Firebase-এ অনুমোদিত নয়। SETUP-bn.md-এর ৭ নম্বর ধাপ দেখো।";
  else if (code === "auth/network-request-failed") msg.textContent = "ইন্টারনেট সংযোগ দেখো।";
  else msg.textContent = `প্রবেশ করা যায়নি (${code || "অজানা সমস্যা"})।`;
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
    if (user) toast("ড্রাইভ যুক্ত হয়েছে।");
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
  connectCloud(user);
  if (!appReady) {
    appReady = true;
    renderAll();
    renderTrack();
    renderQueue();
  }
  updateBanner();
}

// ---------- rendering everything ----------
function renderAll() {
  renderSongs();
  renderFolders();
  renderRadio();
  renderLook();
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
      toast("আগে একটি গান বেছে নাও।");
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
    if (!songsView.length) return toast("এই প্লেলিস্টে এখনো গান নেই।");
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
    if (meta.undo()) toast("পরিবর্তন ফিরিয়ে নেওয়া হয়েছে।");
  });
  $("#btn-redo").addEventListener("click", () => {
    if (meta.redo()) toast("আবার করা হয়েছে।");
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

  $("#themes-color").addEventListener("click", pickTheme);
  $("#themes-night").addEventListener("click", pickTheme);
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
    toast("এরপর বাজবে।");
  });
  $("#sheet-queue").addEventListener("click", () => {
    if (sheetTrack) player.enqueue(sheetTrack);
    closeSheet();
    toast("কিউয়ের শেষে যোগ হয়েছে।");
  });
  $("#sheet-fav").addEventListener("click", () => {
    if (sheetTrack) {
      const on = !meta.get(sheetTrack.id).fav;
      meta.toggleFav(sheetTrack.id);
      toast(on ? "পছন্দের তালিকায় যোগ হয়েছে।" : "পছন্দের তালিকা থেকে সরানো হয়েছে।");
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
        toast(`"${st.name}" আমার রেডিওতে রাখা হয়েছে।`);
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
    if (radio.status === "error") toast("এই রেডিও এখন বাজছে না। অন্যটি চেষ্টা করো।");
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
      $("#now-status").textContent = pct ? `গান লোড হচ্ছে… ${pct}%` : "গান লোড হচ্ছে…";
    })
    .on("error", () => {
      const more = player.index + 1 < player.order.length;
      toast(more ? "এই ফাইল বাজানো যাচ্ছে না, পরেরটা চালানো হচ্ছে।" : "এই ফাইল বাজানো যাচ্ছে না।");
    })
    .on("needauth", () => {
      updateBanner();
      $("#banner").hidden = false;
      toast('ড্রাইভের সঙ্গে সংযোগের সময় শেষ। "আবার যুক্ত করো" চাপো।');
    })
    .on("blocked", () => toast("চালাতে চালানোর বোতামে চাপ দাও।"));
}

// ---------- boot ----------
async function boot() {
  applyTheme(prefs.theme);
  applyFont(prefs.font);
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
    $("#login-msg").textContent = "Firebase-এর তথ্য এখনো বসানো হয়নি। js/firebase-config.js ফাইলটি খুলে নিজের তথ্য বসাও।";
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
