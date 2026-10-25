import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

const sessionLifetime = 30 * 24 * 60 * 60 * 1000

function createSessionStorage() {
  const projectRef = new URL(supabaseUrl).hostname.split('.')[0]
  const storageKey = `sb-${projectRef}-auth-token`
  const rememberedAtKey = `${storageKey}-remembered-at`

  return {
    getItem(key: string) {
      const value = window.localStorage.getItem(key)
      if (key !== storageKey) return value
      if (!value) {
        window.localStorage.removeItem(rememberedAtKey)
        return null
      }

      const storedRememberedAt = window.localStorage.getItem(rememberedAtKey)
      if (storedRememberedAt === null) {
        window.localStorage.setItem(rememberedAtKey, String(Date.now()))
        return value
      }

      const rememberedAt = Number(storedRememberedAt)
      if (!Number.isFinite(rememberedAt) || rememberedAt > Date.now() || Date.now() - rememberedAt >= sessionLifetime) {
        window.localStorage.removeItem(key)
        window.localStorage.removeItem(rememberedAtKey)
        return null
      }
      return value
    },
    setItem(key: string, value: string) {
      if (key === storageKey && window.localStorage.getItem(key) === null) {
        window.localStorage.setItem(rememberedAtKey, String(Date.now()))
      }
      window.localStorage.setItem(key, value)
    },
    removeItem(key: string) {
      window.localStorage.removeItem(key)
      if (key === storageKey) window.localStorage.removeItem(rememberedAtKey)
    },
  }
}

export const supabase = supabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: createSessionStorage(),
      },
    })
  : null
