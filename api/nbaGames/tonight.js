import { createClient } from '@supabase/supabase-js'

const TEAM_COLORS = {
  ATL: '#E03A3E',
  BOS: '#007A33',
  BKN: '#FFFFFF',
  CHA: '#1D1160',
  CHI: '#CE1141',
  CLE: '#6F263D',
  DAL: '#00538C',
  DEN: '#0E2240',
  DET: '#C8102E',
  GSW: '#1D428A',
  HOU: '#CE1141',
  IND: '#002D62',
  LAC: '#C8102E',
  LAL: '#552583',
  MEM: '#5D76A9',
  MIA: '#98002E',
  MIL: '#00471B',
  MIN: '#0C2340',
  NOP: '#0C2340',
  NYK: '#006BB6',
  OKC: '#007AC1',
  ORL: '#0077C0',
  PHI: '#006BB6',
  PHX: '#1D1160',
  POR: '#E03A3E',
  SAC: '#5A2D81',
  SAS: '#C4CED4',
  TOR: '#CE1141',
  UTA: '#002B5C',
  WAS: '#002B5C',
}

function easternDate(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  return `${values.year}-${values.month}-${values.day}`
}

function recentDates(today) {
  const [year, month, day] = today.split('-').map(Number)
  const base = new Date(Date.UTC(year, month - 1, day, 12))
  return Array.from({ length: 4 }, (_, offset) => {
    const date = new Date(base)
    date.setUTCDate(date.getUTCDate() - offset)
    return date.toISOString().slice(0, 10)
  })
}

function teamsFromGames(games) {
  const teams = new Map()
  for (const game of games) {
    for (const team of [game.home_team, game.visitor_team]) {
      teams.set(team.id, {
        id: team.id,
        abbreviation: team.abbreviation,
        name: team.full_name,
        color: TEAM_COLORS[team.abbreviation] ?? '#A3E635',
      })
    }
  }
  return [...teams.values()]
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { BDL_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env
  if (!BDL_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'NBA data service is not configured' })
  }

  try {
    const date = easternDate(new Date())
    const dates = recentDates(date)
    const url = new URL('https://api.balldontlie.io/v1/games')
    for (const day of dates) url.searchParams.append('dates[]', day)
    url.searchParams.set('per_page', '100')

    const response = await fetch(url, {
      headers: { Authorization: BDL_API_KEY },
    })
    if (!response.ok) {
      const detail = await response.text()
      console.error(`BallDontLie returned ${response.status}: ${detail}`)
      return res.status(502).json({ error: 'Unable to load NBA games right now' })
    }

    const payload = await response.json()
    const games = payload.data ?? []
    const validGames = games.filter((game) => game.datetime)
    if (validGames.length !== games.length) {
      console.error('BallDontLie returned a game without a scheduled start time')
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })
    const teams = teamsFromGames(validGames)
    if (teams.length) {
      const { error } = await supabase.from('teams').upsert(teams, { onConflict: 'id' })
      if (error) throw error
    }

    const gameRows = validGames.map((game) => ({
      id: game.id,
      game_date: game.date,
      start_at: game.datetime,
      home_team_id: game.home_team.id,
      visitor_team_id: game.visitor_team.id,
      home_team_score: game.home_team_score,
      visitor_team_score: game.visitor_team_score,
      status: game.status,
    }))
    if (gameRows.length) {
      const { error } = await supabase.from('games').upsert(gameRows, { onConflict: 'id' })
      if (error) throw error
    }

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30')
    return res.status(200).json({
      date,
      games: validGames.sort((gameA, gameB) => gameA.datetime.localeCompare(gameB.datetime)),
      teams,
    })
  } catch (error) {
    console.error('Failed to sync tonight’s NBA games:', error)
    return res.status(500).json({ error: 'Unable to load NBA games right now' })
  }
}
