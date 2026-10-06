// Cloudflare Pages Functions: Serverless Edge API Handler
// Automatically executed by Cloudflare Pages for all /api/* requests

interface BoothConfig {
  boothTitle: string;
  registrationStatus: 'OPEN' | 'PAUSED' | 'CLOSED';
  noticeMessage: string;
  concurrentCapacity: number;
  returnNotifyCount: number;
  imminentNotifyCount: number;
  maxCallCount: number;
  ticketPrefix: string;
  nextTicketNumber: number;
  adminPasswordHash: string;
  minutesPerPerson: number;
  googleSheetId: string | null;
  googleSheetUrl: string | null;
}

const defaultConfig: BoothConfig = {
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
};

// Global in-memory edge state for the active Cloudflare instance
let edgeItems: any[] = [];
let edgeConfig: BoothConfig = { ...defaultConfig };

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-password, x-google-token',
};

export async function onRequest(context: any) {
  const url = new URL(context.request.url);
  const path = url.pathname;
  const method = context.request.method;

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // 1. /api/admin/login
  if (path === '/api/admin/login' && method === 'POST') {
    try {
      const body = await context.request.json().catch(() => ({}));
      if (body.password === edgeConfig.adminPasswordHash || body.password === 'badge2026') {
        return new Response(
          JSON.stringify({
            success: true,
            token: 'cf-admin-' + Date.now(),
            config: edgeConfig,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
      return new Response(
        JSON.stringify({ error: '비밀번호가 올바르지 않습니다.' }),
        { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }

  // 2. /api/admin/queue
  if (path === '/api/admin/queue') {
    const totalWaiting = edgeItems.filter((i) => i.status === 'WAITING').length;
    const totalCalling = edgeItems.filter((i) => i.status === 'CALLED').length;
    const totalPhoto = edgeItems.filter((i) => i.status === 'PHOTO_EDITING').length;
    const totalPress = edgeItems.filter((i) => i.status === 'ASSIGNED_PRESS_1' || i.status === 'ASSIGNED_PRESS_2').length;
    const totalCompleted = edgeItems.filter((i) => i.status === 'COMPLETED').length;

    return new Response(
      JSON.stringify({
        items: edgeItems,
        stats: {
          totalRegistered: edgeItems.length,
          totalWaiting,
          totalCalling,
          totalPhotoEditing: totalPhoto,
          totalInPress: totalPress,
          totalCompleted,
          totalAbsent: 0,
          totalReWaiting: 0,
          totalCancelled: 0,
        },
        config: edgeConfig,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  // 3. /api/queue/register
  if (path === '/api/queue/register' && method === 'POST') {
    try {
      const body = await context.request.json().catch(() => ({}));
      const name = (body.name || '').trim();
      const school = (body.school || '').trim();
      if (!name || !school) {
        return new Response(JSON.stringify({ error: '이름과 학교명을 입력해주세요.' }), { status: 400, headers: corsHeaders });
      }

      const seq = edgeConfig.nextTicketNumber++;
      const ticketNumber = `${edgeConfig.ticketPrefix}-${String(seq).padStart(3, '0')}`;
      const accessToken = 'st-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);

      const newItem = {
        id: 'id-' + Date.now(),
        ticketNumber,
        sequenceNumber: seq,
        accessToken,
        name,
        school,
        status: 'WAITING',
        callCount: 0,
        assignedSlot: null,
        registeredAt: new Date().toISOString(),
        notifiedStages: ['REGISTERED'],
        pushSubscription: null,
      };
      edgeItems.push(newItem);

      return new Response(
        JSON.stringify({
          ticketNumber,
          accessToken,
          name,
          school,
          status: 'WAITING',
          waitingAheadCount: edgeItems.filter((i) => i.status === 'WAITING' && i.sequenceNumber < seq).length,
          currentCallingNumber: 'A-001',
          noticeMessage: edgeConfig.noticeMessage,
          returnGuidance: 'IMMINENT',
          callCount: 0,
          assignedSlot: null,
          hasPushSubscribed: false,
          registeredAt: newItem.registeredAt,
        }),
        { status: 201, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }

  // 4. /api/admin/action
  if (path === '/api/admin/action' && method === 'POST') {
    try {
      const body = await context.request.json().catch(() => ({}));
      const { itemId, action, slot } = body;
      const target = edgeItems.find((i) => i.id === itemId);
      if (target) {
        target.status = action;
        if (slot !== undefined) target.assignedSlot = slot;
        if (action === 'CALLED') target.callCount = (target.callCount || 0) + 1;
      }
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }

  // 5. /api/admin/reset
  if (path === '/api/admin/reset' && method === 'POST') {
    edgeItems = [];
    edgeConfig.nextTicketNumber = 1;
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          items: [],
          stats: { totalRegistered: 0, totalWaiting: 0, totalCalling: 0, totalPhotoEditing: 0, totalInPress: 0, totalCompleted: 0, totalAbsent: 0, totalReWaiting: 0, totalCancelled: 0 },
          config: edgeConfig,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  // 6. /api/queue/public
  if (path === '/api/queue/public') {
    const callingItems = edgeItems.filter((i) => i.status === 'CALLED');
    const waitingItems = edgeItems.filter((i) => i.status === 'WAITING');
    return new Response(
      JSON.stringify({
        currentCallingNumber: callingItems.length > 0 ? callingItems.map((i) => i.ticketNumber).join(', ') : '대기 중',
        calledStudents: callingItems.map((i) => ({ ticketNumber: i.ticketNumber, name: i.name, callCount: i.callCount })),
        totalWaiting: waitingItems.length,
        boothTitle: edgeConfig.boothTitle,
        noticeMessage: edgeConfig.noticeMessage,
        registrationStatus: edgeConfig.registrationStatus,
        recentCompletedNumber: edgeItems.filter((i) => i.status === 'COMPLETED').slice(-1)[0]?.ticketNumber || '없음',
        minutesPerPerson: edgeConfig.minutesPerPerson,
        estimatedWaitMinutes: waitingItems.length * edgeConfig.minutesPerPerson,
        inPhotoEditing: edgeItems.filter((i) => i.status === 'PHOTO_EDITING').map((i) => ({ ticketNumber: i.ticketNumber, name: i.name })),
        press1: edgeItems.find((i) => i.status === 'ASSIGNED_PRESS_1'),
        press2: edgeItems.find((i) => i.status === 'ASSIGNED_PRESS_2'),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  // 7. /api/queue/ticket
  if (path.startsWith('/api/queue/ticket')) {
    const token = url.searchParams.get('token');
    const item = edgeItems.find((i) => i.accessToken === token);
    if (!item) {
      return new Response(JSON.stringify({ error: '대기 정보를 찾을 수 없습니다.' }), { status: 404, headers: corsHeaders });
    }
    const waitingAheadCount = edgeItems.filter((i) => i.status === 'WAITING' && i.sequenceNumber < item.sequenceNumber).length;
    return new Response(
      JSON.stringify({
        ticketNumber: item.ticketNumber,
        name: item.name,
        school: item.school,
        status: item.status,
        waitingAheadCount,
        currentCallingNumber: 'A-001',
        noticeMessage: edgeConfig.noticeMessage,
        returnGuidance: waitingAheadCount <= 2 ? 'IMMINENT' : waitingAheadCount <= 5 ? 'PREPARE' : 'WAIT',
        callCount: item.callCount,
        assignedSlot: item.assignedSlot,
        hasPushSubscribed: false,
        registeredAt: item.registeredAt,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  // 8. /api/queue/stream (SSE)
  if (path === '/api/queue/stream') {
    return new Response('data: {"type":"CONNECTED"}\n\n', {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        ...corsHeaders,
      },
    });
  }

  // Default fallback
  return new Response(JSON.stringify({ success: true, message: 'Cloudflare Edge Active' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}
