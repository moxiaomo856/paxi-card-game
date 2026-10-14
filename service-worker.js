// 🟢 2A：CACHE 与 index.html 的 window.HUB_BUILD 联动
//   ⚠️ 维护约定：每次改前端代码，必须【同时】改这两处版本号，保持一致：
//     ① index.html: <script>window.HUB_BUILD = '20261014-16';</script>
//     ② service-worker.js: const BUILD = '20261014-16';
//   这样 SW 文件字节变化 → 重装 → CACHE 名变化 → 旧缓存清空 → 干净拉新。
//   （20261014-5：配套合约 code_id 36 上线——合并 BattlePvp/BattleAi、碎片统一、零费锁定）
const BUILD = '20261014-16';
const V = '?v=' + BUILD;
const CACHE = 'paxihub-' + BUILD;
const SHELL = [
  './',
  'index.html' + V,
  'app.js' + V,
  'session.js' + V,
  'shared.js' + V,
  'games.js' + V,
  'sanguo.js' + V,
  'compat.js' + V,
  'paxi-cosmjs.umd.js' + V,
  'style/theme.css' + V,
  'manifest.json',
  'icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨域（CDN 回退）不拦截

  // vendor / 图标：cache-first
  if (url.pathname.includes('/vendor/') || url.pathname.endsWith('/icon.svg')) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => hit))
    );
    return;
  }

  // 应用外壳：network-first，失败回退缓存
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
  );
});
