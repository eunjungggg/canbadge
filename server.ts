import express, { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import webpush from 'web-push';
import { fileURLToPath } from 'url';
import type {
  QueueItem,
  BoothConfig,
  QueueStatus,
  StudentTicketDTO,
  PublicBoardDTO,
  AdminQueueItemDTO,
  AdminStatsDTO,
  ReturnGuidanceType,
} from './src/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ----------------------------------------------------
// 1. Web Push VAPID Configuration
// ----------------------------------------------------
const VAPID_FILE = path.join(DATA_DIR, 'vapid-keys.json');
let vapidKeys: { publicKey: string; privateKey: string };

if (fs.existsSync(VAPID_FILE)) {
  try {
    vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf-8'));
  } catch {
    vapidKeys = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2));
  }
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2));
}

webpush.setVapidDetails(
  'mailto:booth-admin@school-fair.local',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// ----------------------------------------------------
// 2. Data Store & Persistence
// ----------------------------------------------------
const DB_FILE = path.join(DATA_DIR, 'booth-data.json');

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

let queueItems: QueueItem[] = [];
let config: BoothConfig = { ...defaultConfig };
let lastResetTime = 0;

function loadData() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
      if (parsed.queueItems && Array.isArray(parsed.queueItems)) {
        queueItems = parsed.queueItems;
      }
      if (parsed.config) {
        config = { ...defaultConfig, ...parsed.config };
        if (config.returnNotifyCount === 8) {
          config.returnNotifyCount = 5;
          config.imminentNotifyCount = 2;
        }
      }
    } catch (e) {
      console.error('Failed to load db file, using defaults', e);
    }
  }
}

function saveData() {
  try {
    fs.writeFileSync(
      DB_FILE,
      JSON.stringify({ queueItems, config }, null, 2),
      'utf-8'
    );
  } catch (e) {
    console.error('Failed to save db file', e);
  }
}

loadData();

// ----------------------------------------------------
// 3. SSE Clients for Real-time Broadcasting
// ----------------------------------------------------
const sseClients: Response[] = [];

function broadcastUpdate() {
  saveData();
  const data = JSON.stringify({ type: 'UPDATE', timestamp: Date.now() });
  for (let i = sseClients.length - 1; i >= 0; i--) {
    const client = sseClients[i];
    try {
      if (client.writableEnded || client.destroyed) {
        sseClients.splice(i, 1);
      } else {
        client.write(`data: ${data}\n\n`);
      }
    } catch (e) {
      sseClients.splice(i, 1);
    }
  }
}

// Keep SSE connections alive through Cloud Run / proxy with 15s heartbeat
setInterval(() => {
  for (let i = sseClients.length - 1; i >= 0; i--) {
    const client = sseClients[i];
    try {
      if (client.writableEnded || client.destroyed) {
        sseClients.splice(i, 1);
      } else {
        client.write(': ping\n\n');
      }
    } catch (e) {
      sseClients.splice(i, 1);
    }
  }
}, 15000);

// ----------------------------------------------------
// 4. Web Push Notification Helper
// ----------------------------------------------------
async function sendPush(
  item: QueueItem,
  payload: { title: string; body: string; url?: string; tag?: string }
) {
  if (!item.pushSubscription) return false;

  try {
    const dataString = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url || `/status?token=${item.accessToken}`,
      tag: payload.tag || 'badge-queue-alert',
      ticketNumber: item.ticketNumber,
    });

    await webpush.sendNotification(item.pushSubscription as any, dataString);
    return true;
  } catch (err: any) {
    console.warn(`Push failed for ${item.ticketNumber}:`, err?.statusCode || err?.message);
    if (err?.statusCode === 410 || err?.statusCode === 404) {
      item.pushSubscription = null;
    }
    return false;
  }
}

async function evaluatePushAlerts() {
  const waitingList = queueItems
    .filter((i) => i.status === 'WAITING' || i.status === 'RE_WAITING')
    .sort((a, b) => {
      if (a.status === 'RE_WAITING' && b.status !== 'RE_WAITING') return -1;
      if (b.status === 'RE_WAITING' && a.status !== 'RE_WAITING') return 1;
      return a.sequenceNumber - b.sequenceNumber;
    });

  for (let index = 0; index < waitingList.length; index++) {
    const item = waitingList[index];
    const aheadCount = index;

    if (!item.notifiedStages) item.notifiedStages = [];

    if (aheadCount <= config.imminentNotifyCount && !item.notifiedStages.includes('IMMINENT_2')) {
      item.notifiedStages.push('IMMINENT_2');
      await sendPush(item, {
        title: `[호출 임박] 내 순서가 다가왔습니다! (${item.ticketNumber})`,
        body: `앞에 ${aheadCount}명이 남아 있습니다. 사진 접수 및 편집대 앞으로 이동해 주세요.`,
        tag: `stage-imminent-${item.ticketNumber}`,
      });
    } else if (aheadCount <= config.returnNotifyCount && !item.notifiedStages.includes('RETURN_5')) {
      item.notifiedStages.push('RETURN_5');
      await sendPush(item, {
        title: `[부스 복귀 안내] 차례가 가까워졌습니다 (${item.ticketNumber})`,
        body: `앞에 ${aheadCount}명이 남아 있습니다. 캔뱃지 부스 근처로 복귀해 주세요.`,
        tag: `stage-return-${item.ticketNumber}`,
      });
    }
  }

  // Check CALLED items
  const calledItems = queueItems.filter((i) => i.status === 'CALLED');
  for (const item of calledItems) {
    if (!item.notifiedStages) item.notifiedStages = [];
    const stageKey = `CALLED_${item.callCount}`;
    if (!item.notifiedStages.includes(stageKey)) {
      item.notifiedStages.push(stageKey);
      await sendPush(item, {
        title: `★ [지금 입장해 주세요!] 사진 접수대 호출 (${item.ticketNumber})`,
        body: `대기번호 ${item.ticketNumber}번 학생! 사진 접수 및 편집대로 입장해 주세요. (${item.callCount}차 호출)`,
        tag: `stage-called-${item.ticketNumber}`,
      });
    }
  }

  // Check Assigned Press Machine notifications
  for (const item of queueItems) {
    if (!item.notifiedStages) item.notifiedStages = [];
    if (item.status === 'ASSIGNED_PRESS_1' && !item.notifiedStages.includes('PRESS_1')) {
      item.notifiedStages.push('PRESS_1');
      await sendPush(item, {
        title: `[기계 이동 안내] 1번 프레스 기계로 가세요! (${item.ticketNumber})`,
        body: `사진 편집/커팅이 완료되었습니다. 1번 프레스 기계로 이동하여 캔뱃지를 제작하세요!`,
        tag: `stage-press1-${item.ticketNumber}`,
      });
    } else if (item.status === 'ASSIGNED_PRESS_2' && !item.notifiedStages.includes('PRESS_2')) {
      item.notifiedStages.push('PRESS_2');
      await sendPush(item, {
        title: `[기계 이동 안내] 2번 프레스 기계로 가세요! (${item.ticketNumber})`,
        body: `사진 편집/커팅이 완료되었습니다. 2번 프레스 기계로 이동하여 캔뱃지를 제작하세요!`,
        tag: `stage-press2-${item.ticketNumber}`,
      });
    }
  }
}

// ----------------------------------------------------
// 5. View Helpers (Duration and estimate removed per user request)
// ----------------------------------------------------
function calculateStudentView(token: string): StudentTicketDTO | null {
  const item = queueItems.find((i) => i.accessToken === token);
  if (!item) return null;

  const callingList = queueItems
    .filter((i) => i.status === 'CALLED')
    .map((i) => i.ticketNumber);
  const currentCallingNumber = callingList.length > 0 ? callingList.join(', ') : '대기 중';

  let waitingAheadCount = 0;
  if (item.status === 'WAITING' || item.status === 'RE_WAITING') {
    const sortedWaiting = queueItems
      .filter((i) => i.status === 'WAITING' || i.status === 'RE_WAITING')
      .sort((a, b) => {
        if (a.status === 'RE_WAITING' && b.status !== 'RE_WAITING') return -1;
        if (b.status === 'RE_WAITING' && a.status !== 'RE_WAITING') return 1;
        return a.sequenceNumber - b.sequenceNumber;
      });
    const myIndex = sortedWaiting.findIndex((i) => i.id === item.id);
    waitingAheadCount = myIndex >= 0 ? myIndex : 0;
  }

  let returnGuidance: ReturnGuidanceType = 'NORMAL';
  if (item.status === 'CALLED') {
    returnGuidance = 'NOW_CALLED';
  } else if (item.status === 'PHOTO_EDITING') {
    returnGuidance = 'PHOTO_EDITING';
  } else if (item.status === 'ASSIGNED_PRESS_1') {
    returnGuidance = 'GO_TO_PRESS_1';
  } else if (item.status === 'ASSIGNED_PRESS_2') {
    returnGuidance = 'GO_TO_PRESS_2';
  } else if (item.status === 'COMPLETED') {
    returnGuidance = 'COMPLETED';
  } else if (item.status === 'ABSENT') {
    returnGuidance = 'ABSENT';
  } else if (item.status === 'CANCELLED') {
    returnGuidance = 'CANCELLED';
  } else if (waitingAheadCount <= config.imminentNotifyCount) {
    returnGuidance = 'IMMINENT';
  } else if (waitingAheadCount <= config.returnNotifyCount) {
    returnGuidance = 'PREPARE_RETURN';
  } else {
    returnGuidance = 'NORMAL';
  }

  return {
    ticketNumber: item.ticketNumber,
    name: item.name,
    school: item.school,
    status: item.status,
    waitingAheadCount,
    currentCallingNumber,
    noticeMessage: config.noticeMessage,
    returnGuidance,
    callCount: item.callCount,
    assignedSlot: item.assignedSlot,
    hasPushSubscribed: Boolean(item.pushSubscription),
    registeredAt: item.registeredAt,
  };
}

function getPublicBoard(): PublicBoardDTO {
  const photoEditingTickets = queueItems
    .filter((i) => i.status === 'PHOTO_EDITING')
    .map((i) => i.ticketNumber);
  const photoEditingTicket = photoEditingTickets.length > 0 ? photoEditingTickets.join(', ') : null;

  const activeSlots = [1, 2].map((slotNum) => {
    const pressStatus = slotNum === 1 ? 'ASSIGNED_PRESS_1' : 'ASSIGNED_PRESS_2';
    const activeStudent = queueItems.find(
      (i) => i.status === pressStatus || (i.assignedSlot === slotNum && i.status === 'CALLED')
    );

    if (activeStudent) {
      return {
        slotNumber: slotNum,
        ticketNumber: activeStudent.ticketNumber,
        status: (activeStudent.status === pressStatus ? 'IN_PROGRESS' : 'CALLING') as
          | 'IN_PROGRESS'
          | 'CALLING',
      };
    }
    return {
      slotNumber: slotNum,
      ticketNumber: null,
      status: 'IDLE' as const,
    };
  });

  const callingTickets = queueItems
    .filter((i) => i.status === 'CALLED')
    .map((i) => i.ticketNumber);

  const waitingTickets = queueItems
    .filter((i) => i.status === 'WAITING' || i.status === 'RE_WAITING')
    .sort((a, b) => {
      if (a.status === 'RE_WAITING' && b.status !== 'RE_WAITING') return -1;
      if (b.status === 'RE_WAITING' && a.status !== 'RE_WAITING') return 1;
      return a.sequenceNumber - b.sequenceNumber;
    })
    .map((i) => i.ticketNumber);

  return {
    registrationStatus: config.registrationStatus,
    noticeMessage: config.noticeMessage,
    photoEditingTicket,
    activeSlots,
    callingTickets,
    waitingTickets,
    totalWaitingCount: waitingTickets.length,
    totalCompletedCount: queueItems.filter((i) => i.status === 'COMPLETED').length,
    totalRegisteredCount: queueItems.length,
    concurrentCapacity: config.concurrentCapacity,
    googleSheetUrl: config.googleSheetUrl,
  };
}

function getAdminData() {
  const adminItems: AdminQueueItemDTO[] = queueItems.map((i) => ({
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

  const stats: AdminStatsDTO = {
    totalRegistered: queueItems.length,
    totalWaiting: queueItems.filter((i) => i.status === 'WAITING').length,
    totalCalling: queueItems.filter((i) => i.status === 'CALLED').length,
    totalPhotoEditing: queueItems.filter((i) => i.status === 'PHOTO_EDITING').length,
    totalInPress: queueItems.filter(
      (i) => i.status === 'ASSIGNED_PRESS_1' || i.status === 'ASSIGNED_PRESS_2'
    ).length,
    totalCompleted: queueItems.filter((i) => i.status === 'COMPLETED').length,
    totalAbsent: queueItems.filter((i) => i.status === 'ABSENT').length,
    totalReWaiting: queueItems.filter((i) => i.status === 'RE_WAITING').length,
    totalCancelled: queueItems.filter((i) => i.status === 'CANCELLED').length,
  };

  return {
    items: adminItems,
    stats,
    config,
  };
}

// ----------------------------------------------------
// 6. Admin Auth Middleware
// ----------------------------------------------------
const ADMIN_TOKENS_FILE = path.join(DATA_DIR, 'admin-tokens.json');
const activeAdminTokens = new Set<string>();

function loadAdminTokens() {
  if (fs.existsSync(ADMIN_TOKENS_FILE)) {
    try {
      const arr = JSON.parse(fs.readFileSync(ADMIN_TOKENS_FILE, 'utf-8'));
      if (Array.isArray(arr)) {
        arr.forEach((t) => {
          if (typeof t === 'string') activeAdminTokens.add(t);
        });
      }
    } catch (e) {
      console.error('Failed to load admin tokens', e);
    }
  }
}

function saveAdminTokens() {
  try {
    fs.writeFileSync(ADMIN_TOKENS_FILE, JSON.stringify(Array.from(activeAdminTokens)), 'utf-8');
  } catch (e) {
    console.error('Failed to save admin tokens', e);
  }
}

loadAdminTokens();

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  // Allow direct admin password verification fallback
  if (
    req.body?.adminPassword === config.adminPasswordHash ||
    req.headers['x-admin-password'] === config.adminPasswordHash
  ) {
    return next();
  }
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '관리자 로그인이 필요합니다.' });
  }
  const token = authHeader.substring(7);
  if (!activeAdminTokens.has(token)) {
    return res.status(401).json({ error: '인증 토큰이 유효하지 않거나 만료되었습니다.' });
  }
  next();
}

app.use(express.json());

// ----------------------------------------------------
// 7. Public Endpoints
// ----------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.get('/api/queue/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sseClients.push(res);
  res.write(`data: ${JSON.stringify({ type: 'CONNECTED' })}\n\n`);

  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

app.get('/api/queue/public', (req, res) => {
  res.json(getPublicBoard());
});

app.get('/api/queue/ticket', (req, res) => {
  const token = req.query.token as string;
  if (!token) return res.status(400).json({ error: '조회 토큰이 누락되었습니다.' });

  const ticketData = calculateStudentView(token);
  if (!ticketData) return res.status(404).json({ error: '대기 정보를 찾을 수 없습니다.' });

  res.json(ticketData);
});

app.post('/api/queue/register', async (req, res) => {
  if (config.registrationStatus !== 'OPEN') {
    return res.status(400).json({
      error:
        config.registrationStatus === 'PAUSED'
          ? '현재 대기 접수가 일시 중지되었습니다.'
          : '금일 체험 부스 대기 접수가 마감되었습니다.',
    });
  }

  const { name, school } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: '이름을 입력해 주세요.' });
  }
  if (!school || typeof school !== 'string' || !school.trim()) {
    return res.status(400).json({ error: '학교명을 입력해 주세요.' });
  }

  const seq = config.nextTicketNumber;
  config.nextTicketNumber += 1;

  const ticketNumber = `${config.ticketPrefix}-${String(seq).padStart(3, '0')}`;
  const accessToken = crypto.randomUUID();
  const id = crypto.randomUUID();

  const newItem: QueueItem = {
    id,
    ticketNumber,
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
  };

  queueItems.push(newItem);

  broadcastUpdate();
  await evaluatePushAlerts();

  const studentView = calculateStudentView(accessToken);
  res.status(201).json({ ...studentView, accessToken });
});

app.post('/api/queue/push-subscribe', async (req, res) => {
  const { token, subscription } = req.body;
  if (!token || !subscription || !subscription.endpoint) {
    return res.status(400).json({ error: '유효한 토큰과 푸시 구독 정보가 필요합니다.' });
  }

  const item = queueItems.find((i) => i.accessToken === token);
  if (!item) return res.status(404).json({ error: '대기 정보를 찾을 수 없습니다.' });

  item.pushSubscription = subscription;
  saveData();

  await sendPush(item, {
    title: `[접수 완료] ${item.ticketNumber}번 대기표 등록`,
    body: `${item.name}님, 캔뱃지 체험 부스 대기 등록이 완료되었습니다. 순서가 오면 알려드립니다!`,
    tag: `welcome-${item.ticketNumber}`,
  });

  res.json({ success: true, message: '푸시 알림 등록 완료' });
});

// ----------------------------------------------------
// 8. Admin Endpoints
// ----------------------------------------------------
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === config.adminPasswordHash) {
    const adminToken = crypto.randomUUID();
    activeAdminTokens.add(adminToken);
    saveAdminTokens();
    res.json({ success: true, token: adminToken, config });
  } else {
    res.status(401).json({ error: '관리자 비밀번호가 일치하지 않습니다.' });
  }
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    activeAdminTokens.delete(token);
    saveAdminTokens();
  }
  res.json({ success: true });
});

app.get('/api/admin/queue', requireAdmin, (req, res) => {
  res.json(getAdminData());
});

app.post('/api/admin/call-next', requireAdmin, async (req, res) => {
  const nextCandidate = queueItems
    .filter((i) => i.status === 'RE_WAITING' || i.status === 'WAITING')
    .sort((a, b) => {
      if (a.status === 'RE_WAITING' && b.status !== 'RE_WAITING') return -1;
      if (b.status === 'RE_WAITING' && a.status !== 'RE_WAITING') return 1;
      return a.sequenceNumber - b.sequenceNumber;
    })[0];

  if (nextCandidate) {
    nextCandidate.status = 'CALLED';
    nextCandidate.callCount = (nextCandidate.callCount || 0) + 1;
    nextCandidate.calledAt = new Date().toISOString();
  }

  broadcastUpdate();
  await evaluatePushAlerts();

  res.json({
    success: true,
    calledTicket: nextCandidate ? nextCandidate.ticketNumber : null,
    data: getAdminData(),
  });
});

app.post('/api/admin/action', requireAdmin, async (req, res) => {
  const { id, action } = req.body;
  const item = queueItems.find((i) => i.id === id);

  if (!item) {
    return res.status(404).json({ error: '대기 학생을 찾을 수 없습니다.' });
  }

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
      const delIdx = queueItems.findIndex((i) => i.id === id);
      if (delIdx !== -1) queueItems.splice(delIdx, 1);
      break;

    default:
      return res.status(400).json({ error: '알 수 없는 조작 명령입니다.' });
  }

  broadcastUpdate();
  await evaluatePushAlerts();

  res.json({ success: true, data: getAdminData() });
});

app.post('/api/admin/config', requireAdmin, (req, res) => {
  const updates = req.body;
  if (updates.boothTitle) config.boothTitle = String(updates.boothTitle).slice(0, 50);
  if (['OPEN', 'PAUSED', 'CLOSED'].includes(updates.registrationStatus)) {
    config.registrationStatus = updates.registrationStatus;
  }
  if (typeof updates.noticeMessage === 'string') {
    config.noticeMessage = updates.noticeMessage.slice(0, 200);
  }
  if (typeof updates.ticketPrefix === 'string' && updates.ticketPrefix.trim()) {
    config.ticketPrefix = updates.ticketPrefix.trim().slice(0, 5).toUpperCase();
  }
  if (typeof updates.adminPassword === 'string' && updates.adminPassword.trim().length >= 4) {
    config.adminPasswordHash = updates.adminPassword.trim();
  }
  if (typeof updates.googleSheetId === 'string') {
    config.googleSheetId = updates.googleSheetId.trim();
  }
  if (typeof updates.googleSheetUrl === 'string') {
    config.googleSheetUrl = updates.googleSheetUrl.trim();
  }
  if (typeof updates.returnNotifyCount === 'number' && updates.returnNotifyCount > 0) {
    config.returnNotifyCount = updates.returnNotifyCount;
  }

  saveData();
  broadcastUpdate();
  res.json({ success: true, config });
});

// Google Sheets Sync & Pull Endpoints (Google Sheets as Primary Database)
app.post('/api/sheets/pull', requireAdmin, async (req, res) => {
  const { googleToken, spreadsheetId } = req.body;
  if (!googleToken || !spreadsheetId) {
    return res.status(400).json({ error: 'Google 인증 토큰과 시트 ID가 필요합니다.' });
  }

  try {
    const range = encodeURIComponent('대기자 명단!A2:K1000');
    const sheetRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`,
      {
        headers: { Authorization: `Bearer ${googleToken}` },
      }
    );

    if (!sheetRes.ok) {
      const err = await sheetRes.json().catch(() => ({}));
      if (sheetRes.status === 401) {
        return res.status(401).json({
          code: 'GOOGLE_TOKEN_EXPIRED',
          error: '구글 로그인 인증 토큰이 만료되었습니다. 상단 [Google 계정 다시 로그인] 버튼을 눌러주세요.',
        });
      }
      throw new Error(err?.error?.message || '구글 시트 읽기 실패');
    }

    const sheetData = await sheetRes.json();
    const rows = sheetData.values || [];

    // If reset was executed within 15 seconds and current queue is empty, do not re-import old rows
    if (Date.now() - lastResetTime < 15000 && queueItems.length === 0) {
      return res.json({ success: true, hasChanges: false, rowsUpdated: 0, data: getAdminData() });
    }

    // Parse status back to enum with robust aliases
    const parseStatus = (raw: string): QueueStatus => {
      const s = (raw || '').trim().replace(/\s+/g, '');
      if (
        s === '완료' ||
        s === '체험완료' ||
        s === '제작완료' ||
        s.toUpperCase() === 'COMPLETED' ||
        s === '종료' ||
        s === '끝' ||
        s === '완성'
      ) {
        return 'COMPLETED';
      }
      if (s.includes('1번') || s.includes('1호')) {
        return 'ASSIGNED_PRESS_1';
      }
      if (s.includes('2번') || s.includes('2호')) {
        return 'ASSIGNED_PRESS_2';
      }
      if (
        s.includes('사진') ||
        s.includes('편집') ||
        s.includes('출력') ||
        s.includes('인쇄') ||
        s.includes('커팅') ||
        s.toUpperCase() === 'PHOTO_EDITING'
      ) {
        return 'PHOTO_EDITING';
      }
      if (s.includes('호출') || s.toUpperCase() === 'CALLED') {
        return 'CALLED';
      }
      if (s.includes('부재') || s.toUpperCase() === 'ABSENT') {
        return 'ABSENT';
      }
      if (s.includes('재대기') || s.toUpperCase() === 'RE_WAITING') {
        return 'RE_WAITING';
      }
      if (s.includes('취소') || s.toUpperCase() === 'CANCELLED') {
        return 'CANCELLED';
      }
      return 'WAITING';
    };

    let hasChanges = false;

    if (rows.length > 0) {
      rows.forEach((row: string[]) => {
        const ticketNumber = (row[0] || '').trim();
        if (!ticketNumber) return;

        const name = (row[1] || '').trim();
        const school = (row[2] || '').trim();
        const statusStr = (row[3] || '').trim();
        const assignedSlotStr = (row[4] || '').trim();
        const callCount = Number(row[5]) || 0;

        const existing = queueItems.find((i) => i.ticketNumber === ticketNumber);
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
                if (!existing.completedAt) existing.completedAt = new Date().toISOString();
                existing.assignedSlot = null;
              } else if (newStatus === 'ASSIGNED_PRESS_1') {
                existing.assignedSlot = 1;
                if (!existing.pressStartedAt) existing.pressStartedAt = new Date().toISOString();
              } else if (newStatus === 'ASSIGNED_PRESS_2') {
                existing.assignedSlot = 2;
                if (!existing.pressStartedAt) existing.pressStartedAt = new Date().toISOString();
              } else if (newStatus === 'PHOTO_EDITING') {
                existing.assignedSlot = null;
                if (!existing.editingStartedAt) existing.editingStartedAt = new Date().toISOString();
              } else if (newStatus === 'CALLED') {
                if (!existing.calledAt) existing.calledAt = new Date().toISOString();
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
        } else if (ticketNumber && name) {
          // If queue is empty (e.g. freshly reset), only import if user explicitly clicked "시트에서 불러오기" (forceImport: true)
          if (queueItems.length === 0 && !req.body.forceImport) {
            return;
          }
          // Student manually created in Google Sheet
          queueItems.push({
            id: crypto.randomUUID(),
            ticketNumber,
            sequenceNumber: queueItems.length + 1,
            accessToken: crypto.randomUUID(),
            name,
            school: school || '인천비즈니스고',
            status: parseStatus(statusStr || '대기 중'),
            callCount: callCount || 0,
            assignedSlot: assignedSlotStr.includes('1') ? 1 : assignedSlotStr.includes('2') ? 2 : null,
            registeredAt: new Date().toISOString(),
            notifiedStages: ['REGISTERED'],
            pushSubscription: null,
          });
          hasChanges = true;
        }
      });
    }

    if (hasChanges) {
      broadcastUpdate();
    }

    res.json({ success: true, hasChanges, rowsUpdated: rows.length, data: getAdminData() });
  } catch (err: any) {
    res.status(500).json({ error: err.message || '시트 동기화 실패' });
  }
});

app.post('/api/admin/reset', requireAdmin, async (req, res) => {
  const { clearAllData, resetCounterOnly, googleToken } = req.body;
  if (resetCounterOnly) {
    config.nextTicketNumber = 1;
  } else if (clearAllData) {
    queueItems = [];
    config.nextTicketNumber = 1;
    lastResetTime = Date.now();

    // Clear Google Sheet if connected and token provided
    const token = googleToken || req.headers['x-google-token'];
    const sheetId = config.googleSheetId;
    if (token && sheetId) {
      try {
        // 1. Batch clear candidate ranges
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchClear`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ranges: [
              "'대기자 명단'!A2:K2000",
              "대기자 명단!A2:K2000",
            ],
          }),
        }).catch(() => {});

        // 2. Clear range with proper !
        const clearRange = encodeURIComponent('대기자 명단') + '!A2:K2000';
        await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${clearRange}:clear`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
          }
        ).catch(() => {});

        // 3. Reset Summary tab
        const resetSummaryValues = [
          ['부스 운영 지표', '실시간 현황 값'],
          ['총 접수 인원', 0],
          ['현재 대기 인원', 0],
          ['체험 완료 인원', 0],
          ['사진 접수대 진행 번호', '비어 있음'],
          ['프레스 1호기 진행 번호', '비어 있음'],
          ['프레스 2호기 진행 번호', '비어 있음'],
          ['마지막 초기화 시각', new Date().toLocaleString('ko-KR')],
        ];

        const summaryRange = encodeURIComponent('실시간 부스 현황') + '!A1:B8';
        await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${summaryRange}?valueInputOption=USER_ENTERED`,
          {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              range: '실시간 부스 현황!A1:B8',
              majorDimension: 'ROWS',
              values: resetSummaryValues,
            }),
          }
        ).catch(() => {});
      } catch (sheetErr) {
        console.error('Failed to clear google sheet on backend reset:', sheetErr);
      }
    }
  }

  saveData();
  broadcastUpdate();
  res.json({ success: true, data: getAdminData() });
});

app.post('/api/admin/purge-pii', requireAdmin, (req, res) => {
  queueItems.forEach((i, idx) => {
    i.name = `익명학생_${idx + 1}`;
    i.school = '○○학교';
    i.pushSubscription = null;
  });
  broadcastUpdate();
  res.json({ success: true, data: getAdminData() });
});

app.get('/api/admin/export', requireAdmin, (req, res) => {
  const headers = [
    '대기번호',
    '이름',
    '학교명',
    '진행상태',
    '배정프레스',
    '호출횟수',
    '접수시각',
    '호출시각',
    '편집시작시각',
    '프레스시작시각',
    '체험완료시각',
  ];

  const rows = queueItems.map((item) => [
    item.ticketNumber,
    `"${item.name.replace(/"/g, '""')}"`,
    `"${item.school.replace(/"/g, '""')}"`,
    item.status,
    item.assignedSlot ? `${item.assignedSlot}호기` : '-',
    item.callCount,
    item.registeredAt ? new Date(item.registeredAt).toLocaleString('ko-KR') : '',
    item.calledAt ? new Date(item.calledAt).toLocaleString('ko-KR') : '',
    item.editingStartedAt ? new Date(item.editingStartedAt).toLocaleString('ko-KR') : '',
    item.pressStartedAt ? new Date(item.pressStartedAt).toLocaleString('ko-KR') : '',
    item.completedAt ? new Date(item.completedAt).toLocaleString('ko-KR') : '',
  ]);

  const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="canbadge_booth_report_${new Date().toISOString().slice(0, 10)}.csv"`
  );
  res.send(csvContent);
});

// Prevent unhandled /api requests from falling through to Vite's index.html fallback
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: `API endpoint not found: ${req.method} ${req.path}` });
});

// ----------------------------------------------------
// 9. Vite Dev & Static Server
// ----------------------------------------------------
async function setupFrontend() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Booth Server] Server running on http://0.0.0.0:${PORT}`);
  });
}

setupFrontend().catch((err) => {
  console.error('Failed to start server:', err);
});
