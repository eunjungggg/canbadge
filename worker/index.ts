// Cloudflare Worker entry: serves /api/* from a single Durable Object (persistent booth state + SSE),
// everything else from the built static assets (dist/).
import type {
  QueueItem,
  BoothConfig,
  QueueStatus,
  StudentTicketDTO,
  PublicBoardDTO,
  AdminQueueItemDTO,
  AdminStatsDTO,
  ReturnGuidanceType,
} from '../src/types';

interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  BOOTH: any;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const stub = env.BOOTH.get(env.BOOTH.idFromName('booth'));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

// ----------------------------------------------------
// Data defaults
// ----------------------------------------------------
const defaultConfig: BoothConfig = {
  boothTitle: '인천비즈니스고 콘텐츠디자인과 캔뱃지 체험 부스',
  registrationStatus: 'OPEN',
  noticeMessage: '부스에 오신 것을 환영합니다! 사진 접수 및 편집 후 1번/2번 프레스 기계로 안내해 드립니다.',
  concurrentCapacity: 2,
  returnNotifyCount: 5,
  imminentNotifyCount: 2,
  maxCallCount: 3,
  ticketPrefix: 'A',
  nextTicketNumber: 1,
  adminPasswordHash: 'badge2026',
};

const SHEET_TAB = '대기자 명단';
const SUMMARY_TAB = '실시간 부스 현황';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

const sortWaiting = (a: QueueItem, b: QueueItem) => {
  if (a.status === 'RE_WAITING' && b.status !== 'RE_WAITING') return -1;
  if (b.status === 'RE_WAITING' && a.status !== 'RE_WAITING') return 1;
  return a.sequenceNumber - b.sequenceNumber;
};

const isWaiting = (i: QueueItem) => i.status === 'WAITING' || i.status === 'RE_WAITING';

// ----------------------------------------------------
// Durable Object: single source of truth for the booth
// ----------------------------------------------------
export class BoothState {
  private ctx: any;
  private queueItems: QueueItem[] = [];
  private config: BoothConfig = { ...defaultConfig };
  private adminTokens = new Set<string>();
  private lastResetTime = 0;
  private sseClients = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private encoder = new TextEncoder();

  constructor(ctx: any, _env: Env) {
    this.ctx = ctx;
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get(['queueItems', 'config', 'adminTokens']);
      const items = stored.get('queueItems');
      if (Array.isArray(items)) this.queueItems = items;
      const cfg = stored.get('config');
      if (cfg) this.config = { ...defaultConfig, ...cfg };
      const tokens = stored.get('adminTokens');
      if (Array.isArray(tokens)) tokens.forEach((t: string) => this.adminTokens.add(t));
    });
  }

  private async save() {
    await this.ctx.storage.put({
      queueItems: this.queueItems,
      config: this.config,
      adminTokens: Array.from(this.adminTokens),
    });
  }

  private send(writer: WritableStreamDefaultWriter<Uint8Array>, chunk: string) {
    writer.write(this.encoder.encode(chunk)).catch(() => {
      this.sseClients.delete(writer);
    });
  }

  private async broadcastUpdate() {
    await this.save();
    const data = JSON.stringify({ type: 'UPDATE', timestamp: Date.now() });
    for (const writer of this.sseClients) this.send(writer, `data: ${data}\n\n`);
  }

  private openStream(): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    this.sseClients.add(writer);
    this.send(writer, `retry: 3000\ndata: ${JSON.stringify({ type: 'CONNECTED' })}\n\n`);

    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        for (const w of this.sseClients) this.send(w, ': ping\n\n');
        if (this.sseClients.size === 0 && this.heartbeat) {
          clearInterval(this.heartbeat);
          this.heartbeat = null;
        }
      }, 15000);
    }

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  // ---------------- View helpers ----------------
  private calculateStudentView(token: string): StudentTicketDTO | null {
    const item = this.queueItems.find((i) => i.accessToken === token);
    if (!item) return null;

    const callingList = this.queueItems.filter((i) => i.status === 'CALLED').map((i) => i.ticketNumber);
    const currentCallingNumber = callingList.length > 0 ? callingList.join(', ') : '대기 중';

    let waitingAheadCount = 0;
    if (isWaiting(item)) {
      const sorted = this.queueItems.filter(isWaiting).sort(sortWaiting);
      const myIndex = sorted.findIndex((i) => i.id === item.id);
      waitingAheadCount = myIndex >= 0 ? myIndex : 0;
    }

    let returnGuidance: ReturnGuidanceType = 'NORMAL';
    if (item.status === 'CALLED') returnGuidance = 'NOW_CALLED';
    else if (item.status === 'PHOTO_EDITING') returnGuidance = 'PHOTO_EDITING';
    else if (item.status === 'ASSIGNED_PRESS_1') returnGuidance = 'GO_TO_PRESS_1';
    else if (item.status === 'ASSIGNED_PRESS_2') returnGuidance = 'GO_TO_PRESS_2';
    else if (item.status === 'COMPLETED') returnGuidance = 'COMPLETED';
    else if (item.status === 'ABSENT') returnGuidance = 'ABSENT';
    else if (item.status === 'CANCELLED') returnGuidance = 'CANCELLED';
    else if (waitingAheadCount <= this.config.imminentNotifyCount) returnGuidance = 'IMMINENT';
    else if (waitingAheadCount <= this.config.returnNotifyCount) returnGuidance = 'PREPARE_RETURN';

    return {
      ticketNumber: item.ticketNumber,
      name: item.name,
      school: item.school,
      status: item.status,
      waitingAheadCount,
      currentCallingNumber,
      noticeMessage: this.config.noticeMessage,
      returnGuidance,
      callCount: item.callCount,
      assignedSlot: item.assignedSlot,
      hasPushSubscribed: Boolean(item.pushSubscription),
      registeredAt: item.registeredAt,
    };
  }

  private getPublicBoard(): PublicBoardDTO {
    const items = this.queueItems;
    const photoEditingTickets = items.filter((i) => i.status === 'PHOTO_EDITING').map((i) => i.ticketNumber);

    const activeSlots = [1, 2].map((slotNum) => {
      const pressStatus = slotNum === 1 ? 'ASSIGNED_PRESS_1' : 'ASSIGNED_PRESS_2';
      const active = items.find(
        (i) => i.status === pressStatus || (i.assignedSlot === slotNum && i.status === 'CALLED')
      );
      if (active) {
        return {
          slotNumber: slotNum,
          ticketNumber: active.ticketNumber,
          status: (active.status === pressStatus ? 'IN_PROGRESS' : 'CALLING') as 'IN_PROGRESS' | 'CALLING',
        };
      }
      return { slotNumber: slotNum, ticketNumber: null, status: 'IDLE' as const };
    });

    const waitingTickets = items.filter(isWaiting).sort(sortWaiting).map((i) => i.ticketNumber);

    return {
      registrationStatus: this.config.registrationStatus,
      noticeMessage: this.config.noticeMessage,
      photoEditingTicket: photoEditingTickets.length > 0 ? photoEditingTickets.join(', ') : null,
      activeSlots,
      callingTickets: items.filter((i) => i.status === 'CALLED').map((i) => i.ticketNumber),
      waitingTickets,
      totalWaitingCount: waitingTickets.length,
      totalCompletedCount: items.filter((i) => i.status === 'COMPLETED').length,
      totalRegisteredCount: items.length,
      concurrentCapacity: this.config.concurrentCapacity,
      googleSheetUrl: this.config.googleSheetUrl,
    };
  }

  private getAdminData() {
    const items = this.queueItems;
    const adminItems: AdminQueueItemDTO[] = items.map((i) => ({
      id: i.id,
      ticketNumber: i.ticketNumber,
      sequenceNumber: i.sequenceNumber,
      name: i.name,
      school: i.school,
      status: i.status,
      callCount: i.callCount,
      assignedSlot: i.assignedSlot,
      registeredAt: i.registeredAt,
      calledAt: i.calledAt,
      editingStartedAt: i.editingStartedAt,
      pressStartedAt: i.pressStartedAt,
      completedAt: i.completedAt,
      hasPush: Boolean(i.pushSubscription),
    }));

    const count = (s: QueueStatus) => items.filter((i) => i.status === s).length;
    const stats: AdminStatsDTO = {
      totalRegistered: items.length,
      totalWaiting: count('WAITING'),
      totalCalling: count('CALLED'),
      totalPhotoEditing: count('PHOTO_EDITING'),
      totalInPress: count('ASSIGNED_PRESS_1') + count('ASSIGNED_PRESS_2'),
      totalCompleted: count('COMPLETED'),
      totalAbsent: count('ABSENT'),
      totalReWaiting: count('RE_WAITING'),
      totalCancelled: count('CANCELLED'),
    };

    return { items: adminItems, stats, config: this.config };
  }

  private isAdmin(request: Request, body: any, url: URL): boolean {
    if (
      body?.adminPassword === this.config.adminPasswordHash ||
      request.headers.get('x-admin-password') === this.config.adminPasswordHash
    ) {
      return true;
    }
    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.substring(7) : url.searchParams.get('auth');
    return Boolean(token && this.adminTokens.has(token));
  }

  // ---------------- Router ----------------
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const body: any = method === 'POST' ? await request.json().catch(() => ({})) : {};

    // Public endpoints
    if (path === '/api/health') return json({ ok: true, timestamp: new Date().toISOString() });
    if (path === '/api/queue/stream' && method === 'GET') return this.openStream();
    if (path === '/api/queue/public' && method === 'GET') return json(this.getPublicBoard());

    if (path === '/api/queue/ticket' && method === 'GET') {
      const token = url.searchParams.get('token');
      if (!token) return json({ error: '조회 토큰이 누락되었습니다.' }, 400);
      const view = this.calculateStudentView(token);
      if (!view) return json({ error: '대기 정보를 찾을 수 없습니다.' }, 404);
      return json(view);
    }

    if (path === '/api/queue/register' && method === 'POST') return this.register(body);

    // Web Push is not available on the Workers runtime (web-push needs Node crypto)
    if (path === '/api/vapid-public-key') {
      return json({ error: '이 서버에서는 푸시 알림이 지원되지 않습니다.' }, 503);
    }
    if (path === '/api/queue/push-subscribe') {
      return json({ error: '이 서버에서는 푸시 알림이 지원되지 않습니다.' }, 503);
    }

    if (path === '/api/admin/login' && method === 'POST') {
      if (body.password === this.config.adminPasswordHash) {
        const token = crypto.randomUUID();
        this.adminTokens.add(token);
        await this.save();
        return json({ success: true, token, config: this.config });
      }
      return json({ error: '관리자 비밀번호가 일치하지 않습니다.' }, 401);
    }

    // Admin endpoints
    if (path.startsWith('/api/admin/') || path.startsWith('/api/sheets/')) {
      if (!this.isAdmin(request, body, url)) {
        return json({ error: '관리자 로그인이 필요합니다.' }, 401);
      }

      if (path === '/api/admin/logout' && method === 'POST') {
        const token = (request.headers.get('Authorization') || '').replace('Bearer ', '');
        if (token) {
          this.adminTokens.delete(token);
          await this.save();
        }
        return json({ success: true });
      }
      if (path === '/api/admin/queue' && method === 'GET') return json(this.getAdminData());
      if (path === '/api/admin/call-next' && method === 'POST') return this.callNext();
      if (path === '/api/admin/action' && method === 'POST') return this.action(body);
      if (path === '/api/admin/config' && method === 'POST') return this.updateConfig(body);
      if (path === '/api/admin/reset' && method === 'POST') return this.reset(body, request);
      if (path === '/api/admin/purge-pii' && method === 'POST') {
        this.queueItems.forEach((i, idx) => {
          i.name = `익명학생_${idx + 1}`;
          i.school = '○○학교';
          i.pushSubscription = null;
        });
        await this.broadcastUpdate();
        return json({ success: true, data: this.getAdminData() });
      }
      if (path === '/api/admin/export' && method === 'GET') return this.exportCsv();
      if (path === '/api/sheets/pull' && method === 'POST') return this.pullSheet(body);
    }

    return json({ error: `API endpoint not found: ${method} ${path}` }, 404);
  }

  // ---------------- Handlers ----------------
  private async register(body: any): Promise<Response> {
    const config = this.config;
    if (config.registrationStatus !== 'OPEN') {
      return json(
        {
          error:
            config.registrationStatus === 'PAUSED'
              ? '현재 대기 접수가 일시 중지되었습니다.'
              : '금일 체험 부스 대기 접수가 마감되었습니다.',
        },
        400
      );
    }

    const { name, school } = body;
    if (!name || typeof name !== 'string' || !name.trim()) return json({ error: '이름을 입력해 주세요.' }, 400);
    if (!school || typeof school !== 'string' || !school.trim()) return json({ error: '학교명을 입력해 주세요.' }, 400);

    const seq = config.nextTicketNumber;
    config.nextTicketNumber += 1;

    const accessToken = crypto.randomUUID();
    this.queueItems.push({
      id: crypto.randomUUID(),
      ticketNumber: `${config.ticketPrefix}-${String(seq).padStart(3, '0')}`,
      sequenceNumber: seq,
      accessToken,
      name: name.trim().slice(0, 30),
      school: school.trim().slice(0, 40),
      status: 'WAITING',
      callCount: 0,
      assignedSlot: null,
      registeredAt: new Date().toISOString(),
      notifiedStages: ['REGISTERED'],
      pushSubscription: null,
    });

    await this.broadcastUpdate();
    return json({ ...this.calculateStudentView(accessToken), accessToken }, 201);
  }

  private async callNext(): Promise<Response> {
    const next = this.queueItems.filter(isWaiting).sort(sortWaiting)[0];
    if (next) {
      next.status = 'CALLED';
      next.callCount = (next.callCount || 0) + 1;
      next.calledAt = new Date().toISOString();
    }
    await this.broadcastUpdate();
    return json({ success: true, calledTicket: next ? next.ticketNumber : null, data: this.getAdminData() });
  }

  private async action(body: any): Promise<Response> {
    const { id, action } = body;
    const item = this.queueItems.find((i) => i.id === id);
    if (!item) return json({ error: '대기 학생을 찾을 수 없습니다.' }, 404);

    const now = new Date().toISOString();
    switch (action) {
      case 'CALL':
      case 'RECALL':
        item.status = 'CALLED';
        item.callCount = (item.callCount || 0) + 1;
        item.calledAt = now;
        break;
      case 'START_EDITING':
        item.status = 'PHOTO_EDITING';
        item.editingStartedAt = now;
        break;
      case 'ASSIGN_PRESS_1':
        item.status = 'ASSIGNED_PRESS_1';
        item.assignedSlot = 1;
        item.pressStartedAt = now;
        break;
      case 'ASSIGN_PRESS_2':
        item.status = 'ASSIGNED_PRESS_2';
        item.assignedSlot = 2;
        item.pressStartedAt = now;
        break;
      case 'COMPLETE':
        item.status = 'COMPLETED';
        item.completedAt = now;
        item.assignedSlot = null;
        break;
      case 'MARK_ABSENT':
        item.status = 'ABSENT';
        item.assignedSlot = null;
        break;
      case 'RE_WAIT':
        item.status = 'RE_WAITING';
        item.callCount = 0;
        item.assignedSlot = null;
        break;
      case 'CANCEL':
        item.status = 'CANCELLED';
        item.assignedSlot = null;
        break;
      case 'DELETE':
        this.queueItems = this.queueItems.filter((i) => i.id !== id);
        break;
      default:
        return json({ error: '알 수 없는 조작 명령입니다.' }, 400);
    }

    await this.broadcastUpdate();
    return json({ success: true, data: this.getAdminData() });
  }

  private async updateConfig(updates: any): Promise<Response> {
    const config = this.config;
    if (updates.boothTitle) config.boothTitle = String(updates.boothTitle).slice(0, 50);
    if (['OPEN', 'PAUSED', 'CLOSED'].includes(updates.registrationStatus)) {
      config.registrationStatus = updates.registrationStatus;
    }
    if (typeof updates.noticeMessage === 'string') config.noticeMessage = updates.noticeMessage.slice(0, 200);
    if (typeof updates.ticketPrefix === 'string' && updates.ticketPrefix.trim()) {
      config.ticketPrefix = updates.ticketPrefix.trim().slice(0, 5).toUpperCase();
    }
    if (typeof updates.adminPassword === 'string' && updates.adminPassword.trim().length >= 4) {
      config.adminPasswordHash = updates.adminPassword.trim();
    }
    if (typeof updates.googleSheetId === 'string') config.googleSheetId = updates.googleSheetId.trim();
    if (typeof updates.googleSheetUrl === 'string') config.googleSheetUrl = updates.googleSheetUrl.trim();
    if (typeof updates.returnNotifyCount === 'number' && updates.returnNotifyCount > 0) {
      config.returnNotifyCount = updates.returnNotifyCount;
    }

    await this.broadcastUpdate();
    return json({ success: true, config });
  }

  private async reset(body: any, request: Request): Promise<Response> {
    const { clearAllData, resetCounterOnly, googleToken } = body;
    if (resetCounterOnly) {
      this.config.nextTicketNumber = 1;
    } else if (clearAllData) {
      this.queueItems = [];
      this.config.nextTicketNumber = 1;
      this.lastResetTime = Date.now();

      const token = googleToken || request.headers.get('x-google-token');
      const sheetId = this.config.googleSheetId;
      if (token && sheetId) {
        const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
        const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`;
        const clearRange = encodeURIComponent(SHEET_TAB) + '!A2:K2000';
        await fetch(`${base}/values/${clearRange}:clear`, { method: 'POST', headers }).catch(() => {});

        const summaryRange = encodeURIComponent(SUMMARY_TAB) + '!A1:B8';
        await fetch(`${base}/values/${summaryRange}?valueInputOption=USER_ENTERED`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            range: `${SUMMARY_TAB}!A1:B8`,
            majorDimension: 'ROWS',
            values: [
              ['부스 운영 지표', '실시간 현황 값'],
              ['총 접수 인원', 0],
              ['현재 대기 인원', 0],
              ['체험 완료 인원', 0],
              ['사진 접수대 진행 번호', '비어 있음'],
              ['프레스 1호기 진행 번호', '비어 있음'],
              ['프레스 2호기 진행 번호', '비어 있음'],
              ['마지막 초기화 시각', new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })],
            ],
          }),
        }).catch(() => {});
      }
    }

    await this.broadcastUpdate();
    return json({ success: true, data: this.getAdminData() });
  }

  private exportCsv(): Response {
    const fmt = (s?: string) => (s ? new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '');
    const headers = ['대기번호', '이름', '학교명', '진행상태', '배정프레스', '호출횟수', '접수시각', '호출시각', '편집시작시각', '프레스시작시각', '체험완료시각'];
    const rows = this.queueItems.map((item) => [
      item.ticketNumber,
      `"${item.name.replace(/"/g, '""')}"`,
      `"${item.school.replace(/"/g, '""')}"`,
      item.status,
      item.assignedSlot ? `${item.assignedSlot}호기` : '-',
      item.callCount,
      fmt(item.registeredAt),
      fmt(item.calledAt),
      fmt(item.editingStartedAt),
      fmt(item.pressStartedAt),
      fmt(item.completedAt),
    ]);
    const csv = '﻿' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="canbadge_booth_report_${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  private async pullSheet(body: any): Promise<Response> {
    const { googleToken, spreadsheetId } = body;
    if (!googleToken || !spreadsheetId) {
      return json({ error: 'Google 인증 토큰과 시트 ID가 필요합니다.' }, 400);
    }

    try {
      const range = encodeURIComponent(`${SHEET_TAB}!A2:K1000`);
      const sheetRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`, {
        headers: { Authorization: `Bearer ${googleToken}` },
      });

      if (!sheetRes.ok) {
        const err: any = await sheetRes.json().catch(() => ({}));
        if (sheetRes.status === 401) {
          return json(
            {
              code: 'GOOGLE_TOKEN_EXPIRED',
              error: '구글 로그인 인증 토큰이 만료되었습니다. 상단 [Google 계정 다시 로그인] 버튼을 눌러주세요.',
            },
            401
          );
        }
        throw new Error(err?.error?.message || '구글 시트 읽기 실패');
      }

      const sheetData: any = await sheetRes.json();
      const rows: string[][] = sheetData.values || [];

      if (Date.now() - this.lastResetTime < 15000 && this.queueItems.length === 0) {
        return json({ success: true, hasChanges: false, rowsUpdated: 0, data: this.getAdminData() });
      }

      let hasChanges = false;
      const nowIso = () => new Date().toISOString();

      for (const row of rows) {
        const ticketNumber = (row[0] || '').trim();
        if (!ticketNumber) continue;

        const name = (row[1] || '').trim();
        const school = (row[2] || '').trim();
        const statusStr = (row[3] || '').trim();
        const assignedSlotStr = (row[4] || '').trim();
        const callCount = Number(row[5]) || 0;

        const existing = this.queueItems.find((i) => i.ticketNumber === ticketNumber);
        if (existing) {
          if (name && existing.name !== name) {
            existing.name = name;
            hasChanges = true;
          }
          if (school && existing.school !== school) {
            existing.school = school;
            hasChanges = true;
          }
          if (statusStr) {
            const newStatus = parseStatus(statusStr);
            if (newStatus !== existing.status) {
              existing.status = newStatus;
              hasChanges = true;
              if (newStatus === 'COMPLETED') {
                if (!existing.completedAt) existing.completedAt = nowIso();
                existing.assignedSlot = null;
              } else if (newStatus === 'ASSIGNED_PRESS_1') {
                existing.assignedSlot = 1;
                if (!existing.pressStartedAt) existing.pressStartedAt = nowIso();
              } else if (newStatus === 'ASSIGNED_PRESS_2') {
                existing.assignedSlot = 2;
                if (!existing.pressStartedAt) existing.pressStartedAt = nowIso();
              } else if (newStatus === 'PHOTO_EDITING') {
                existing.assignedSlot = null;
                if (!existing.editingStartedAt) existing.editingStartedAt = nowIso();
              } else if (newStatus === 'CALLED') {
                if (!existing.calledAt) existing.calledAt = nowIso();
              }
            }
          }
          if (assignedSlotStr.includes('1') && existing.assignedSlot !== 1) {
            existing.assignedSlot = 1;
            hasChanges = true;
          } else if (assignedSlotStr.includes('2') && existing.assignedSlot !== 2) {
            existing.assignedSlot = 2;
            hasChanges = true;
          } else if ((assignedSlotStr === '-' || !assignedSlotStr) && existing.assignedSlot !== null) {
            existing.assignedSlot = null;
            hasChanges = true;
          }
          if (callCount !== existing.callCount) {
            existing.callCount = callCount;
            hasChanges = true;
          }
        } else if (name) {
          if (this.queueItems.length === 0 && !body.forceImport) continue;
          this.queueItems.push({
            id: crypto.randomUUID(),
            ticketNumber,
            sequenceNumber: this.queueItems.length + 1,
            accessToken: crypto.randomUUID(),
            name,
            school: school || '인천비즈니스고',
            status: parseStatus(statusStr || '대기 중'),
            callCount,
            assignedSlot: assignedSlotStr.includes('1') ? 1 : assignedSlotStr.includes('2') ? 2 : null,
            registeredAt: nowIso(),
            notifiedStages: ['REGISTERED'],
            pushSubscription: null,
          });
          hasChanges = true;
        }
      }

      if (hasChanges) await this.broadcastUpdate();
      return json({ success: true, hasChanges, rowsUpdated: rows.length, data: this.getAdminData() });
    } catch (err: any) {
      return json({ error: err?.message || '시트 동기화 실패' }, 500);
    }
  }
}

function parseStatus(raw: string): QueueStatus {
  const s = (raw || '').trim().replace(/\s+/g, '');
  const u = s.toUpperCase();
  if (['완료', '체험완료', '제작완료', '종료', '끝', '완성'].includes(s) || u === 'COMPLETED') return 'COMPLETED';
  if (s.includes('1번') || s.includes('1호')) return 'ASSIGNED_PRESS_1';
  if (s.includes('2번') || s.includes('2호')) return 'ASSIGNED_PRESS_2';
  if (['사진', '편집', '출력', '인쇄', '커팅'].some((k) => s.includes(k)) || u === 'PHOTO_EDITING') return 'PHOTO_EDITING';
  if (s.includes('재대기') || u === 'RE_WAITING') return 'RE_WAITING';
  if (s.includes('호출') || u === 'CALLED') return 'CALLED';
  if (s.includes('부재') || u === 'ABSENT') return 'ABSENT';
  if (s.includes('취소') || u === 'CANCELLED') return 'CANCELLED';
  return 'WAITING';
}
