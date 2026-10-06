import React, { useState, useEffect } from 'react';
import { StudentRegister } from './components/StudentRegister';
import { StudentTicket } from './components/StudentTicket';
import { PublicDisplay } from './components/PublicDisplay';
import { AdminDashboard } from './components/AdminDashboard';
import { registerServiceWorker } from './utils/pushManager';
import type { PublicBoardDTO } from './types';
import { LayoutDashboard, MonitorPlay, Ticket, WifiOff } from 'lucide-react';

import { safeFetchJson } from './utils/api';

export type AppView = 'REGISTER' | 'TICKET' | 'DISPLAY' | 'ADMIN';

const NAV_ITEMS = [
  { key: 'STUDENT', label: '학생 화면', Icon: Ticket },
  { key: 'DISPLAY', label: '부스 전광판', Icon: MonitorPlay },
  { key: 'ADMIN', label: '관리자', Icon: LayoutDashboard },
] as const;

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

      {/* Screen switcher: full-width tab bar on phones, floating pill on larger screens */}
      <nav
        aria-label="화면 전환 바"
        className="fixed z-40 inset-x-0 bottom-0 bg-slate-900/95 backdrop-blur-md text-white border-t border-slate-700/60 pb-[env(safe-area-inset-bottom)] sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 sm:bottom-4 sm:rounded-2xl sm:border sm:shadow-2xl sm:pb-0"
      >
        <div className="grid grid-cols-3 sm:flex sm:items-center sm:gap-1 sm:p-1.5">
          {NAV_ITEMS.map(({ key, label, Icon }) => {
            const active = key === 'STUDENT' ? view === 'REGISTER' || view === 'TICKET' : view === key;
            return (
              <button
                key={key}
                onClick={() => {
                  if (key === 'STUDENT') {
                    const saved = localStorage.getItem('canbadge_token');
                    if (saved) navigateTo('TICKET', saved);
                    else navigateTo('REGISTER');
                  } else {
                    navigateTo(key);
                  }
                }}
                aria-current={active ? 'page' : undefined}
                className={`flex flex-col sm:flex-row items-center justify-center gap-0.5 sm:gap-1.5 py-2 sm:px-4 sm:py-2 sm:rounded-xl text-[11px] sm:text-xs font-bold transition ${
                  active ? 'text-white sm:bg-blue-600' : 'text-slate-400 hover:text-white sm:hover:bg-slate-800'
                }`}
              >
                <Icon className={`w-5 h-5 sm:w-4 sm:h-4 ${active ? 'text-blue-400 sm:text-white' : ''}`} />
                <span className="whitespace-nowrap">{label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
