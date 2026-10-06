import React, { useEffect, useState } from 'react';
import { Download, Share, PlusSquare, Smartphone } from 'lucide-react';
import { isIOS, isStandalone } from '../utils/pushManager';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export const PWAInstallButton: React.FC = () => {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [showIOSModal, setShowIOSModal] = useState(false);

  useEffect(() => {
    setIsInstalled(isStandalone());

    const handleBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  if (isInstalled) return null;

  const handleInstallClick = async () => {
    if (deferredPrompt) {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        setIsInstalled(true);
        setDeferredPrompt(null);
      }
    } else if (isIOS()) {
      setShowIOSModal(true);
    }
  };

  if (!deferredPrompt && !isIOS()) return null;

  return (
    <>
      <button
        onClick={handleInstallClick}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold shadow-xs transition active:scale-95"
      >
        <Smartphone className="w-3.5 h-3.5" />
        앱으로 설치
      </button>

      {showIOSModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="font-bold text-gray-900 text-base">홈 화면에 앱 추가하기</h3>
            <p className="mt-2 text-xs text-gray-600">
              1. Safari 하단의 <Share className="w-3.5 h-3.5 inline text-blue-600" /> [공유] 버튼을 탭합니다.<br />
              2. <PlusSquare className="w-3.5 h-3.5 inline text-gray-800" /> [홈 화면에 추가]를 선택합니다.<br />
              3. 추가된 앱으로 실행하면 푸시 알림을 가장 안정적으로 받으실 수 있습니다!
            </p>
            <button
              onClick={() => setShowIOSModal(false)}
              className="mt-4 w-full py-2 bg-gray-900 text-white font-bold rounded-xl text-xs"
            >
              닫기
            </button>
          </div>
        </div>
      )}
    </>
  );
};
