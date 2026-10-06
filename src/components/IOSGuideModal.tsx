import React from 'react';
import { X, Share, PlusSquare, Bell, ArrowRight } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export const IOSGuideModal: React.FC<Props> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl transition-all">
        <div className="flex items-center justify-between pb-3 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold">
              🍎
            </div>
            <h3 className="font-bold text-gray-900 text-base">아이폰 푸시 알림 설정법</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-full text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="mt-3 text-xs text-gray-600 leading-relaxed">
          Apple 정책상 아이폰(iOS 16.4+)에서는 <strong>웹앱을 홈 화면에 추가한 후</strong> 실행해야 화면이 꺼져 있어도 푸시 알림을 받을 수 있습니다.
        </p>

        <div className="mt-4 space-y-3">
          <div className="flex items-start gap-3 p-3 bg-gray-50 rounded-xl border border-gray-100">
            <div className="w-7 h-7 rounded-lg bg-blue-600 text-white flex items-center justify-center shrink-0 text-xs font-bold">
              1
            </div>
            <div className="text-xs text-gray-700">
              <span className="font-semibold text-gray-900">Safari 브라우저 하단</span>의
              <span className="inline-flex items-center gap-1 mx-1 px-1.5 py-0.5 bg-white border border-gray-300 rounded font-medium text-blue-600">
                <Share className="w-3.5 h-3.5" /> 공유
              </span>
              버튼을 누릅니다.
            </div>
          </div>

          <div className="flex items-start gap-3 p-3 bg-gray-50 rounded-xl border border-gray-100">
            <div className="w-7 h-7 rounded-lg bg-blue-600 text-white flex items-center justify-center shrink-0 text-xs font-bold">
              2
            </div>
            <div className="text-xs text-gray-700">
              메뉴를 아래로 내려
              <span className="inline-flex items-center gap-1 mx-1 px-1.5 py-0.5 bg-white border border-gray-300 rounded font-medium text-gray-900">
                <PlusSquare className="w-3.5 h-3.5 text-blue-600" /> 홈 화면에 추가
              </span>
              를 탭합니다.
            </div>
          </div>

          <div className="flex items-start gap-3 p-3 bg-blue-50/70 rounded-xl border border-blue-100">
            <div className="w-7 h-7 rounded-lg bg-blue-600 text-white flex items-center justify-center shrink-0 text-xs font-bold">
              3
            </div>
            <div className="text-xs text-blue-950">
              홈 화면에 생긴 <strong>[캔뱃지대기]</strong> 아이콘을 켜고, <strong>[푸시 알림 받기]</strong>를 누르면 완료!
            </div>
          </div>
        </div>

        <div className="mt-4 p-3 bg-amber-50 rounded-xl border border-amber-200 text-xs text-amber-800 flex items-center gap-2">
          <Bell className="w-4 h-4 shrink-0 text-amber-600" />
          <span>홈 화면 추가 없이도 현재 브라우저 탭을 열어두시면 실시간으로 대기 순번이 자동 갱신됩니다.</span>
        </div>

        <button
          onClick={onClose}
          className="mt-5 w-full py-2.5 bg-gray-900 text-white font-medium rounded-xl hover:bg-gray-800 transition text-sm flex items-center justify-center gap-1"
        >
          확인했습니다
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
