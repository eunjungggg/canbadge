// Service Worker for 캔뱃지 부스 실시간 대기 웹 푸시 알림
const CACHE_NAME = 'canbadge-queue-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Push notification listener
self.addEventListener('push', (event) => {
  if (!event.data) return;

  try {
    const data = event.data.json();
    const title = data.title || '캔뱃지 부스 알림';
    const options = {
      body: data.body || '대기 순서가 업데이트되었습니다.',
      icon: data.icon || '/icon.svg',
      badge: data.badge || '/icon.svg',
      tag: data.tag || 'queue-notification',
      renotify: true,
      vibrate: [200, 100, 200, 100, 200],
      data: {
        url: data.url || '/',
        ticketNumber: data.ticketNumber,
      },
      actions: [
        {
          action: 'open_ticket',
          title: '대기표 확인하기',
        }
      ]
    };

    event.waitUntil(self.registration.showNotification(title, options));
  } catch (err) {
    console.error('Error handling push event:', err);
  }
});

// Notification click listener
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = (event.notification.data && event.notification.data.url) ? event.notification.data.url : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If a tab is already open, focus it and navigate
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
