function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function isPushSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function isIOS(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = window.navigator.userAgent.toLowerCase();
  return /iphone|ipad|ipod/.test(ua);
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as any).standalone === true
  );
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    return reg;
  } catch (err) {
    console.error('Service worker registration failed:', err);
    return null;
  }
}

export async function requestAndSubscribePush(accessToken: string): Promise<{
  success: boolean;
  message: string;
}> {
  if (!isPushSupported()) {
    if (isIOS() && !isStandalone()) {
      return {
        success: false,
        message: 'iOS(아이폰)에서는 [공유] 버튼 > [홈 화면에 추가] 후 실행해야 푸시 알림이 지원됩니다.',
      };
    }
    return {
      success: false,
      message: '이 브라우저는 웹 푸시 알림을 지원하지 않습니다. 화면의 실시간 대기 현황을 확인해 주세요.',
    };
  }

  try {
    // 1. Request notification permission
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return {
        success: false,
        message: '알림 권한이 거부되었습니다. 브라우저 설정에서 알림을 허용해 주세요.',
      };
    }

    // 2. Register service worker
    const swReg = await registerServiceWorker();
    if (!swReg) {
      return {
        success: false,
        message: '서비스 워커를 등록할 수 없습니다.',
      };
    }

    // 3. Fetch VAPID key
    const keyRes = await fetch('/api/vapid-public-key');
    if (!keyRes.ok) {
      throw new Error('VAPID 키를 불러올 수 없습니다.');
    }
    const { publicKey } = await keyRes.json();
    const convertedKey = urlBase64ToUint8Array(publicKey);

    // 4. Subscribe with pushManager
    let subscription = await swReg.pushManager.getSubscription();
    if (!subscription) {
      subscription = await swReg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: convertedKey,
      });
    }

    // 5. Send to server
    const sendRes = await fetch('/api/queue/push-subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: accessToken,
        subscription: subscription.toJSON(),
      }),
    });

    if (!sendRes.ok) {
      const errData = await sendRes.json();
      throw new Error(errData.error || '푸시 등록 서버 전송 실패');
    }

    return {
      success: true,
      message: '휴대폰 푸시 알림이 정상적으로 등록되었습니다! (확인용 테스트 알림 발송됨)',
    };
  } catch (err: any) {
    console.error('Push subscription failed:', err);
    return {
      success: false,
      message: err.message || '푸시 알림 등록 중 오류가 발생했습니다.',
    };
  }
}
