// Service worker Lucky Bienie: aplikasi tetap terbuka saat offline.
const C = "lb-cloud-v1";
const FILES = ["./", "./index.html", "./cloud.js", "./supabase.js", "./config.js", "./manifest.json", "./icon-192.png", "./icon-512.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(C).then((c) => c.addAll(FILES).catch(() => {})).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== C).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/")) return;   // Supabase & API tidak disentuh
  e.respondWith(
    fetch(r).then((res) => { const cp = res.clone(); caches.open(C).then((c) => c.put(r, cp)); return res; })
      .catch(() => caches.match(r).then((m) => m || (r.mode === "navigate" ? caches.match("./index.html") : Response.error())))
  );
});
