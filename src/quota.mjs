import { present } from './presentation.mjs';

export { present };

// 已被占用、平台尚未确认回收的号额（作废核实中也仍然占用）
export function heldQuota(state) {
  let held = 0;
  for (const parcel of Object.values(state.parcels)) {
    for (const entry of parcel.history ?? []) if (!entry.quotaReturned) held += 1;
    const covered = (parcel.history ?? []).some(entry => entry.number === parcel.number);
    if (parcel.number && !covered && parcel.quotaReturned !== true) held += 1;
  }
  return held;
}

export function assessIssue(state, request, data) {
  if (!Number.isInteger(data.quotaDebit) || data.quotaDebit !== 1) throw new Error('首次申领额度扣减不符');
  const remaining = state.capacity - heldQuota(state);
  if (remaining < data.quotaDebit) throw new Error('本地已确认额度不足，取消中的额度不得挪用');
  if (!Number.isInteger(data.remaining) || data.remaining < 0 || data.remaining !== remaining - data.quotaDebit) throw new Error('来源额度余额不一致');
  if (data.requestId !== request.requestId || data.parcel !== request.parcel) throw new Error('额度归属与原包裹请求不符');
  return { quotaDebit: data.quotaDebit, remaining: data.remaining };
}

export const assess = assessIssue;
