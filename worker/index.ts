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
  // Google Apps Script 웹 앱 URL (시트에 서버가 직접 기록). 없으면 서버 측 시트 기록은 꺼짐.
  SHEET_WEBHOOK_URL?: string;
  SHEET_WEBHOOK_SECRET?: string;
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
const SHEET_HEADERS = ['대기 번호', '학생 이름', '학교명', '진행 상태', '배정 기계', '호출 횟수', '접수 시각', '호출 시각', '사진 편집 시작', '프레스 제작 시작', '체험 완료 시각'];

const STATUS_LABELS: Record<QueueStatus, string> = {
  WAITING: '대기 중',
  CALLED: '호출 중',
  PHOTO_EDITING: '사진 편집/출력',
  ASSIGNED_PRESS_1: '1번 프레스',
  ASSIGNED_PRESS_2: '2번 프레스',
  COMPLETED: '완료',
  ABSENT: '부재',
  RE_WAITING: '재대기',
  CANCELLED: '취소',
};
const statusLabel = (s: QueueStatus) => STATUS_LABELS[s] || s;

const SHEET_POLL_MS = 10_000;
const SHEET_POLL_IDLE_MS = 30 * 60 * 1000;

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
  private env: Env;
  private sheetTimer: ReturnType<typeof setTimeout> | null = null;
  private sheetInFlight = false;
  private sheetDirty = false;
  private lastSheetWriteAt = 0;
  // Monotonic state version; clients drop responses older than the newest they've seen.
  // Seeded from the clock so it keeps increasing across Durable Object restarts.
  private revision = Date.now();
  // What the server last wrote to the sheet, per ticket: [name, school, status, slot, callCount].
  // A pulled cell that differs from this was edited by a person in the sheet.
  private sheetBaseline = new Map<string, string[]>();

  constructor(ctx: any, env: Env) {
    this.ctx = ctx;
    this.env = env;
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
    this.revision = Math.max(Date.now(), this.revision + 1);
    await this.save();
    const data = JSON.stringify({ type: 'UPDATE', timestamp: Date.now() });
    for (const writer of this.sseClients) this.send(writer, `data: ${data}\n\n`);
    this.scheduleSheetWrite();
    this.evaluatePushAlerts().catch((e) => console.warn('Push alerts error:', e?.message));
  }

  // ---------------- Web Push ----------------
  private appOrigin = '';
  private vapid: { publicKey: string; privateJwk: JsonWebKey } | null = null;

  private async getVapidKeys() {
    if (this.vapid) return this.vapid;
    const stored = await this.ctx.storage.get('vapid');
    if (stored?.publicKey && stored?.privateJwk) {
      this.vapid = stored;
      return stored as { publicKey: string; privateJwk: JsonWebKey };
    }
    const pair: any = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicRaw = await crypto.subtle.exportKey('raw', pair.publicKey);
    const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
    const created = { publicKey: b64uEncode(publicRaw), privateJwk };
    await this.ctx.storage.put('vapid', created);
    this.vapid = created;
    return created;
  }

  private async sendPush(item: QueueItem, payload: { title: string; body: string; tag?: string }): Promise<boolean> {
    const sub = item.pushSubscription;
    if (!sub) return false;
    try {
      const vapid = await this.getVapidKeys();
      const message = JSON.stringify({
        title: payload.title,
        body: payload.body,
        url: `/?token=${item.accessToken}`,
        tag: payload.tag || 'badge-queue-alert',
        ticketNumber: item.ticketNumber,
      });
      const status = await sendWebPush(sub, message, vapid, this.appOrigin || 'https://canbadge.workers.dev');
      if (status === 404 || status === 410) {
        item.pushSubscription = null;
        await this.save();
        return false;
      }
      if (status < 200 || status >= 300) {
        console.warn(`Push failed for ${item.ticketNumber}: HTTP ${status}`);
        return false;
      }
      return true;
    } catch (e: any) {
      console.warn(`Push error for ${item.ticketNumber}:`, e?.message);
      return false;
    }
  }

  // Decide which stage alerts are due. Stages are marked synchronously before sending,
  // so overlapping evaluations never send the same alert twice.
  private async evaluatePushAlerts() {
    const due: { item: QueueItem; title: string; body: string; tag: string }[] = [];
    const mark = (item: QueueItem, stage: string) => {
      if (!item.notifiedStages) item.notifiedStages = [];
      if (item.notifiedStages.includes(stage)) return false;
      item.notifiedStages.push(stage);
      return true;
    };

    this.queueItems
      .filter(isWaiting)
      .sort(sortWaiting)
      .forEach((item, ahead) => {
        if (ahead <= this.config.imminentNotifyCount) {
          if (mark(item, 'IMMINENT_2')) {
            due.push({
              item,
              title: `[호출 임박] 곧 내 차례예요! (${item.ticketNumber})`,
              body: `앞에 ${ahead}명 남았습니다. 사진 접수대 앞으로 와 주세요.`,
              tag: `stage-imminent-${item.ticketNumber}`,
            });
          }
        } else if (ahead <= this.config.returnNotifyCount && mark(item, 'RETURN_5')) {
          due.push({
            item,
            title: `[복귀 안내] 차례가 가까워졌어요 (${item.ticketNumber})`,
            body: `앞에 ${ahead}명 남았습니다. 캔뱃지 부스 근처로 돌아와 주세요.`,
            tag: `stage-return-${item.ticketNumber}`,
          });
        }
      });

    for (const item of this.queueItems) {
      if (item.status === 'CALLED' && mark(item, `CALLED_${item.callCount}`)) {
        due.push({
          item,
          title: `★ 지금 입장해 주세요! (${item.ticketNumber})`,
          body: `${item.ticketNumber}번 학생, 사진 접수대로 와 주세요. (${item.callCount}차 호출)`,
          tag: `stage-called-${item.ticketNumber}`,
        });
      } else if (item.status === 'ASSIGNED_PRESS_1' && mark(item, 'PRESS_1')) {
        due.push({
          item,
          title: `[이동 안내] 1번 프레스 기계로 가세요! (${item.ticketNumber})`,
          body: '사진 출력이 끝났어요. 1번 프레스 기계에서 캔뱃지를 만들어요!',
          tag: `stage-press1-${item.ticketNumber}`,
        });
      } else if (item.status === 'ASSIGNED_PRESS_2' && mark(item, 'PRESS_2')) {
        due.push({
          item,
          title: `[이동 안내] 2번 프레스 기계로 가세요! (${item.ticketNumber})`,
          body: '사진 출력이 끝났어요. 2번 프레스 기계에서 캔뱃지를 만들어요!',
          tag: `stage-press2-${item.ticketNumber}`,
        });
      }
    }

    if (due.length === 0) return;
    await this.save();
    await Promise.all(
      due.filter((d) => d.item.pushSubscription).map((d) => this.sendPush(d.item, d))
    );
  }

  // ---------------- Server-side Google Sheet sync (Apps Script webhook) ----------------
  // The server is the only reader/writer of the sheet, so no browser needs a Google login.
  private sheetWriteGen = 0;

  private get sheetWebhookEnabled() {
    return Boolean(this.env.SHEET_WEBHOOK_URL);
  }

  // Coalesce bursts of updates into one write; never run two writes at once.
  private scheduleSheetWrite() {
    if (!this.sheetWebhookEnabled) return;
    this.sheetDirty = true;
    if (this.sheetTimer || this.sheetInFlight) return;
    this.sheetTimer = setTimeout(() => {
      this.sheetTimer = null;
      this.flushSheetWrite();
    }, 500);
  }

  private async flushSheetWrite() {
    if (!this.sheetDirty) return;
    this.sheetDirty = false;
    this.sheetInFlight = true;
    try {
      const payload = this.buildSheetPayload();
      if (await this.writeSheetViaWebhook(payload)) {
        this.sheetBaseline = new Map(
          payload.rows.map((r) => [
            String(r[0]),
            [String(r[1]).replace(/^'/, ''), String(r[2]).replace(/^'/, ''), String(r[3]), String(r[4]), String(r[5])],
          ])
        );
      }
    } catch (e: any) {
      console.warn('Sheet write error:', e?.message);
    } finally {
      this.sheetInFlight = false;
      this.sheetWriteGen += 1;
      this.lastSheetWriteAt = Date.now();
      if (this.sheetDirty) this.scheduleSheetWrite();
    }
  }

  private async writeSheetViaWebhook(payload: ReturnType<BoothState['buildSheetPayload']>): Promise<boolean> {
    const res = await fetch(this.env.SHEET_WEBHOOK_URL!, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: this.env.SHEET_WEBHOOK_SECRET || '', ...payload }),
    });
    const text = await res.text();
    if (!res.ok || !text.includes('"ok":true')) {
      console.warn('Sheet webhook failed:', res.status, text.slice(0, 200));
      return false;
    }
    return true;
  }

  private async readSheetViaWebhook(): Promise<string[][]> {
    const res = await fetch(this.env.SHEET_WEBHOOK_URL!, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: this.env.SHEET_WEBHOOK_SECRET || '', action: 'read' }),
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {}
    if (!res.ok || !data?.ok || !Array.isArray(data.rows)) {
      throw new Error(`시트 읽기 실패 (Apps Script): ${data?.error || text.slice(0, 120)}`);
    }
    return data.rows.map((r: unknown[]) => r.map((v) => String(v ?? '')));
  }

  // ---------------- Automatic sheet → app sync (no admin browser needed) ----------------
  // With the Apps Script webhook, a Durable Object alarm checks the sheet every SHEET_POLL_MS
  // for hand edits. It only keeps polling while the booth is in use, to stay within Apps Script quotas.
  private lastActivityAt = Date.now();
  private pollAlarmSet = false;

  private async ensureSheetPoll() {
    if (!this.sheetWebhookEnabled || this.pollAlarmSet) return;
    this.pollAlarmSet = true;
    await this.ctx.storage.setAlarm(Date.now() + SHEET_POLL_MS);
  }

  async alarm() {
    this.pollAlarmSet = false;
    if (!this.sheetWebhookEnabled) return;
    const active = this.sseClients.size > 0 || Date.now() - this.lastActivityAt < SHEET_POLL_IDLE_MS;
    if (!active) return; // the next request will restart polling
    try {
      await this.pullSheet({});
    } catch (e: any) {
      console.warn('Scheduled sheet pull failed:', e?.message);
    }
    await this.ensureSheetPoll();
  }

  private buildSheetPayload() {
    const fmt = (s?: string) => (s ? new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '');
    const items = this.queueItems;
    // Student-typed text must not be evaluated as a sheet formula
    const safe = (s: string) => (/^[=+\-@]/.test(s) ? `'${s}` : s);
    const rows = items.map((i) => [
      i.ticketNumber,
      safe(i.name),
      safe(i.school),
      statusLabel(i.status),
      i.assignedSlot ? `${i.assignedSlot}호기` : '-',
      i.callCount,
      fmt(i.registeredAt),
      fmt(i.calledAt),
      fmt(i.editingStartedAt),
      fmt(i.pressStartedAt),
      fmt(i.completedAt),
    ]);
    const desk = items.find((i) => i.status === 'PHOTO_EDITING' || i.status === 'CALLED');
    const press1 = items.find((i) => i.status === 'ASSIGNED_PRESS_1');
    const press2 = items.find((i) => i.status === 'ASSIGNED_PRESS_2');
    const summary = [
      ['부스 운영 지표', '실시간 현황 값'],
      ['총 접수 인원', items.length],
      ['현재 대기 인원', items.filter(isWaiting).length],
      ['체험 완료 인원', items.filter((i) => i.status === 'COMPLETED').length],
      ['사진 접수대 진행 번호', desk ? desk.ticketNumber : '비어 있음'],
      ['프레스 1호기 진행 번호', press1 ? press1.ticketNumber : '비어 있음'],
      ['프레스 2호기 진행 번호', press2 ? press2.ticketNumber : '비어 있음'],
      ['마지막 시트 동기화 시각', new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })],
    ];
    return { headers: SHEET_HEADERS, rows, summary };
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

    return {
      items: adminItems,
      stats,
      config: this.config,
      revision: this.revision,
      serverWritesSheet: true,
      // Apps Script set up: the server both writes and reads the sheet, no Google login needed in the browser
      serverSyncsSheet: this.sheetWebhookEnabled,
    };
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
    this.appOrigin = url.origin;
    this.lastActivityAt = Date.now();
    await this.ensureSheetPoll();

    // Public endpoints
    if (path === '/api/health') {
      return json({
        ok: true,
        timestamp: new Date().toISOString(),
        sheetWebhook: this.sheetWebhookEnabled,
        sheetWriter: this.sheetWebhookEnabled ? 'apps-script' : 'none',
      });
    }
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

    if (path === '/api/vapid-public-key') {
      const vapid = await this.getVapidKeys();
      return json({ publicKey: vapid.publicKey });
    }
    if (path === '/api/queue/push-subscribe' && method === 'POST') {
      const { token, subscription } = body;
      if (!token || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
        return json({ error: '유효한 토큰과 푸시 구독 정보가 필요합니다.' }, 400);
      }
      const item = this.queueItems.find((i) => i.accessToken === token);
      if (!item) return json({ error: '대기 정보를 찾을 수 없습니다.' }, 404);

      item.pushSubscription = subscription;
      await this.save();
      const sent = await this.sendPush(item, {
        title: `[접수 완료] ${item.ticketNumber}번 대기표 등록`,
        body: `${item.name}님, 순서가 가까워지면 이 알림으로 알려드릴게요!`,
        tag: `welcome-${item.ticketNumber}`,
      });
      if (!sent) {
        return json({ error: '알림 등록은 되었지만 테스트 알림 발송에 실패했습니다. 잠시 후 다시 시도해 주세요.' }, 502);
      }
      await this.broadcastUpdate();
      return json({ success: true, message: '푸시 알림 등록 완료' });
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
      if (path === '/api/admin/reset' && method === 'POST') return this.reset(body);
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
      if (path === '/api/admin/sheet-sync' && method === 'POST') {
        if (!this.sheetWebhookEnabled) return json({ error: '시트 자동 동기화(Apps Script)가 설정되지 않았습니다.' }, 400);
        this.scheduleSheetWrite();
        return json({ success: true });
      }
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

  private async reset(body: any): Promise<Response> {
    const { clearAllData, resetCounterOnly } = body;
    if (resetCounterOnly) {
      this.config.nextTicketNumber = 1;
    } else if (clearAllData) {
      this.queueItems = [];
      this.config.nextTicketNumber = 1;
      this.lastResetTime = Date.now();
      // broadcastUpdate below rewrites the sheet with the now-empty list (Apps Script clears old rows)
      this.sheetBaseline.clear();
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
    if (!this.sheetWebhookEnabled) {
      return json({ error: '시트 자동 동기화(Apps Script)가 설정되지 않았습니다.' }, 400);
    }

    const unchanged = () => json({ success: true, hasChanges: false, rowsUpdated: 0, data: this.getAdminData() });
    // While a sheet write is pending, the sheet is stale: pulling now would revert fresh app changes.
    const writePending = () => this.sheetDirty || this.sheetInFlight || Boolean(this.sheetTimer);
    if (!body.forceImport && writePending()) return unchanged();
    if (!body.forceImport && this.sheetBaseline.size === 0 && this.queueItems.length > 0) {
      // No record of what the sheet should contain yet (e.g. after a restart): write first, compare later.
      this.scheduleSheetWrite();
      return unchanged();
    }
    const writeGenAtStart = this.sheetWriteGen;

    try {
      const rows = await this.readSheetViaWebhook();

      // A write started or finished while we were reading: what we read may predate it.
      if (!body.forceImport && (writePending() || this.sheetWriteGen !== writeGenAtStart)) return unchanged();

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
          // Only cells a person changed in the sheet (differ from what the server last wrote) are applied.
          // Without a baseline for this row we can't tell an edit from a stale value, so leave it alone.
          const base = this.sheetBaseline.get(ticketNumber);
          if (!base && !body.forceImport) continue;
          const cells = [name, school, statusStr, assignedSlotStr, (row[5] || '').trim()];
          const edited = cells.map((v, idx) => !base || v !== base[idx]);
          this.sheetBaseline.set(ticketNumber, cells);

          if (edited[0] && name && existing.name !== name) {
            existing.name = name;
            hasChanges = true;
          }
          if (edited[1] && school && existing.school !== school) {
            existing.school = school;
            hasChanges = true;
          }
          if (edited[2] && statusStr) {
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
          if (edited[3]) {
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
          }
          if (edited[4] && callCount !== existing.callCount) {
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

// ----------------------------------------------------
// Web Push helpers (VAPID RFC 8292 + aes128gcm RFC 8291) on WebCrypto
// ----------------------------------------------------
const utf8 = (s: string) => new TextEncoder().encode(s);

function b64uEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

async function sendWebPush(
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  vapid: { publicKey: string; privateJwk: JsonWebKey },
  subject: string
): Promise<number> {
  // 1. VAPID JWT (ES256)
  const header = b64uEncode(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64uEncode(
    utf8(
      JSON.stringify({
        aud: new URL(sub.endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: subject,
      })
    )
  );
  const unsigned = `${header}.${claims}`;
  const signKey = await crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKey, utf8(unsigned));
  const jwt = `${unsigned}.${b64uEncode(signature)}`;

  // 2. Payload encryption (aes128gcm)
  const uaPublic = b64uDecode(sub.keys.p256dh);
  const authSecret = b64uDecode(sub.keys.auth);
  const local: any = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as any, local.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concatBytes(utf8('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, concatBytes(utf8(payload), new Uint8Array([2])))
  );

  const recordHeader = new Uint8Array(16 + 4 + 1 + asPublic.length);
  recordHeader.set(salt, 0);
  new DataView(recordHeader.buffer).setUint32(16, 4096);
  recordHeader[20] = asPublic.length;
  recordHeader.set(asPublic, 21);

  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '3600',
      Urgency: 'high',
    },
    body: concatBytes(recordHeader, cipher),
  });
  if (res.status >= 400) console.warn('Push service response:', res.status, (await res.text()).slice(0, 200));
  else await res.body?.cancel();
  return res.status;
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
