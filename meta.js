// Song details (artist, album, movie, tags, favourite) kept apart from the Drive files.
// Everything here is small text; it is saved on this device and synced through cloud.js.
const KEY = "mb.meta";
const HISTORY_LIMIT = 50;

export const TAG_COLORS = ["#E63946", "#F4A300", "#2A9D5C", "#0FA3A3", "#3B6CF0", "#8E5BE8", "#E0559B", "#6B7280"];

const blankTrack = () => ({ artist: "", album: "", movie: "", tags: [], fav: false });
const emptyData = () => ({ tags: [], tracks: {}, playlists: [], radio: [], updatedAt: 0 });
const newId = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const clone = (o) => JSON.parse(JSON.stringify(o));
const isBlank = (t) => !t.artist && !t.album && !t.movie && !(t.tags && t.tags.length) && !t.fav;

export class MetaStore {
  constructor() {
    this.data = this.loadLocal();
    this.past = [];
    this.future = [];
    this.listeners = [];
  }

  loadLocal() {
    try {
      const raw = localStorage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && parsed.tracks ? { ...emptyData(), ...parsed } : emptyData();
    } catch {
      return emptyData();
    }
  }

  saveLocal() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* ignore */
    }
  }

  onChange(fn) {
    this.listeners.push(fn);
  }

  emit(source) {
    this.listeners.forEach((fn) => fn(source));
  }

  // Every edit goes through here so undo and redo always work.
  commit(mutator) {
    this.past.push(clone(this.data));
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
    mutator(this.data);
    this.data.updatedAt = Date.now();
    this.saveLocal();
    this.emit("local");
  }

  get(id) {
    return { ...blankTrack(), ...(this.data.tracks[id] || {}) };
  }

  get tags() {
    return this.data.tags;
  }

  tag(id) {
    return this.data.tags.find((t) => t.id === id) || null;
  }

  setTrack(id, patch) {
    this.commit((d) => {
      const next = { ...blankTrack(), ...(d.tracks[id] || {}), ...patch };
      next.artist = (next.artist || "").trim();
      next.album = (next.album || "").trim();
      next.movie = (next.movie || "").trim();
      if (isBlank(next)) delete d.tracks[id];
      else d.tracks[id] = next;
    });
  }

  // Applies one change to many songs as a single undo step.
  // change: { patch: {artist?, album?, movie?}, addTags: [tagId], fav: boolean (true = mark favourite) }
  setMany(ids, change) {
    const { patch = {}, addTags = [], fav = false } = change;
    this.commit((d) => {
      for (const id of ids) {
        const next = { ...blankTrack(), ...(d.tracks[id] || {}) };
        for (const key of ["artist", "album", "movie"]) {
          if (patch[key]) next[key] = patch[key].trim();
        }
        const tags = new Set(next.tags || []);
        addTags.forEach((t) => tags.add(t));
        next.tags = [...tags];
        if (fav) next.fav = true;
        if (isBlank(next)) delete d.tracks[id];
        else d.tracks[id] = next;
      }
    });
  }

  toggleFav(id) {
    this.setTrack(id, { fav: !this.get(id).fav });
  }

  addTag(name, color) {
    const tag = {
      id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      name: name.trim(),
      color: color || TAG_COLORS[0],
    };
    this.commit((d) => d.tags.push(tag));
    return tag.id;
  }

  updateTag(id, patch) {
    this.commit((d) => {
      const tag = d.tags.find((t) => t.id === id);
      if (tag) Object.assign(tag, patch, { name: (patch.name ?? tag.name).trim() });
    });
  }

  deleteTag(id) {
    this.commit((d) => {
      d.tags = d.tags.filter((t) => t.id !== id);
      for (const key of Object.keys(d.tracks)) {
        d.tracks[key].tags = (d.tracks[key].tags || []).filter((x) => x !== id);
        if (isBlank(d.tracks[key])) delete d.tracks[key];
      }
    });
  }

  // ---- playlists ----
  playlist(id) {
    return this.data.playlists.find((p) => p.id === id) || null;
  }

  createPlaylist(name, ids = []) {
    const pl = { id: newId("p"), name: name.trim(), ids: [...new Set(ids)] };
    this.commit((d) => d.playlists.push(pl));
    return pl.id;
  }

  renamePlaylist(id, name) {
    this.commit((d) => {
      const pl = d.playlists.find((p) => p.id === id);
      if (pl) pl.name = name.trim();
    });
  }

  deletePlaylist(id) {
    this.commit((d) => {
      d.playlists = d.playlists.filter((p) => p.id !== id);
    });
  }

  // Returns how many songs were really added (songs already inside are skipped).
  addToPlaylist(id, ids) {
    const pl = this.playlist(id);
    if (!pl) return 0;
    const have = new Set(pl.ids);
    const fresh = [...new Set(ids)].filter((x) => !have.has(x));
    if (!fresh.length) return 0;
    this.commit((d) => d.playlists.find((p) => p.id === id).ids.push(...fresh));
    return fresh.length;
  }

  removeFromPlaylist(id, pos) {
    this.commit((d) => {
      const pl = d.playlists.find((p) => p.id === id);
      if (pl && pos >= 0 && pos < pl.ids.length) pl.ids.splice(pos, 1);
    });
  }

  // Moves the song at position `from` so that it ends up at position `to`.
  movePlaylistItem(id, from, to) {
    const pl = this.playlist(id);
    if (!pl || from === to || from < 0 || to < 0 || from >= pl.ids.length || to >= pl.ids.length) return;
    this.commit((d) => {
      const list = d.playlists.find((p) => p.id === id).ids;
      const [item] = list.splice(from, 1);
      list.splice(to, 0, item);
    });
  }

  // ---- saved radio stations ----
  saveStation(station) {
    if (this.data.radio.some((r) => r.id === station.id)) return;
    this.commit((d) => d.radio.push({ id: station.id, name: station.name, url: station.url, custom: !!station.custom }));
  }

  removeStation(id) {
    this.commit((d) => {
      d.radio = d.radio.filter((r) => r.id !== id);
    });
  }

  // ---- folder list (shared between devices, but not part of undo) ----
  setFolders(list) {
    this.data.folders = clone(list);
    this.data.updatedAt = Date.now();
    this.saveLocal();
    this.emit("local");
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  undo() {
    if (!this.past.length) return false;
    this.future.push(clone(this.data));
    const folders = this.data.folders;
    this.data = { ...emptyData(), ...this.past.pop() };
    this.data.folders = folders;
    this.data.updatedAt = Date.now();
    this.saveLocal();
    this.emit("local");
    return true;
  }

  redo() {
    if (!this.future.length) return false;
    this.past.push(clone(this.data));
    const folders = this.data.folders;
    this.data = { ...emptyData(), ...this.future.pop() };
    this.data.folders = folders;
    this.data.updatedAt = Date.now();
    this.saveLocal();
    this.emit("local");
    return true;
  }

  // Takes the cloud copy when it is newer than ours.
  adoptRemote(remote) {
    if (!remote || (remote.updatedAt || 0) <= (this.data.updatedAt || 0)) return false;
    this.data = { ...emptyData(), ...remote };
    this.past = [];
    this.future = [];
    this.saveLocal();
    this.emit("remote");
    return true;
  }
}
