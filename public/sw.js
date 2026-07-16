// Service worker: this is what stays alive after you close the app.
const CACHE = "cre-brief-v1";
const SHELL = ["/", "/index.html", "/manifest.json", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// App shell from cache, everything else from network.
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || e.request.url.includes("/api/")) return;
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
});

// The daily brief arrives here even with the app closed.
self.addEventListener("push", e => {
  let d = { title: "CRE brief", body: "Your brief is ready." };
  try { if (e.data) d = e.data.json(); } catch {}

  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: "cre-daily-brief",
    renotify: true,
    data: { date: d.date },
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const c of list) if ("focus" in c) return c.focus();
      return self.clients.openWindow("/");
    })
  );
});
