import { createClient } from '@supabase/supabase-js'
import { clientIpKey, consumeRateLimit, rejectRateLimit } from '../_lib/rateLimit.js'

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
    return sendJson(res, 500, { error: 'pick_service_not_configured' })
  }

  let supabase
  let ipKey
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })
    ipKey = clientIpKey(req)
    if (!await consumeRateLimit(supabase, `pick:ip:${ipKey}`, 60, 60)) {
      return rejectRateLimit(res, 60)
    }
  } catch (error) {
    console.error('Could not apply pick rate limit:', error)
    return sendJson(res, 500, { error: 'pick_service_unavailable' })
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

  const gameId = Number(body.game_id)
  const pickedTeamId = Number(body.picked_team_id)
  if (!Number.isSafeInteger(gameId) || gameId <= 0
    || !Number.isSafeInteger(pickedTeamId) || pickedTeamId <= 0) {
    return sendJson(res, 400, { error: 'pick_invalid' })
  }

  const authorization = req.headers.authorization
  const accessToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!accessToken) return sendJson(res, 401, { error: 'not_authenticated' })

  try {
    const { data: authData, error: authError } = await supabase.auth.getUser(accessToken)
    if (authError || !authData.user) return sendJson(res, 401, { error: 'not_authenticated' })

    const { data, error } = await supabase.rpc('make_pick_for_user', {
      p_user_id: authData.user.id,
      p_game_id: gameId,
      p_picked_team_id: pickedTeamId,
    })
    if (error) {
      if (error.message.includes('Picks lock at tip-off')) {
        return sendJson(res, 409, { error: 'pick_locked' })
      }
      if (error.message.includes('rate_limited')) {
        return rejectRateLimit(res, 60)
      }
      if (error.message.includes('Game not found')) {
        return sendJson(res, 404, { error: 'game_not_found' })
      }
      if (error.message.includes('Pick must be one of the teams')) {
        return sendJson(res, 400, { error: 'pick_invalid' })
      }
      throw error
    }
    return sendJson(res, 200, data)
  } catch (error) {
    console.error('Failed to save pick:', error)
    return sendJson(res, 500, { error: 'pick_save_failed' })
  }
}
