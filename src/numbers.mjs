export function prepare(state, input) {
  const parcel = input.parcel ?? 'P1';
  if (state.parcels[parcel]) throw new Error('包裹已有申领记录');
  return { parcel, requestId: input.requestId ?? 'R1' };
}

export function allIssuedNumbers(state) {
  const numbers = [];
  for (const parcel of Object.values(state.parcels)) {
    for (const entry of parcel.history ?? []) numbers.push(entry.number);
    if (parcel.number && !(parcel.history ?? []).some(item => item.number === parcel.number)) numbers.push(parcel.number);
  }
  return numbers;
}

export function resolve(state, request, data) {
  if (data.requestId !== request.requestId || data.parcel !== request.parcel) throw new Error('申领结果不属于原包裹请求');
  if (!data.number || !data.jobId || typeof data.printed !== 'boolean') throw new Error('面单及打印事实缺失');
  if (allIssuedNumbers(state).includes(data.number)) throw new Error('面单号码已分配或已失效，不得复用');
  return data;
}
