// Small localStorage helpers. Only metadata is stored here — never audio files.
function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_PREFS = {
  theme: "yellow",
  font: "lato",
  shuffle: false,
  repeat: "off",
  volume: 1,
  scriptUrl: "",
  scriptKey: "",
  grabFolder: "",
  foldersSynced: false,
};

export const store = {
  prefs() {
    return { ...DEFAULT_PREFS, ...read("mb.prefs", {}) };
  },
  savePrefs(prefs) {
    write("mb.prefs", prefs);
  },
  folders() {
    return read("mb.folders", []);
  },
  saveFolders(folders) {
    write("mb.folders", folders);
  },
  tracks() {
    return read("mb.tracks", []);
  },
  saveTracks(tracks) {
    return write("mb.tracks", tracks);
  },
  clearAll() {
    try {
      ["mb.prefs", "mb.folders", "mb.tracks", "mb.token", "mb.meta", "mb.radio"].forEach((k) => localStorage.removeItem(k));
    } catch {
      /* ignore */
    }
  },
};
