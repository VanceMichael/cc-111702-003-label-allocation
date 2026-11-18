export function present(state) {
  const parcels = Object.entries(state.parcels).map(([parcel, item]) => ({ parcel, ...item, printable: !state.prints[item.jobId]?.printed, handedOver: false }));
  const used = parcels.length;
  return { parcels, used, remaining: Math.max(0, state.capacity - used) };
}
