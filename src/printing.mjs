export function accept(state, request, data) {
  if (data.parcel !== request.parcel || !data.number || !data.jobId) throw new Error('面单归属不符');
  if (Object.values(state.parcels).some(item => item.number === data.number)) throw new Error('号码已归属其他包裹');
  state.parcels[data.parcel] = { number: data.number, requestId: request.requestId, jobId: data.jobId };
  state.prints[data.jobId] = { number: data.number, printed: data.printed === true };
  return data.parcel;
}
