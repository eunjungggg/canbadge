/**
 * Safe fetch utility that checks Content-Type and gracefully handles non-JSON responses
 * (such as when server is starting up or returning HTML error pages)
 */

export async function safeFetchJson<T = any>(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  try {
    const res = await fetch(input, init);
    const contentType = res.headers.get('content-type') || '';

    if (!contentType.includes('application/json')) {
      return {
        ok: false,
        status: res.status,
        error: res.ok
          ? '서버가 아직 준비 중입니다. 잠시 후 다시 시도해 주세요.'
          : `서버 통신 실패 (HTTP ${res.status})`,
      };
    }

    const data = await res.json();

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        data,
        error: (data && data.error) || `요청 실패 (HTTP ${res.status})`,
      };
    }

    return { ok: true, status: res.status, data };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      error: err?.message || '네트워크 연결 오류가 발생했습니다.',
    };
  }
}
