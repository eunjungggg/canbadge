export type QueueStatus =
  | 'WAITING'           // 접수 후 대기 중
  | 'CALLED'            // 사진 접수/편집대로 호출 중
  | 'PHOTO_EDITING'     // 1단계: 사진 접수 및 편집/커팅 진행 중
  | 'ASSIGNED_PRESS_1'  // 2단계: 1번 프레스 기계로 이동 및 뱃지 제작
  | 'ASSIGNED_PRESS_2'  // 2단계: 2번 프레스 기계로 이동 및 뱃지 제작
  | 'COMPLETED'         // 체험 완료
  | 'ABSENT'            // 부재 처리
  | 'RE_WAITING'        // 늦게 돌아온 학생 재대기
  | 'CANCELLED';        // 취소

export interface PushSubscriptionJSON {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface QueueItem {
  id: string;
  ticketNumber: string;       // e.g. "A-001"
  sequenceNumber: number;     // 1, 2, 3...
  accessToken: string;        // 학생 본인 조회용 비밀 토큰
  name: string;               // 학생 이름
  school: string;             // 소속 학교명
  status: QueueStatus;
  callCount: number;          // 호출 횟수 (0~3)
  assignedSlot: number | null;// 1 또는 2 (프레스 기계 번호)
  registeredAt: string;       // ISO string
  calledAt?: string;
  editingStartedAt?: string;
  pressStartedAt?: string;
  completedAt?: string;
  pushSubscription?: PushSubscriptionJSON | null;
  notifiedStages: string[];
}

export interface BoothConfig {
  boothTitle: string;
  registrationStatus: 'OPEN' | 'PAUSED' | 'CLOSED';
  noticeMessage: string;
  concurrentCapacity: number;  // 2대 프레스
  returnNotifyCount: number;    // 5명
  imminentNotifyCount: number;  // 2명
  maxCallCount: number;         // 3회
  ticketPrefix: string;         // 'A'
  nextTicketNumber: number;
  adminPasswordHash: string;
  minutesPerPerson?: number;
  googleSheetId?: string;       // 연동된 구글 스프레드시트 ID
  googleSheetUrl?: string;      // 구글 스프레드시트 URL
}

export type ReturnGuidanceType =
  | 'NORMAL'             // 여유 있음
  | 'PREPARE_RETURN'     // 앞 5명 이하: 부스 근처 복귀 준비
  | 'IMMINENT'           // 앞 2명 이하: 사진 접수대 앞 대기 임박
  | 'NOW_CALLED'         // 사진 접수/편집대로 지금 오세요!
  | 'PHOTO_EDITING'       // 사진 편집 및 재단 중
  | 'GO_TO_PRESS_1'      // 1번 프레스 기계로 이동하세요!
  | 'GO_TO_PRESS_2'      // 2번 프레스 기계로 이동하세요!
  | 'COMPLETED'          // 체험 완료
  | 'ABSENT'             // 부재
  | 'CANCELLED';         // 취소됨

export interface StudentTicketDTO {
  ticketNumber: string;
  name: string;
  school: string;
  status: QueueStatus;
  waitingAheadCount: number;
  currentCallingNumber: string;
  noticeMessage: string;
  returnGuidance: ReturnGuidanceType;
  callCount: number;
  assignedSlot: number | null;
  hasPushSubscribed: boolean;
  registeredAt: string;
}

export interface PublicBoardDTO {
  registrationStatus: 'OPEN' | 'PAUSED' | 'CLOSED';
  noticeMessage: string;
  photoEditingTicket: string | null; // 사진 편집/커팅 중인 번호
  activeSlots: {
    slotNumber: number;
    ticketNumber: string | null;
    status: 'IDLE' | 'CALLING' | 'IN_PROGRESS';
  }[];
  callingTickets: string[];
  waitingTickets: string[];
  totalWaitingCount: number;
  totalCompletedCount: number;
  totalRegisteredCount: number;
  concurrentCapacity: number;
  googleSheetUrl?: string;
}

export interface AdminQueueItemDTO {
  id: string;
  ticketNumber: string;
  sequenceNumber: number;
  name: string;
  school: string;
  status: QueueStatus;
  callCount: number;
  assignedSlot: number | null;
  registeredAt: string;
  calledAt?: string;
  editingStartedAt?: string;
  pressStartedAt?: string;
  completedAt?: string;
  hasPush: boolean;
}

export interface AdminStatsDTO {
  totalRegistered: number;
  totalWaiting: number;
  totalCalling: number;
  totalPhotoEditing: number;
  totalInPress: number;
  totalCompleted: number;
  totalAbsent: number;
  totalReWaiting: number;
  totalCancelled: number;
}
