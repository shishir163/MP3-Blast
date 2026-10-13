// MP3 Blast service worker: keeps the app shell available and never touches Drive or login traffic.
const VERSION = "v4";
const SHELL_CACHE = `mp3blast-shell-${VERSION}`;
const RUNTIME_CACHE = `mp3blast-runtime-${VERSION}`;

const SHELL = [
  "./",
  "index.html",
  "css/style.css",
  "js/app.js",
  "js/auth.js",
  "js/drive.js",
  "js/player.js",
  "js/store.js",
  "js/meta.js",
  "js/cloud.js",
  "js/radio.js",
  "js/icons.js",
  "js/firebase-config.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
  "icons/favicon-32.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => ![SHELL_CACHE, RUNTIME_CACHE].includes(k)).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

const RUNTIME_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "www.gstatic.com"];

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Our own files: try the network first so updates show up straight away.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("index.html")))
    );
    return;
  }

  // Fonts and the Firebase library: serve from cache, refresh in the background.
  if (RUNTIME_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then((cache) =>
        cache.match(req).then((hit) => {
          const refresh = fetch(req)
            .then((res) => {
              if (res.ok || res.type === "opaque") cache.put(req, res.clone());
              return res;
            })
            .catch(() => hit);
          return hit || refresh;
        })
      )
    );
  }
  // Everything else (Drive API, login) goes straight to the network.
});
