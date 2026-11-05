// New events are queued atomically and claimed with SKIP LOCKED by the
// existing sender. A failed immediate attempt stays eligible for the ordinary
// minute-by-minute queue drain; do not manufacture or resend events here.
export async function scanAndDrainLottery(scan, drain, onError = () => {}) {
  const summary = await scan();
  if (!(summary.newlyQueued > 0)) return summary;
  try {
    return {...summary, delivery: await drain()};
  } catch (error) {
    onError(error);
    return {...summary, deliveryPending: true};
  }
}
