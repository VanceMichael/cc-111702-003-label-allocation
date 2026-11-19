import { allIssuedNumbers } from './numbers.mjs';

export function accept(state, request, data) {
  if (data.parcel !== request.parcel || !data.number || !data.jobId) throw new Error('面单归属不符');
  if (allIssuedNumbers(state).includes(data.number)) throw new Error('号码已归属其他包裹');
  const printed = data.printed === true;
  state.parcels[data.parcel] = {
    number: data.number,
    requestId: request.requestId,
    jobId: data.jobId,
    printed,
    handedOver: false,
    reopen: null,
    history: [{ number: data.number, requestId: request.requestId, jobId: data.jobId, printed, handedOver: false, status: 'active', quotaReturned: false }],
  };
  state.prints[data.jobId] = { number: data.number, printed };
  return data.parcel;
}

// 打印回执通道的事后核实：只登记打印事实，不推断平台号码状态
export function applyPrintReceipt(state, parcel, data) {
  if (data.number !== parcel.number || data.jobId !== parcel.jobId) throw new Error('打印回执不属于原包裹号码');
  if (data.printed === null || data.printed === undefined) return false;
  if (typeof data.printed !== 'boolean') throw new Error('打印事实格式不符');
  state.prints[data.jobId] = { number: data.number, printed: data.printed };
  if (data.printed) parcel.printed = true;
  return true;
}
