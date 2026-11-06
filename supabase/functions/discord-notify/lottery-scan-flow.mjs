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

export async function scanLotteryCatalogs(scanners, onError = () => {}) {
  const entries = Object.entries(scanners);
  const results = await Promise.allSettled(entries.map(async ([, scan]) => scan()));
  const catalogs = {};
  let total = 0, newlyQueued = 0, successful = 0;
  for (const [index, result] of results.entries()) {
    const name = entries[index][0];
    if (result.status === 'rejected') {
      onError(name, result.reason);
      catalogs[name] = {error: true};
    } else {
      catalogs[name] = result.value;
      total += result.value.total;
      newlyQueued += result.value.newlyQueued;
      successful++;
    }
  }
  if (!successful) throw Error('No lottery catalog could be scanned');
  return {total, newlyQueued, catalogs};
}
