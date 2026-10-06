import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { X, Download, Copy, Check, ExternalLink } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  url?: string;
  title?: string;
}

export const QRCodeModal: React.FC<Props> = ({
  isOpen,
  onClose,
  url,
  title = '캔뱃지 부스 대기 신청 QR코드',
}) => {
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copied, setCopied] = useState(false);

  const targetUrl = url || (typeof window !== 'undefined' ? `${window.location.origin}/` : '');

  useEffect(() => {
    if (isOpen && targetUrl) {
      QRCode.toDataURL(targetUrl, {
        width: 360,
        margin: 2,
        color: {
          dark: '#1e3a8a',
          light: '#ffffff',
        },
      })
        .then((url) => setQrDataUrl(url))
        .catch((err) => console.error(err));
    }
  }, [isOpen, targetUrl]);

  if (!isOpen) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(targetUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!qrDataUrl) return;
    const a = document.createElement('a');
    a.href = qrDataUrl;
    a.download = 'canbadge_booth_qr.png';
    a.click();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl transition-all">
        <div className="flex items-center justify-between pb-3 border-b border-gray-100">
          <h3 className="font-bold text-gray-900 text-lg">{title}</h3>
          <button
            onClick={onClose}
            className="p-1 rounded-full text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="mt-4 flex flex-col items-center">
          <div className="p-3 bg-blue-50 rounded-2xl border border-blue-100 shadow-inner">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="QR Code"
                className="w-64 h-64 rounded-xl object-contain bg-white p-2 shadow-sm"
              />
            ) : (
              <div className="w-64 h-64 flex items-center justify-center text-gray-400">
                QR 생성 중...
              </div>
            )}
          </div>
          <p className="mt-3 text-center text-xs text-gray-500 font-medium">
            학생들이 스마트폰 카메라로 비추면 바로 대기 신청 페이지로 연결됩니다.
          </p>
        </div>

        <div className="mt-5 space-y-2">
          <div className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg text-xs font-mono text-gray-700 truncate border border-gray-200">
            <span className="truncate flex-1">{targetUrl}</span>
            <button
              onClick={handleCopy}
              className="px-2 py-1 bg-white border border-gray-300 rounded text-gray-700 hover:bg-gray-100 flex items-center gap-1 font-sans shrink-0 font-medium"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? '복사됨' : '복사'}
            </button>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleDownload}
              className="flex-1 py-2.5 px-3 bg-blue-600 text-white font-medium rounded-xl hover:bg-blue-700 transition flex items-center justify-center gap-2 text-sm shadow-sm"
            >
              <Download className="w-4 h-4" />
              QR 이미지 저장
            </button>
            <button
              onClick={() => window.open(targetUrl, '_blank')}
              className="py-2.5 px-3 bg-gray-100 text-gray-700 font-medium rounded-xl hover:bg-gray-200 transition flex items-center justify-center gap-1 text-sm"
              title="새 탭으로 열기"
            >
              <ExternalLink className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
