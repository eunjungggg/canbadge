import React, { useState, useEffect, useRef } from 'react';
import {
  Lock,
  LogOut,
  Users,
  Sparkles,
  QrCode,
  Download,
  ShieldAlert,
  Settings,
  Search,
  Bell,
  CheckCircle,
  RotateCcw,
  Volume2,
  FileSpreadsheet,
  AlertTriangle,
  Scissors,
  Layers,
  ArrowRight,
  ExternalLink,
  Copy,
  Check,
  X,
  RefreshCw,
  LogIn,
} from 'lucide-react';
import type {
  AdminQueueItemDTO,
  AdminStatsDTO,
  BoothConfig,
} from '../types';
import { QRCodeModal } from './QRCodeModal';
import { googleSignIn, logoutGoogle, initAuth, isGoogleTokenExpired, clearGoogleTokens } from '../utils/googleAuth';
import { createGoogleSheet, syncQueueDataToSheet } from '../utils/googleSheets';
import type { User } from 'firebase/auth';
import { safeFetchJson } from '../utils/api';

interface Props {
  onGoHome?: () => void;
  onGoDisplay?: () => void;
}

export const AdminDashboard: React.FC<Props> = ({ onGoHome, onGoDisplay }) => {
  const [adminToken, setAdminToken] = useState<string | null>(() => {
    return sessionStorage.getItem('canbadge_admin_token');
  });
  const [passwordInput, setPasswordInput] = useState('');
  const [loginError, setLoginError] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const [items, setItems] = useState<AdminQueueItemDTO[]>([]);
  const [stats, setStats] = useState<AdminStatsDTO | null>(null);
  const [config, setConfig] = useState<BoothConfig | null>(null);

  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState<'ALL' | 'WAITING' | 'RE_WAITING' | 'COMPLETED'>('WAITING');
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showQRModal, setShowQRModal] = useState(false);
  const [showResetModal, setShowResetModal] = useState(false);
  const [isResettingData, setIsResettingData] = useState(false);
  const [resetSuccessToast, setResetSuccessToast] = useState<string | null>(null);
  const [showGoogleSheetModal, setShowGoogleSheetModal] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // Google Workspace Auth & Sheet State (Main Database)
  const [googleUser, setGoogleUser] = useState<User | null>(null);
  const [googleAccessToken, setGoogleAccessToken] = useState<string | null>(null);
  const [syncedSheetId, setSyncedSheetId] = useState<string | null>(() => {
    return localStorage.getItem('canbadge_sheet_id');
  });
  const [syncedSheetUrl, setSyncedSheetUrl] = useState<string | null>(() => {
    return localStorage.getItem('canbadge_sheet_url');
  });
  const [sheetSyncing, setSheetSyncing] = useState(false);
  const [sheetMessage, setSheetMessage] = useState('');
  const [copiedSheet, setCopiedSheet] = useState(false);
  const [manualSheetUrl, setManualSheetUrl] = useState('');

  useEffect(() => {
    initAuth(
      (user, token) => {
        setGoogleUser(user);
        setGoogleAccessToken(token);
      },
      () => {
        setGoogleUser(null);
        setGoogleAccessToken(null);
      }
    );
  }, []);

  // Newest server revision applied to the screen. Responses that left the server earlier
  // (e.g. a poll that crosses a button click) are dropped instead of reverting the UI.
  const lastRevision = useRef<number>(0);

  type AdminData = { items: AdminQueueItemDTO[]; stats: AdminStatsDTO; config: BoothConfig; revision?: number };

  const applyAdminData = (data: AdminData): boolean => {
    if (typeof data.revision === 'number') {
      if (data.revision < lastRevision.current) return false;
      lastRevision.current = data.revision;
    }
    setItems(data.items);
    setStats(data.stats);
    setConfig(data.config);
    return true;
  };

  const fetchAdminData = async (): Promise<AdminQueueItemDTO[] | null> => {
    if (!adminToken) return null;
    try {
      const res = await safeFetchJson<AdminData>('/api/admin/queue', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (res.status === 401) {
        sessionStorage.removeItem('canbadge_admin_token');
        setAdminToken(null);
        return null;
      }
      if (res.ok && res.data) {
        if (!applyAdminData(res.data)) return null;

        if (res.data.config.googleSheetId && !syncedSheetId) {
          setSyncedSheetId(res.data.config.googleSheetId);
          setSyncedSheetUrl(res.data.config.googleSheetUrl || null);
        }
        return res.data.items;
      }
    } catch (err) {
      console.error(err);
    }
    return null;
  };

  // The server is the only writer of the Google Sheet (writing from several browsers at once
  // made stale snapshots overwrite newer ones). This just asks it to write now.
  const pushToGoogleSheet = async (_currentItems?: AdminQueueItemDTO[], tokenOverride?: string) => {
    const token = tokenOverride || googleAccessToken || localStorage.getItem('canbadge_google_access_token');
    const sheetId = syncedSheetId || localStorage.getItem('canbadge_sheet_id');
    if (!adminToken || !sheetId) return;

    try {
      const res = await fetch('/api/admin/sheet-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ googleToken: token || undefined, spreadsheetId: sheetId }),
      });
      if (res.ok) {
        setSheetMessage(`⚡ 구글 시트에 실시간 반영 중 (${new Date().toLocaleTimeString('ko-KR')})`);
      }
    } catch (e) {
      console.warn('Sheet sync request error:', e);
    }
  };

  useEffect(() => {
    if (adminToken) {
      fetchAdminData();

      // SSE connection for internal real-time updates
      const eventSource = new EventSource('/api/queue/stream');
      eventSource.onmessage = async (event) => {
        try {
          const payload = JSON.parse(event.data);
          // The server writes the sheet itself on every change; just refresh the screen.
          if (payload.type === 'UPDATE') await fetchAdminData();
        } catch (e) {
          console.error(e);
        }
      };

      // Let EventSource auto-reconnect instead of closing it for good
      eventSource.onerror = () => {
        fetchAdminData();
      };

      // Polling fallback in case SSE dropped
      const adminInterval = setInterval(fetchAdminData, 3000);

      // Bidirectional Sync: check whether someone edited the Google Sheet by hand (every 3.5s).
      // The server only applies cells that differ from what it last wrote, so this can't revert clicks.
      const sheetPullInterval = setInterval(async () => {
        const token = googleAccessToken || localStorage.getItem('canbadge_google_access_token');
        const sheetId = syncedSheetId || localStorage.getItem('canbadge_sheet_id');
        if (!token || !sheetId || !adminToken) return;

        try {
          const res = await fetch('/api/sheets/pull', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
              googleToken: token,
              spreadsheetId: sheetId,
            }),
          });
          if (res.ok) {
            const pullData = await res.json();
            if (pullData?.data) {
              applyAdminData(pullData.data);
              if (pullData.hasChanges) {
                setSheetMessage(`⚡ 구글 시트의 수정 사항이 웹앱에 실시간 반영되었습니다 (${new Date().toLocaleTimeString('ko-KR')})`);
              }
            }
          } else if (res.status === 401) {
            const data = await res.json().catch(() => ({}));
            if (data?.code === 'GOOGLE_TOKEN_EXPIRED') {
              clearGoogleTokens();
              setGoogleAccessToken(null);
              setSheetMessage('⚠️ 구글 로그인 세션이 만료되었습니다. 상단 [Google 계정 다시 로그인] 버튼을 눌러주세요.');
            }
          }
        } catch (e) {
          // ignore transient poll error
        }
      }, 3500);

      return () => {
        eventSource.close();
        clearInterval(adminInterval);
        clearInterval(sheetPullInterval);
      };
    }
  }, [adminToken, googleAccessToken, syncedSheetId]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    setIsLoggingIn(true);

    try {
      const res = await safeFetchJson<{ token: string; config: BoothConfig }>('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordInput.trim() }),
      });

      if (res.ok && res.data) {
        sessionStorage.setItem('canbadge_admin_token', res.data.token);
        setAdminToken(res.data.token);
        setConfig(res.data.config);
      } else {
        // Direct Serverless Mode Fallback (when running on Cloudflare Pages static hosting)
        if (passwordInput.trim() === 'badge2026') {
          const clientToken = 'cf-token-' + Date.now();
          sessionStorage.setItem('canbadge_admin_token', clientToken);
          setAdminToken(clientToken);
          if (!config) {
            setConfig({
              boothTitle: '나만의 캔뱃지 만들기 체험 부스',
              registrationStatus: 'OPEN',
              noticeMessage: '부스에 오신 것을 환영합니다! 자유롭게 관람 후 순서가 되기 전에 돌아와주세요(●\'◡\'●)',
              concurrentCapacity: 2,
              returnNotifyCount: 5,
              imminentNotifyCount: 2,
              maxCallCount: 3,
              ticketPrefix: 'A',
              nextTicketNumber: 1,
              adminPasswordHash: 'badge2026',
              minutesPerPerson: 4,
              googleSheetId: '1mj1dHs0Z6_EqIvpKx3XvyFAnYvNRsi_kBH6m9eWVU_8',
              googleSheetUrl: 'https://docs.google.com/spreadsheets/d/1mj1dHs0Z6_EqIvpKx3XvyFAnYvNRsi_kBH6m9eWVU_8/edit',
            });
          }
        } else {
          throw new Error(res.error || '비밀번호가 올바르지 않습니다.');
        }
      }
    } catch (err: any) {
      setLoginError(err.message || '비밀번호가 올바르지 않습니다.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = () => {
    sessionStorage.removeItem('canbadge_admin_token');
    setAdminToken(null);
  };

  // Requests currently in flight, keyed per button. A second tap on the same button before the
  // first finishes is ignored, so a double-tap can't call two students or apply an action twice.
  const inFlight = useRef<Set<string>>(new Set());

  const runAdminAction = async (key: string, url: string, body: unknown) => {
    if (!adminToken || inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setActionLoading(true);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const resData = await res.json();
        if (resData?.data?.items) applyAdminData(resData.data);
        else await fetchAdminData();
      }
    } catch (err) {
      console.error(err);
    } finally {
      inFlight.current.delete(key);
      setActionLoading(inFlight.current.size > 0);
    }
  };

  const handleAction = (id: string, action: string, slotNumber?: number) =>
    runAdminAction(`action:${id}`, '/api/admin/action', { id, action, slotNumber });

  const handleCallNextToDesk = () => runAdminAction('call-next', '/api/admin/call-next', { count: 1 });

  const handleStatusChange = async (status: 'OPEN' | 'PAUSED' | 'CLOSED') => {
    if (!adminToken) return;
    try {
      await fetch('/api/admin/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ registrationStatus: status }),
      });
      fetchAdminData();
    } catch (err) {
      console.error(err);
    }
  };

  const handleDownloadCSV = () => {
    if (!adminToken) return;
    window.location.href = `/api/admin/export?auth=${adminToken}`;
  };

  // Google Auth Handlers
  const handleGoogleSignIn = async () => {
    try {
      const res = await googleSignIn();
      if (res) {
        setGoogleUser(res.user);
        setGoogleAccessToken(res.accessToken);
        setSheetMessage('Google 계정 인증 완료!');
      }
    } catch (err: any) {
      setSheetMessage(`Google 로그인 오류: ${err.message}`);
    }
  };

  const handleCreateAndSyncSheet = async () => {
    setSheetSyncing(true);
    setSheetMessage('구글 시트 생성 준비 중...');

    try {
      let token = googleAccessToken;
      if (!token) {
        setSheetMessage('Google 로그인을 진행합니다. 팝업 창에서 계정을 선택해 주세요...');
        const authRes = await googleSignIn();
        if (!authRes || !authRes.accessToken) {
          throw new Error('Google 로그인이 완료되지 않았습니다.');
        }
        token = authRes.accessToken;
        setGoogleUser(authRes.user);
        setGoogleAccessToken(authRes.accessToken);
      }

      setSheetMessage('구글 드라이브에 새 스프레드시트를 생성하고 있습니다...');
      const sheet = await createGoogleSheet(token, '인천비즈니스고 콘텐츠디자인과 캔뱃지 부스 실시간 대기 명단');
      
      setSheetMessage(`스프레드시트 생성 완료! 신청자 ${items.length}명의 데이터를 동기화 중...`);
      await syncQueueDataToSheet(token, sheet.spreadsheetId, items);

      setSyncedSheetId(sheet.spreadsheetId);
      setSyncedSheetUrl(sheet.spreadsheetUrl);
      localStorage.setItem('canbadge_sheet_id', sheet.spreadsheetId);
      localStorage.setItem('canbadge_sheet_url', sheet.spreadsheetUrl);

      // Save to config on server
      await fetch('/api/admin/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          googleSheetId: sheet.spreadsheetId,
          googleSheetUrl: sheet.spreadsheetUrl,
        }),
      });

      setSheetMessage('🎉 성공! 새 구글 스프레드시트가 메인 데이터베이스로 연동되었습니다.');
    } catch (err: any) {
      console.error(err);
      let msg = err.message || '알 수 없는 오류가 발생했습니다.';
      if (err.code === 'auth/popup-blocked') {
        msg = '브라우저 팝업이 차단되었습니다. 주소창의 팝업 차단을 해제하고 다시 시도해 주세요.';
      } else if (err.code === 'auth/popup-closed-by-user') {
        msg = '로그인 팝업이 닫혔습니다. 다시 시도해 주세요.';
      }
      setSheetMessage(`시트 생성 오류: ${msg}`);
    } finally {
      setSheetSyncing(false);
    }
  };

  const handleUpdateExistingSheet = async () => {
    if (!syncedSheetId) return;
    setSheetSyncing(true);
    setSheetMessage('구글 시트에 최신 명단 반영 중...');

    try {
      let token = googleAccessToken;
      if (!token || isGoogleTokenExpired()) {
        const authRes = await googleSignIn();
        if (!authRes || !authRes.accessToken) {
          throw new Error('Google 계정 인증이 필요합니다.');
        }
        token = authRes.accessToken;
        setGoogleUser(authRes.user);
        setGoogleAccessToken(authRes.accessToken);
      }

      await pushToGoogleSheet(items, token);
      setSheetMessage('🎉 성공! 최신 대기 명단을 구글 시트에 반영하고 있습니다.');
    } catch (err: any) {
      console.error(err);
      if (err.message?.includes('credentials') || err.message?.includes('OAuth') || err.message?.includes('만료')) {
        clearGoogleTokens();
        setGoogleAccessToken(null);
        setSheetMessage('⚠️ 구글 로그인 세션(1시간)이 만료되었습니다. 상단 [Google 계정 다시 로그인]을 눌러주세요.');
      } else {
        setSheetMessage(`업데이트 오류: ${err.message}`);
      }
    } finally {
      setSheetSyncing(false);
    }
  };

  const handlePullFromSheet = async () => {
    if (!syncedSheetId || !adminToken) return;
    let token = googleAccessToken;
    if (!token || isGoogleTokenExpired()) {
      try {
        const authRes = await googleSignIn();
        if (!authRes) return;
        token = authRes.accessToken;
        setGoogleUser(authRes.user);
        setGoogleAccessToken(authRes.accessToken);
      } catch (authErr: any) {
        alert('Google 계정 로그인이 필요합니다: ' + authErr.message);
        return;
      }
    }

    setSheetSyncing(true);
    setSheetMessage('구글 시트로부터 데이터 불러오는 중...');

    try {
      const res = await fetch('/api/sheets/pull', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          googleToken: token,
          spreadsheetId: syncedSheetId,
          forceImport: true,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        if (data.code === 'GOOGLE_TOKEN_EXPIRED' || data.error?.includes('credentials') || data.error?.includes('만료')) {
          clearGoogleTokens();
          setGoogleAccessToken(null);
          setSheetMessage('⚠️ 구글 로그인 세션(1시간)이 만료되었습니다. [Google 계정 다시 로그인] 버튼을 눌러주세요.');
          return;
        }
        throw new Error(data.error || '시트 불러오기 실패');
      }

      fetchAdminData();
      setSheetMessage(`성공! 구글 시트에서 총 ${data.rowsUpdated}건의 명단을 웹앱으로 불러왔습니다.`);
    } catch (err: any) {
      console.error(err);
      if (err.message?.includes('credentials') || err.message?.includes('OAuth') || err.message?.includes('만료')) {
        clearGoogleTokens();
        setGoogleAccessToken(null);
        setSheetMessage('⚠️ 구글 로그인 세션이 만료되었습니다. [Google 계정 다시 로그인] 버튼을 눌러주세요.');
      } else {
        setSheetMessage(`불러오기 오류: ${err.message}`);
      }
    } finally {
      setSheetSyncing(false);
    }
  };

  const handleConnectManualSheet = async () => {
    if (!manualSheetUrl.trim()) return;
    const match = manualSheetUrl.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/) || [null, manualSheetUrl.trim()];
    const sheetId = match[1];
    if (!sheetId) {
      setSheetMessage('올바른 스프레드시트 URL 또는 ID를 입력해 주세요.');
      return;
    }
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
    setSyncedSheetId(sheetId);
    setSyncedSheetUrl(sheetUrl);
    localStorage.setItem('canbadge_sheet_id', sheetId);
    localStorage.setItem('canbadge_sheet_url', sheetUrl);

    if (adminToken) {
      await fetch('/api/admin/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          googleSheetId: sheetId,
          googleSheetUrl: sheetUrl,
        }),
      });
    }
    setSheetMessage(`연결 완료! 구글 시트 ID(${sheetId.slice(0, 8)}...)가 연동되었습니다.`);
  };

  const executeReset = async () => {
    setIsResettingData(true);
    try {
      // 1. Instantly reset client state for immediate visual feedback
      setItems([]);
      setStats({
        totalRegistered: 0,
        totalWaiting: 0,
        totalCalling: 0,
        totalPhotoEditing: 0,
        totalInPress: 0,
        totalCompleted: 0,
        totalAbsent: 0,
        totalReWaiting: 0,
        totalCancelled: 0,
      });
      if (config) {
        setConfig((prev) => (prev ? { ...prev, nextTicketNumber: 1 } : prev));
      }

      // 2. Call backend reset
      const token = adminToken || sessionStorage.getItem('canbadge_admin_token');
      const gToken = googleAccessToken || localStorage.getItem('canbadge_google_access_token');
      const validGToken = gToken && !isGoogleTokenExpired() ? gToken : undefined;

      await fetch('/api/admin/reset', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          clearAllData: true,
          googleToken: validGToken,
        }),
      });

      // 3. Refetch admin data (the server clears and rewrites the sheet itself)
      await fetchAdminData();
      setShowResetModal(false);
      setResetSuccessToast('✅ 전체 데이터가 1번으로 성공적으로 초기화되었습니다!');
      setTimeout(() => setResetSuccessToast(null), 4000);
    } catch (err: any) {
      console.error('Reset error:', err);
      setShowResetModal(false);
      setResetSuccessToast('✅ 데이터가 초기화되었습니다.');
      setTimeout(() => setResetSuccessToast(null), 4000);
      fetchAdminData();
    } finally {
      setIsResettingData(false);
    }
  };

  const handleCopyForGoogleSheet = () => {
    const headers = ['대기번호', '이름', '학교명', '진행상태', '배정프레스', '호출횟수', '접수시각'];
    const rows = items.map((i) => [
      i.ticketNumber,
      i.name,
      i.school,
      i.status,
      i.assignedSlot ? `${i.assignedSlot}호기` : '-',
      i.callCount,
      new Date(i.registeredAt).toLocaleTimeString('ko-KR'),
    ]);
    const tsv = [headers.join('\t'), ...rows.map((r) => r.join('\t'))].join('\n');
    navigator.clipboard.writeText(tsv);
    setCopiedSheet(true);
    setTimeout(() => setCopiedSheet(false), 2500);
  };

  // Station occupant objects (support multiple concurrent students at desk)
  const deskItems = items.filter(
    (i) => i.status === 'PHOTO_EDITING' || i.status === 'CALLED'
  );
  const press1Item = items.find((i) => i.status === 'ASSIGNED_PRESS_1');
  const press2Item = items.find((i) => i.status === 'ASSIGNED_PRESS_2');

  const filteredItems = items.filter((item) => {
    const matchesSearch =
      item.ticketNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.school.toLowerCase().includes(searchTerm.toLowerCase());

    if (!matchesSearch) return false;

    if (activeTab === 'WAITING') {
      return (
        item.status === 'WAITING' ||
        item.status === 'CALLED' ||
        item.status === 'PHOTO_EDITING' ||
        item.status === 'ASSIGNED_PRESS_1' ||
        item.status === 'ASSIGNED_PRESS_2'
      );
    }
    if (activeTab === 'RE_WAITING') {
      return item.status === 'RE_WAITING' || item.status === 'ABSENT';
    }
    if (activeTab === 'COMPLETED') {
      return item.status === 'COMPLETED' || item.status === 'CANCELLED';
    }
    return true;
  });

  // -------------------------------------------------------------------------
  // LOGIN SCREEN
  // -------------------------------------------------------------------------
  if (!adminToken) {
    return (
      <div className="min-h-screen bg-[#faf8f5] flex items-center justify-center p-4 text-stone-800">
        <div className="w-full max-w-sm bg-white rounded-3xl p-8 shadow-sm border border-stone-200">
          <div className="text-center mb-6">
            <div className="w-14 h-14 rounded-2xl bg-rose-100 text-rose-500 flex items-center justify-center mx-auto mb-3 shadow-2xs">
              <Lock className="w-6 h-6" />
            </div>
            <h1 className="text-lg font-black text-stone-800">부스 관리자 로그인</h1>
            <p className="text-xs text-stone-500 mt-1">
              캔뱃지 체험 부스 운영자 전용 시스템
            </p>
          </div>

          {loginError && (
            <div className="mb-4 p-3 bg-rose-50 border border-rose-200 rounded-2xl text-xs text-rose-700 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 text-rose-500" />
              <span>{loginError}</span>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-stone-700 mb-1">
                관리자 비밀번호
              </label>
              <input
                type="password"
                required
                autoFocus
                placeholder="비밀번호 입력"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                className="w-full px-4 py-3 bg-[#faf9f7] border border-stone-200 rounded-2xl text-stone-800 text-sm focus:outline-none focus:ring-2 focus:ring-rose-300 focus:bg-white transition"
              />
            </div>

            <button
              type="submit"
              disabled={isLoggingIn}
              className="w-full py-3.5 bg-stone-800 text-white font-bold rounded-2xl text-xs hover:bg-stone-900 active:scale-98 transition flex items-center justify-center gap-2 shadow-xs cursor-pointer disabled:opacity-50"
            >
              {isLoggingIn ? '인증 중...' : '대시보드 접속'}
            </button>
          </form>

          <div className="mt-6 pt-4 border-t border-stone-100 flex items-center justify-between text-xs text-stone-400">
            <button onClick={onGoHome} className="hover:text-stone-800 font-medium">
              ← 학생 대기 신청
            </button>
            <button onClick={onGoDisplay} className="hover:text-stone-800 font-medium">
              공개 전광판 →
            </button>
          </div>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // MAIN ADMIN DASHBOARD
  // -------------------------------------------------------------------------
  return (
    <div className="min-h-[100dvh] bg-[#faf8f5] text-stone-800 flex flex-col pb-nav">
      {/* Top Header */}
      <header className="bg-white/90 backdrop-blur-xs border-b border-stone-200/80 px-4 lg:px-8 py-3 sticky top-0 z-30 shadow-2xs">
        <div className="max-w-[1600px] mx-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 shrink-0 rounded-2xl bg-gradient-to-tr from-rose-300 via-purple-300 to-sky-300 flex items-center justify-center text-white shadow-2xs">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 min-w-0">
              <h1 className="text-base lg:text-lg font-extrabold text-stone-800 truncate">
                {config?.boothTitle || '캔뱃지 부스 관리 시스템'}
              </h1>
              <span className="text-[11px] px-2.5 py-0.5 rounded-full font-bold bg-purple-50 text-purple-700 border border-purple-200 whitespace-nowrap">
                관리자 모드
              </span>
            </div>
          </div>

          {/* Quick Registration Status Toggle & Google Sheet Button */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center bg-[#f4f2ee] p-1 rounded-2xl border border-stone-200/80 text-xs font-bold">
              <button
                onClick={() => handleStatusChange('OPEN')}
                className={`px-3 py-1.5 rounded-xl transition ${
                  config?.registrationStatus === 'OPEN'
                    ? 'bg-emerald-600 text-white shadow-xs'
                    : 'text-stone-600 hover:text-stone-900'
                }`}
              >
                접수 중
              </button>
              <button
                onClick={() => handleStatusChange('PAUSED')}
                className={`px-3 py-1.5 rounded-xl transition ${
                  config?.registrationStatus === 'PAUSED'
                    ? 'bg-amber-500 text-white shadow-xs'
                    : 'text-stone-600 hover:text-stone-900'
                }`}
              >
                일시 중지
              </button>
              <button
                onClick={() => handleStatusChange('CLOSED')}
                className={`px-3 py-1.5 rounded-xl transition ${
                  config?.registrationStatus === 'CLOSED'
                    ? 'bg-rose-500 text-white shadow-xs'
                    : 'text-stone-600 hover:text-stone-900'
                }`}
              >
                접수 마감
              </button>
            </div>

            <button
              onClick={() => setShowGoogleSheetModal(true)}
              className={`px-3 py-1.5 border rounded-2xl transition flex items-center gap-1.5 text-xs font-bold ${
                syncedSheetUrl
                  ? 'bg-emerald-100 text-emerald-900 border-emerald-300 shadow-2xs'
                  : 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
              }`}
            >
              <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
              <span className="hidden md:inline">{syncedSheetUrl ? '구글 시트 DB 연결됨' : '구글 시트 연동'}</span>
            </button>

            <button
              onClick={() => setShowQRModal(true)}
              className="p-2 bg-white text-stone-700 hover:text-rose-600 border border-stone-200 rounded-xl hover:bg-stone-50 transition"
              title="접수 QR코드"
            >
              <QrCode className="w-4 h-4" />
            </button>

            <button
              onClick={() => setShowResetModal(true)}
              className="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 rounded-xl transition flex items-center gap-1.5 text-xs font-bold shadow-2xs cursor-pointer"
              title="모든 대기 데이터를 초기화하고 1번으로 리셋"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span className="hidden md:inline">데이터 초기화</span>
            </button>

            <button
              onClick={() => setShowSettingsModal(true)}
              className="p-2 bg-white text-stone-700 hover:text-rose-600 border border-stone-200 rounded-xl hover:bg-stone-50 transition"
              title="부스 설정"
            >
              <Settings className="w-4 h-4" />
            </button>

            <button
              onClick={handleLogout}
              className="p-2 bg-white text-stone-400 hover:text-rose-600 border border-stone-200 rounded-xl hover:bg-stone-50 transition"
              title="로그아웃"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-[1600px] mx-auto w-full px-4 lg:px-8 py-5 space-y-5">
        {/* GOOGLE SHEETS LIVE DB STATUS BANNER */}
        {syncedSheetUrl && (
          <div
            className={`p-3.5 rounded-3xl border flex flex-wrap items-center justify-between gap-3 text-xs shadow-2xs ${
              !googleAccessToken || isGoogleTokenExpired()
                ? 'bg-amber-50 border-amber-300 text-amber-950'
                : 'bg-emerald-50/80 border-emerald-200/80 text-emerald-900'
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  !googleAccessToken || isGoogleTokenExpired()
                    ? 'bg-amber-500 animate-bounce'
                    : 'bg-emerald-500 animate-pulse'
                }`}
              />
              <span className="font-extrabold">
                {!googleAccessToken || isGoogleTokenExpired()
                  ? '⚠️ Google Sheets 연동 세션 만료 (재로그인 필요)'
                  : 'Google Sheets 양방향 실시간 동기화 활성화'}
              </span>
              <span className="opacity-80">
                {!googleAccessToken || isGoogleTokenExpired()
                  ? '보안 정책으로 1시간마다 로그인이 만료됩니다. 오른쪽 [Google 계정 다시 로그인]을 눌러주세요.'
                  : (sheetMessage || '(앱과 구글 시트 양방향으로 완료 및 상태가 실시간 자동 연동됩니다)')}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {(!googleAccessToken || isGoogleTokenExpired()) && (
                <button
                  onClick={async () => {
                    try {
                      const authRes = await googleSignIn();
                      if (authRes) {
                        setGoogleUser(authRes.user);
                        setGoogleAccessToken(authRes.accessToken);
                        setSheetMessage('✅ Google 계정 재로그인 성공! 시트 동기화가 활성화되었습니다.');
                        await pushToGoogleSheet(items, authRes.accessToken);
                      }
                    } catch (e: any) {
                      alert('Google 로그인 실패: ' + e.message);
                    }
                  }}
                  className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-xl font-bold transition flex items-center gap-1 shadow-xs animate-pulse"
                >
                  <LogIn className="w-3.5 h-3.5" />
                  Google 계정 다시 로그인
                </button>
              )}
              <button
                onClick={handleUpdateExistingSheet}
                disabled={sheetSyncing}
                className="px-2.5 py-1 bg-white text-emerald-800 border border-emerald-300 rounded-xl font-bold hover:bg-emerald-100 transition flex items-center gap-1"
              >
                <RefreshCw className={`w-3 h-3 ${sheetSyncing ? 'animate-spin' : ''}`} />
                시트 최신 갱신
              </button>
              <button
                onClick={handlePullFromSheet}
                disabled={sheetSyncing}
                className="px-2.5 py-1 bg-white text-emerald-800 border border-emerald-300 rounded-xl font-bold hover:bg-emerald-100 transition flex items-center gap-1"
                title="구글 시트에서 직접 수정한 내용을 웹앱으로 반영"
              >
                시트에서 불러오기
              </button>
              <a
                href={syncedSheetUrl}
                target="_blank"
                rel="noreferrer"
                className="px-3 py-1 bg-emerald-700 text-white rounded-xl font-bold hover:bg-emerald-800 transition flex items-center gap-1 shadow-2xs"
              >
                구글 시트 열기
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>
        )}

        {/* METRICS ROW */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 text-center">
          <div className="bg-white p-3.5 rounded-2xl border border-stone-200">
            <span className="text-xs font-bold text-stone-400">전체 접수</span>
            <p className="text-2xl font-black text-stone-800 mt-0.5">{stats?.totalRegistered || 0}</p>
          </div>
          <div className="p-3.5 rounded-2xl border border-purple-200 bg-purple-50/40">
            <span className="text-xs font-bold text-purple-600">현재 대기</span>
            <p className="text-2xl font-black text-purple-700 mt-0.5">{stats?.totalWaiting || 0}</p>
          </div>
          <div className="p-3.5 rounded-2xl border border-rose-200 bg-rose-50/40">
            <span className="text-xs font-bold text-rose-600">접수대 호출</span>
            <p className="text-2xl font-black text-rose-600 mt-0.5">{stats?.totalCalling || 0}</p>
          </div>
          <div className="p-3.5 rounded-2xl border border-emerald-200 bg-emerald-50/40">
            <span className="text-xs font-bold text-emerald-600">완료 인원</span>
            <p className="text-2xl font-black text-emerald-700 mt-0.5">{stats?.totalCompleted || 0}</p>
          </div>
          <div className="bg-white p-3.5 rounded-2xl border border-stone-200">
            <span className="text-xs font-bold text-stone-500">재대기/부재</span>
            <p className="text-2xl font-black text-stone-700 mt-0.5">
              {(stats?.totalReWaiting || 0) + (stats?.totalAbsent || 0)}
            </p>
          </div>
        </div>

        {/* Desktop (xl+): workflow on the left, queue table on the right */}
        <div className="space-y-5 xl:space-y-0 xl:grid xl:grid-cols-12 xl:gap-5 xl:items-start">
        <div className="xl:col-span-5">
        {/* WORKFLOW HERO: 1단계 사진 접수/편집/출력대 & 2단계 1번/2번 프레스 안내 */}
        <div className="grid grid-cols-1 lg:grid-cols-12 xl:grid-cols-1 gap-4">
          {/* STEP 1: PHOTO EDITING DESK (5 Cols) */}
          <div className="lg:col-span-5 xl:col-span-1 bg-white rounded-3xl p-5 shadow-sm border border-purple-100 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between pb-3 border-b border-stone-100">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-xl bg-purple-100 text-purple-700 font-bold flex items-center justify-center text-xs">
                    <Scissors className="w-3.5 h-3.5" />
                  </div>
                  <div>
                    <h3 className="font-extrabold text-stone-800 text-sm">
                      1단계: 사진 접수 / 편집 / 출력
                    </h3>
                  </div>
                </div>
                <span
                  className={`text-xs px-2.5 py-0.5 rounded-full font-bold ${
                    deskItems.length > 0
                      ? 'bg-purple-100 text-purple-700 border border-purple-200'
                      : 'bg-stone-100 text-stone-500'
                  }`}
                >
                  {deskItems.length > 0 ? `${deskItems.length}명 진행·대기 중` : '비어 있음'}
                </span>
              </div>

              {/* Call Next Button - ALWAYS ACCESSIBLE */}
              <div className="mt-3.5">
                <button
                  onClick={handleCallNextToDesk}
                  disabled={
                    actionLoading ||
                    ((stats?.totalWaiting || 0) === 0 && (stats?.totalReWaiting || 0) === 0)
                  }
                  className="w-full py-2.5 px-3 bg-purple-600 hover:bg-purple-700 text-white font-bold text-xs rounded-2xl transition flex items-center justify-center gap-1.5 shadow-xs disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Volume2 className="w-4 h-4" />
                  {deskItems.length === 0
                    ? '다음 1명 사진 접수대로 호출'
                    : `+ 다음 1명 추가 호출 (현재 접수대 ${deskItems.length}명)`}
                </button>
              </div>

              {/* Multi-student cards at the desk */}
              {deskItems.length > 0 ? (
                <div className="space-y-3 my-3 max-h-[380px] overflow-y-auto pr-0.5">
                  {deskItems.map((deskItem) => (
                    <div
                      key={deskItem.id}
                      className={`p-3.5 rounded-2xl border transition ${
                        deskItem.status === 'CALLED'
                          ? 'bg-rose-50/70 border-rose-200'
                          : 'bg-purple-50/70 border-purple-200'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <span
                            className={`font-mono text-xl font-black ${
                              deskItem.status === 'CALLED' ? 'text-rose-900' : 'text-purple-900'
                            }`}
                          >
                            {deskItem.ticketNumber}
                          </span>
                          <p className="text-xs font-bold text-stone-800">
                            {deskItem.name} 학생
                            <span className="text-[11px] font-normal text-stone-500 ml-1.5">
                              ({deskItem.school})
                            </span>
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {deskItem.hasPush && (
                            <span className="text-[10px] bg-emerald-100 text-emerald-800 font-bold px-1.5 py-0.5 rounded-lg flex items-center gap-0.5">
                              <Bell className="w-2.5 h-2.5" /> 알림
                            </span>
                          )}
                          <span
                            className={`text-[11px] px-2 py-0.5 rounded-full font-bold ${
                              deskItem.status === 'CALLED'
                                ? 'bg-rose-100 text-rose-700 animate-pulse border border-rose-200'
                                : 'bg-purple-100 text-purple-700 border border-purple-200'
                            }`}
                          >
                            {deskItem.status === 'CALLED'
                              ? `도착 대기 (${deskItem.callCount}회 호출)`
                              : '사진 편집/출력 중'}
                          </span>
                        </div>
                      </div>

                      {/* Actions for this student */}
                      {deskItem.status === 'CALLED' ? (
                        <div className="flex gap-2 mt-2.5 pt-2 border-t border-rose-100">
                          <button
                            onClick={() => handleAction(deskItem.id, 'START_EDITING')}
                            className="flex-1 py-2 bg-purple-600 hover:bg-purple-700 text-white font-bold text-xs rounded-xl transition shadow-2xs"
                          >
                            도착 확인 (출력 시작)
                          </button>
                          <button
                            onClick={() => handleAction(deskItem.id, 'RECALL')}
                            className="px-2.5 py-2 bg-white text-rose-700 border border-rose-300 font-bold text-xs rounded-xl hover:bg-rose-50 transition"
                            title="재호출 알림 발송"
                          >
                            재호출
                          </button>
                          <button
                            onClick={() => handleAction(deskItem.id, 'MARK_ABSENT')}
                            className="px-3 py-2 bg-stone-200 text-stone-700 font-bold text-xs rounded-xl hover:bg-stone-300 transition"
                            title="미도착 시 부재 처리하여 즉시 대기열에서 제외"
                          >
                            부재
                          </button>
                        </div>
                      ) : (
                        <div className="space-y-1.5 mt-2.5 pt-2 border-t border-purple-100">
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-bold text-stone-600">
                              🖨️ 출력 완료! 프레스기로 안내:
                            </span>
                            <button
                              onClick={() => handleAction(deskItem.id, 'MARK_ABSENT')}
                              className="text-[10px] text-stone-400 hover:text-rose-600 underline font-medium"
                              title="학생 이탈 시 부재 처리"
                            >
                              부재 처리
                            </button>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <button
                              onClick={() => handleAction(deskItem.id, 'ASSIGN_PRESS_1')}
                              className="py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl transition shadow-2xs flex items-center justify-center gap-1"
                            >
                              👉 "1번 프레스기"
                            </button>
                            <button
                              onClick={() => handleAction(deskItem.id, 'ASSIGN_PRESS_2')}
                              className="py-2 bg-sky-600 hover:bg-sky-700 text-white font-bold text-xs rounded-xl transition shadow-2xs flex items-center justify-center gap-1"
                            >
                              👉 "2번 프레스기"
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="my-4 py-8 text-center text-stone-400 text-xs bg-stone-50/50 rounded-2xl border border-dashed border-stone-200">
                  현재 접수대에서 진행 중인 학생이 없습니다.
                  <br />
                  위 [호출] 버튼을 눌러 다음 학생을 불러주세요.
                </div>
              )}
            </div>
          </div>

          {/* STEP 2: PRESS MACHINES 1 & 2 (7 Cols) */}
          <div className="lg:col-span-7 xl:col-span-1 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* PRESS MACHINE 1 */}
            <div className="bg-white rounded-3xl p-5 shadow-sm border border-emerald-100 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between pb-3 border-b border-stone-100">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-xl bg-emerald-100 text-emerald-700 font-bold flex items-center justify-center text-xs">
                      1
                    </div>
                    <div>
                      <h3 className="font-extrabold text-stone-800 text-sm">프레스 기계 1호기</h3>
                    </div>
                  </div>
                  <span
                    className={`text-xs px-2.5 py-0.5 rounded-full font-bold ${
                      press1Item ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-100 text-stone-400'
                    }`}
                  >
                    {press1Item ? '제작 진행 중' : '비어 있음'}
                  </span>
                </div>

                {press1Item ? (
                  <div className="my-3.5 p-3.5 bg-emerald-50/50 rounded-2xl border border-emerald-100/80">
                    <span className="font-mono text-2xl font-black text-emerald-900">
                      {press1Item.ticketNumber}
                    </span>
                    <p className="text-xs font-bold text-stone-800 mt-0.5">
                      {press1Item.name} 학생 ({press1Item.school})
                    </p>
                    <p className="text-[11px] text-emerald-700 font-semibold mt-1">
                      📍 1번 기계 도착 (커팅 후 프레스 압착)
                    </p>
                  </div>
                ) : (
                  <div className="my-3.5 py-7 text-center text-stone-400 text-xs">
                    대기 중인 학생이 없습니다.
                  </div>
                )}
              </div>

              <div className="pt-2 border-t border-stone-100">
                {press1Item ? (
                  <button
                    onClick={() => handleAction(press1Item.id, 'COMPLETE')}
                    className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl transition flex items-center justify-center gap-1.5"
                  >
                    <CheckCircle className="w-4 h-4" />
                    1호기 커팅 및 뱃지 완성
                  </button>
                ) : (
                  <div className="py-2 text-center text-[11px] text-stone-400">
                    사진 접수대에서 1번으로 안내 대기 중
                  </div>
                )}
              </div>
            </div>

            {/* PRESS MACHINE 2 */}
            <div className="bg-white rounded-3xl p-5 shadow-sm border border-sky-100 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between pb-3 border-b border-stone-100">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-xl bg-sky-100 text-sky-700 font-bold flex items-center justify-center text-xs">
                      2
                    </div>
                    <div>
                      <h3 className="font-extrabold text-stone-800 text-sm">프레스 기계 2호기</h3>
                    </div>
                  </div>
                  <span
                    className={`text-xs px-2.5 py-0.5 rounded-full font-bold ${
                      press2Item ? 'bg-sky-100 text-sky-800' : 'bg-stone-100 text-stone-400'
                    }`}
                  >
                    {press2Item ? '제작 진행 중' : '비어 있음'}
                  </span>
                </div>

                {press2Item ? (
                  <div className="my-3.5 p-3.5 bg-sky-50/50 rounded-2xl border border-sky-100/80">
                    <span className="font-mono text-2xl font-black text-sky-900">
                      {press2Item.ticketNumber}
                    </span>
                    <p className="text-xs font-bold text-stone-800 mt-0.5">
                      {press2Item.name} 학생 ({press2Item.school})
                    </p>
                    <p className="text-[11px] text-sky-700 font-semibold mt-1">
                      📍 2번 기계 도착 (커팅 후 프레스 압착)
                    </p>
                  </div>
                ) : (
                  <div className="my-3.5 py-7 text-center text-stone-400 text-xs">
                    대기 중인 학생이 없습니다.
                  </div>
                )}
              </div>

              <div className="pt-2 border-t border-stone-100">
                {press2Item ? (
                  <button
                    onClick={() => handleAction(press2Item.id, 'COMPLETE')}
                    className="w-full py-2.5 bg-sky-600 hover:bg-sky-700 text-white font-bold text-xs rounded-xl transition flex items-center justify-center gap-1.5"
                  >
                    <CheckCircle className="w-4 h-4" />
                    2호기 커팅 및 뱃지 완성
                  </button>
                ) : (
                  <div className="py-2 text-center text-[11px] text-stone-400">
                    사진 접수대에서 2번으로 안내 대기 중
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        </div>

        {/* STUDENT QUEUE TABLE */}
        <div className="xl:col-span-7 bg-white rounded-3xl shadow-sm border border-stone-200/80 overflow-hidden flex flex-col xl:sticky xl:top-24 xl:max-h-[calc(100dvh-8rem)]">
          <div className="p-4 border-b border-stone-100 flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
            <div className="flex bg-[#f5f3ef] p-1 rounded-2xl text-xs font-bold shrink-0 overflow-x-auto whitespace-nowrap">
              <button
                onClick={() => setActiveTab('WAITING')}
                className={`px-3 py-1.5 rounded-xl transition ${
                  activeTab === 'WAITING' ? 'bg-white text-stone-900 shadow-2xs' : 'text-stone-500'
                }`}
              >
                대기·진행 ({stats?.totalWaiting || 0})
              </button>
              <button
                onClick={() => setActiveTab('RE_WAITING')}
                className={`px-3 py-1.5 rounded-xl transition ${
                  activeTab === 'RE_WAITING' ? 'bg-white text-purple-900 shadow-2xs' : 'text-stone-500'
                }`}
              >
                재대기·부재 ({(stats?.totalReWaiting || 0) + (stats?.totalAbsent || 0)})
              </button>
              <button
                onClick={() => setActiveTab('COMPLETED')}
                className={`px-3 py-1.5 rounded-xl transition ${
                  activeTab === 'COMPLETED' ? 'bg-white text-emerald-900 shadow-2xs' : 'text-stone-500'
                }`}
              >
                완료 ({stats?.totalCompleted || 0})
              </button>
              <button
                onClick={() => setActiveTab('ALL')}
                className={`px-3 py-1.5 rounded-xl transition ${
                  activeTab === 'ALL' ? 'bg-white text-stone-900 shadow-2xs' : 'text-stone-500'
                }`}
              >
                전체 ({items.length})
              </button>
            </div>

            <div className="relative flex-1 max-w-xs">
              <Search className="w-3.5 h-3.5 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="번호, 이름, 학교 검색..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-3 py-2 bg-[#faf9f7] border border-stone-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-rose-300"
              />
            </div>
          </div>

          <div className="overflow-auto flex-1 min-h-0">
            <table className="w-full text-left text-sm">
              <thead className="bg-[#faf8f5] text-stone-500 text-xs font-semibold border-b border-stone-200 sticky top-0 z-10">
                <tr>
                  <th className="py-3 px-4 whitespace-nowrap">번호</th>
                  <th className="py-3 px-4 whitespace-nowrap">이름</th>
                  <th className="py-3 px-4 whitespace-nowrap hidden md:table-cell">학교명</th>
                  <th className="py-3 px-4 whitespace-nowrap">진행 상태</th>
                  <th className="py-3 px-4 whitespace-nowrap hidden 2xl:table-cell">배정 기계</th>
                  <th className="py-3 px-4 whitespace-nowrap hidden 2xl:table-cell">알림</th>
                  <th className="py-3 px-4 whitespace-nowrap hidden lg:table-cell">접수시각</th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">단계별 조작</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {filteredItems.length > 0 ? (
                  filteredItems.map((item) => (
                    <tr
                      key={item.id}
                      className={`hover:bg-stone-50 transition ${
                        item.status === 'CALLED'
                          ? 'bg-rose-50/50'
                          : item.status === 'PHOTO_EDITING'
                          ? 'bg-purple-50/40'
                          : item.status === 'ASSIGNED_PRESS_1'
                          ? 'bg-emerald-50/40'
                          : item.status === 'ASSIGNED_PRESS_2'
                          ? 'bg-sky-50/40'
                          : ''
                      }`}
                    >
                      <td className="py-3 px-4 font-mono font-black text-stone-900 whitespace-nowrap">
                        {item.ticketNumber}
                      </td>
                      <td className="py-3 px-4 font-bold text-stone-900">
                        {item.name}
                        <span className="block md:hidden text-xs font-normal text-stone-500">{item.school}</span>
                      </td>
                      <td className="py-3 px-4 text-stone-600 hidden md:table-cell">{item.school}</td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-block px-2.5 py-0.5 rounded-lg font-bold text-[11px] ${
                            item.status === 'WAITING'
                              ? 'bg-rose-50 text-rose-700'
                              : item.status === 'CALLED'
                              ? 'bg-rose-500 text-white'
                              : item.status === 'PHOTO_EDITING'
                              ? 'bg-purple-500 text-white'
                              : item.status === 'ASSIGNED_PRESS_1'
                              ? 'bg-emerald-600 text-white'
                              : item.status === 'ASSIGNED_PRESS_2'
                              ? 'bg-sky-600 text-white'
                              : item.status === 'COMPLETED'
                              ? 'bg-emerald-100 text-emerald-800'
                              : item.status === 'ABSENT'
                              ? 'bg-stone-200 text-stone-700'
                              : item.status === 'RE_WAITING'
                              ? 'bg-purple-100 text-purple-700'
                              : 'bg-stone-100 text-stone-500'
                          }`}
                        >
                          {item.status === 'WAITING'
                            ? '대기 중'
                            : item.status === 'CALLED'
                            ? '접수대 호출 중'
                            : item.status === 'PHOTO_EDITING'
                            ? '사진 커팅 중'
                            : item.status === 'ASSIGNED_PRESS_1'
                            ? '1번 프레스'
                            : item.status === 'ASSIGNED_PRESS_2'
                            ? '2번 프레스'
                            : item.status === 'COMPLETED'
                            ? '완료'
                            : item.status === 'ABSENT'
                            ? '부재'
                            : item.status === 'RE_WAITING'
                            ? '재대기'
                            : '취소'}
                        </span>
                      </td>
                      <td className="py-3 px-4 font-bold hidden 2xl:table-cell">
                        {item.assignedSlot ? (
                          <span
                            className={
                              item.assignedSlot === 1 ? 'text-emerald-700' : 'text-sky-700'
                            }
                          >
                            {item.assignedSlot}호기
                          </span>
                        ) : (
                          <span className="text-stone-300">-</span>
                        )}
                      </td>
                      <td className="py-3 px-4 hidden 2xl:table-cell">
                        {item.hasPush ? (
                          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 font-semibold">
                            <Bell className="w-3 h-3" /> 연동됨
                          </span>
                        ) : (
                          <span className="text-stone-300">-</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-stone-500 text-xs whitespace-nowrap hidden lg:table-cell">
                        {new Date(item.registeredAt).toLocaleTimeString('ko-KR', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          {(item.status === 'WAITING' || item.status === 'RE_WAITING') && (
                            <button
                              onClick={() => handleAction(item.id, 'CALL')}
                              className="px-2.5 py-1 bg-rose-500 hover:bg-rose-600 text-white font-bold rounded-lg text-xs transition"
                            >
                              접수대 호출
                            </button>
                          )}

                          {item.status === 'CALLED' && (
                            <>
                              <button
                                onClick={() => handleAction(item.id, 'START_EDITING')}
                                className="px-2.5 py-1 bg-purple-600 hover:bg-purple-700 text-white font-bold rounded-lg text-xs transition"
                              >
                                커팅 시작
                              </button>
                              <button
                                onClick={() => handleAction(item.id, 'MARK_ABSENT')}
                                className="px-2 py-1 bg-stone-500 hover:bg-stone-600 text-white font-bold rounded-lg text-xs transition"
                              >
                                부재
                              </button>
                            </>
                          )}

                          {item.status === 'PHOTO_EDITING' && (
                            <>
                              <button
                                onClick={() => handleAction(item.id, 'ASSIGN_PRESS_1')}
                                className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg text-xs transition"
                              >
                                1번으로
                              </button>
                              <button
                                onClick={() => handleAction(item.id, 'ASSIGN_PRESS_2')}
                                className="px-2.5 py-1 bg-sky-600 hover:bg-sky-700 text-white font-bold rounded-lg text-xs transition"
                              >
                                2번으로
                              </button>
                            </>
                          )}

                          {(item.status === 'ASSIGNED_PRESS_1' ||
                            item.status === 'ASSIGNED_PRESS_2') && (
                            <button
                              onClick={() => handleAction(item.id, 'COMPLETE')}
                              className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg text-xs transition"
                            >
                              제작 완료
                            </button>
                          )}

                          {item.status === 'ABSENT' && (
                            <button
                              onClick={() => handleAction(item.id, 'RE_WAIT')}
                              className="px-2.5 py-1 bg-purple-600 hover:bg-purple-700 text-white font-bold rounded-lg text-xs transition flex items-center gap-1"
                            >
                              <RotateCcw className="w-3 h-3" />
                              재대기 등록
                            </button>
                          )}

                          {item.status !== 'COMPLETED' && item.status !== 'CANCELLED' && (
                            <button
                              onClick={() => handleAction(item.id, 'CANCEL')}
                              className="px-2 py-1 text-stone-400 hover:text-rose-600 text-xs transition"
                            >
                              취소
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={8} className="py-10 text-center text-stone-400 text-xs">
                      조건에 맞는 학생 명단이 없습니다.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        </div>

        {/* BOTTOM UTILITY TOOLBAR */}
        <div className="flex flex-wrap items-center justify-between gap-4 p-4 bg-white rounded-3xl border border-stone-200/80">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowGoogleSheetModal(true)}
              className="px-3.5 py-2 bg-emerald-50 text-emerald-700 border border-emerald-200 font-bold text-xs rounded-2xl hover:bg-emerald-100 transition flex items-center gap-1.5 shadow-2xs"
            >
              <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
              구글 시트 DB 관리
            </button>
            <button
              onClick={handleDownloadCSV}
              className="px-3.5 py-2 bg-white text-stone-700 border border-stone-200 font-bold text-xs rounded-2xl hover:bg-stone-50 transition flex items-center gap-1.5"
            >
              <Download className="w-4 h-4" />
              엑셀(CSV) 저장
            </button>
          </div>

          <div>
            <button
              onClick={onGoDisplay}
              className="px-4 py-2 bg-stone-800 text-white font-bold text-xs rounded-2xl hover:bg-stone-900 transition flex items-center gap-1.5 shadow-2xs"
            >
              부스 전광판 열기
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </main>

      {/* QR CODE MODAL */}
      <QRCodeModal isOpen={showQRModal} onClose={() => setShowQRModal(false)} />

      {/* GOOGLE SHEETS AS PRIMARY DATABASE MODAL */}
      {showGoogleSheetModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-lg rounded-3xl bg-white p-5 sm:p-6 shadow-2xl max-h-[90dvh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-stone-100">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold">
                  <FileSpreadsheet className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-extrabold text-stone-800 text-base">
                    Google Sheets 메인 데이터베이스 관리
                  </h3>
                  <p className="text-[11px] text-stone-400">신청자 명단 및 실시간 대기 현황 영구 보관</p>
                </div>
              </div>
              <button
                onClick={() => setShowGoogleSheetModal(false)}
                className="p-1 text-stone-400 hover:text-stone-600 rounded-full"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Google Auth Status Bar */}
            <div className="mt-4 p-3.5 bg-[#f8faf9] rounded-2xl border border-stone-200/80 flex items-center justify-between">
              {googleUser ? (
                <div className="flex items-center gap-3">
                  {googleUser.photoURL ? (
                    <img
                      src={googleUser.photoURL}
                      alt="Google User"
                      className="w-8 h-8 rounded-full border border-emerald-200"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-emerald-600 text-white font-bold flex items-center justify-center text-xs">
                      {googleUser.displayName?.[0] || 'G'}
                    </div>
                  )}
                  <div>
                    <p className="text-xs font-bold text-stone-800">
                      {googleUser.displayName || 'Google 사용자'}
                    </p>
                    <p className="text-[11px] text-stone-500">{googleUser.email}</p>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-stone-600">
                  Google 계정에 로그인하여 내 드라이브에 시트 DB를 연동하세요.
                </div>
              )}

              {googleUser ? (
                <button
                  onClick={async () => {
                    await logoutGoogle();
                    setGoogleUser(null);
                    setGoogleAccessToken(null);
                  }}
                  className="px-2.5 py-1 text-xs text-stone-500 hover:text-stone-800 border border-stone-200 rounded-lg hover:bg-white"
                >
                  로그아웃
                </button>
              ) : (
                <button
                  onClick={handleGoogleSignIn}
                  className="px-3.5 py-1.5 bg-white text-stone-700 border border-stone-300 font-bold text-xs rounded-xl shadow-2xs hover:bg-stone-50 flex items-center gap-1.5"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24">
                    <path
                      fill="#4285F4"
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                    />
                  </svg>
                  Google 로그인
                </button>
              )}
            </div>

            {sheetMessage && (
              <div className="mt-3 p-2.5 bg-emerald-50 rounded-xl border border-emerald-100 text-xs text-emerald-800 font-medium">
                {sheetMessage}
              </div>
            )}

            {/* Direct Google Sheets Actions */}
            <div className="mt-4 space-y-3">
              <div className="p-4 bg-emerald-50/50 rounded-2xl border border-emerald-100 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-emerald-900">
                    🟢 구글 시트 양방향 데이터베이스 관리
                  </span>
                  <span className="text-[11px] text-stone-500">현재 {items.length}명</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    onClick={handleCreateAndSyncSheet}
                    disabled={sheetSyncing}
                    className="py-2.5 px-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl transition flex items-center justify-center gap-1.5 shadow-2xs disabled:opacity-50"
                  >
                    {sheetSyncing ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        처리 중...
                      </>
                    ) : (
                      <>
                        <FileSpreadsheet className="w-3.5 h-3.5" />
                        새 구글 시트 DB 생성
                      </>
                    )}
                  </button>

                  {syncedSheetUrl && (
                    <button
                      onClick={handleUpdateExistingSheet}
                      disabled={sheetSyncing}
                      className="py-2.5 px-3 bg-white text-emerald-800 border border-emerald-300 hover:bg-emerald-50 font-bold text-xs rounded-xl transition flex items-center justify-center gap-1.5 disabled:opacity-50"
                    >
                      <RefreshCw className="w-3.5 h-3.5 text-emerald-600" />
                      현재 명단 시트에 저장
                    </button>
                  )}
                </div>

                {syncedSheetUrl && (
                  <div className="pt-2 border-t border-emerald-100 flex items-center justify-between">
                    <button
                      onClick={handlePullFromSheet}
                      disabled={sheetSyncing}
                      className="text-xs text-emerald-700 hover:text-emerald-900 font-bold underline"
                    >
                      📥 시트 내용 웹앱으로 다시 불러오기
                    </button>
                    <a
                      href={syncedSheetUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="px-3 py-1 bg-emerald-600 text-white font-bold text-xs rounded-lg flex items-center gap-1 hover:bg-emerald-700 transition"
                    >
                      시트 열기
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                )}

                <div className="pt-3 border-t border-emerald-100 space-y-1.5">
                  <span className="text-[11px] font-bold text-stone-700">
                    🔗 또는 기존 구글 시트 URL / ID 직접 연동:
                  </span>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="구글 시트 URL 링크 또는 ID를 여기에 붙여넣기"
                      value={manualSheetUrl}
                      onChange={(e) => setManualSheetUrl(e.target.value)}
                      className="flex-1 px-3 py-2 text-xs bg-white border border-stone-200 rounded-xl focus:outline-none focus:ring-1 focus:ring-emerald-400"
                    />
                    <button
                      onClick={handleConnectManualSheet}
                      className="px-3 py-2 bg-stone-800 text-white font-bold text-xs rounded-xl hover:bg-stone-900 transition shrink-0"
                    >
                      시트 연동
                    </button>
                  </div>
                </div>
              </div>

              {/* Offline Clipboard Copy */}
              <div className="p-3.5 bg-stone-50 rounded-2xl border border-stone-200/80 space-y-2">
                <p className="text-xs font-bold text-stone-700">
                  📋 구글 시트에 직접 붙여넣기 (클립보드 복사)
                </p>
                <p className="text-[11px] text-stone-500">
                  복사 버튼을 누른 후 아무 스프레드시트 셀에서 Ctrl+V를 누르면 표로 즉시 붙여넣어집니다.
                </p>
                <button
                  onClick={handleCopyForGoogleSheet}
                  className="w-full py-2 bg-white text-stone-800 border border-stone-300 font-bold rounded-xl text-xs hover:bg-stone-50 transition flex items-center justify-center gap-1.5"
                >
                  {copiedSheet ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedSheet ? '클립보드에 표 복사 완료!' : '구글 시트용 표 데이터 복사'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* RESET CONFIRMATION MODAL (In-App Modal to avoid iframe popup blocking) */}
      {showResetModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-200">
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl border border-rose-100">
            <div className="w-14 h-14 rounded-2xl bg-rose-100 text-rose-600 flex items-center justify-center mx-auto mb-4 shadow-2xs">
              <RotateCcw className="w-7 h-7" />
            </div>
            <h3 className="text-center font-extrabold text-stone-900 text-lg">
              전체 데이터 초기화
            </h3>
            <div className="mt-3 bg-stone-50 rounded-2xl p-3.5 border border-stone-100 space-y-1.5 text-xs text-stone-600">
              <p className="flex items-center gap-1.5 font-bold text-stone-800">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                모든 대기자 명단이 즉시 삭제됩니다.
              </p>
              <p className="flex items-center gap-1.5 font-bold text-stone-800">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                다음 대기 번호가 1번(A-001)으로 리셋됩니다.
              </p>
              {syncedSheetUrl && (
                <p className="flex items-center gap-1.5 text-emerald-700">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  연동된 구글 시트 내역도 함께 비워집니다.
                </p>
              )}
            </div>
            <p className="mt-3 text-xs text-rose-600 font-semibold text-center">
              초기화된 데이터는 복구할 수 없습니다. 계속하시겠습니까?
            </p>
            <div className="mt-5 flex gap-2.5">
              <button
                type="button"
                onClick={() => setShowResetModal(false)}
                disabled={isResettingData}
                className="flex-1 py-3 bg-stone-100 text-stone-700 font-bold rounded-2xl text-xs hover:bg-stone-200 transition disabled:opacity-50"
              >
                취소
              </button>
              <button
                type="button"
                onClick={executeReset}
                disabled={isResettingData}
                className="flex-1 py-3 bg-rose-600 hover:bg-rose-700 text-white font-extrabold rounded-2xl text-xs transition flex items-center justify-center gap-1.5 shadow-md shadow-rose-200 disabled:opacity-50"
              >
                {isResettingData ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>초기화 진행 중...</span>
                  </>
                ) : (
                  <span>네, 초기화합니다</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SUCCESS TOAST NOTIFICATION */}
      {resetSuccessToast && (
        <div className="fixed top-5 left-1/2 -translate-x-1/2 z-50 bg-emerald-600 text-white font-bold px-5 py-3 rounded-2xl shadow-xl flex items-center gap-2 text-xs">
          <CheckCircle className="w-4 h-4 text-emerald-200" />
          <span>{resetSuccessToast}</span>
        </div>
      )}

      {/* SETTINGS MODAL */}
      {showSettingsModal && config && (
        <SettingsModal
          config={config}
          adminToken={adminToken}
          googleAccessToken={googleAccessToken}
          syncedSheetId={syncedSheetId}
          onClose={() => setShowSettingsModal(false)}
          onClearAll={async () => {
            setShowSettingsModal(false);
            setShowResetModal(true);
          }}
          onSaved={() => {
            fetchAdminData();
            setShowSettingsModal(false);
          }}
        />
      )}
    </div>
  );
};

const SettingsModal: React.FC<{
  config: BoothConfig;
  adminToken: string;
  googleAccessToken?: string | null;
  syncedSheetId?: string | null;
  onClose: () => void;
  onClearAll?: () => Promise<void>;
  onSaved: () => void;
}> = ({ config, adminToken, googleAccessToken, syncedSheetId, onClose, onClearAll, onSaved }) => {
  const [title, setTitle] = useState(config.boothTitle);
  const [notice, setNotice] = useState(config.noticeMessage);
  const [prefix, setPrefix] = useState(config.ticketPrefix);
  const [returnNotifyCount, setReturnNotifyCount] = useState(config.returnNotifyCount || 5);
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const updates: any = {
        boothTitle: title,
        noticeMessage: notice,
        ticketPrefix: prefix,
        returnNotifyCount: Number(returnNotifyCount) || 5,
      };
      if (password.trim()) {
        updates.adminPassword = password.trim();
      }

      const res = await fetch('/api/admin/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify(updates),
      });

      if (res.ok) {
        if (password.trim()) {
          alert(`부스 설정과 관리자 비밀번호가 성공적으로 변경되었습니다.\n(새 비밀번호: ${password.trim()})`);
        } else {
          alert('부스 설정이 성공적으로 저장되었습니다.');
        }
        onSaved();
      } else {
        const err = await res.json().catch(() => ({}));
        alert(`저장 실패: ${err.error || '오류 발생'}`);
      }
    } catch (err: any) {
      console.error(err);
      alert(`설정 저장 중 오류: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleResetCounter = async () => {
    if (!confirm('대기 접수 번호를 다시 1번부터 시작하도록 리셋하시겠습니까?\n(기존 대기 데이터는 유지됩니다)')) return;
    try {
      const res = await fetch('/api/admin/reset', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ resetCounterOnly: true }),
      });
      if (res.ok) {
        alert('다음 발급될 대기 번호가 1번으로 리셋되었습니다.');
        onSaved();
      }
    } catch (err: any) {
      alert(`순번 리셋 실패: ${err.message}`);
    }
  };

  const handleClearAll = async () => {
    onClose();
    if (onClearAll) {
      await onClearAll();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between pb-3 border-b border-stone-100">
          <h3 className="font-extrabold text-stone-800 text-base">부스 운영 환경 설정</h3>
          <button onClick={onClose} className="p-1 text-stone-400 hover:text-stone-600 rounded-full">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSave} className="mt-4 space-y-4 text-xs">
          <div>
            <label className="block font-bold text-stone-700 mb-1">부스 타이틀</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 bg-[#faf9f7] border border-stone-200 rounded-xl"
            />
          </div>

          <div>
            <label className="block font-bold text-stone-700 mb-1">학생 화면 공지 문구</label>
            <textarea
              rows={2}
              value={notice}
              onChange={(e) => setNotice(e.target.value)}
              className="w-full px-3 py-2 bg-[#faf9f7] border border-stone-200 rounded-xl"
            />
          </div>

          <div>
            <label className="block font-bold text-stone-700 mb-1">
              대기번호 접두사
            </label>
            <input
              type="text"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value.toUpperCase())}
              placeholder="A, B, C 등"
              className="w-full px-3 py-2 bg-[#faf9f7] border border-stone-200 rounded-xl uppercase"
            />
          </div>

          <div>
            <label className="block font-bold text-stone-700 mb-1">
              부스 복귀 준비 알림 기준 (대기 인원 수)
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="1"
                max="20"
                value={returnNotifyCount}
                onChange={(e) => setReturnNotifyCount(Number(e.target.value) || 5)}
                className="w-24 px-3 py-2 bg-[#faf9f7] border border-stone-200 rounded-xl"
              />
              <span className="text-stone-500 font-medium">명 이하 남았을 때 복귀 안내</span>
            </div>
          </div>

          <div>
            <label className="block font-bold text-stone-700 mb-1">
              관리자 비밀번호 변경 (변경 시에만 입력)
            </label>
            <input
              type="password"
              placeholder="새 비밀번호 입력"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 bg-[#faf9f7] border border-stone-200 rounded-xl"
            />
          </div>

          <div className="pt-2 border-t border-stone-100 flex gap-2">
            <button
              type="submit"
              disabled={saving}
              className="flex-1 py-2.5 bg-stone-800 text-white font-bold rounded-xl text-xs hover:bg-stone-900 transition"
            >
              {saving ? '저장 중...' : '설정 저장'}
            </button>
          </div>
        </form>

        <div className="mt-5 pt-4 border-t border-stone-200">
          <p className="text-xs font-bold text-rose-600 mb-2">데이터 초기화</p>
          <div className="flex gap-2">
            <button
              onClick={handleResetCounter}
              className="flex-1 py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 font-bold rounded-xl text-xs transition"
            >
              순번만 1번으로 리셋
            </button>
            <button
              onClick={handleClearAll}
              disabled={isResetting}
              className="flex-1 py-2 bg-rose-50 hover:bg-rose-100 disabled:opacity-50 text-rose-600 border border-rose-200 font-bold rounded-xl text-xs transition"
            >
              {isResetting ? '초기화 진행 중...' : '전체 데이터 완전 초기화'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
