import React, { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import {
  Sparkles,
  Maximize2,
  Minimize2,
  Users,
  CheckCircle2,
  Radio,
  ArrowRight,
  Scissors,
  Layers,
} from 'lucide-react';
import type { PublicBoardDTO } from '../types';
import { safeFetchJson } from '../utils/api';

interface Props {
  onGoHome?: () => void;
}

export const PublicDisplay: React.FC<Props> = ({ onGoHome }) => {
  const [boardData, setBoardData] = useState<PublicBoardDTO | null>(null);
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [currentTime, setCurrentTime] = useState<string>('');

  const fetchBoard = async () => {
    const res = await safeFetchJson<PublicBoardDTO>('/api/queue/public');
    if (res.ok && res.data) {
      setBoardData(res.data);
    }
  };

  useEffect(() => {
    fetchBoard();

    let eventSource: EventSource | null = null;
    try {
      eventSource = new EventSource('/api/queue/stream');
      eventSource.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'UPDATE') fetchBoard();
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

    const poll = setInterval(fetchBoard, 4000);
    const clock = setInterval(() => {
      const now = new Date();
      setCurrentTime(
        now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      );
    }, 1000);

    return () => {
      if (eventSource) eventSource.close();
      clearInterval(poll);
      clearInterval(clock);
    };
  }, []);

  useEffect(() => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    QRCode.toDataURL(origin, {
      width: 240,
      margin: 1,
      color: { dark: '#292524', light: '#ffffff' },
    }).then(setQrCodeUrl);
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  const slot1 = boardData?.activeSlots.find((s) => s.slotNumber === 1);
  const slot2 = boardData?.activeSlots.find((s) => s.slotNumber === 2);

  return (
    <div className="min-h-screen bg-[#f7f5f2] text-stone-800 flex flex-col justify-between p-4 sm:p-7 select-none">
      {/* Top Header */}
      <header className="flex items-center justify-between border-b border-stone-200/80 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-tr from-rose-300 via-purple-300 to-sky-300 flex items-center justify-center shadow-xs">
            <Sparkles className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl sm:text-2xl font-black tracking-tight text-stone-900 flex items-center gap-2">
              나만의 캔뱃지 만들기!
              <span className="text-xs px-2.5 py-0.5 rounded-full bg-rose-100 text-rose-700 font-bold border border-rose-200">
                실시간 순번 전광판
              </span>
            </h1>
            <p className="text-xs sm:text-sm text-stone-600 font-medium">
              인천비즈니스고등학교 콘텐츠디자인과 직업체험관
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-right hidden sm:block">
            <div className="text-sm font-mono font-bold text-stone-700">{currentTime}</div>
            <div className="flex items-center gap-1.5 justify-end text-xs text-emerald-600 font-semibold">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              실시간 연동 중
            </div>
          </div>

          <button
            onClick={toggleFullscreen}
            className="p-2.5 bg-white hover:bg-stone-50 rounded-2xl border border-stone-200 text-stone-500 hover:text-stone-800 shadow-2xs transition"
            title="전체 화면"
          >
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {/* Main Grid Content */}
      <div className="my-5 grid grid-cols-1 lg:grid-cols-12 gap-5 flex-1">
        {/* Left Column: Live Calling & Stations (7 Cols) */}
        <div className="lg:col-span-7 flex flex-col justify-between space-y-4">
          {/* NOW CALLING BANNER */}
          <div className="bg-gradient-to-br from-rose-100 via-pink-50 to-orange-50 border-2 border-rose-300/70 rounded-3xl p-5 sm:p-6 shadow-sm relative overflow-hidden">
            <div className="flex items-center justify-between mb-3 pb-1 border-b border-rose-200/50">
              <p className="text-xs font-bold text-rose-600 uppercase tracking-wider flex items-center gap-1.5">
                <Radio className="w-3.5 h-3.5 text-rose-500 animate-pulse" />
                사진 접수대 호출 중
              </p>
              <span className="text-[11px] font-semibold text-rose-500 bg-white/80 px-2.5 py-0.5 rounded-full border border-rose-200 shadow-2xs">
                사진 접수대로 와 주세요
              </span>
            </div>

            <div className="flex flex-wrap items-baseline gap-3 my-3">
              {boardData?.callingTickets && boardData.callingTickets.length > 0 ? (
                boardData.callingTickets.map((num) => (
                  <div
                    key={num}
                    className="inline-block px-6 py-2.5 bg-rose-500 text-white font-mono font-black text-3xl sm:text-5xl rounded-2xl shadow-md shadow-rose-200 animate-gentle-bounce"
                  >
                    {num}
                  </div>
                ))
              ) : (
                <div className="text-2xl sm:text-3xl font-bold text-stone-400 font-mono py-1">
                  호출 대기 중
                </div>
              )}
            </div>
          </div>

          {/* TWO STAGE PROGRESS DISPLAY */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* STEP 1: PHOTO EDITING STATION */}
            <div className="bg-white rounded-3xl p-4 border border-purple-100 shadow-xs relative">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-purple-700 flex items-center gap-1">
                  <Scissors className="w-3.5 h-3.5 text-purple-500" />
                  사진 접수대
                </span>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-50 text-purple-600 border border-purple-200">
                  1단계
                </span>
              </div>
              <div className="text-center py-4 bg-purple-50/40 rounded-2xl border border-purple-100/60">
                <div className="text-2xl sm:text-3xl font-mono font-black text-purple-900">
                  {boardData?.photoEditingTicket || '-'}
                </div>
                <div className="text-[11px] text-purple-600 mt-1 font-semibold">
                  {boardData?.photoEditingTicket ? '원형 커팅 중' : '대기 중'}
                </div>
              </div>
            </div>

            {/* STEP 2: PRESS MACHINE 1 */}
            <div className="bg-white rounded-3xl p-4 border border-emerald-100 shadow-xs relative">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-emerald-700 flex items-center gap-1">
                  <Layers className="w-3.5 h-3.5 text-emerald-500" />
                  프레스 1호기
                </span>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200">
                  2단계
                </span>
              </div>
              <div className="text-center py-4 bg-emerald-50/40 rounded-2xl border border-emerald-100/60">
                <div className="text-2xl sm:text-3xl font-mono font-black text-emerald-900">
                  {slot1?.ticketNumber || '-'}
                </div>
                <div className="text-[11px] text-emerald-600 mt-1 font-semibold">
                  {slot1?.ticketNumber ? '1번 기계 압착 중' : '대기 중'}
                </div>
              </div>
            </div>

            {/* STEP 2: PRESS MACHINE 2 */}
            <div className="bg-white rounded-3xl p-4 border border-sky-100 shadow-xs relative">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-sky-700 flex items-center gap-1">
                  <Layers className="w-3.5 h-3.5 text-sky-500" />
                  프레스 2호기
                </span>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-sky-50 text-sky-600 border border-sky-200">
                  2단계
                </span>
              </div>
              <div className="text-center py-4 bg-sky-50/40 rounded-2xl border border-sky-100/60">
                <div className="text-2xl sm:text-3xl font-mono font-black text-sky-900">
                  {slot2?.ticketNumber || '-'}
                </div>
                <div className="text-[11px] text-sky-600 mt-1 font-semibold">
                  {slot2?.ticketNumber ? '2번 기계 압착 중' : '대기 중'}
                </div>
              </div>
            </div>
          </div>

          {/* Quick Metrics Bar (Duration removed per request) */}
          <div className="grid grid-cols-2 gap-3 bg-white p-4 rounded-3xl border border-stone-200/80 text-center shadow-2xs">
            <div>
              <p className="text-xs text-stone-400 flex items-center justify-center gap-1 font-medium">
                <Users className="w-3.5 h-3.5 text-purple-400" />
                현재 대기 인원
              </p>
              <p className="text-2xl font-black text-stone-800 mt-0.5">
                {boardData?.totalWaitingCount || 0}
                <span className="text-xs font-normal text-stone-400 ml-1">명</span>
              </p>
            </div>
            <div className="border-l border-stone-100">
              <p className="text-xs text-stone-400 flex items-center justify-center gap-1 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                체험 완료 인원
              </p>
              <p className="text-2xl font-black text-emerald-600 mt-0.5">
                {boardData?.totalCompletedCount || 0}
                <span className="text-xs font-normal text-stone-400 ml-1">명</span>
              </p>
            </div>
          </div>
        </div>

        {/* Right Column: Waiting Queue & QR (5 Cols) */}
        <div className="lg:col-span-5 flex flex-col justify-between space-y-4">
          {/* WAITING QUEUE GRID */}
          <div className="bg-white border border-stone-200/80 rounded-3xl p-5 flex-1 flex flex-col shadow-2xs">
            <div className="flex items-center justify-between pb-3 border-b border-stone-100">
              <h2 className="text-sm font-bold text-stone-800 flex items-center gap-2">
                <span>다음 대기 순번</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 font-bold">
                  총 {boardData?.waitingTickets.length || 0}명
                </span>
              </h2>
              <span className="text-xs text-stone-400">선착순</span>
            </div>

            <div className="mt-3 flex-1 overflow-y-auto max-h-[260px] pr-1">
              {boardData?.waitingTickets && boardData.waitingTickets.length > 0 ? (
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {boardData.waitingTickets.slice(0, 16).map((ticket, idx) => (
                    <div
                      key={ticket}
                      className={`p-2.5 rounded-2xl text-center font-mono font-bold text-sm border transition ${
                        idx < 2
                          ? 'bg-rose-50 text-rose-700 border-rose-200'
                          : idx < 6
                          ? 'bg-purple-50/50 text-purple-700 border-purple-100'
                          : 'bg-[#faf9f7] text-stone-600 border-stone-200/60'
                      }`}
                    >
                      {ticket}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="h-full flex items-center justify-center text-stone-400 text-xs py-10">
                  현재 대기 중인 학생이 없습니다.
                </div>
              )}
            </div>
          </div>

          {/* QR CODE REGISTRATION CARD */}
          <div className="bg-gradient-to-r from-rose-50 via-purple-50 to-sky-50 border border-stone-200/80 rounded-3xl p-4 flex items-center gap-4 shadow-2xs">
            <div className="p-2 bg-white rounded-2xl shrink-0 shadow-2xs border border-stone-100">
              {qrCodeUrl ? (
                <img src={qrCodeUrl} alt="대기 등록 QR" className="w-24 h-24 object-contain" />
              ) : (
                <div className="w-24 h-24 bg-stone-100 animate-pulse rounded-lg" />
              )}
            </div>
            <div className="space-y-1">
              <span className="inline-block px-2 py-0.5 bg-rose-100 text-rose-700 font-bold text-[10px] rounded-full">
                QR 스캔으로 즉시 접수
              </span>
              <h3 className="text-sm font-bold text-stone-800 leading-snug">
                스마트폰으로 번호표 받기
              </h3>
              <p className="text-[11px] text-stone-500 leading-tight">
                카메라로 QR을 비추면 바로 번호표가 발급되고, 차례가 오면 휴대폰으로 알려드립니다!
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Footer Notice */}
      <footer className="pt-3 border-t border-stone-200 flex flex-col sm:flex-row items-center justify-between text-xs text-stone-400 gap-2">
        <div className="flex items-center gap-2 truncate max-w-xl">
          <span className="font-bold text-rose-500 shrink-0">📢 알림</span>
          <span className="text-stone-600 truncate">
            {boardData?.noticeMessage || '개인정보 보호를 위해 전광판에는 대기번호만 표시됩니다.'}
          </span>
        </div>

        {onGoHome && (
          <button
            onClick={onGoHome}
            className="text-stone-500 hover:text-stone-800 transition flex items-center gap-1 font-medium"
          >
            메인 화면으로
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        )}
      </footer>
    </div>
  );
};
