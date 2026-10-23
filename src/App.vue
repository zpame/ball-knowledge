<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { supabase, supabaseConfigured } from './lib/supabase'
import type { User } from '@supabase/supabase-js'

type Team = {
  id: number
  abbreviation: string
  full_name: string
  name?: string
}

type Game = {
  id: number
  date: string
  datetime: string
  status: string
  home_team: Team
  visitor_team: Team
  home_team_score: number | null
  visitor_team_score: number | null
  status_state?: string
}

type Pick = {
  game_id: number
  picked_team_id: number
  game_date?: string
}

type LeaderboardEntry = {
  rank: number
  user_id: string
  display_name: string
  wins: number
  losses: number
  total_picks: number
  win_percentage: number
  current_streak: number
  current_streak_is_win: boolean
  period?: LeaderboardPeriod
}

type LeaderboardPeriod = 'week' | 'season' | 'all_time'

const games = ref<Game[]>([])
const slateDate = ref('')
const picks = ref<Pick[]>([])
const leaders = ref<LeaderboardEntry[]>([])
const myRecords = ref<LeaderboardEntry[]>([])
const user = ref<User | null>(null)
const activePage = ref<'home' | 'games' | 'profile' | 'leaderboard'>('home')
const activePeriod = ref<LeaderboardPeriod>('week')
const loadingGames = ref(true)
const loadingLeaders = ref(true)
const submittingGame = ref<number | null>(null)
const authBusy = ref(false)
const authMode = ref<'signin' | 'signup'>('signin')
const authOpen = ref(false)
const email = ref('')
const password = ref('')
const confirmPassword = ref('')
const displayName = ref('')
const errorMessage = ref('')
const authErrorMessage = ref('')
const noticeMessage = ref('')
const confirmationPending = ref(false)
const authNotice = ref('')
const currentDate = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  timeZone: 'America/New_York',
}).format(new Date())
const todayGames = computed(() => games.value.filter((game) => game.date === slateDate.value))
const homeGames = computed(() => todayGames.value.slice(0, 3))
const homeLeaders = computed(() => leaders.value.slice(0, 5))
const allTimeRecord = computed(() => myRecords.value.find((entry) => entry.period === 'all_time'))
const seasonRecord = computed(() => myRecords.value.find((entry) => entry.period === 'season'))
const weeklyRecord = computed(() => myRecords.value.find((entry) => entry.period === 'week'))
const pickedGames = computed(() => games.value.filter((game) => pickedTeam(game) !== undefined))
const recentPickedGames = computed(() => [...pickedGames.value]
  .sort((gameA, gameB) => gameB.datetime.localeCompare(gameA.datetime))
  .slice(0, 10))
const gameDays = computed(() => {
  const days = new Map<string, Game[]>()
  for (const game of games.value) {
    const dayGames = days.get(game.date) ?? []
    dayGames.push(game)
    days.set(game.date, dayGames)
  }
  return [...days.entries()].sort(([dateA], [dateB]) => {
    if (dateA === slateDate.value) return -1
    if (dateB === slateDate.value) return 1
    const dateAIsUpcoming = dateA > slateDate.value
    const dateBIsUpcoming = dateB > slateDate.value
    if (dateAIsUpcoming !== dateBIsUpcoming) return dateAIsUpcoming ? -1 : 1
    return dateAIsUpcoming ? dateA.localeCompare(dateB) : dateB.localeCompare(dateA)
  })
})

let authSubscription: { unsubscribe: () => void } | undefined
let gameRefreshInterval: number | undefined

async function loadGames() {
  loadingGames.value = true
  errorMessage.value = ''
  try {
    const response = await fetch('/api/nbaGames/tonight')
    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new Error('The NBA games API did not return JSON. Check the dev server logs and server-side environment variables.')
    }
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error || 'Could not load tonight’s games.')
    slateDate.value = payload.date
    games.value = payload.games ?? []
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Could not load tonight’s games.'
  } finally {
    loadingGames.value = false
  }
}

async function loadPicks() {
  if (!supabase || !user.value) {
    picks.value = []
    return
  }
  const { data, error } = await supabase
    .from('picks')
    .select('game_id, picked_team_id, game_date')
    .eq('user_id', user.value.id)
  if (error) {
    errorMessage.value = `Could not load your picks: ${error.message}`
    return
  }
  picks.value = data ?? []
}

async function loadMyRecords() {
  if (!supabase || !user.value) {
    myRecords.value = []
    return
  }
  const { data, error } = await supabase
    .from('leaderboard')
    .select('rank, user_id, display_name, wins, losses, total_picks, win_percentage, current_streak, current_streak_is_win, period')
    .eq('user_id', user.value.id)
  if (error) {
    errorMessage.value = `Could not load your record: ${error.message}`
    return
  }
  myRecords.value = (data ?? []) as LeaderboardEntry[]
}

async function loadAccountData() {
  await Promise.all([loadPicks(), loadMyRecords()])
}

async function loadLeaders() {
  if (!supabase) {
    loadingLeaders.value = false
    return
  }
  loadingLeaders.value = true
  const { data, error } = await supabase
    .from('leaderboard')
    .select('rank, user_id, display_name, wins, losses, total_picks, win_percentage, current_streak, current_streak_is_win, period')
    .eq('period', activePeriod.value)
    .order('rank', { ascending: true })
  if (error) {
    errorMessage.value = `Could not load the leaderboard: ${error.message}`
    leaders.value = []
  } else {
    leaders.value = (data ?? []) as LeaderboardEntry[]
  }
  loadingLeaders.value = false
}

async function selectTeam(game: Game, team: Team) {
  if (!user.value) {
    if (supabase) {
      openAuth()
      noticeMessage.value = 'Sign in to save your picks.'
    } else {
      errorMessage.value = 'Connect your Supabase project before saving picks.'
    }
    return
  }
  if (!supabase || submittingGame.value !== null) return

  submittingGame.value = game.id
  errorMessage.value = ''
  noticeMessage.value = ''
  const { data, error } = await supabase.rpc('make_pick', {
    p_game_id: game.id,
    p_picked_team_id: team.id,
  })
  if (error) {
    errorMessage.value = error.message
  } else if (data) {
    const updatedPick = data as Pick
    picks.value = [
      ...picks.value.filter((pick) => pick.game_id !== game.id),
      updatedPick,
    ]
    noticeMessage.value = `Pick saved: ${team.abbreviation}. You can change it until tip-off.`
  } else {
    errorMessage.value = 'Your pick could not be confirmed. Refresh and try again.'
  }
  submittingGame.value = null
}

function openAuth() {
  if (!supabase) {
    errorMessage.value = 'Connect your Supabase project before signing in.'
    return
  }
  authErrorMessage.value = ''
  authNotice.value = ''
  authOpen.value = true
}

async function resendConfirmation() {
  if (!supabase) return
  const address = email.value.trim()
  if (!address) {
    authErrorMessage.value = 'Enter your email address first.'
    return
  }

  authBusy.value = true
  authErrorMessage.value = ''
  authNotice.value = ''
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email: address,
    options: { emailRedirectTo: window.location.origin },
  })
  authBusy.value = false
  if (error) {
    authErrorMessage.value = error.message
  } else {
    confirmationPending.value = true
    authNotice.value = 'A new confirmation link has been sent. Check your inbox.'
  }
}

async function submitAuth() {
  if (!supabase) return
  authErrorMessage.value = ''
  authNotice.value = ''
  noticeMessage.value = ''
  if (authMode.value === 'signup' && password.value !== confirmPassword.value) {
    authErrorMessage.value = 'Passwords do not match.'
    return
  }

  authBusy.value = true
  const result = authMode.value === 'signup'
    ? await supabase.auth.signUp({
        email: email.value,
        password: password.value,
        options: {
          data: { display_name: displayName.value.trim() || 'Player' },
          emailRedirectTo: window.location.origin,
        },
      })
    : await supabase.auth.signInWithPassword({ email: email.value, password: password.value })
  authBusy.value = false
  if (result.error) {
    if (result.error.code === 'email_not_confirmed') {
      confirmationPending.value = true
      authErrorMessage.value = 'Your email is not confirmed yet. Resend the confirmation link below.'
    } else {
      authErrorMessage.value = result.error.message
    }
  } else if (authMode.value === 'signup' && !result.data.session) {
    confirmationPending.value = true
    authNotice.value = 'Check your inbox for a confirmation link.'
  } else {
    user.value = result.data.user
    authOpen.value = false
    confirmationPending.value = false
    password.value = ''
    confirmPassword.value = ''
    await Promise.all([loadPicks(), loadLeaders()])
    noticeMessage.value = 'You’re signed in. Make your picks before tip-off.'
  }
}

async function signOut() {
  if (!supabase) return
  const { error } = await supabase.auth.signOut()
  if (error) {
    errorMessage.value = error.message
    return
  }
  user.value = null
  picks.value = []
  myRecords.value = []
  noticeMessage.value = 'You’re signed out.'
}

function navigateTo(page: 'home' | 'games' | 'profile' | 'leaderboard') {
  activePage.value = page
  const url = new URL(window.location.href)
  if (page === 'home') url.searchParams.delete('page')
  else url.searchParams.set('page', page)
  window.history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`)
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function syncRoute() {
  const page = new URLSearchParams(window.location.search).get('page')
  activePage.value = page === 'games' || page === 'profile' || page === 'leaderboard' ? page : 'home'
}

function formatGameDate(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/New_York',
  }).format(new Date(Date.UTC(year, month - 1, day, 12)))
}

function pickedTeam(game: Game) {
  const pick = picks.value.find((item) => item.game_id === game.id)
  return pick?.picked_team_id
}

function pickedTeamName(game: Game) {
  const pickedTeamId = pickedTeam(game)
  if (pickedTeamId === game.home_team.id) return game.home_team.abbreviation
  if (pickedTeamId === game.visitor_team.id) return game.visitor_team.abbreviation
  return 'No pick'
}

function isFinal(game: Game) {
  return game.status_state?.toLowerCase() === 'final' || game.status.toLowerCase().startsWith('final')
}

function pickResult(game: Game): 'correct' | 'incorrect' | undefined {
  const pickedTeamId = pickedTeam(game)
  if (!pickedTeamId || !isFinal(game) || game.home_team_score === null || game.visitor_team_score === null) return
  if (game.home_team_score === game.visitor_team_score) return

  const winnerId = game.home_team_score > game.visitor_team_score
    ? game.home_team.id
    : game.visitor_team.id
  return pickedTeamId === winnerId ? 'correct' : 'incorrect'
}

function gameTime(game: Game) {
  const start = new Date(game.datetime)
  if (Number.isNaN(start.getTime())) return game.status
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
  }).format(start)
}

function teamName(team: Team) {
  return team.full_name || team.name || team.abbreviation
}

function isLocked(game: Game) {
  const start = new Date(game.datetime).getTime()
  return game.status.toLowerCase().includes('final') || (Number.isFinite(start) && start <= Date.now())
}

onMounted(async () => {
  syncRoute()
  window.addEventListener('popstate', syncRoute)
  const authError = new URLSearchParams(window.location.hash.slice(1))
  if (authError.has('error')) {
    confirmationPending.value = true
    authMode.value = 'signin'
    authOpen.value = true
    authErrorMessage.value = authError.get('error_code') === 'otp_expired'
      ? 'That confirmation link has expired. Enter your email and request a new one.'
      : authError.get('error_description') || 'That confirmation link could not be used. Request a new one.'
    window.history.replaceState(null, document.title, window.location.pathname + window.location.search)
  }

  await loadGames()
  gameRefreshInterval = window.setInterval(() => void loadGames(), 60_000)
  if (supabase) {
    const { data } = await supabase.auth.getSession()
    user.value = data.session?.user ?? null
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      user.value = session?.user ?? null
      window.setTimeout(() => void loadAccountData(), 0)
    })
    authSubscription = listener.subscription
  }
  await Promise.all([loadAccountData(), loadLeaders()])
})

onUnmounted(() => {
  window.removeEventListener('popstate', syncRoute)
  authSubscription?.unsubscribe()
  if (gameRefreshInterval !== undefined) window.clearInterval(gameRefreshInterval)
})
</script>

<template>
  <div class="site-shell">
    <header class="topbar">
      <nav class="top-nav" aria-label="Main navigation">
        <a class="nav-link" href="?page=home" :class="{ active: activePage === 'home' }" :aria-current="activePage === 'home' ? 'page' : undefined" @click.prevent="navigateTo('home')">Home</a>
        <a class="nav-link" href="?page=games" :class="{ active: activePage === 'games' }" :aria-current="activePage === 'games' ? 'page' : undefined" @click.prevent="navigateTo('games')">Games</a>
        <a class="nav-link" href="?page=profile" :class="{ active: activePage === 'profile' }" :aria-current="activePage === 'profile' ? 'page' : undefined" @click.prevent="navigateTo('profile')">My Profile</a>
        <a class="nav-link" href="?page=leaderboard" :class="{ active: activePage === 'leaderboard' }" :aria-current="activePage === 'leaderboard' ? 'page' : undefined" @click.prevent="navigateTo('leaderboard')">Leaderboard</a>
      </nav>
      <div class="account-actions">
        <template v-if="user">
          <span class="signed-in">{{ user.user_metadata.display_name || user.email }}</span>
          <button class="button button-quiet" @click="signOut">Sign out</button>
        </template>
        <button v-else class="button button-outline" @click="openAuth">Sign in</button>
      </div>
    </header>

    <main>
      <div v-if="!supabaseConfigured" class="notice setup-notice">Supabase is not configured.</div>
      <div v-if="errorMessage" class="notice error-notice" role="alert">{{ errorMessage }}</div>
      <div v-if="noticeMessage" class="notice success-notice" role="status">{{ noticeMessage }}</div>

      <section v-if="activePage === 'home'" class="section home-page">
        <div class="section-heading">
          <div><h1>Home</h1><p class="page-subtitle">{{ currentDate }} · NBA</p></div>
          <button v-if="!user" class="button button-lime" @click="openAuth">Sign in to play</button>
        </div>

        <div class="home-overview">
          <section class="overview-panel">
            <div class="panel-heading"><h2>Your record</h2><a href="?page=profile" @click.prevent="navigateTo('profile')">Profile →</a></div>
            <template v-if="user">
              <div class="overview-stats">
                <div><strong>{{ allTimeRecord ? `${allTimeRecord.wins}-${allTimeRecord.losses}` : '—' }}</strong><span>All-time record</span></div>
                <div><strong>{{ seasonRecord?.win_percentage ?? '—' }}<small v-if="seasonRecord">%</small></strong><span>Season win rate</span></div>
                <div><strong>{{ allTimeRecord ? `${allTimeRecord.current_streak_is_win ? 'W' : 'L'}${allTimeRecord.current_streak}` : '—' }}</strong><span>Current streak</span></div>
              </div>
            </template>
            <p v-else class="panel-note">Sign in to see your record and saved picks.</p>
          </section>
          <section class="overview-panel">
            <div class="panel-heading"><h2>Tonight</h2><a href="?page=games" @click.prevent="navigateTo('games')">All games →</a></div>
            <p v-if="loadingGames" class="panel-note">Loading games…</p>
            <p v-else-if="!homeGames.length" class="panel-note">No games tonight.</p>
            <div v-else class="home-game-list">
              <div v-for="game in homeGames" :key="game.id" class="home-game-row">
                <span>{{ game.visitor_team.abbreviation }} <small>@</small> {{ game.home_team.abbreviation }}</span>
                <span>{{ isLocked(game) ? `${game.visitor_team_score}–${game.home_team_score}` : gameTime(game) }}</span>
              </div>
            </div>
          </section>
        </div>

        <section class="home-leaderboard">
          <div class="panel-heading"><h2>Leaderboard · {{ activePeriod === 'week' ? 'This week' : activePeriod === 'season' ? 'This season' : 'All time' }}</h2><a href="?page=leaderboard" @click.prevent="navigateTo('leaderboard')">Full leaderboard →</a></div>
          <div v-if="loadingLeaders" class="panel-note">Loading leaderboard…</div>
          <div v-else-if="!homeLeaders.length" class="panel-note">No results yet.</div>
          <div v-else class="home-leader-list">
            <div v-for="entry in homeLeaders" :key="entry.user_id" class="home-leader-row">
              <span class="home-rank">{{ entry.rank }}</span><strong>{{ entry.display_name }}</strong>
              <span>{{ entry.wins }}–{{ entry.losses }}</span><span>{{ Number(entry.win_percentage).toFixed(1) }}%</span>
            </div>
          </div>
        </section>
      </section>

      <section v-else-if="activePage === 'games'" class="section games-section">
        <div class="section-heading"><div><h1>Games</h1><p class="page-subtitle">Recent and upcoming games · Eastern time</p></div></div>
        <div v-if="loadingGames" class="empty-state">Loading games…</div>
        <div v-else-if="games.length === 0" class="empty-state">No recent or upcoming games.</div>
        <div v-else class="game-days">
          <section v-for="[date, dayGames] in gameDays" :key="date" class="game-day">
            <h2>{{ date === slateDate ? 'Today' : formatGameDate(date) }}</h2>
            <div class="game-grid">
              <article v-for="game in dayGames" :key="game.id" class="game-card">
                <div class="game-meta">
                  <span class="game-time">
                    {{ gameTime(game) }} ET
                    <svg v-if="isLocked(game)" class="lock-icon" viewBox="0 0 16 16" aria-label="Picks locked" role="img" title="Picks locked">
                      <rect x="3" y="7" width="10" height="7" rx="1.5" />
                      <path d="M5.5 7V4.75a2.5 2.5 0 0 1 5 0V7" />
                    </svg>
                  </span>
                </div>
                <div class="matchup">
                  <div class="team-row"><div class="team-copy"><strong>{{ game.visitor_team.abbreviation }}</strong><span>{{ teamName(game.visitor_team) }}</span></div><span v-if="game.visitor_team_score !== null" class="team-score">{{ game.visitor_team_score }}</span></div>
                  <div class="team-row"><div class="team-copy"><strong>{{ game.home_team.abbreviation }}</strong><span>{{ teamName(game.home_team) }}</span></div><span v-if="game.home_team_score !== null" class="team-score">{{ game.home_team_score }}</span></div>
                </div>
                <div v-if="pickResult(game)" class="pick-result" :class="`pick-result-${pickResult(game)}`">{{ pickResult(game) === 'correct' ? 'Correct pick' : 'Incorrect pick' }}</div>
                <div v-else-if="pickedTeam(game)" class="saved-tag">Pick saved</div>
                <div class="pick-actions">
                  <button class="pick-button" :class="[`team-pick-${game.visitor_team.abbreviation}`, { selected: pickedTeam(game) === game.visitor_team.id }, pickedTeam(game) === game.visitor_team.id && pickResult(game) ? `result-${pickResult(game)}` : '']" :disabled="isLocked(game) || submittingGame === game.id" @click="selectTeam(game, game.visitor_team)">
                    {{ game.visitor_team.abbreviation }} <span>{{ pickedTeam(game) === game.visitor_team.id ? (pickResult(game) === 'correct' ? 'Correct' : pickResult(game) === 'incorrect' ? 'Incorrect' : 'Picked') : '' }}</span>
                  </button>
                  <button class="pick-button" :class="[`team-pick-${game.home_team.abbreviation}`, { selected: pickedTeam(game) === game.home_team.id }, pickedTeam(game) === game.home_team.id && pickResult(game) ? `result-${pickResult(game)}` : '']" :disabled="isLocked(game) || submittingGame === game.id" @click="selectTeam(game, game.home_team)">
                    {{ game.home_team.abbreviation }} <span>{{ pickedTeam(game) === game.home_team.id ? (pickResult(game) === 'correct' ? 'Correct' : pickResult(game) === 'incorrect' ? 'Incorrect' : 'Picked') : '' }}</span>
                  </button>
                </div>
              </article>
            </div>
          </section>
        </div>
      </section>

      <section v-else-if="activePage === 'profile'" class="section profile-page">
        <div class="section-heading"><div><h1>My Profile</h1><p class="page-subtitle">{{ user?.user_metadata.display_name || user?.email || 'Your picks and results' }}</p></div></div>
        <div v-if="!user" class="empty-state profile-signin"><p>Sign in to see your stats and picks.</p><button class="button button-lime" @click="openAuth">Sign in</button></div>
        <template v-else>
          <div class="record-grid">
            <article v-for="record in [
              { key: 'all_time', label: 'All time', value: allTimeRecord },
              { key: 'season', label: 'This season', value: seasonRecord },
              { key: 'week', label: 'This week', value: weeklyRecord },
            ]" :key="record.key" class="record-card">
              <span>{{ record.label }}</span>
              <strong>{{ record.value ? `${record.value.wins}–${record.value.losses}` : '—' }}</strong>
              <small>{{ record.value ? `${Number(record.value.win_percentage).toFixed(1)}% win rate` : 'No settled picks' }}</small>
            </article>
          </div>
          <section class="profile-streak overview-panel">
            <div class="panel-heading"><h2>Current streak</h2></div>
            <p v-if="allTimeRecord"><strong :class="allTimeRecord.current_streak_is_win ? 'streak-positive' : 'streak-negative'">{{ allTimeRecord.current_streak_is_win ? 'W' : 'L' }}{{ allTimeRecord.current_streak }}</strong><span>{{ allTimeRecord.current_streak_is_win ? ' consecutive wins' : ' consecutive losses' }}</span></p>
            <p v-else class="panel-note">Your streak will show after your first game is settled.</p>
          </section>
          <section class="profile-picks overview-panel">
            <div class="panel-heading"><h2>Recent picks</h2><a href="?page=games" @click.prevent="navigateTo('games')">Games →</a></div>
            <div v-if="recentPickedGames.length" class="profile-pick-list">
              <div v-for="game in recentPickedGames" :key="game.id" class="profile-pick-row">
                <div class="profile-pick-date">
                  <strong>{{ formatGameDate(game.date) }}</strong>
                  <span>{{ gameTime(game) }} ET</span>
                </div>
                <div class="profile-pick-matchup">
                  <div class="profile-pick-team" :class="{ 'picked-team': pickedTeam(game) === game.visitor_team.id }">
                    <strong>{{ game.visitor_team.abbreviation }}</strong>
                    <span>{{ isFinal(game) ? game.visitor_team_score : '—' }}</span>
                  </div>
                  <div class="profile-pick-team" :class="{ 'picked-team': pickedTeam(game) === game.home_team.id }">
                    <strong>{{ game.home_team.abbreviation }}</strong>
                    <span>{{ isFinal(game) ? game.home_team_score : '—' }}</span>
                  </div>
                </div>
                <div class="profile-pick-outcome">
                  <span v-if="pickResult(game)" class="pick-result-inline" :class="`pick-result-${pickResult(game)}`">
                    {{ pickResult(game) === 'correct' ? 'Correct' : 'Incorrect' }}
                  </span>
                  <span v-else class="pick-pending">{{ isFinal(game) ? 'Final' : 'Pending' }}</span>
                  <small>Your pick: {{ pickedTeamName(game) }}</small>
                </div>
              </div>
            </div>
            <p v-else class="panel-note">No recent picks.</p>
          </section>
        </template>
      </section>

      <section v-else class="section leaderboard-page">
        <div class="section-heading"><div><h1>Leaderboard</h1><p class="page-subtitle">Compare records across time periods</p></div></div>
        <div class="leaderboard-panel">
          <div class="leaderboard-top">
            <div class="period-tabs" role="tablist" aria-label="Leaderboard period">
              <button v-for="period in (['week', 'season', 'all_time'] as const)" :key="period" :class="{ active: activePeriod === period }" role="tab" :aria-selected="activePeriod === period" @click="activePeriod = period; loadLeaders()">
                {{ period === 'all_time' ? 'All time' : period === 'season' ? 'This season' : 'This week' }}
              </button>
            </div>
          </div>
          <div class="table-scroll">
            <table>
              <thead><tr><th>RANK</th><th>PLAYER</th><th>RECORD</th><th>WIN %</th><th>CURRENT STREAK</th><th>PICKS</th></tr></thead>
              <tbody v-if="!loadingLeaders && leaders.length">
                <tr v-for="entry in leaders" :key="entry.user_id" :class="{ 'current-player': user?.id === entry.user_id }">
                  <td><span class="rank-number" :class="{ 'top-rank': entry.rank <= 3 }">{{ String(entry.rank).padStart(2, '0') }}</span></td>
                  <td class="player-cell"><strong>{{ entry.display_name }}<span v-if="user?.id === entry.user_id" class="you-label">You</span></strong></td>
                  <td>{{ entry.wins }}<span class="record-separator">—</span>{{ entry.losses }}</td>
                  <td><strong class="win-rate">{{ Number(entry.win_percentage).toFixed(1) }}%</strong></td>
                  <td><span class="streak" :class="entry.current_streak_is_win ? 'win-streak' : 'loss-streak'">{{ entry.current_streak_is_win ? 'W' : 'L' }}{{ entry.current_streak }}</span></td>
                  <td>{{ entry.total_picks }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="loadingLeaders" class="leaderboard-empty">Loading…</div>
          <div v-else-if="!leaders.length" class="leaderboard-empty">No results for this period yet.</div>
        </div>
      </section>
    </main>

    <div v-if="authOpen" class="modal-backdrop" @click.self="authOpen = false">
      <section class="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <button class="modal-close" aria-label="Close sign-in dialog" @click="authOpen = false">×</button>
        <h2 id="auth-title">{{ authMode === 'signin' ? 'Sign in' : 'Create account' }}</h2>
        <form @submit.prevent="submitAuth">
          <label v-if="authMode === 'signup'">Display name<input v-model="displayName" autocomplete="nickname" maxlength="40" required /></label>
          <label>Email<input v-model="email" type="email" autocomplete="email" required /></label>
          <label>Password<input v-model="password" type="password" :autocomplete="authMode === 'signin' ? 'current-password' : 'new-password'" minlength="6" required /></label>
          <label v-if="authMode === 'signup'">Confirm password<input v-model="confirmPassword" type="password" autocomplete="new-password" minlength="6" required /></label>
          <p v-if="authErrorMessage" class="form-error" role="alert">{{ authErrorMessage }}</p>
          <p v-if="authNotice" class="auth-notice" role="status">{{ authNotice }}</p>
          <button class="button button-lime submit-button" :disabled="authBusy">{{ authBusy ? 'Please wait…' : authMode === 'signin' ? 'Sign in' : 'Create account' }}</button>
        </form>
        <button
          v-if="confirmationPending && authMode === 'signin'"
          class="mode-switch"
          :disabled="authBusy"
          @click="resendConfirmation"
        >{{ authBusy ? 'Sending…' : 'Resend confirmation email' }}</button>
        <button class="mode-switch" @click="authMode = authMode === 'signin' ? 'signup' : 'signin'; authErrorMessage = ''; authNotice = ''">
          {{ authMode === 'signin' ? 'New to the board? Create an account' : 'Already have an account? Sign in' }}
        </button>
      </section>
    </div>
  </div>
</template>
