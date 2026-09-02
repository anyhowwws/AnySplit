import { claimQuota } from './db.ts';
import { config } from './config.ts';
import { userRef } from './userref.ts';

const HOUR = 3600;
const DAY = 86400;

/** Which ceiling was hit, and how long until it lifts. */
export interface Rejection {
  scope: 'hour' | 'day' | 'global';
  retryInSeconds: number;
}

/** Seconds remaining in the fixed window of the given length. */
function secondsLeftInWindow(windowSeconds: number): number {
  return windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
}

/**
 * Decides whether this person may have another receipt parsed, and consumes
 * their allowance if so.
 *
 * Called before the bill is created and before anything is enqueued, so a
 * refusal costs one conditional write rather than a vision call.
 *
 * **The order of these checks is load-bearing.** They run narrowest first, and
 * stop at the first refusal, so somebody who has exhausted their own hourly
 * allowance never touches the global counter. Checked in the other order — or
 * in parallel — one determined user would burn through the day's global budget
 * and lock out everyone else, turning a spend ceiling into a denial-of-service
 * against legitimate users.
 *
 * A tier set to zero is skipped entirely.
 */
export async function claimParse(userId: number | undefined): Promise<Rejection | null> {
  const ref = await userRef(userId);
  // No identifiable user means no per-user counter to keep. The global ceiling
  // below still applies, so this is not a way around the limits.
  const perUser = ref ?? 'anon';

  const hourly = config.perUserHourly();
  if (hourly > 0 && !(await claimQuota(`u#${perUser}`, hourly, HOUR))) {
    return { scope: 'hour', retryInSeconds: secondsLeftInWindow(HOUR) };
  }

  const daily = config.perUserDaily();
  if (daily > 0 && !(await claimQuota(`u#${perUser}`, daily, DAY))) {
    return { scope: 'day', retryInSeconds: secondsLeftInWindow(DAY) };
  }

  const global = config.globalDaily();
  if (global > 0 && !(await claimQuota('global', global, DAY))) {
    return { scope: 'global', retryInSeconds: secondsLeftInWindow(DAY) };
  }

  return null;
}
