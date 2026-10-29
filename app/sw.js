// v2: navigation is network-first. The old cache-first handler pinned the app HTML to
// whatever version was cached first, so fixes deployed to GitHub Pages never reached an
// installed phone (and a failed asset request was answered with index.html). Offline still
// works: the last good copy is kept and served when the network is gone.
const CACHE = "smgps-app-v2";
const ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const put = (req, res) => {
  const copy = res.clone();
  caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
  return res;
};

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  // Live data and the optional Render API must never be served from this cache.
  if (url.hostname === "raw.githubusercontent.com" || url.pathname.startsWith("/api/")) return;

  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request)
        .then((res) => put(e.request, res))
        .catch(() => caches.match(e.request).then((hit) => hit || caches.match("./index.html")))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(
      (hit) => hit || fetch(e.request).then((res) => put(e.request, res))
    )
  );
});
