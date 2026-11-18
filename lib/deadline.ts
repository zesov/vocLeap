/**
 * Resolves with the promise's value, or `null` once `ms` elapses — whichever
 * comes first. The underlying promise keeps running: this only bounds how
 * long the CALLER waits (the boot-time bootstrap pull must not hold the app
 * hostage on a bad network, but the sync itself continues in the background).
 */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, ms);
    promise
      .then((value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      })
      .catch(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(null);
        }
      });
  });
}
