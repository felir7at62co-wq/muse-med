/** 绿泡泡 collector status shared by the server and the client. */

/** Stored board names start with this, so they never share history with another platform's board of the same name. */
export const LVPAOPAO_BOARD_PREFIX = '绿泡泡 · ';

/** States the Mac collector reports; `offline` and `not_configured` are derived by the server. */
export const LVPAOPAO_STATES = ['ok', 'collecting', 'recovering', 'waiting-login', 'reentry-failed', 'build-changed', 'offline-network', 'error'] as const;
export type LvpaopaoReportedState = typeof LVPAOPAO_STATES[number];
export type LvpaopaoState = LvpaopaoReportedState | 'offline' | 'never-connected' | 'not_configured';

/** States that stop collection until someone acts. */
export const LVPAOPAO_HUMAN_STATES: readonly LvpaopaoState[] = ['waiting-login', 'reentry-failed', 'build-changed', 'offline'];

export const LVPAOPAO_STATE_LABELS: Record<LvpaopaoState, string> = {
  ok: '运行正常', collecting: '正在采集', recovering: '正在自动恢复', 'waiting-login': '等待扫码登录', 'reentry-failed': '无法自动打开小程序',
  'build-changed': '微信版本变化', 'offline-network': 'Mac 断网', error: '采集出错', offline: 'Mac 采集端失联',
  'never-connected': '等待采集端接入', not_configured: '采集端未配置',
};

export const LVPAOPAO_ACTIONS = ['start-login', 'collect-now'] as const;
export type LvpaopaoAction = typeof LVPAOPAO_ACTIONS[number];

export interface LvpaopaoCommand { id: string; action: LvpaopaoAction; issuedAt: string; requestedBy: string; }

export interface LvpaopaoRunSummary {
  runId: string; kind: 'rankings' | 'engagement'; slot: string; status: 'complete' | 'partial' | 'failed'; reason: string | null;
  finishedAt: string; receivedAt: string; boards: number; dramas: number;
}

/** Status visible to every member; admins also get runs, pending commands and screenshot details. */
export interface LvpaopaoStatus {
  state: LvpaopaoState; label: string; message: string; needsHuman: boolean;
  lastHeartbeatAt: string | null; lastSuccessAt: string | null; nextSlot: string | null;
  wechat: { running: boolean; loggedIn: boolean | null } | null;
  pendingUploads: number;
  loginScreen: { capturedAt: string; kind: 'qr' | 'confirm' | 'unknown' } | null;
}

export interface LvpaopaoAdminStatus extends LvpaopaoStatus {
  runs: LvpaopaoRunSummary[]; commands: LvpaopaoCommand[]; alertsConfigured: boolean;
}

/** Human-readable reason codes from docs/lvpaopao.md; unknown codes are shown as sent. */
export const LVPAOPAO_REASONS: Record<string, string> = {
  'mac-asleep': 'Mac 处于睡眠', network: 'Mac 网络不可用', 'server-unreachable': '数据站暂时连不上', 'wechat-not-running': '隔离微信未运行',
  'wechat-logged-out': '微信已退出登录', 'reentry-failed': '无法自动打开小程序', 'target-timeout': '等待小程序超时', 'build-changed': '微信版本变化',
  'helper-error': '采集组件出错', 'business-error': '小程序接口返回错误', 'budget-exhausted': '今日请求预算已用完', cancelled: '已取消',
};
