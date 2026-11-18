export function prepare(state, input) {
  const parcel = input.parcel ?? 'P1';
  if (state.parcels[parcel]) throw new Error('包裹已有申领记录');
  return { parcel, requestId: input.requestId ?? 'R1' };
}
