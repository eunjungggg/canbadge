import React, { useState, useEffect } from 'react';
import { StudentRegister } from './components/StudentRegister';
import { StudentTicket } from './components/StudentTicket';
import { PublicDisplay } from './components/PublicDisplay';
import { AdminDashboard } from './components/AdminDashboard';
import { PWAInstallButton } from './components/PWAInstallButton';
import { registerServiceWorker } from './utils/pushManager';
import type { PublicBoardDTO } from './types';
import { LayoutDashboard, MonitorPlay, Ticket, ShieldCheck, WifiOff } from 'lucide-react';

import { safeFetchJson } from './utils/api';

export type AppView = 'REGISTER' | 'TICKET' | 'DISPLAY' | 'ADMIN';

export default function App() {
  const [view, setView] = useState<AppView>('REGISTER');
  const [ticketToken, setTicketToken] = useState<string | null>(null);
  const [publicData, setPublicData] = useState<PublicBoardDTO | null>(null);
  const [isOnline, setIsOnline] = useState<boolean>(true);

  // Parse URL on initial load and popstate
  const syncRouteWithUrl = () => {
    const params = new URLSearchParams(window.location.search);
    const tokenParam = params.get('token');
    const path = window.location.pathname;

    if (tokenParam) {
      setTicketToken(tokenParam);
      setView('TICKET');
    } else if (path === '/admin') {
      setView('ADMIN');
    } else if (path === '/display') {
      setView('DISPLAY');
    } else {
      // Check localStorage for saved ticket
      const savedToken = localStorage.getItem('canbadge_token');
      if (savedToken && view === 'REGISTER') {
        // keep at register, but allow easy restore
      }
    }
  };

  const fetchPublicData = async () => {
    const res = await safeFetchJson<PublicBoardDTO>('/api/queue/public');
    if (res.ok && res.data) {
      setPublicData(res.data);
    }
  };

  useEffect(() => {
    syncRouteWithUrl();
    fetchPublicData();
    registerServiceWorker();

    const handlePopState = () => syncRouteWithUrl();
    window.addEventListener('popstate', handlePopState);

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // SSE connection for public updates
    let eventSource: EventSource | null = null;
    try {
      eventSource = new EventSource('/api/queue/stream');
      eventSource.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'UPDATE') {
            fetchPublicData();
          }
        } catch (e) {
          console.error(e);
        }
      };
      eventSource.onerror = () => {
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
      };
    } catch (e) {}

    const interval = setInterval(fetchPublicData, 6000);

    return () => {
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (eventSource) eventSource.close();
      clearInterval(interval);
    };
  }, []);

  const navigateTo = (targetView: AppView, token?: string) => {
    setView(targetView);
    if (token) {
      setTicketToken(token);
      window.history.pushState({}, '', `/?token=${token}`);
    } else if (targetView === 'ADMIN') {
      window.history.pushState({}, '', '/admin');
    } else if (targetView === 'DISPLAY') {
      window.history.pushState({}, '', '/display');
    } else {
      setTicketToken(null);
      window.history.pushState({}, '', '/');
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-gray-900 selection:bg-blue-600 selection:text-white">
      {/* Offline Status Warning Bar */}
      {!isOnline && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-amber-500 text-white text-xs font-bold py-1.5 px-4 text-center flex items-center justify-center gap-2 shadow-md">
          <WifiOff className="w-4 h-4" />
          네트워크 연결이 끊겼습니다. 인터넷이 연결되면 자동으로 다시 동기화됩니다.
        </div>
      )}

      {/* Main View Render */}
      {view === 'REGISTER' && (
        <StudentRegister
          publicData={publicData}
          onRefreshPublic={fetchPublicData}
          onRegistered={(token) => navigateTo('TICKET', token)}
          onGoToStatus={(token) => navigateTo('TICKET', token)}
        />
      )}

      {view === 'TICKET' && ticketToken && (
        <StudentTicket
          token={ticketToken}
          onBackToRegister={() => navigateTo('REGISTER')}
        />
      )}

      {view === 'DISPLAY' && (
        <PublicDisplay onGoHome={() => navigateTo('REGISTER')} />
      )}

      {view === 'ADMIN' && (
        <AdminDashboard
          onGoHome={() => navigateTo('REGISTER')}
          onGoDisplay={() => navigateTo('DISPLAY')}
        />
      )}

      {/* Fixed Navigation Bottom Bar for Easy Switching between Student / Screen / Admin */}
      <nav
        aria-label="화면 전환 바"
        className="fixed bottom-3 left-1/2 -translate-x-1/2 z-40 bg-slate-900/90 backdrop-blur-md text-white px-2 py-1.5 rounded-2xl shadow-2xl border border-slate-700/60 flex items-center gap-1 text-xs"
      >
        <button
          onClick={() => {
            const saved = localStorage.getItem('canbadge_token');
            if (saved) navigateTo('TICKET', saved);
            else navigateTo('REGISTER');
          }}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-bold transition ${
            view === 'REGISTER' || view === 'TICKET'
              ? 'bg-blue-600 text-white shadow-xs'
              : 'text-slate-300 hover:text-white hover:bg-slate-800'
          }`}
        >
          <Ticket className="w-3.5 h-3.5" />
          <span>학생 화면</span>
        </button>

        <button
          onClick={() => navigateTo('DISPLAY')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-bold transition ${
            view === 'DISPLAY'
              ? 'bg-blue-600 text-white shadow-xs'
              : 'text-slate-300 hover:text-white hover:bg-slate-800'
          }`}
        >
          <MonitorPlay className="w-3.5 h-3.5" />
          <span>부스 전광판</span>
        </button>

        <button
          onClick={() => navigateTo('ADMIN')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-bold transition ${
            view === 'ADMIN'
              ? 'bg-blue-600 text-white shadow-xs'
              : 'text-slate-300 hover:text-white hover:bg-slate-800'
          }`}
        >
          <LayoutDashboard className="w-3.5 h-3.5" />
          <span>관리자</span>
        </button>

        <div className="ml-1 pl-1 border-l border-slate-700">
          <PWAInstallButton />
        </div>
      </nav>
    </div>
  );
}
