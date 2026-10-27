import { createHash } from 'node:crypto'

export function clientIpKey(req) {
  const forwardedFor = req.headers['x-forwarded-for']
  const ip = (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)
    ?.split(',')[0]
    ?.trim() || req.socket?.remoteAddress
  if (!ip) throw new Error('Could not determine request IP')

  return createHash('sha256').update(ip).digest('hex')
}

export async function consumeRateLimit(supabase, bucket, limit, windowSeconds) {
  const { data, error } = await supabase.rpc('consume_rate_limit', {
    p_bucket: bucket,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  })
  if (error) throw error
  return data === true
}

export function rejectRateLimit(res, windowSeconds) {
  const secondsUntilReset = windowSeconds - Math.floor((Date.now() / 1000) % windowSeconds)
  res.setHeader('Retry-After', String(secondsUntilReset))
  res.setHeader('Cache-Control', 'no-store')
  return res.status(429).json({ error: 'rate_limited' })
}
