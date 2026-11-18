export function present(state) {
  const parcels = Object.entries(state.parcels).map(([parcel, item]) => ({ parcel, ...item, printable: !state.prints[item.jobId]?.printed, handedOver: false }));
  const used = parcels.length;
  return { parcels, used, remaining: Math.max(0, state.capacity - used) };
}

export function assess(state, request, data) {
  if (!Number.isInteger(data.quotaDebit) || data.quotaDebit !== 1) throw new Error('首次申领额度扣减不符');
  const remaining = state.capacity - Object.keys(state.parcels).length;
  if (remaining < data.quotaDebit) throw new Error('本地已确认额度不足');
  if (!Number.isInteger(data.remaining) || data.remaining < 0 || data.remaining !== remaining - data.quotaDebit) throw new Error('来源额度余额不一致');
  return { quotaDebit: data.quotaDebit, remaining: data.remaining };
}
