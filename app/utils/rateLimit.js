const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? String(60 * 1000));
const MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX ?? "10");

// ip -> array of hit timestamps within the current window
const hits = new Map();

// Purge stale entries every 5 minutes to prevent unbounded growth
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [ip, timestamps] of hits) {
    const recent = timestamps.filter((t) => t > cutoff);
    if (recent.length === 0) hits.delete(ip);
    else hits.set(ip, recent);
  }
}, 5 * 60 * 1000).unref();

export function getClientIp(request) {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

// Returns { limited: false } or { limited: true, retryAfter: seconds }
export function checkRateLimit(ip, { windowMs = WINDOW_MS, max = MAX_REQUESTS } = {}) {
  const now = Date.now();
  const cutoff = now - windowMs;
  const timestamps = (hits.get(ip) ?? []).filter((t) => t > cutoff);

  if (timestamps.length >= max) {
    const retryAfter = Math.ceil((timestamps[0] + windowMs - now) / 1000);
    return { limited: true, retryAfter };
  }

  timestamps.push(now);
  hits.set(ip, timestamps);
  return { limited: false };
}
