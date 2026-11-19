import { allIssuedNumbers } from './numbers.mjs';
import { applyPrintReceipt } from './printing.mjs';
import { assessIssue } from './quota.mjs';
import { PHASE, TERMINAL_PHASES, HELD_PHASES } from './phases.mjs';

export { PHASE };

const TERMINAL = TERMINAL_PHASES;

function fill(route, params) {
  let path = route.path;
  for (const [key, value] of Object.entries(params)) path = path.replace(`:${key}`, encodeURIComponent(String(value)));
  return { method: route.method, path };
}

// 决定本次继续办理要做的一步；返回 null 表示当前处于等待/终态，无需再请求来源
export function planReopen(state, input, routes) {
  const parcelId = input.parcel ?? 'P1';
  const parcel = state.parcels[parcelId];
  if (!parcel) throw new Error('包裹尚无首次申领，不能办理重开');
  let reopen = parcel.reopen;
  if (!reopen) {
    if (parcel.handedOver) throw new Error('号码已交寄，不能办理重开');
    reopen = parcel.reopen = {
      phase: PHASE.VERIFY_PRINT,
      requestId: input.requestId ?? `R-${parcelId}-REOPEN`,
      voidRequest: null,
      paperDestroyed: false,
      printSettled: false,
      platformChecked: false,
      notes: [],
    };
  }
  if (TERMINAL.has(reopen.phase)) return null;
  if (HELD_PHASES.has(reopen.phase)) return null;

  const params = { number: parcel.number, id: reopen.voidRequest ?? '' };
  switch (reopen.phase) {
    case PHASE.VERIFY_PRINT:
      return { route: fill(routes.printReceipt, params), body: { jobId: parcel.jobId, number: parcel.number } };
    case PHASE.VERIFY_PLATFORM:
      return { route: fill(routes.label, params), body: { number: parcel.number } };
    case PHASE.VOID_REQUEST:
      return { route: fill(routes.void, params), body: { number: parcel.number, requestId: reopen.requestId } };
    case PHASE.VOID_PENDING:
      return { route: fill(routes.voidStatus, params), body: {} };
    case PHASE.REISSUE_READY:
      return { route: fill(routes.issue, params), body: { parcel: parcelId, requestId: reopen.requestId, reissue: true } };
    default:
      return null;
  }
}

function currentHistory(parcel) {
  return (parcel.history ?? []).find(entry => entry.number === parcel.number) ?? null;
}

// 作废轮询期间当前号码可能已被标记失效，按历史最后一条核对来源归属
function lastHistoryNumber(parcel) {
  const history = parcel.history ?? [];
  return history.length ? history[history.length - 1].number : null;
}

function markOldNumberDead(parcel, quotaReturned) {
  const entry = currentHistory(parcel); // 先取条目，再清空当前号码
  parcel.number = null;
  parcel.jobId = null;
  parcel.printable = false;
  if (entry) { entry.status = 'voided'; entry.quotaReturned = quotaReturned; }
}

// 把来源响应应用到重开进度；返回 { advanced, waiting }，advanced 表示状态机是否前进
export function applyReopenResponse(state, parcelId, route, data) {
  const parcel = state.parcels[parcelId];
  const reopen = parcel.reopen;
  const path = route.path;
  let advanced = false;

  if (reopen.phase === PHASE.VERIFY_PRINT) {
    if (data.jobId !== parcel.jobId || data.number !== (currentHistory(parcel)?.number)) throw new Error('打印回执不属于原包裹作业');
    const settled = applyPrintReceipt(state, parcel, data);
    if (!settled) { reopen.notes.push('打印通道尚未给出确定回执，保持核实中'); return { advanced: false, waiting: true }; }
    reopen.printSettled = true;
    reopen.phase = PHASE.VERIFY_PLATFORM;
    advanced = true;
  } else if (reopen.phase === PHASE.VERIFY_PLATFORM) {
    if (data.number !== parcel.number) throw new Error('平台核实结果不属于原号码');
    const handedOver = data.handover === true || data.status === 'handed-over';
    parcel.handedOver = handedOver;
    const entry = currentHistory(parcel);
    if (entry) { entry.handedOver = handedOver; entry.platformStatus = data.status; }
    reopen.platformChecked = true;
    if (handedOver) {
      reopen.phase = PHASE.REFUSED_HANDOVER;
      reopen.notes.push('平台确认号码已交寄，不能作废');
      return { advanced: true, waiting: false };
    }
    if (parcel.printed) {
      reopen.phase = PHASE.AWAIT_DESTRUCTION;
    } else {
      reopen.phase = PHASE.VOID_REQUEST;
      advanced = true;
    }
  } else if (path.includes('/void') && reopen.phase === PHASE.VOID_REQUEST) {
    if (data.number !== parcel.number) throw new Error('作废受理结果不属于原号码');
    if (data.status === 'rejected' || data.status === 'handed-over') {
      reopen.phase = data.status === 'handed-over' ? PHASE.REFUSED_HANDOVER : PHASE.VOID_REJECTED;
      reopen.notes.push(`平台明确拒绝作废：${data.reason ?? '未说明原因'}`);
      if (data.status === 'handed-over') { parcel.handedOver = true; const entry = currentHistory(parcel); if (entry) entry.handedOver = true; }
      return { advanced: true, waiting: false };
    }
    if (!data.voidRequest) throw new Error('作废受理号缺失');
    reopen.voidRequest = data.voidRequest;
    reopen.phase = PHASE.VOID_PENDING;
    advanced = true;
  } else if (reopen.phase === PHASE.VOID_PENDING) {
    if (!reopen.voidRequest || data.voidRequest !== reopen.voidRequest || data.number !== lastHistoryNumber(parcel)) throw new Error('作废结论不属于原受理请求');
    if (data.status === 'pending' || data.status === 'processing') {
      reopen.notes.push('平台作废仍在处理中');
      return { advanced: false, waiting: true };
    }
    if (data.status === 'rejected' || data.status === 'handed-over') {
      reopen.phase = data.status === 'handed-over' ? PHASE.REFUSED_HANDOVER : PHASE.VOID_REJECTED;
      reopen.notes.push(`平台最终拒绝作废：${data.reason ?? '未说明原因'}`);
      if (data.status === 'handed-over') { parcel.handedOver = true; const entry = currentHistory(parcel); if (entry) entry.handedOver = true; }
      return { advanced: true, waiting: false };
    }
    if (data.status !== 'completed') throw new Error('作废结论状态无法识别');
    if (data.quotaReturned !== true) throw new Error('平台未确认额度回收，不能进入重新领号');
    markOldNumberDead(parcel, true);
    reopen.phase = PHASE.REISSUE_READY;
    advanced = true;
  } else if (reopen.phase === PHASE.REISSUE_READY) {
    if (data.requestId !== reopen.requestId || data.parcel !== parcelId) throw new Error('重开结果不属于原包裹请求');
    if (!data.number || !data.jobId || typeof data.printed !== 'boolean') throw new Error('重开面单及打印事实缺失');
    if (allIssuedNumbers(state).includes(data.number)) throw new Error('面单号码已分配或已失效，不得复用');
    assessIssue(state, { parcel: parcelId, requestId: reopen.requestId }, data);
    const printed = data.printed === true;
    parcel.number = data.number;
    parcel.requestId = reopen.requestId;
    parcel.jobId = data.jobId;
    parcel.printed = printed;
    parcel.printable = !printed;
    parcel.handedOver = false;
    parcel.history.push({ number: data.number, requestId: reopen.requestId, jobId: data.jobId, printed, handedOver: false, status: 'active', quotaReturned: false });
    state.prints[data.jobId] = { number: data.number, printed };
    reopen.phase = PHASE.DONE;
    advanced = true;
  } else {
    throw new Error('重开进度与来源响应不匹配');
  }
  return { advanced, waiting: reopen.phase === PHASE.AWAIT_DESTRUCTION || reopen.phase === PHASE.VOID_PENDING || reopen.phase === PHASE.VERIFY_PRINT };
}

// 来源明确的业务拒绝（非2xx）：作废类拒绝转为终态，其余错误向上抛出以保持重试
export function applyReopenError(state, parcelId, error) {
  const parcel = state.parcels[parcelId];
  const reopen = parcel.reopen;
  const body = error.body ?? {};
  const reason = body.reason ?? body.error ?? error.message;
  if (error.status !== 409 && error.status !== 422 && error.status !== 410) throw error;

  if ((reopen.phase === PHASE.VOID_REQUEST || reopen.phase === PHASE.VOID_PENDING) && (body.reason === 'already-handed-over' || body.status === 'handed-over')) {
    reopen.phase = PHASE.REFUSED_HANDOVER;
    parcel.handedOver = true;
    const entry = currentHistory(parcel); if (entry) entry.handedOver = true;
    reopen.notes.push(`平台以已交寄拒绝作废：${reason}`);
    return { handled: true };
  }
  if (reopen.phase === PHASE.VOID_REQUEST) {
    reopen.phase = PHASE.VOID_REJECTED;
    reopen.notes.push(`平台拒绝作废受理：${reason}`);
    return { handled: true };
  }
  if (reopen.phase === PHASE.VOID_PENDING && body.status === 'rejected') {
    reopen.phase = PHASE.VOID_REJECTED;
    reopen.notes.push(`平台作废结论为拒绝：${reason}`);
    return { handled: true };
  }
  if (reopen.phase === PHASE.REISSUE_READY) {
    reopen.phase = PHASE.REISSUE_FAILED;
    reopen.notes.push(`重新领号被来源拒绝，旧号已失效：${reason}`);
    return { handled: true };
  }
  throw error;
}

// 来源网络故障（断线、超时等）：只登记等待事项，阶段不变，再次进入时按原进度重试
export function recordTrouble(state, parcelId, message) {
  const parcel = state.parcels[parcelId];
  if (!parcel?.reopen) throw new Error('包裹未在重开流程中，无法登记来源故障');
  parcel.reopen.notes.push(`来源暂时不可用，保持原阶段等待重试：${message}`);
  parcel.reopen.lastTrouble = message;
}

// 现场确认原纸销毁：只解决纸面问题，不改变平台号码状态
export function confirmDestruction(state, input) {
  const parcelId = input.parcel ?? 'P1';
  const parcel = state.parcels[parcelId];
  if (!parcel || !parcel.reopen) throw new Error('包裹未在重开流程中，不能登记销毁确认');
  const reopen = parcel.reopen;
  if (reopen.paperDestroyed) return { advanced: false };
  if (reopen.phase !== PHASE.AWAIT_DESTRUCTION) throw new Error('当前阶段不需要现场销毁确认');
  if (!parcel.printed) throw new Error('原面单没有打印事实，无需销毁确认');
  reopen.paperDestroyed = true;
  reopen.phase = PHASE.VOID_REQUEST;
  return { advanced: true };
}
