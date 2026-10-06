import React, { useState, useEffect } from 'react';
import { Sparkles, User, School, ArrowRight, AlertCircle, Ticket, Users, RefreshCw } from 'lucide-react';
import type { PublicBoardDTO } from '../types';
import { safeFetchJson } from '../utils/api';

interface Props {
  onRegistered: (token: string) => void;
  onGoToStatus: (token: string) => void;
  publicData: PublicBoardDTO | null;
  onRefreshPublic: () => void;
}

export const StudentRegister: React.FC<Props> = ({
  onRegistered,
  onGoToStatus,
  publicData,
  onRefreshPublic,
}) => {
  const [name, setName] = useState('');
  const [school, setSchool] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [existingToken, setExistingToken] = useState<string | null>(null);

  useEffect(() => {
    const savedToken = localStorage.getItem('canbadge_token');
    if (savedToken) {
      setExistingToken(savedToken);
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setErrorMessage('이름을 입력해 주세요.');
      return;
    }
    if (!school.trim()) {
      setErrorMessage('소속 학교명을 입력해 주세요.');
      return;
    }

    setErrorMessage('');
    setIsSubmitting(true);

    try {
      const res = await safeFetchJson<{ accessToken: string; ticketNumber: string }>(
        '/api/queue/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            school: school.trim(),
          }),
        }
      );

      if (res.ok && res.data && res.data.accessToken) {
        localStorage.setItem('canbadge_token', res.data.accessToken);
        localStorage.setItem('canbadge_ticket', res.data.ticketNumber);
        onRegistered(res.data.accessToken);
      } else {
        setErrorMessage(res.error || '접수에 실패했습니다. 잠시 후 다시 시도해 주세요.');
      }
    } catch (err: any) {
      setErrorMessage(err.message || '접수 실패');
    } finally {
      setIsSubmitting(false);
    }
  };

  const isPaused = publicData?.registrationStatus === 'PAUSED';
  const isClosed = publicData?.registrationStatus === 'CLOSED';
  const isOpen = publicData?.registrationStatus === 'OPEN' || !publicData;

  const inputClass =
    'w-full h-14 px-4 bg-[#faf9f7] border border-stone-200 rounded-2xl text-stone-800 text-base placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-rose-300 focus:bg-white transition';

  return (
    <div className="min-h-[100dvh] bg-[#faf8f5] text-stone-800 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-nav">
      <div className="w-full max-w-md mx-auto space-y-4">
        {/* Header */}
        <header className="flex items-center gap-3 pt-2">
          <div className="relative shrink-0 p-2 bg-white rounded-2xl shadow-sm border border-rose-100">
            <img src="/logo.png" alt="" className="w-11 h-11" />
            <div className="absolute -top-1 -right-1 bg-amber-200 text-amber-800 rounded-full p-1 shadow-2xs">
              <Sparkles className="w-3 h-3 fill-amber-400" />
            </div>
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-bold text-purple-700 truncate">
              인천비즈니스고 콘텐츠디자인과
            </p>
            <h1 className="text-xl font-extrabold tracking-tight leading-tight">나만의 캔뱃지 만들기</h1>
            <p className="text-xs text-stone-500">실시간 대기 신청 · 순번 알림</p>
          </div>
        </header>

        {/* Existing ticket */}
        {existingToken && (
          <button
            onClick={() => onGoToStatus(existingToken)}
            className="w-full p-4 bg-gradient-to-r from-rose-100 via-purple-100 to-sky-100 rounded-3xl border border-rose-200/60 shadow-xs flex items-center gap-3 text-left active:scale-[0.98] transition"
          >
            <div className="w-11 h-11 rounded-2xl bg-white/80 text-rose-500 flex items-center justify-center shrink-0">
              <Ticket className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-stone-500">이전에 받은 대기표가 있어요</p>
              <p className="text-base font-bold text-stone-800">내 대기 순서 확인하기</p>
            </div>
            <ArrowRight className="w-5 h-5 text-rose-500 shrink-0" />
          </button>
        )}

        {/* Live booth status */}
        <section className="bg-white rounded-3xl p-4 shadow-sm border border-stone-100">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-2xl bg-purple-50 text-purple-600 flex items-center justify-center">
                <Users className="w-5 h-5" />
              </div>
              <div>
                <p className="text-xs text-stone-500">지금 기다리는 사람</p>
                <p className="text-2xl font-black text-purple-900 leading-tight">
                  {publicData ? `${publicData.totalWaitingCount}명` : '-'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold ${
                  isOpen
                    ? 'bg-emerald-50 text-emerald-700'
                    : isPaused
                    ? 'bg-amber-50 text-amber-700'
                    : 'bg-rose-50 text-rose-700'
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    isOpen ? 'bg-emerald-400 animate-pulse' : isPaused ? 'bg-amber-400' : 'bg-rose-400'
                  }`}
                />
                {isOpen ? '접수 중' : isPaused ? '일시 중지' : '마감'}
              </span>
              <button
                onClick={onRefreshPublic}
                className="w-9 h-9 flex items-center justify-center text-stone-400 hover:text-stone-600 rounded-full hover:bg-stone-50 transition"
                aria-label="새로고침"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>
          </div>

          {publicData?.noticeMessage && (
            <p className="mt-3 text-sm text-stone-600 bg-stone-50 p-3 rounded-2xl leading-relaxed">
              📢 {publicData.noticeMessage}
            </p>
          )}
        </section>

        {/* Registration form */}
        <section className="bg-white rounded-3xl p-5 shadow-md border border-rose-50">
          {isClosed ? (
            <div className="text-center py-8">
              <div className="w-14 h-14 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center mx-auto mb-3">
                <AlertCircle className="w-7 h-7" />
              </div>
              <h2 className="text-lg font-bold">오늘 접수가 마감되었어요</h2>
              <p className="text-sm text-stone-500 mt-1">
                이미 번호표를 받았다면 위에서 대기 순서를 확인해 주세요.
              </p>
            </div>
          ) : isPaused ? (
            <div className="text-center py-8">
              <div className="w-14 h-14 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center mx-auto mb-3">
                <AlertCircle className="w-7 h-7" />
              </div>
              <h2 className="text-lg font-bold">잠시 접수가 중지되었어요</h2>
              <p className="text-sm text-stone-500 mt-1">혼잡도 조절 중입니다. 곧 다시 열려요!</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <h2 className="text-lg font-bold">체험 대기 등록</h2>
                <p className="text-sm text-stone-500">등록하면 바로 번호표가 나와요.</p>
              </div>

              {errorMessage && (
                <div
                  role="alert"
                  className="p-3 bg-rose-50 border border-rose-200 rounded-2xl text-sm text-rose-700 flex items-center gap-2"
                >
                  <AlertCircle className="w-4 h-4 shrink-0 text-rose-500" />
                  <span>{errorMessage}</span>
                </div>
              )}

              <div>
                <label htmlFor="reg-name" className="text-sm font-bold text-stone-700 mb-1.5 flex items-center gap-1">
                  <User className="w-4 h-4 text-rose-400" />
                  이름
                </label>
                <input
                  id="reg-name"
                  type="text"
                  required
                  autoComplete="name"
                  enterKeyHint="next"
                  placeholder="예: 홍길동"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={20}
                  className={inputClass}
                />
              </div>

              <div>
                <label htmlFor="reg-school" className="text-sm font-bold text-stone-700 mb-1.5 flex items-center gap-1">
                  <School className="w-4 h-4 text-rose-400" />
                  학교
                </label>
                <input
                  id="reg-school"
                  type="text"
                  required
                  autoComplete="organization"
                  enterKeyHint="done"
                  placeholder="예: OO중"
                  value={school}
                  onChange={(e) => setSchool(e.target.value)}
                  maxLength={30}
                  className={inputClass}
                />
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full h-14 bg-gradient-to-r from-rose-400 via-purple-400 to-sky-400 text-white text-base font-bold rounded-2xl shadow-md active:scale-[0.98] transition flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {isSubmitting ? (
                  <>
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    번호표 받는 중...
                  </>
                ) : (
                  <>
                    대기 등록하고 번호 받기
                    <ArrowRight className="w-5 h-5" />
                  </>
                )}
              </button>

              <p className="text-xs text-stone-400 text-center leading-relaxed">
                🔒 이름과 학교는 호출에만 쓰이고, 전광판에는 번호만 나와요.
              </p>
            </form>
          )}
        </section>
      </div>
    </div>
  );
};
