/**
 * In-memory rate limiter for Vercel serverless functions.
 *
 * NOTE: Vercel can spin up multiple instances, so this is "best effort"
 * within a single instance. It stops casual abuse / bots effectively.
 * For stricter guarantees, use a Redis/Upstash-backed limiter.
 */

// Map<key, { count, resetAt }>
const _store = new Map();

/**
 * @param {string} key      – unique identifier (e.g. userId or IP)
 * @param {number} max      – max requests allowed in the window
 * @param {number} windowMs – window duration in milliseconds
 * @returns {{ allowed: boolean, remaining: number, resetIn: number }}
 */
function checkRateLimit(key, max = 10, windowMs = 60_000) {
  const now = Date.now();

  // Prune expired entries every ~100 calls to avoid unbounded growth
  if (_store.size > 500) {
    for (const [k, v] of _store) {
      if (v.resetAt < now) _store.delete(k);
    }
  }

  let entry = _store.get(key);
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + windowMs };
    _store.set(key, entry);
  }

  entry.count++;

  const remaining = Math.max(0, max - entry.count);
  const resetIn   = Math.ceil((entry.resetAt - now) / 1000);
  const allowed   = entry.count <= max;

  return { allowed, remaining, resetIn };
}

/**
 * Express-style middleware helper.
 * Returns true if the request should be blocked (rate-limited).
 */
function isRateLimited(res, key, max, windowMs) {
  const { allowed, remaining, resetIn } = checkRateLimit(key, max, windowMs);
  if (!allowed) {
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', '0');
    res.setHeader('X-RateLimit-Reset', String(resetIn));
    res.setHeader('Retry-After', String(resetIn));
    res.status(429).json({
      error: `Trop de requêtes. Réessayez dans ${resetIn} seconde${resetIn > 1 ? 's' : ''}.`
    });
    return true;
  }
  res.setHeader('X-RateLimit-Limit', String(max));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  return false;
}

module.exports = { checkRateLimit, isRateLimited };
