import { getToken } from "./auth.js";

const API = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus)$/i;
const MIME_BY_EXT = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
};

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}

export class DriveError extends Error {
  constructor(status, message) {
    super(message || `Drive ${status}`);
    this.name = "DriveError";
    this.status = status;
  }
}

export function extOf(name) {
  const m = /\.([^./\\]+)$/.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

export function displayTitle(track) {
  return track.name.replace(/\.[^./\\]+$/, "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

// Accepts a full Drive folder link, a link with ?id=, or a bare folder ID.
export function parseFolderId(input) {
  const text = String(input || "").trim();
  if (!text) return null;
  let m = /\/folders\/([\w-]+)/.exec(text);
  if (m) return m[1];
  m = /[?&]id=([\w-]+)/.exec(text);
  if (m) return m[1];
  if (/^[\w-]{15,}$/.test(text)) return text;
  return null;
}

function authHeader() {
  const token = getToken();
  if (!token) throw new AuthError("no token");
  return { Authorization: `Bearer ${token}` };
}

async function api(path, params = {}) {
  const url = new URL(API + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: authHeader() });
  if (res.status === 401) throw new AuthError("expired");
  if (!res.ok) throw new DriveError(res.status);
  return res.json();
}

export async function getFolderInfo(id) {
  const info = await api(`/files/${encodeURIComponent(id)}`, {
    fields: "id,name,mimeType",
    supportsAllDrives: "true",
  });
  if (info.mimeType !== FOLDER_MIME) throw new DriveError(0, "not-a-folder");
  return info;
}

async function listChildren(folderId) {
  const files = [];
  let pageToken = "";
  do {
    const params = {
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken,files(id,name,mimeType,size)",
      pageSize: "1000",
      orderBy: "name",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    };
    if (pageToken) params.pageToken = pageToken;
    const data = await api("/files", params);
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return files;
}

function isAudio(file) {
  if (file.mimeType && file.mimeType.startsWith("application/vnd.google-apps")) return false;
  return (file.mimeType && file.mimeType.startsWith("audio/")) || AUDIO_EXT.test(file.name || "");
}

// Walks the folder (and its sub-folders) and returns a flat list of audio files.
export async function scanFolder(root, onCount) {
  const found = [];
  const queue = [{ id: root.id, path: [], depth: 0 }];
  while (queue.length) {
    const batch = queue.splice(0, 4);
    const results = await Promise.all(
      batch.map(async (node) => ({ node, items: await listChildren(node.id) }))
    );
    for (const { node, items } of results) {
      for (const f of items) {
        if (f.mimeType === FOLDER_MIME) {
          if (node.depth < 8) queue.push({ id: f.id, path: [...node.path, f.name], depth: node.depth + 1 });
        } else if (isAudio(f)) {
          found.push({
            id: f.id,
            name: f.name,
            path: node.path.join(" › "),
            root: root.id,
            size: Number(f.size) || 0,
          });
        }
      }
    }
    onCount?.(found.length);
  }
  return found;
}

// Renames a file in Drive. Needs the full Drive permission, not the read-only one.
export async function renameFile(id, name) {
  const url = `${API}/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id,name`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (res.status === 401) throw new AuthError("expired");
  if (!res.ok) throw new DriveError(res.status);
  return res.json();
}

// Downloads one song into memory (nothing is saved to disk) and reports progress.
export async function fetchAudioBlob(track, onProgress) {
  const url = `${API}/files/${encodeURIComponent(track.id)}?alt=media&supportsAllDrives=true`;
  const res = await fetch(url, { headers: authHeader() });
  if (res.status === 401) throw new AuthError("expired");
  if (!res.ok) throw new DriveError(res.status);
  const type = MIME_BY_EXT[extOf(track.name)] || "audio/mpeg";
  const total = Number(res.headers.get("content-length")) || track.size || 0;
  if (!res.body || !res.body.getReader) {
    return new Blob([await res.arrayBuffer()], { type });
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  return new Blob(chunks, { type });
}
