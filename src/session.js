// Single shared Silogtran session (credentials from ENV). Logs in lazily and re-logs once
// when Silogtran reports the session expired.
import { Silogtran, SilogtranError } from './silogtran.js';

const BASE_URL = process.env.SILOG_BASE_URL || 'https://construproyec.colombiasoftware.net';

let client = null;
let loginPromise = null;

function ensureLogin(force = false) {
  if (client && !force && !loginPromise) return Promise.resolve(client);
  if (loginPromise) return loginPromise;
  const { SILOG_USER, SILOG_PASSWORD } = process.env;
  if (!SILOG_USER || !SILOG_PASSWORD) {
    return Promise.reject(new SilogtranError('SILOG_USER / SILOG_PASSWORD not configured.', { status: 500 }));
  }
  const next = client || new Silogtran(BASE_URL); // reuse jar to keep the WAF token
  loginPromise = next
    .login(SILOG_USER, SILOG_PASSWORD)
    .then(() => {
      client = next;
      console.log(`[session] logged in as ${SILOG_USER}`);
      return client;
    })
    .catch((e) => {
      client = null;
      throw e;
    })
    .finally(() => {
      loginPromise = null;
    });
  return loginPromise;
}

// Runs fn(client) inside the client's queue; retries once after re-login on expired session.
export async function withSession(fn) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const c = await ensureLogin(attempt > 0);
    try {
      return await c.enqueue(() => fn(c));
    } catch (e) {
      if (!(e instanceof SilogtranError && e.sessionExpired) || attempt > 0) throw e;
      console.warn('[session] expired, re-logging in');
    }
  }
}

export const sessionActive = () => Boolean(client);
