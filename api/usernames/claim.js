import { createClient } from '@supabase/supabase-js'
import { Filter } from 'bad-words'
import { clientIpKey, consumeRateLimit, rejectRateLimit } from '../_lib/rateLimit.js'

const profanityFilter = new Filter()
const usernamePattern = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,18}[A-Za-z0-9]$/

function sendJson(res, status, body) {
  res.setHeader('Cache-Control', 'no-store')
  return res.status(status).json(body)
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') return JSON.parse(req.body)

  let rawBody = ''
  for await (const chunk of req) {
    rawBody += Buffer.from(chunk).toString()
    if (rawBody.length > 4096) throw new Error('request_too_large')
  }
  return rawBody ? JSON.parse(rawBody) : {}
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return sendJson(res, 405, { error: 'method_not_allowed' })
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return sendJson(res, 500, { error: 'username_service_not_configured' })
  }

  let supabase
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })
    const ipKey = clientIpKey(req)
    if (!await consumeRateLimit(supabase, `username:ip:${ipKey}`, 30, 600)) {
      return rejectRateLimit(res, 600)
    }
  } catch (error) {
    console.error('Could not apply username rate limit:', error)
    return sendJson(res, 500, { error: 'username_service_unavailable' })
  }

  const authorization = req.headers.authorization
  const accessToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!accessToken) return sendJson(res, 401, { error: 'not_authenticated' })

  let authData
  try {
    const { data, error } = await supabase.auth.getUser(accessToken)
    if (error || !data.user) return sendJson(res, 401, { error: 'not_authenticated' })
    authData = data
    if (!await consumeRateLimit(supabase, `username:user:${authData.user.id}`, 10, 600)) {
      return rejectRateLimit(res, 600)
    }
  } catch (error) {
    console.error('Could not validate username request:', error)
    return sendJson(res, 500, { error: 'username_service_unavailable' })
  }

  let body
  try {
    body = await readBody(req)
  } catch {
    return sendJson(res, 400, { error: 'invalid_request_body' })
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendJson(res, 400, { error: 'invalid_request_body' })
  }

  const username = typeof body.username === 'string' ? body.username : ''
  if (!usernamePattern.test(username)) {
    return sendJson(res, 400, { error: 'username_invalid' })
  }
  if (profanityFilter.isProfane(username)) {
    return sendJson(res, 400, { error: 'username_profanity' })
  }

  try {
    const { data, error } = await supabase.rpc('claim_username', {
      p_user_id: authData.user.id,
      p_username: username,
    })
    if (error) {
      if (error.code === '23505' || error.message.includes('username_taken')) {
        return sendJson(res, 409, { error: 'username_taken' })
      }
      if (error.message.includes('profile_not_found')) {
        return sendJson(res, 404, { error: 'profile_not_found' })
      }
      if (error.message.includes('username_cooldown')) {
        return sendJson(res, 429, {
          error: 'username_cooldown',
          next_available_at: error.details,
        })
      }
      throw error
    }

    return sendJson(res, 200, data)
  } catch (error) {
    console.error('Failed to save username:', error)
    return sendJson(res, 500, { error: 'username_save_failed' })
  }
}
