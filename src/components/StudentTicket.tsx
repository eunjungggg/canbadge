import React, { useState, useEffect } from 'react';
import {
  Bell,
  Users,
  CheckCircle,
  AlertTriangle,
  Sparkles,
  RefreshCw,
  ArrowLeft,
  Scissors,
  Check,
  Zap,
} from 'lucide-react';
import type { StudentTicketDTO } from '../types';
import { requestAndSubscribePush, isIOS, isStandalone } from '../utils/pushManager';
import { IOSGuideModal } from './IOSGuideModal';
import { safeFetchJson } from '../utils/api';

interface Props {
  token: string;
  onBackToRegister: () => void;
}

export const StudentTicket: React.FC<Props> = ({ token, onBackToRegister }) => {
  const [ticket, setTicket] = useState<StudentTicketDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [subscribingPush, setSubscribingPush] = useState(false);
  const [pushStatusMessage, setPushStatusMessage] = useState('');
  const [showIOSModal, setShowIOSModal] = useState(false);

  const fetchTicket = async () => {
    try {
      const res = await safeFetchJson<StudentTicketDTO>(`/api/queue/ticket?token=${token}`);
      if (res.ok && res.data) {
        const data = res.data;
        setTicket(data);
        setLastRefreshed(new Date());

        if (
          (data.status === 'CALLED' ||
            data.status === 'ASSIGNED_PRESS_1' ||
            data.status === 'ASSIGNED_PRESS_2') &&
          'vibrate' in navigator
        ) {
          navigator.vibrate([300, 150, 300, 150, 300]);
        }
      } else {
        // Direct local storage fallback
        const local = localStorage.getItem(`canbadge_ticket_${token}`);
        if (local) {
          setTicket(JSON.parse(local));
          setLastRefreshed(new Date());
        } else if (res.status === 404) {
          throw new Error('대기 정보를 찾을 수 없습니다.');
        }
      }
    } catch (err: any) {
      setError(err.message || '데이터 로드 실패');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTicket();

    let eventSource: EventSource | null = null;
    try {
      eventSource = new EventSource('/api/queue/stream');
      eventSource.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'UPDATE') fetchTicket();
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

    const interval = setInterval(fetchTicket, 6000);

    return () => {
      if (eventSource) eventSource.close();
      clearInterval(interval);
    };
  }, [token]);

  const handleSubscribePush = async () => {
    if (isIOS() && !isStandalone()) {
      setShowIOSModal(true);
      return;
    }

    setSubscribingPush(true);
    setPushStatusMessage('');

    const res = await requestAndSubscribePush(token);
    setPushStatusMessage(res.message);
    setSubscribingPush(false);

    if (res.success) {
      fetchTicket();
    }
  };

  if (loading && !ticket) {
    return (
      <div className="min-h-screen bg-[#faf8f5] flex items-center justify-center p-4">
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-rose-300 border-t-rose-500 rounded-full animate-spin mx-auto mb-3" />
          <p className="text-xs font-bold text-stone-600">대기표를 확인하는 중입니다...</p>
        </div>
      </div>
    );
  }

  if (error || !ticket) {
    return (
      <div className="min-h-screen bg-[#faf8f5] flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-white rounded-3xl p-6 shadow-md text-center border border-stone-200">
          <div className="w-12 h-12 rounded-full bg-rose-100 text-rose-500 flex items-center justify-center mx-auto mb-3">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <h2 className="text-base font-bold text-stone-800">대기표를 찾을 수 없습니다</h2>
          <p className="text-xs text-stone-500 mt-1 mb-5">
            {error || '만료되었거나 유효하지 않은 대기표입니다.'}
          </p>
          <button
            onClick={onBackToRegister}
            className="w-full py-3 bg-rose-400 text-white font-bold rounded-2xl text-xs hover:bg-rose-500 transition"
          >
            대기 신청 화면으로 가기
          </button>
        </div>
      </div>
    );
  }

  const renderGuidanceBanner = () => {
    switch (ticket.returnGuidance) {
      case 'NOW_CALLED':
        return (
          <div className="p-4 rounded-3xl bg-gradient-to-r from-rose-400 to-pink-500 text-white shadow-md animate-pulse">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-white/20 flex items-center justify-center shrink-0">
                <Zap className="w-6 h-6 text-yellow-200 fill-yellow-200" />
              </div>
              <div>
                <p className="text-xs font-bold text-rose-100 uppercase tracking-wider">
                  ★ 사진 접수대 호출 ★
                </p>
                <p className="text-sm sm:text-base font-extrabold">
                  지금 바로 [사진 접수 및 편집대]로 와 주세요!
                </p>
              </div>
            </div>
            <p className="mt-2 text-xs text-rose-100">
              담당자에게 준비한 사진을 보여주시면 예쁘게 원형 커팅해 드립니다.
            </p>
          </div>
        );

      case 'PHOTO_EDITING':
        return (
          <div className="p-4 rounded-3xl bg-gradient-to-r from-purple-400 to-indigo-400 text-white shadow-md">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-white/20 flex items-center justify-center shrink-0">
                <Scissors className="w-6 h-6 text-purple-100" />
              </div>
              <div>
                <p className="text-xs font-bold text-purple-100">1단계: 사진 편집 & 출력 중</p>
                <p className="text-sm sm:text-base font-extrabold">
                  사진을 캔뱃지 규격에 맞춰 인쇄하고 있습니다!
                </p>
              </div>
            </div>
            <p className="mt-2 text-xs text-purple-100">
              출력이 끝나면 "1번 또는 2번 프레스 기계"로 이동하여 원형 커팅 후 압착을 진행합니다.
            </p>
          </div>
        );

      case 'GO_TO_PRESS_1':
        return (
          <div className="p-5 rounded-3xl bg-gradient-to-r from-emerald-400 to-teal-500 text-white shadow-lg animate-gentle-bounce">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-white/25 flex items-center justify-center shrink-0 text-xl font-black">
                1호
              </div>
              <div>
                <p className="text-xs font-bold text-emerald-100">✨ 2단계: 프레스 배정 안내</p>
                <p className="text-base sm:text-lg font-black">
                  [1번 프레스 기계]로 가세요!
                </p>
              </div>
            </div>
            <div className="mt-3 p-2 bg-white/20 rounded-xl text-xs font-semibold text-center">
              1번 기계 앞에 서 계시면 출력된 사진을 원형 커팅 후 캔뱃지 압착을 진행합니다.
            </div>
          </div>
        );

      case 'GO_TO_PRESS_2':
        return (
          <div className="p-5 rounded-3xl bg-gradient-to-r from-sky-400 to-blue-500 text-white shadow-lg animate-gentle-bounce">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-white/25 flex items-center justify-center shrink-0 text-xl font-black">
                2호
              </div>
              <div>
                <p className="text-xs font-bold text-sky-100">✨ 2단계: 프레스 배정 안내</p>
                <p className="text-base sm:text-lg font-black">
                  [2번 프레스 기계]로 가세요!
                </p>
              </div>
            </div>
            <div className="mt-3 p-2 bg-white/20 rounded-xl text-xs font-semibold text-center">
              2번 기계 앞에 서 계시면 출력된 사진을 원형 커팅 후 캔뱃지 압착을 진행합니다.
            </div>
          </div>
        );

      case 'IMMINENT':
        return (
          <div className="p-4 rounded-3xl bg-gradient-to-r from-amber-200 to-orange-200 text-amber-900 shadow-xs border border-amber-300/60">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-amber-300/60 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-amber-800" />
              </div>
              <div>
                <p className="text-xs font-bold text-amber-800">호출 임박 안내</p>
                <p className="text-sm font-black">
                  앞에 {ticket.waitingAheadCount}명 남음! 사진 접수대 앞으로 이동해 주세요.
                </p>
              </div>
            </div>
          </div>
        );

      case 'PREPARE_RETURN':
        return (
          <div className="p-4 rounded-3xl bg-gradient-to-r from-amber-100 to-yellow-100 text-amber-900 shadow-xs border border-amber-200/60">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-amber-200/50 flex items-center justify-center shrink-0">
                <Users className="w-5 h-5 text-amber-800" />
              </div>
              <div>
                <p className="text-xs font-bold text-amber-800">복귀 준비 안내</p>
                <p className="text-sm font-extrabold">
                  앞에 {ticket.waitingAheadCount}명 남음! 캔뱃지 부스 근처로 돌아와 주세요.
                </p>
              </div>
            </div>
          </div>
        );

      case 'COMPLETED':
        return (
          <div className="p-4 rounded-3xl bg-gradient-to-r from-emerald-100 via-teal-100 to-green-100 text-emerald-900 shadow-xs border border-emerald-200">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-emerald-200/60 flex items-center justify-center shrink-0">
                <CheckCircle className="w-5 h-5 text-emerald-700" />
              </div>
              <div>
                <p className="text-xs font-bold text-emerald-700">체험 완료</p>
                <p className="text-sm font-extrabold">나만의 예쁜 캔뱃지가 완성되었습니다!</p>
              </div>
            </div>
          </div>
        );

      case 'ABSENT':
        return (
          <div className="p-4 rounded-3xl bg-stone-100 text-stone-700 border border-stone-200">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-stone-200 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-stone-500" />
              </div>
              <div>
                <p className="text-xs font-bold text-stone-500">부재 처리 안내</p>
                <p className="text-sm font-bold">호출 시 미방문으로 부재 처리되었습니다.</p>
              </div>
            </div>
            <p className="mt-2 text-xs text-stone-500">
              돌아오셨다면 <strong>부스 운영자에게 대기번호 {ticket.ticketNumber}를 말씀해 주세요.</strong>
            </p>
          </div>
        );

      default:
        return (
          <div className="p-4 rounded-3xl bg-sky-50/70 border border-sky-100 text-sky-950">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-2xl bg-sky-200/80 text-sky-700 flex items-center justify-center shrink-0">
                <Sparkles className="w-4 h-4" />
              </div>
              <div>
                <p className="text-xs font-bold text-sky-600">대기 중</p>
                <p className="text-xs sm:text-sm font-bold">
                  앞에 {ticket.waitingAheadCount}명이 대기하고 있습니다.
                </p>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-sky-700/80 leading-relaxed">
              다른 부스를 둘러보시다가 5명 이하 알림이 오면 부스로 돌아와 주세요!
            </p>
          </div>
        );
    }
  };

  return (
    <div className="min-h-screen bg-[#faf8f5] flex flex-col items-center justify-start p-4 sm:p-6 pb-24 text-stone-800">
      <div className="w-full max-w-md space-y-4">
        {/* Navigation Bar */}
        <div className="flex items-center justify-between py-1">
          <button
            onClick={onBackToRegister}
            className="flex items-center gap-1 text-xs font-semibold text-stone-600 hover:text-stone-900 bg-white px-3 py-1.5 rounded-full border border-stone-200 shadow-2xs transition"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            신규 접수
          </button>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1 text-[11px] font-semibold text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-200">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              실시간 동기화
            </span>
            <button
              onClick={fetchTicket}
              className="p-1.5 bg-white text-stone-500 hover:text-rose-500 rounded-full border border-stone-200 shadow-2xs transition"
              title="새로고침"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Dynamic Guidance Banner */}
        {renderGuidanceBanner()}

        {/* Pastel Ticket Card */}
        <div className="bg-white rounded-3xl p-6 shadow-sm border border-stone-100 relative overflow-hidden">
          <div className="flex items-center justify-between pb-4 border-b border-stone-100">
            <div>
              <p className="text-[11px] font-bold text-stone-400">참여자</p>
              <h2 className="text-base font-extrabold text-stone-800 flex items-center gap-1.5">
                {ticket.name} 학생
                <span className="text-xs font-semibold text-purple-600 bg-purple-50 px-2 py-0.5 rounded-lg border border-purple-100">
                  {ticket.school}
                </span>
              </h2>
            </div>
            <div>
              <span
                className={`inline-block px-2.5 py-1 text-xs font-bold rounded-xl ${
                  ticket.status === 'CALLED'
                    ? 'bg-rose-400 text-white animate-pulse'
                    : ticket.status === 'PHOTO_EDITING'
                    ? 'bg-purple-400 text-white'
                    : ticket.status === 'ASSIGNED_PRESS_1'
                    ? 'bg-emerald-500 text-white font-black'
                    : ticket.status === 'ASSIGNED_PRESS_2'
                    ? 'bg-sky-500 text-white font-black'
                    : ticket.status === 'COMPLETED'
                    ? 'bg-emerald-100 text-emerald-800'
                    : ticket.status === 'ABSENT'
                    ? 'bg-stone-200 text-stone-700'
                    : ticket.status === 'RE_WAITING'
                    ? 'bg-purple-100 text-purple-700'
                    : 'bg-rose-50 text-rose-700'
                }`}
              >
                {ticket.status === 'CALLED'
                  ? `호출 중 (${ticket.callCount}차)`
                  : ticket.status === 'PHOTO_EDITING'
                  ? '사진 편집 중'
                  : ticket.status === 'ASSIGNED_PRESS_1'
                  ? '1번 프레스 배정'
                  : ticket.status === 'ASSIGNED_PRESS_2'
                  ? '2번 프레스 배정'
                  : ticket.status === 'COMPLETED'
                  ? '체험 완료'
                  : ticket.status === 'ABSENT'
                  ? '부재'
                  : ticket.status === 'RE_WAITING'
                  ? '재대기 중'
                  : '대기 중'}
              </span>
            </div>
          </div>

          {/* Ticket Number Hero */}
          <div className="py-5 text-center">
            <p className="text-xs font-bold text-stone-400 uppercase tracking-widest mb-1">
              내 대기 번호
            </p>
            <div className="inline-block px-6 py-2 bg-gradient-to-r from-stone-800 to-stone-900 text-white rounded-2xl shadow-inner font-mono text-4xl sm:text-5xl font-black tracking-wider">
              {ticket.ticketNumber}
            </div>
          </div>

          {/* Live Queue Grid (Estimated wait duration removed per request) */}
          <div className="grid grid-cols-2 gap-3 py-3.5 bg-[#fbf9f6] rounded-2xl border border-stone-200/60 text-center">
            <div className="p-2">
              <p className="text-xs text-stone-500 font-bold flex items-center justify-center gap-1">
                <Users className="w-3.5 h-3.5 text-purple-400" />
                내 앞 대기자
              </p>
              <p className="text-xl font-black text-stone-800 mt-1">
                {ticket.status === 'WAITING' || ticket.status === 'RE_WAITING'
                  ? `${ticket.waitingAheadCount}명`
                  : '-'}
              </p>
            </div>

            <div className="p-2 border-l border-stone-200">
              <p className="text-xs text-stone-500 font-bold flex items-center justify-center gap-1">
                <Zap className="w-3.5 h-3.5 text-rose-400" />
                현재 호출 중 번호
              </p>
              <p className="text-xl font-black text-rose-500 mt-1 truncate">
                {ticket.currentCallingNumber || '대기 중'}
              </p>
            </div>
          </div>
        </div>

        {/* Web Push Subscription Card */}
        <div className="bg-white rounded-3xl p-4 shadow-sm border border-stone-100">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-xl bg-rose-50 text-rose-500 flex items-center justify-center">
                <Bell className="w-3.5 h-3.5" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-stone-800">휴대폰 푸시 알림</h3>
                <p className="text-[10px] text-stone-400">화면이 꺼져도 복귀 및 기계 이동 알림</p>
              </div>
            </div>
            {ticket.hasPushSubscribed && (
              <span className="flex items-center gap-1 px-2 py-0.5 bg-emerald-50 text-emerald-700 text-[11px] font-bold rounded-md">
                <Check className="w-3 h-3" />
                수신 중
              </span>
            )}
          </div>

          {ticket.hasPushSubscribed ? (
            <div className="p-2.5 bg-emerald-50/70 rounded-2xl border border-emerald-100 text-xs text-emerald-800 flex items-center gap-2">
              <CheckCircle className="w-4 h-4 shrink-0 text-emerald-500" />
              <span>
                알림 연동 완료! <strong>사진 접수 호출 시 & 1/2번 기계 배정 시</strong> 휴대폰으로 안내해 드립니다.
              </span>
            </div>
          ) : (
            <div className="space-y-2">
              <button
                onClick={handleSubscribePush}
                disabled={subscribingPush}
                className="w-full py-2.5 bg-stone-800 text-white font-bold rounded-2xl text-xs hover:bg-stone-900 active:scale-98 transition flex items-center justify-center gap-1.5 shadow-xs cursor-pointer disabled:opacity-50"
              >
                {subscribingPush ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    알림 권한 요청 중...
                  </>
                ) : (
                  <>
                    <Bell className="w-3.5 h-3.5 text-amber-300" />
                    휴대폰 푸시 알림 받기
                  </>
                )}
              </button>
            </div>
          )}

          {pushStatusMessage && (
            <div className="mt-2 p-2 bg-rose-50 rounded-xl text-xs text-rose-800 font-medium">
              {pushStatusMessage}
            </div>
          )}
        </div>

        {/* Notice Message */}
        {ticket.noticeMessage && (
          <div className="p-3 bg-white rounded-2xl border border-stone-100 text-xs text-stone-600 flex items-start gap-2">
            <span className="font-bold text-amber-500 shrink-0">공지</span>
            <span className="leading-relaxed">{ticket.noticeMessage}</span>
          </div>
        )}

        <div className="text-center text-[10px] text-stone-400">
          마지막 갱신: {lastRefreshed.toLocaleTimeString('ko-KR')} • 창을 닫아도 번호표는 보존됩니다
        </div>
      </div>

      <IOSGuideModal isOpen={showIOSModal} onClose={() => setShowIOSModal(false)} />
    </div>
  );
};
