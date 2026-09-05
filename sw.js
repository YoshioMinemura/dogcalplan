const CACHE_NAME = "benu-care-v6";
const APP_SHELL = [
  "./", "./index.html", "./styles.css", "./manifest.webmanifest", "./icons/icon.svg",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable.svg", "./icons/apple-touch-icon.png",
  "./js/app.js", "./js/db.js", "./js/defaults.js", "./js/domain.js", "./js/auth.js",
  "./js/sync.js", "./js/care.js", "./js/push-config.js", "./js/supabase-client.js", "./js/supabase-config.js", "./vendor/supabase.min.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (response.ok && new URL(event.request.url).origin === location.origin) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    }).catch(() => caches.match("./index.html")))
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { data = { body: event.data?.text() || "点眼の予定を確認してください。" }; }
  event.waitUntil(self.registration.showNotification(data.title || "べぬケアごはん", {
    body: data.body || "点眼の予定を確認してください。",
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    tag: data.tag || "benu-care",
    data: { url: data.url || "./" }
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./", self.location.href).href;
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
    const existing = windows.find((client) => new URL(client.url).origin === new URL(target).origin);
    if (existing) {
      await existing.navigate(target);
      return existing.focus();
    }
    return clients.openWindow(target);
  }));
});
