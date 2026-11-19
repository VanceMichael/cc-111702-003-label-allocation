import { PHASE, TERMINAL_PHASES } from './phases.mjs';

const WAITING_LABELS = {
  [PHASE.VERIFY_PRINT]: '等待打印回执通道核实原作业',
  [PHASE.VERIFY_PLATFORM]: '等待承运平台核实号码与交寄状态',
  [PHASE.AWAIT_DESTRUCTION]: '等待现场确认原纸面单已销毁',
  [PHASE.VOID_REQUEST]: '等待向承运平台发起作废',
  [PHASE.VOID_PENDING]: '等待承运平台给出作废结论与额度回收',
  [PHASE.REISSUE_READY]: '等待重新领取承运号码',
};

const STATUS_LABELS = {
  [PHASE.VERIFY_PRINT]: '打印核实中',
  [PHASE.VERIFY_PLATFORM]: '平台核实中',
  [PHASE.AWAIT_DESTRUCTION]: '等待现场销毁确认',
  [PHASE.VOID_REQUEST]: '待发起作废',
  [PHASE.VOID_PENDING]: '作废受理核实中',
  [PHASE.REISSUE_READY]: '作废完成待重开',
  [PHASE.DONE]: '重开完成',
  [PHASE.REFUSED_HANDOVER]: '已交寄不可作废',
  [PHASE.VOID_REJECTED]: '平台拒绝作废',
  [PHASE.REISSUE_FAILED]: '重开失败旧号已失效',
};

function derive(parcel) {
  const reopen = parcel.reopen;
  const hasUsableNumber = Boolean(parcel.number);
  const inFlight = Boolean(reopen) && !TERMINAL_PHASES.has(reopen.phase);

  // 可打印：有可用号、没有已打印事实，且该包裹没有进行中的重开
  const printable = hasUsableNumber && parcel.printed !== true && !inFlight;
  // 可交寄：有可用号、平台未确认交寄限制，且没有进行中或已失效的重开
  const deliverable = hasUsableNumber && parcel.handedOver !== true && !inFlight && !(reopen && reopen.phase === PHASE.REISSUE_FAILED);

  let status = 'active';
  let waitingOn = [];
  let nextAction = null;
  if (reopen) {
    status = reopen.phase;
    if (WAITING_LABELS[reopen.phase]) waitingOn = [WAITING_LABELS[reopen.phase]];
    if (reopen.phase === PHASE.AWAIT_DESTRUCTION) nextAction = 'confirm-destruction';
    else if (reopen.phase === PHASE.REISSUE_READY) nextAction = 'reopen';
    else if (inFlight) nextAction = 'reopen';
  }
  return { printable, deliverable, status, statusLabel: STATUS_LABELS[status] ?? '正常', waitingOn, nextAction };
}

function presentParcel(parcelId, parcel) {
  const derived = derive(parcel);
  const entry = (parcel.history ?? []).find(item => item.number === parcel.number) ?? (parcel.history ?? []).at(-1) ?? null;
  const quotaReturned = entry?.quotaReturned ?? parcel.quotaReturned ?? false;
  return {
    parcel: parcelId,
    number: parcel.number,
    requestId: parcel.requestId,
    jobId: parcel.jobId,
    printed: parcel.printed === true,
    handedOver: parcel.handedOver === true,
    printable: derived.printable,
    deliverable: derived.deliverable,
    status: derived.status,
    statusLabel: derived.statusLabel,
    waitingOn: derived.waitingOn,
    nextAction: derived.nextAction,
    paperDestroyed: parcel.reopen?.paperDestroyed ?? false,
    voidRequest: parcel.reopen?.voidRequest ?? null,
    quotaReturned,
    history: structuredClone(parcel.history ?? []),
  };
}

export function present(state) {
  const parcels = Object.entries(state.parcels).map(([parcelId, parcel]) => presentParcel(parcelId, parcel));
  // 平台未确认回收的号码都占用额度（含作废核实中），回收后才释放
  let held = 0;
  for (const parcel of Object.values(state.parcels)) {
    for (const entry of parcel.history ?? []) if (entry.quotaReturned !== true) held += 1;
  }
  const pendingReturn = parcels.filter(item => item.status === PHASE.VOID_PENDING).length;
  return {
    parcels,
    used: held,
    remaining: Math.max(0, state.capacity - held),
    capacity: state.capacity,
    held,
    pendingReturn,
  };
}
