<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
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
const currentUsername = ref('')
const usernameNextChangeAt = ref<string | null>(null)
const usernameSetupOpen = ref(false)
const usernameInput = ref('')
const usernameSaving = ref(false)
const usernameError = ref('')
const activePage = ref<'home' | 'games' | 'profile' | 'leaderboard' | 'settings'>('home')
const activePeriod = ref<LeaderboardPeriod>('week')
const leaderboardSearch = ref('')
const leaderboardPageSize = ref<25 | 50 | 100>(25)
const leaderboardPage = ref(1)
const loadingGames = ref(true)
const loadingLeaders = ref(true)
const submittingGame = ref<number | null>(null)
const authBusy = ref(false)
const authOpen = ref(false)
const errorMessage = ref('')
const authErrorMessage = ref('')
const noticeMessage = ref('')
const currentDate = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  timeZone: 'America/New_York',
}).format(new Date())
const usernameChangeAvailable = computed(() => !usernameNextChangeAt.value
  || new Date(usernameNextChangeAt.value).getTime() <= Date.now())
const usernameChangeDate = computed(() => usernameNextChangeAt.value
  ? new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(usernameNextChangeAt.value))
  : '')
const todayGames = computed(() => games.value.filter((game) => game.date === slateDate.value))
const homeGames = computed(() => todayGames.value.slice(0, 3))
const homeLeaders = computed(() => leaders.value.slice(0, 5))
const filteredLeaders = computed(() => {
  const query = leaderboardSearch.value.trim().toLocaleLowerCase()
  return query
    ? leaders.value.filter((entry) => entry.display_name.toLocaleLowerCase().includes(query))
    : leaders.value
})
const leaderboardPageCount = computed(() => Math.max(1, Math.ceil(filteredLeaders.value.length / leaderboardPageSize.value)))
const pagedLeaders = computed(() => {
  const start = (leaderboardPage.value - 1) * leaderboardPageSize.value
  return filteredLeaders.value.slice(start, start + leaderboardPageSize.value)
})
const leaderboardFirstRow = computed(() => filteredLeaders.value.length
  ? (leaderboardPage.value - 1) * leaderboardPageSize.value + 1
  : 0)
const leaderboardLastRow = computed(() => Math.min(
  leaderboardPage.value * leaderboardPageSize.value,
  filteredLeaders.value.length,
))
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
let errorTimeout: number | undefined
let checkingProfileUserId: string | undefined

watch([leaderboardSearch, leaderboardPageSize, activePeriod], () => {
  leaderboardPage.value = 1
})

watch(errorMessage, (message) => {
  if (errorTimeout !== undefined) window.clearTimeout(errorTimeout)
  if (message) {
    errorTimeout = window.setTimeout(() => {
      errorMessage.value = ''
      errorTimeout = undefined
    }, 7000)
  }
})

function authRedirectUrl() {
  const hostname = window.location.hostname
  if (hostname === 'localhost' || hostname === '127.0.0.1') return window.location.origin
  return 'https://ballknowledge.zacharypamer.com'
}

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
  try {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
    if (sessionError) throw sessionError
    if (!sessionData.session) {
      errorMessage.value = 'Your sign-in expired. Sign in with Google again.'
      return
    }

    const response = await fetch('/api/picks/submit', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionData.session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ game_id: game.id, picked_team_id: team.id }),
    })
    const payload = await response.json()
    if (!response.ok) {
      const messages: Record<string, string> = {
        not_authenticated: 'Your sign-in expired. Sign in with Google again.',
        rate_limited: 'You’re making picks too quickly. Please wait a minute and try again.',
        pick_locked: 'This game locked at tip-off. Picks cannot be changed after the game starts.',
      }
      errorMessage.value = messages[payload.error] || 'Your pick could not be saved. Please try again.'
      return
    }

    const updatedPick = payload as Pick
    picks.value = [
      ...picks.value.filter((pick) => pick.game_id !== game.id),
      updatedPick,
    ]
    noticeMessage.value = `Pick saved: ${team.abbreviation}. You can change it until tip-off; after the listed start time, picks are locked.`
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Your pick could not be saved. Please try again.'
  } finally {
    submittingGame.value = null
  }
}

function openAuth() {
  if (!supabase) {
    errorMessage.value = 'Connect your Supabase project before signing in.'
    return
  }
  authErrorMessage.value = ''
  authOpen.value = true
}

async function signInWithGoogle() {
  if (!supabase) return
  authBusy.value = true
  authErrorMessage.value = ''
  try {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: authRedirectUrl() },
    })
    if (error) {
      authErrorMessage.value = error.message
    }
  } catch (error) {
    authErrorMessage.value = error instanceof Error ? error.message : 'Google sign-in could not be started.'
  } finally {
    authBusy.value = false
  }
}

async function checkUsernameSetup() {
  if (!supabase || !user.value || checkingProfileUserId === user.value.id) return
  const userId = user.value.id
  checkingProfileUserId = userId
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('username, display_name, username_changed_at')
      .eq('id', userId)
      .maybeSingle()
    if (error) {
      errorMessage.value = `Could not load your profile: ${error.message}`
      return
    }
    if (user.value?.id !== userId) return

    const username = data?.username?.trim() ?? ''
    const displayName = data?.display_name?.trim() ?? ''
    currentUsername.value = username || displayName
    usernameNextChangeAt.value = data?.username_changed_at
      ? new Date(new Date(data.username_changed_at).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
      : null
    if (!username || username.toLowerCase() === 'player' || displayName.toLowerCase() === 'player') {
      usernameInput.value = ''
      usernameError.value = ''
      usernameSetupOpen.value = true
    }
  } catch (error) {
    errorMessage.value = error instanceof Error
      ? `Could not load your profile: ${error.message}`
      : 'Could not load your profile.'
  } finally {
    if (checkingProfileUserId === userId) checkingProfileUserId = undefined
  }
}

async function saveUsername() {
  if (!supabase || !user.value || usernameSaving.value) return
  const username = usernameInput.value.trim()
  usernameError.value = ''
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{1,18}[A-Za-z0-9]$/.test(username)) {
    usernameError.value = 'Use 3–20 characters. Letters, numbers, spaces, periods, underscores and hyphens are allowed.'
    return
  }

  usernameSaving.value = true
  try {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
    if (sessionError) throw sessionError
    if (!sessionData.session) {
      usernameError.value = 'Your sign-in expired. Sign in with Google again.'
      return
    }

    const response = await fetch('/api/usernames/claim', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionData.session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username }),
    })
    const payload = await response.json()
    if (!response.ok) {
      const messages: Record<string, string> = {
        username_invalid: 'Use 3–20 characters. Letters, numbers, spaces, periods, underscores and hyphens are allowed.',
        username_profanity: 'Please choose a username without profanity.',
        username_taken: 'That username is already taken. Try another one.',
        not_authenticated: 'Your sign-in expired. Sign in with Google again.',
        rate_limited: 'You’re making username changes too quickly. Please wait a few minutes and try again.',
      }
      if (payload.error === 'username_cooldown' && payload.next_available_at) {
        usernameNextChangeAt.value = payload.next_available_at
        usernameError.value = `You can change your username again on ${new Intl.DateTimeFormat('en-US', {
          dateStyle: 'long',
          timeStyle: 'short',
        }).format(new Date(payload.next_available_at))}.`
      } else {
        usernameError.value = messages[payload.error] || 'Could not save your username. Please try again.'
      }
      return
    }

    currentUsername.value = payload.username
    usernameNextChangeAt.value = payload.next_change_at
    usernameSetupOpen.value = false
    usernameInput.value = ''
    noticeMessage.value = 'Your username is set.'
    await Promise.all([loadMyRecords(), loadLeaders()])
  } catch (error) {
    usernameError.value = error instanceof Error ? error.message : 'Could not save your username. Please try again.'
  } finally {
    usernameSaving.value = false
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
  currentUsername.value = ''
  usernameNextChangeAt.value = null
  usernameSetupOpen.value = false
  usernameInput.value = ''
  usernameError.value = ''
  checkingProfileUserId = undefined
  picks.value = []
  myRecords.value = []
  noticeMessage.value = 'You’re signed out.'
}

function navigateTo(page: 'home' | 'games' | 'profile' | 'leaderboard' | 'settings') {
  errorMessage.value = ''
  activePage.value = page
  const url = new URL(window.location.href)
  if (page === 'home') url.searchParams.delete('page')
  else url.searchParams.set('page', page)
  window.history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`)
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function syncRoute() {
  const page = new URLSearchParams(window.location.search).get('page')
  const nextPage = page === 'games' || page === 'profile' || page === 'leaderboard' || page === 'settings'
    ? page
    : 'home'
  if (nextPage !== activePage.value) errorMessage.value = ''
  activePage.value = nextPage
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
  const queryParams = new URLSearchParams(window.location.search)
  const authErrorDescription = authError.get('error_description') || queryParams.get('error_description')
  if (authError.has('error') || queryParams.has('error')) {
    authOpen.value = true
    authErrorMessage.value = authErrorDescription || 'Google sign-in could not be completed. Please try again.'
    queryParams.delete('error')
    queryParams.delete('error_code')
    queryParams.delete('error_description')
    const search = queryParams.toString()
    window.history.replaceState(null, document.title, `${window.location.pathname}${search ? `?${search}` : ''}`)
  }

  if (supabase) {
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      user.value = session?.user ?? null
      if (!user.value) {
        currentUsername.value = ''
        usernameSetupOpen.value = false
        checkingProfileUserId = undefined
      }
      window.setTimeout(() => {
        void loadAccountData()
        void checkUsernameSetup()
      }, 0)
    })
    authSubscription = listener.subscription
  }

  await loadGames()
  gameRefreshInterval = window.setInterval(() => void loadGames(), 60_000)
  await Promise.all([loadAccountData(), loadLeaders()])
})

onUnmounted(() => {
  window.removeEventListener('popstate', syncRoute)
  authSubscription?.unsubscribe()
  if (gameRefreshInterval !== undefined) window.clearInterval(gameRefreshInterval)
  if (errorTimeout !== undefined) window.clearTimeout(errorTimeout)
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
          <button
            class="signed-in account-link"
            type="button"
            aria-label="Open account settings"
            title="Account settings"
            @click="navigateTo('settings')"
          >{{ currentUsername || user.user_metadata.display_name || user.email }}</button>
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
        <div class="section-heading"><div><h1>Games</h1><p class="page-subtitle">Recent and upcoming games · Eastern time. Picks lock at the listed tip-off and cannot be changed afterward.</p></div></div>
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
                <div v-else-if="isLocked(game)" class="saved-tag">Locked at tip-off · picks cannot be changed</div>
                <div v-else-if="pickedTeam(game)" class="saved-tag">Pick saved · change it before {{ gameTime(game) }} ET</div>
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
        <div class="section-heading"><div><h1>My Profile</h1><p class="page-subtitle">{{ currentUsername || user?.user_metadata.display_name || user?.email || 'Your picks and results' }}</p></div></div>
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

      <section v-else-if="activePage === 'settings'" class="section settings-page">
        <div class="section-heading">
          <div><h1>Account settings</h1><p class="page-subtitle">Manage your Ball Knowledge account</p></div>
        </div>
        <template v-if="user">
          <section class="settings-card overview-panel">
            <div class="panel-heading"><h2>Username</h2></div>
            <div class="settings-value">
              <span>Current username</span>
              <strong>{{ currentUsername || 'Not set' }}</strong>
            </div>
            <p v-if="!usernameChangeAvailable" class="panel-note">
              You can change your username once every 30 days. Your next change is available {{ usernameChangeDate }}.
            </p>
            <template v-else>
              <p class="panel-note">You can change your username once every 30 days. Names must be unique and follow the username rules.</p>
              <form class="settings-form" @submit.prevent="saveUsername">
                <label class="username-label">
                  New username
                  <input
                    v-model="usernameInput"
                    type="text"
                    autocomplete="username"
                    minlength="3"
                    maxlength="20"
                    pattern="[A-Za-z0-9][A-Za-z0-9 ._-]{1,18}[A-Za-z0-9]"
                    required
                  />
                </label>
                <p class="username-hint">3–20 characters. Use letters, numbers, spaces, periods, underscores or hyphens.</p>
                <p v-if="usernameError" class="form-error" role="alert">{{ usernameError }}</p>
                <button class="button button-lime submit-button" :disabled="usernameSaving">
                  {{ usernameSaving ? 'Saving…' : 'Save username' }}
                </button>
              </form>
            </template>
          </section>
          <section class="settings-card overview-panel">
            <div class="panel-heading"><h2>Account</h2></div>
            <div class="settings-value"><span>Signed in with</span><strong>Google</strong></div>
            <div class="settings-value"><span>Email</span><strong>{{ user.email }}</strong></div>
            <button class="button button-outline settings-signout" @click="signOut">Sign out</button>
          </section>
        </template>
        <div v-else class="empty-state profile-signin">
          <p>Sign in to manage your account settings.</p>
          <button class="button button-lime" @click="openAuth">Sign in with Google</button>
        </div>
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
            <label class="leaderboard-search">
              <span class="visually-hidden">Search leaderboard players</span>
              <input v-model="leaderboardSearch" type="search" placeholder="Search players" autocomplete="off" />
            </label>
          </div>
          <div class="table-scroll">
            <table>
              <thead><tr><th>RANK</th><th>PLAYER</th><th>RECORD</th><th>WIN %</th><th>CURRENT STREAK</th><th>PICKS</th></tr></thead>
              <tbody v-if="!loadingLeaders && pagedLeaders.length">
                <tr v-for="entry in pagedLeaders" :key="entry.user_id" :class="{ 'current-player': user?.id === entry.user_id }">
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
          <div v-else-if="!filteredLeaders.length" class="leaderboard-empty">
            {{ leaders.length ? 'No players match your search.' : 'No results for this period yet.' }}
          </div>
          <footer v-if="!loadingLeaders && filteredLeaders.length" class="leaderboard-footer">
            <span class="leaderboard-count">Showing {{ leaderboardFirstRow }}–{{ leaderboardLastRow }} of {{ filteredLeaders.length }}</span>
            <label class="page-size-control">
              Rows per page
              <select v-model.number="leaderboardPageSize">
                <option :value="25">25</option>
                <option :value="50">50</option>
                <option :value="100">100</option>
              </select>
            </label>
            <div class="page-navigation" aria-label="Leaderboard pagination">
              <button class="page-button" :disabled="leaderboardPage === 1" @click="leaderboardPage -= 1">Previous</button>
              <span>Page {{ leaderboardPage }} of {{ leaderboardPageCount }}</span>
              <button class="page-button" :disabled="leaderboardPage >= leaderboardPageCount" @click="leaderboardPage += 1">Next</button>
            </div>
          </footer>
        </div>
      </section>
    </main>

    <div v-if="authOpen" class="modal-backdrop" @click.self="authOpen = false">
      <section class="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <button class="modal-close" aria-label="Close sign-in dialog" @click="authOpen = false">×</button>
        <h2 id="auth-title">Sign in</h2>
        <p class="auth-description">Sign in or create an account with Google.</p>
        <p v-if="authErrorMessage" class="form-error" role="alert">{{ authErrorMessage }}</p>
        <button class="button google-signin-button" :disabled="authBusy" @click="signInWithGoogle">
          <svg aria-hidden="true" viewBox="0 0 48 48">
            <path fill="#4285F4" d="M48 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h13.52c-.59 2.96-2.26 5.48-4.81 7.18l7.75 6.02C44.98 37.77 48 31.7 48 24.55Z" />
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.91-5.78l-7.75-6.02c-2.15 1.45-4.89 2.3-8.16 2.3-6.27 0-11.59-4.23-13.49-9.91l-8.01 6.19C6.48 42.62 14.62 48 24 48Z" />
            <path fill="#FBBC05" d="M10.51 28.59A14.4 14.4 0 0 1 9.75 24c0-1.59.27-3.13.76-4.59L2.5 13.22A23.9 23.9 0 0 0 0 24c0 3.88.93 7.56 2.56 10.78l7.95-6.19Z" />
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.72 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.48 5.38 2.56 13.22l7.95 6.19C12.41 13.73 17.73 9.5 24 9.5Z" />
          </svg>
          {{ authBusy ? 'Connecting…' : 'Continue with Google' }}
        </button>
      </section>
    </div>

    <div v-if="usernameSetupOpen && user" class="modal-backdrop username-backdrop">
      <section class="auth-modal username-modal" role="dialog" aria-modal="true" aria-labelledby="username-title">
        <h2 id="username-title">Choose your username</h2>
        <p class="auth-description">This is how you’ll appear on the leaderboard. Choose a unique name.</p>
        <form @submit.prevent="saveUsername">
          <label class="username-label">
            Username
            <input
              v-model="usernameInput"
              type="text"
              autocomplete="username"
              minlength="3"
              maxlength="20"
              pattern="[A-Za-z0-9][A-Za-z0-9 ._-]{1,18}[A-Za-z0-9]"
              required
              autofocus
            />
          </label>
          <p class="username-hint">3–20 characters. Use letters, numbers, spaces, periods, underscores or hyphens.</p>
          <p v-if="usernameError" class="form-error" role="alert">{{ usernameError }}</p>
          <button class="button button-lime submit-button" :disabled="usernameSaving">
            {{ usernameSaving ? 'Saving…' : 'Save username' }}
          </button>
        </form>
      </section>
    </div>
  </div>
</template>
