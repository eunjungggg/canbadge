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

      if (!res.ok || !res.data) {
        throw new Error(res.error || '대기 접수 중 오류가 발생했습니다.');
      }

      if (res.data.accessToken) {
        localStorage.setItem('canbadge_token', res.data.accessToken);
        localStorage.setItem('canbadge_ticket', res.data.ticketNumber);
        onRegistered(res.data.accessToken);
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

  return (
    <div className="min-h-screen bg-[#faf8f5] flex flex-col items-center justify-start p-4 sm:p-6 pb-24 text-stone-800">
      <div className="w-full max-w-md">
        {/* Soft Pastel Header */}
        <div className="text-center pt-6 pb-5">
          <div className="inline-flex items-center justify-center p-3.5 bg-white/90 backdrop-blur-xs rounded-3xl shadow-sm border border-rose-100 mb-3 relative">
            <img src="/logo.png" alt="Canbadge Logo" className="w-16 h-16 drop-shadow-xs" />
            <div className="absolute -top-1 -right-1 bg-amber-200 text-amber-800 rounded-full p-1.5 shadow-2xs">
              <Sparkles className="w-3.5 h-3.5 fill-amber-400" />
            </div>
          </div>
          <div className="inline-block px-3.5 py-1 bg-purple-50 text-purple-700 text-xs font-bold rounded-full border border-purple-200/80 mb-2 shadow-2xs">
            인천비즈니스고등학교 콘텐츠디자인과
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-stone-800 tracking-tight">
            나만의 캔뱃지 만들기
          </h1>
          <p className="mt-1 text-xs sm:text-sm text-stone-500 font-medium">
            실시간 대기 신청 & 순번 알림 서비스
          </p>
        </div>

        {/* Existing Ticket Banner */}
        {existingToken && (
          <div className="mb-5 p-4 bg-gradient-to-r from-rose-100 via-purple-100 to-sky-100 rounded-3xl border border-rose-200/60 shadow-xs flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-white/80 text-rose-500 flex items-center justify-center shadow-2xs">
                <Ticket className="w-5 h-5" />
              </div>
              <div>
                <p className="text-[11px] text-stone-500 font-medium">이전에 받은 대기표가 있어요</p>
                <p className="text-sm font-bold text-stone-800">내 대기 순서 확인하기</p>
              </div>
            </div>
            <button
              onClick={() => onGoToStatus(existingToken)}
              className="px-3.5 py-2 bg-white text-rose-600 font-bold text-xs rounded-2xl shadow-xs hover:bg-rose-50 active:scale-95 transition flex items-center gap-1 border border-rose-200"
            >
              조회
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Live Booth Info Card (Clean & Minimal: Duration removed) */}
        <div className="bg-white rounded-3xl p-4 shadow-sm border border-stone-100 mb-5">
          <div className="flex items-center justify-between mb-3 pb-2 border-b border-stone-100">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                  isOpen ? 'bg-emerald-300' : isPaused ? 'bg-amber-300' : 'bg-rose-300'
                }`} />
                <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
                  isOpen ? 'bg-emerald-400' : isPaused ? 'bg-amber-400' : 'bg-rose-400'
                }`} />
              </span>
              <span className="text-xs font-bold text-stone-700">
                {isOpen ? '현재 접수 중' : isPaused ? '접수 일시 중지' : '접수 마감'}
              </span>
            </div>
            <button
              onClick={onRefreshPublic}
              className="p-1 text-stone-400 hover:text-stone-600 rounded-lg transition"
              title="새로고침"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="p-4 bg-purple-50/50 rounded-2xl border border-purple-100 text-center">
            <p className="text-xs text-purple-600 font-medium flex items-center justify-center gap-1">
              <Users className="w-3.5 h-3.5" /> 현재 대기 중인 인원
            </p>
            <p className="text-2xl font-black text-purple-900 mt-1">
              {publicData ? `${publicData.totalWaitingCount}명` : '-'}
            </p>
          </div>

          {publicData?.noticeMessage && (
            <p className="mt-3 text-xs text-stone-600 bg-stone-50 p-3 rounded-2xl border border-stone-100 flex items-start gap-2">
              <span className="text-amber-500 font-bold shrink-0">📢</span>
              <span>{publicData.noticeMessage}</span>
            </p>
          )}
        </div>

        {/* Registration Form */}
        <div className="bg-white rounded-3xl p-6 shadow-md border border-rose-50">
          <h2 className="text-base sm:text-lg font-bold text-stone-800 mb-1">체험 대기 등록</h2>
          <p className="text-xs text-stone-500 mb-5">
            등록 후 대기표를 확인하시고, 차례가 오면 사진 접수대로 와 주세요.
          </p>

          {errorMessage && (
            <div className="mb-4 p-3 bg-rose-50 border border-rose-200 rounded-2xl text-xs text-rose-700 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-500" />
              <span>{errorMessage}</span>
            </div>
          )}

          {isClosed ? (
            <div className="text-center py-8">
              <div className="w-12 h-12 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center mx-auto mb-3">
                <AlertCircle className="w-6 h-6" />
              </div>
              <h3 className="text-sm font-bold text-stone-800">금일 접수가 마감되었습니다</h3>
              <p className="text-xs text-stone-500 mt-1">
                많은 성원에 감사드립니다. 이미 번호표를 받으신 분은 대기 현황을 확인해 주세요.
              </p>
            </div>
          ) : isPaused ? (
            <div className="text-center py-8">
              <div className="w-12 h-12 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center mx-auto mb-3">
                <AlertCircle className="w-6 h-6" />
              </div>
              <h3 className="text-sm font-bold text-stone-800">잠시 대기 접수가 중지되었습니다</h3>
              <p className="text-xs text-stone-500 mt-1">
                체험 혼잡도 조절 중입니다. 운영진이 곧 접수를 재개합니다.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-stone-700 mb-1.5 flex items-center gap-1">
                  <User className="w-3.5 h-3.5 text-rose-400" />
                  학생 이름 <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="예: 홍길동"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={20}
                  className="w-full px-4 py-3 bg-[#faf9f7] border border-stone-200 rounded-2xl text-stone-800 text-sm focus:outline-none focus:ring-2 focus:ring-rose-300 focus:bg-white transition"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-stone-700 mb-1.5 flex items-center gap-1">
                  <School className="w-3.5 h-3.5 text-rose-400" />
                  소속 학교명 <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="예: OO중"
                  value={school}
                  onChange={(e) => setSchool(e.target.value)}
                  maxLength={30}
                  className="w-full px-4 py-3 bg-[#faf9f7] border border-stone-200 rounded-2xl text-stone-800 text-sm focus:outline-none focus:ring-2 focus:ring-rose-300 focus:bg-white transition"
                />
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full py-4 bg-gradient-to-r from-rose-400 via-purple-400 to-sky-400 text-white font-bold rounded-2xl shadow-md hover:opacity-95 active:scale-98 transition flex items-center justify-center gap-2 text-sm cursor-pointer disabled:opacity-50"
                >
                  {isSubmitting ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      대기표 발급 중...
                    </>
                  ) : (
                    <>
                      대기 등록하고 순번 받기
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>

              <div className="pt-2 text-center">
                <p className="text-[11px] text-stone-400">
                  🔒 입력하신 이름과 학교명은 관리자 호출 용도로만 사용되며, 전광판에는 번호만 노출됩니다.
                </p>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
