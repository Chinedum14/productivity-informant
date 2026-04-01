import React, { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Activity,
  Briefcase,
  BookOpen,
  Bot,
  CheckCircle2,
  FileText,
  Github,
  Info,
  RefreshCw,
  Settings,
  X
} from 'lucide-react'
import { Reader } from './components/Reader'
import { DailyMetrics, getWeeklyHistory, saveDailyMetrics } from './utils/history'

interface Metrics {
  github: { count: number; completed: boolean; lastChecked: number }
  file: { lastEdit: number; completed: boolean }
  reading: { pages: number; completed: boolean; target: number }
  social: {
    linkedinUrl: string
    indeedUrl: string
    wellfoundUrl: string
    completed: boolean
    lastUpdated: number
  }
}

interface Goals {
  github: number
  reading: number
}

interface GrowthNairaState {
  balance: number
  lastSettlementRunDate: string
  lastSettledDate: string
  refillCount: number
  lastDailyChangePct: number
}

interface WeeklyInsightPayload {
  weekLabel: string
  days: DailyMetrics[]
  summary: {
    avgScore: number
    completionRate: number
    currentStreak: number
    longestStreak: number
    totalCommits: number
    totalPages: number
    daysTracked: number
    growthNaira: {
      currentValue: number
      estimatedStartOfWeekValue: number
      estimatedEndOfWeekValue: number
      weeklyChangePct: number
      perfectDays: number
      nonPerfectDays: number
    }
  }
}

interface WeeklyInsightResult {
  text: string
  source: 'gemini' | 'fallback'
  reason?: string
  retryAfterSeconds?: number
}

interface WeeklyInsightDailyCache {
  date: string
  text: string
  meta: string
  createdAt: number
}

interface DailyApplicationUrls {
  linkedin: string
  indeed: string
  wellfound: string
  submittedAt: number
}

type TabView = 'dashboard' | 'metrics'
type GoalType = 'github' | 'reading'

function parseRepoPaths(raw: string): string[] {
  return [...new Set(raw.split('\n').map((item) => item.trim()).filter((item) => item.length > 0))]
}

function getDeadlineForToday(now: Date): Date {
  const deadline = new Date(now)
  deadline.setHours(24, 0, 0, 0)
  return deadline
}

function getHoursUntilDeadline(now: Date): number {
  const msLeft = getDeadlineForToday(now).getTime() - now.getTime()
  return Math.max(0, msLeft / (1000 * 60 * 60))
}

function getNotificationIntervalMs(now: Date): number {
  const hoursLeft = getHoursUntilDeadline(now)
  return hoursLeft < 4 ? 60 * 60 * 1000 : 4 * 60 * 60 * 1000
}

const GROWTH_NAIRA_STORAGE_KEY = 'growth-naira-state'
const APPLICATION_ID_LOG_KEY = 'application-id-log'
const WEEKLY_INSIGHT_DAILY_CACHE_KEY = 'weekly-insight-daily-cache-v1'
const LEGACY_UTC_DATE_MIGRATION_KEY = 'migration-local-date-keys-v1'
const URGENT_NOTIFICATION_ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#5a0f16"/><text x="32" y="42" text-anchor="middle" font-size="32" fill="#ffb8c0">!</text></svg>')}`

function formatDateOnly(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00`)
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function migrateLegacyUtcDateKeysOnce(): void {
  if (localStorage.getItem(LEGACY_UTC_DATE_MIGRATION_KEY) === 'done') return

  const now = new Date()
  const localToday = formatDateOnly(now)
  const utcToday = utcDateKey(now)
  const localYesterday = formatDateOnly(addDays(now, -1))
  const utcYesterday = utcDateKey(addDays(now, -1))

  const remapTodayLikeKey = (prefix: string) => {
    const utcTodayKey = `${prefix}${utcToday}`
    const localTodayKey = `${prefix}${localToday}`
    if (!localStorage.getItem(localTodayKey) && localStorage.getItem(utcTodayKey)) {
      localStorage.setItem(localTodayKey, localStorage.getItem(utcTodayKey) as string)
    }

    const utcYesterdayKey = `${prefix}${utcYesterday}`
    const localYesterdayKey = `${prefix}${localYesterday}`
    if (!localStorage.getItem(localYesterdayKey) && localStorage.getItem(utcYesterdayKey)) {
      localStorage.setItem(localYesterdayKey, localStorage.getItem(utcYesterdayKey) as string)
    }
  }

  remapTodayLikeKey('reading-')
  remapTodayLikeKey('viewed-')

  const historyRaw = localStorage.getItem('metrics-history')
  if (historyRaw) {
    try {
      const history = JSON.parse(historyRaw) as DailyMetrics[]
      if (Array.isArray(history) && history.length > 0) {
        const rewritten = history.map((entry) => {
          if (entry.date === utcToday) return { ...entry, date: localToday }
          if (entry.date === utcYesterday) return { ...entry, date: localYesterday }
          return entry
        })

        const dedupedByDate = new Map<string, DailyMetrics>()
        for (const entry of rewritten) {
          if (!entry?.date) continue
          const existing = dedupedByDate.get(entry.date)
          if (!existing || (entry.score ?? 0) >= (existing.score ?? 0)) {
            dedupedByDate.set(entry.date, entry)
          }
        }
        const normalized = Array.from(dedupedByDate.values()).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30)
        localStorage.setItem('metrics-history', JSON.stringify(normalized))
      }
    } catch {
      // Ignore malformed history and proceed.
    }
  }

  const gnRaw = localStorage.getItem(GROWTH_NAIRA_STORAGE_KEY)
  if (gnRaw) {
    try {
      const gn = JSON.parse(gnRaw) as Partial<GrowthNairaState>
      if (typeof gn?.lastSettlementRunDate === 'string') {
        if (gn.lastSettlementRunDate === utcToday) gn.lastSettlementRunDate = localToday
        if (gn.lastSettlementRunDate === utcYesterday) gn.lastSettlementRunDate = localYesterday
        if (typeof gn.lastSettledDate === 'string') {
          if (gn.lastSettledDate === utcToday) gn.lastSettledDate = localToday
          if (gn.lastSettledDate === utcYesterday) gn.lastSettledDate = localYesterday
        } else {
          gn.lastSettledDate = formatDateOnly(addDays(parseDateOnly(gn.lastSettlementRunDate), -1))
        }
        localStorage.setItem(GROWTH_NAIRA_STORAGE_KEY, JSON.stringify(gn))
      }
    } catch {
      // Ignore malformed GN state and proceed.
    }
  }

  localStorage.setItem(LEGACY_UTC_DATE_MIGRATION_KEY, 'done')
}

function settleGrowthNaira(history: DailyMetrics[]): GrowthNairaState {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayKey = formatDateOnly(today)
  const yesterdayKey = formatDateOnly(addDays(today, -1))

  const defaultState: GrowthNairaState = {
    balance: 100,
    lastSettlementRunDate: todayKey,
    lastSettledDate: yesterdayKey,
    refillCount: 0,
    lastDailyChangePct: 0
  }

  const existingRaw = localStorage.getItem(GROWTH_NAIRA_STORAGE_KEY)
  const parsedExisting = existingRaw ? (JSON.parse(existingRaw) as Partial<GrowthNairaState>) : null
  const state: GrowthNairaState =
    parsedExisting &&
    typeof parsedExisting.balance === 'number' &&
    typeof parsedExisting.lastSettlementRunDate === 'string' &&
    typeof parsedExisting.refillCount === 'number' &&
    typeof parsedExisting.lastDailyChangePct === 'number'
      ? (() => {
          const inferredLastSettledDate =
            typeof parsedExisting.lastSettledDate === 'string' && parsedExisting.lastSettledDate.length > 0
              ? parsedExisting.lastSettledDate
              : formatDateOnly(addDays(parseDateOnly(parsedExisting.lastSettlementRunDate), -1))
          return {
            balance: Math.max(0, parsedExisting.balance),
            lastSettlementRunDate: parsedExisting.lastSettlementRunDate,
            lastSettledDate: inferredLastSettledDate,
            refillCount: Math.max(0, parsedExisting.refillCount),
            lastDailyChangePct: parsedExisting.lastDailyChangePct
          }
        })()
      : defaultState

  if (state.lastSettledDate >= yesterdayKey) {
    state.lastSettlementRunDate = todayKey
    localStorage.setItem(GROWTH_NAIRA_STORAGE_KEY, JSON.stringify(state))
    return state
  }

  const historyByDate = new Map(history.map((entry) => [entry.date, entry]))
  let rollingBalance = state.balance
  let cursor = addDays(parseDateOnly(state.lastSettledDate), 1)
  let lastDailyChangePct = state.lastDailyChangePct

  while (formatDateOnly(cursor) <= yesterdayKey) {
    const settlementDateKey = formatDateOnly(cursor)
    const dayMetric = historyByDate.get(settlementDateKey)
    const dayScoredPerfect = dayMetric?.score === 100
    const dayChangePct = dayScoredPerfect ? 1 : -2
    rollingBalance = rollingBalance * (1 + dayChangePct / 100)
    if (rollingBalance < 0.01) {
      rollingBalance = 0
    } else {
      rollingBalance = Number.parseFloat(rollingBalance.toFixed(2))
    }
    lastDailyChangePct = dayChangePct

    cursor = addDays(cursor, 1)
  }

  const nextState: GrowthNairaState = {
    balance: rollingBalance,
    lastSettlementRunDate: todayKey,
    lastSettledDate: yesterdayKey,
    refillCount: state.refillCount,
    lastDailyChangePct
  }
  localStorage.setItem(GROWTH_NAIRA_STORAGE_KEY, JSON.stringify(nextState))
  return nextState
}

function isTech4mationActiveDay(date: Date): boolean {
  const day = date.getDay()
  return day >= 1 && day <= 5
}

function isJobHuntingActiveDay(date: Date): boolean {
  const day = date.getDay()
  return day >= 1 && day <= 5
}

function isDayFullyCompleted(metric: DailyMetrics): boolean {
  const dayDate = new Date(metric.date)
  const tech4mationCompleted = isTech4mationActiveDay(dayDate) ? metric.githubCompleted : true
  const socialCompleted = isJobHuntingActiveDay(dayDate) ? (metric.socialCompleted ?? false) : true
  return tech4mationCompleted && metric.fileCompleted && metric.readingCompleted && socialCompleted
}

function normalizeUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim())
    parsed.hash = ''
    const normalizedPath = parsed.pathname.replace(/\/+$/, '')
    parsed.pathname = normalizedPath || '/'
    return parsed.toString()
  } catch {
    return null
  }
}

function normalizeSiteUrl(rawUrl: string, site: 'linkedin' | 'indeed' | 'wellfound'): string | null {
  const normalized = normalizeUrl(rawUrl)
  if (!normalized) return null

  const host = new URL(normalized).hostname.toLowerCase()
  if (site === 'linkedin' && !host.includes('linkedin.com')) return null
  if (site === 'indeed' && !host.includes('indeed.')) return null
  if (site === 'wellfound' && !host.includes('wellfound.com')) return null

  return normalized
}

function getApplicationIdLog(): Record<string, DailyApplicationUrls> {
  const raw = localStorage.getItem(APPLICATION_ID_LOG_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, DailyApplicationUrls>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function getSocialStatusForDate(date: string) {
  const log = getApplicationIdLog()
  const todayRecord = log[date]
  if (!todayRecord) {
    return {
      linkedinUrl: '',
      indeedUrl: '',
      wellfoundUrl: '',
      completed: false,
      lastUpdated: 0
    }
  }

  const formerRecords = Object.entries(log)
    .filter(([recordDate]) => recordDate < date)
    .map(([, record]) => record)

  const linkedinUnique = !formerRecords.some((record) => record.linkedin === todayRecord.linkedin)
  const indeedUnique = !formerRecords.some((record) => record.indeed === todayRecord.indeed)
  const wellfoundUnique = !formerRecords.some((record) => record.wellfound === todayRecord.wellfound)

  return {
    linkedinUrl: todayRecord.linkedin,
    indeedUrl: todayRecord.indeed,
    wellfoundUrl: todayRecord.wellfound,
    completed: linkedinUnique && indeedUnique && wellfoundUnique,
    lastUpdated: todayRecord.submittedAt
  }
}

function dateKey(date: Date): string {
  return formatDateOnly(date)
}

function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return 'N/A Today'
  const diffMs = Date.now() - timestamp
  const diffMinutes = Math.floor(diffMs / 60000)
  if (diffMinutes < 1) return 'Just now'
  if (diffMinutes < 60) return `Last ${diffMinutes} min ago`
  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `Last ${diffHours} hour${diffHours > 1 ? 's' : ''} ago`
  return new Date(timestamp).toLocaleString()
}

function getStreaks(records: DailyMetrics[]): { currentStreak: number; longestStreak: number } {
  if (records.length === 0) return { currentStreak: 0, longestStreak: 0 }
  const byDate = new Map(records.map((entry) => [entry.date, entry]))
  const sortedDates = [...byDate.keys()].sort((a, b) => a.localeCompare(b))

  const isPerfectScoreDay = (key: string): boolean => {
    const day = byDate.get(key)
    return Boolean(day && day.score === 100)
  }

  let longest = 0
  let run = 0
  let previousDate: string | null = null
  for (const dayKey of sortedDates) {
    const isConsecutive = previousDate
      ? formatDateOnly(addDays(parseDateOnly(previousDate), 1)) === dayKey
      : true

    if (!isConsecutive) {
      run = 0
    }

    if (isPerfectScoreDay(dayKey)) {
      run += 1
      longest = Math.max(longest, run)
    } else {
      run = 0
    }
    previousDate = dayKey
  }

  const today = new Date()
  const todayKey = formatDateOnly(today)
  const yesterdayKey = formatDateOnly(addDays(today, -1))
  const anchorKey = isPerfectScoreDay(todayKey) ? todayKey : yesterdayKey

  let current = 0
  if (isPerfectScoreDay(anchorKey)) {
    current = 1
    let cursor = parseDateOnly(anchorKey)
    while (true) {
      cursor = addDays(cursor, -1)
      const cursorKey = formatDateOnly(cursor)
      if (isPerfectScoreDay(cursorKey)) {
        current += 1
      } else {
        break
      }
    }
  }

  return { currentStreak: current, longestStreak: longest }
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const result: React.ReactNode[] = []
  const regex = /\*\*(.+?)\*\*/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push(text.slice(lastIndex, match.index))
    }
    result.push(<strong key={`bold-${match.index}`}>{match[1]}</strong>)
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    result.push(text.slice(lastIndex))
  }

  return result
}

function renderInsightText(text: string): React.ReactNode {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  return (
    <div className="ai-insight-text">
      {lines.map((line, index) => (
        <p key={`insight-line-${index}`}>{renderInlineMarkdown(line)}</p>
      ))}
    </div>
  )
}

function App(): React.JSX.Element {
  const [metrics, setMetrics] = useState<Metrics>({
    github: { count: 0, completed: false, lastChecked: 0 },
    file: { lastEdit: 0, completed: false },
    reading: { pages: 0, completed: false, target: 10 },
    social: {
      linkedinUrl: '',
      indeedUrl: '',
      wellfoundUrl: '',
      completed: false,
      lastUpdated: 0
    }
  })

  const [goals, setGoals] = useState<Goals>({
    github: Number(localStorage.getItem('goal-github')) || 3,
    reading: Number(localStorage.getItem('goal-reading')) || 10
  })

  const [config, setConfig] = useState(() => {
    const storedList = localStorage.getItem('local-repo-paths')
    const fallback = localStorage.getItem('local-repo-path') || ''
    return {
      localRepoPathsText: storedList || fallback
    }
  })

  const [loading, setLoading] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showApplicationModal, setShowApplicationModal] = useState(false)
  const [applicationForm, setApplicationForm] = useState({
    linkedinUrl: '',
    indeedUrl: '',
    wellfoundUrl: ''
  })
  const [applicationFormError, setApplicationFormError] = useState<string | null>(null)
  const [goalEditor, setGoalEditor] = useState<{ type: GoalType; value: number } | null>(null)
  const [history, setHistory] = useState<DailyMetrics[]>([])
  const [allHistory, setAllHistory] = useState<DailyMetrics[]>([])
  const [view, setView] = useState<TabView>('dashboard')
  const [activeChartIndex, setActiveChartIndex] = useState<number | null>(null)
  const [weeklyInsight, setWeeklyInsight] = useState('Generating weekly insight...')
  const [weeklyInsightLoading, setWeeklyInsightLoading] = useState(false)
  const [weeklyInsightError, setWeeklyInsightError] = useState<string | null>(null)
  const [weeklyInsightMeta, setWeeklyInsightMeta] = useState('Source: pending')
  const weeklyInsightInFlightRef = useRef(false)
  const weeklyInsightLastAutoSignatureRef = useRef<string | null>(null)
  const weeklyInsightRateLimitedUntilRef = useRef<number>(0)
  const [growthNaira, setGrowthNaira] = useState<GrowthNairaState>(() => {
    const today = new Date()
    const todayKey = formatDateOnly(today)
    return {
      balance: 100,
      lastSettlementRunDate: todayKey,
      lastSettledDate: formatDateOnly(addDays(today, -1)),
      refillCount: 0,
      lastDailyChangePct: 0
    }
  })
  const tech4mationActiveToday = isTech4mationActiveDay(new Date())
  const jobHuntingActiveToday = isJobHuntingActiveDay(new Date())

  const performanceScore = useMemo(() => {
    const taskStates = [metrics.file.completed, metrics.reading.completed]
    if (jobHuntingActiveToday) {
      taskStates.push(metrics.social.completed)
    }
    if (tech4mationActiveToday) {
      taskStates.unshift(metrics.github.completed)
    }

    const completedCount = taskStates.filter(Boolean).length
    return taskStates.length === 0 ? 0 : Math.round((completedCount / taskStates.length) * 100)
  }, [metrics, tech4mationActiveToday, jobHuntingActiveToday])
  const latestPerformanceScoreRef = useRef(performanceScore)

  useEffect(() => {
    latestPerformanceScoreRef.current = performanceScore
  }, [performanceScore])

  useEffect(() => {
    migrateLegacyUtcDateKeysOnce()
  }, [])

  const fetchMetrics = async () => {
    setLoading(true)
    try {
      if (tech4mationActiveToday) {
        const ghStatus = await window.electron.ipcRenderer.invoke('get-github-status', {
          repoPaths: parseRepoPaths(config.localRepoPathsText)
        })
        setMetrics((prev) => ({
          ...prev,
          github: { ...ghStatus, completed: ghStatus.count >= goals.github }
        }))
      } else {
        setMetrics((prev) => ({
          ...prev,
          github: { count: 0, completed: false, lastChecked: 0 }
        }))
      }

      const fileStatus = await window.electron.ipcRenderer.invoke('get-file-edit-status')
      setMetrics((prev) => ({ ...prev, file: fileStatus }))

      const today = dateKey(new Date())
      const readingData = JSON.parse(localStorage.getItem(`reading-${today}`) || '{"pages": 0}')
      setMetrics((prev) => ({
        ...prev,
        reading: {
          pages: readingData.pages,
          completed: readingData.pages >= goals.reading,
          target: goals.reading
        }
      }))

      const socialStatus = jobHuntingActiveToday
        ? getSocialStatusForDate(today)
        : {
            linkedinUrl: '',
            indeedUrl: '',
            wellfoundUrl: '',
            completed: false,
            lastUpdated: 0
          }
      setMetrics((prev) => ({
        ...prev,
        social: socialStatus
      }))
    } catch (error) {
      console.error('Failed to fetch metrics:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const today = dateKey(new Date())
    saveDailyMetrics({
      date: today,
      githubCount: metrics.github.count,
      githubCompleted: metrics.github.completed,
      fileCompleted: metrics.file.completed,
      readingPages: metrics.reading.pages,
      readingCompleted: metrics.reading.completed,
      socialCompleted: metrics.social.completed,
      score: performanceScore
    })

    const historyRaw = localStorage.getItem('metrics-history') || '[]'
    const parsedHistory: DailyMetrics[] = JSON.parse(historyRaw)
    setAllHistory(parsedHistory.sort((a, b) => a.date.localeCompare(b.date)))
    setHistory(getWeeklyHistory())
  }, [performanceScore, metrics])

  useEffect(() => {
    const settled = settleGrowthNaira(allHistory)
    setGrowthNaira(settled)
  }, [allHistory])

  useEffect(() => {
    fetchMetrics()
    const interval = setInterval(fetchMetrics, 300000)
    return () => clearInterval(interval)
  }, [config, goals])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof Notification === 'undefined') return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const ensurePermission = async () => {
      if (Notification.permission === 'default') {
        try {
          await Notification.requestPermission()
        } catch (error) {
          console.warn('Unable to request notification permission:', error)
        }
      }
    }

    const sendProgressNotification = () => {
      if (Notification.permission !== 'granted') return

      const score = latestPerformanceScoreRef.current
      if (score >= 100) return

      const now = new Date()
      const hoursLeft = Math.max(0, Math.ceil(getHoursUntilDeadline(now)))

      new Notification('Progress Reminder', {
        body: `Current score: ${score}%. ${hoursLeft} hour${hoursLeft === 1 ? '' : 's'} left to today’s deadline.`,
        icon: URGENT_NOTIFICATION_ICON
      })
    }

    const scheduleNext = () => {
      if (cancelled) return
      const now = new Date()
      const nextIntervalMs = getNotificationIntervalMs(now)
      timer = setTimeout(() => {
        sendProgressNotification()
        scheduleNext()
      }, nextIntervalMs)
    }

    ensurePermission()
    scheduleNext()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  const saveGoals = (nextGoals: Goals) => {
    localStorage.setItem('goal-github', String(nextGoals.github))
    localStorage.setItem('goal-reading', String(nextGoals.reading))
    setGoals(nextGoals)
    setShowSettings(false)
  }

  const saveGithubConfig = () => {
    const normalized = parseRepoPaths(config.localRepoPathsText).join('\n')
    localStorage.setItem('local-repo-paths', normalized)
    localStorage.removeItem('local-repo-path')
    setConfig((prev) => ({ ...prev, localRepoPathsText: normalized }))
    setShowSettings(false)
    fetchMetrics()
  }

  const refillGrowthNaira = () => {
    const today = new Date()
    const todayKey = formatDateOnly(today)
    const nextState: GrowthNairaState = {
      balance: 100,
      lastSettlementRunDate: todayKey,
      lastSettledDate: growthNaira.lastSettledDate || formatDateOnly(addDays(today, -1)),
      refillCount: growthNaira.refillCount + 1,
      lastDailyChangePct: 0
    }
    localStorage.setItem(GROWTH_NAIRA_STORAGE_KEY, JSON.stringify(nextState))
    setGrowthNaira(nextState)
  }

  const recalculateGrowthNairaFromHistory = () => {
    const today = new Date()
    const todayKey = formatDateOnly(today)
    const yesterdayKey = formatDateOnly(addDays(today, -1))

    const scoredDays = [...allHistory]
      .filter((entry) => entry.date <= yesterdayKey)
      .sort((a, b) => a.date.localeCompare(b.date))

    let balance = 100
    let lastDailyChangePct = 0

    for (const day of scoredDays) {
      const dayChangePct = day.score === 100 ? 1 : -2
      balance = balance * (1 + dayChangePct / 100)
      if (balance < 0.01) {
        balance = 0
      } else {
        balance = Number.parseFloat(balance.toFixed(2))
      }
      lastDailyChangePct = dayChangePct
    }

    const nextState: GrowthNairaState = {
      balance,
      lastSettlementRunDate: todayKey,
      lastSettledDate: yesterdayKey,
      refillCount: growthNaira.refillCount,
      lastDailyChangePct
    }

    localStorage.setItem(GROWTH_NAIRA_STORAGE_KEY, JSON.stringify(nextState))
    setGrowthNaira(nextState)
  }

  const openApplicationModal = () => {
    const today = dateKey(new Date())
    const log = getApplicationIdLog()
    const todayRecord = log[today]
    setApplicationForm({
      linkedinUrl: todayRecord?.linkedin || '',
      indeedUrl: todayRecord?.indeed || '',
      wellfoundUrl: todayRecord?.wellfound || ''
    })
    setApplicationFormError(null)
    setShowApplicationModal(true)
  }

  const saveApplicationIds = () => {
    const linkedinUrl = normalizeSiteUrl(applicationForm.linkedinUrl, 'linkedin')
    const indeedUrl = normalizeSiteUrl(applicationForm.indeedUrl, 'indeed')
    const wellfoundUrl = normalizeSiteUrl(applicationForm.wellfoundUrl, 'wellfound')

    if (!linkedinUrl || !indeedUrl || !wellfoundUrl) {
      setApplicationFormError(
        'Please paste valid LinkedIn, Indeed, and Wellfound URLs.'
      )
      return
    }

    const today = dateKey(new Date())
    const log = getApplicationIdLog()
    log[today] = {
      linkedin: linkedinUrl,
      indeed: indeedUrl,
      wellfound: wellfoundUrl,
      submittedAt: Date.now()
    }
    localStorage.setItem(APPLICATION_ID_LOG_KEY, JSON.stringify(log))

    const socialStatus = getSocialStatusForDate(today)
    setMetrics((prev) => ({
      ...prev,
      social: socialStatus
    }))

    setApplicationFormError(null)
    setShowApplicationModal(false)
  }

  const openGoalEditor = (type: GoalType) => {
    setGoalEditor({
      type,
      value: type === 'github' ? goals.github : goals.reading
    })
  }

  const saveGoalFromEditor = () => {
    if (!goalEditor) return
    const normalizedValue = Math.max(0, Number(goalEditor.value) || 0)
    const nextGoals =
      goalEditor.type === 'github'
        ? { ...goals, github: normalizedValue }
        : { ...goals, reading: normalizedValue }
    saveGoals(nextGoals)
    setGoalEditor(null)
  }

  const overviewStats = useMemo(() => {
    const totalDays = allHistory.length
    const completedDays = allHistory.filter((d) => isDayFullyCompleted(d)).length
    const completionRate = totalDays === 0 ? 0 : Math.round((completedDays / totalDays) * 100)
    const { currentStreak, longestStreak } = getStreaks(allHistory)
    return { totalDays, completedDays, currentStreak, longestStreak, completionRate }
  }, [allHistory])

  const weeklyInsightPayload = useMemo<WeeklyInsightPayload | null>(() => {
    if (history.length === 0) return null
    const first = history[0]?.date
    const last = history[history.length - 1]?.date
    const perfectDays = history.filter((item) => item.score === 100).length
    const nonPerfectDays = Math.max(0, history.length - perfectDays)
    const weeklyFactor = history.reduce((factor, item) => factor * (item.score === 100 ? 1.01 : 0.98), 1)
    const estimatedEnd = growthNaira.balance
    const estimatedStart = weeklyFactor > 0 ? estimatedEnd / weeklyFactor : estimatedEnd
    const weeklyChangePct = (weeklyFactor - 1) * 100

    return {
      weekLabel: first && last ? `${first} to ${last}` : 'Current week',
      days: history,
      summary: {
        avgScore: history.length > 0 ? Math.round(history.reduce((sum, item) => sum + item.score, 0) / history.length) : 0,
        completionRate: overviewStats.completionRate,
        currentStreak: overviewStats.currentStreak,
        longestStreak: overviewStats.longestStreak,
        totalCommits: history.reduce((sum, item) => sum + item.githubCount, 0),
        totalPages: history.reduce((sum, item) => sum + item.readingPages, 0),
        daysTracked: history.length,
        growthNaira: {
          currentValue: Number.parseFloat(growthNaira.balance.toFixed(2)),
          estimatedStartOfWeekValue: Number.parseFloat(estimatedStart.toFixed(2)),
          estimatedEndOfWeekValue: Number.parseFloat(estimatedEnd.toFixed(2)),
          weeklyChangePct: Number.parseFloat(weeklyChangePct.toFixed(2)),
          perfectDays,
          nonPerfectDays
        }
      }
    }
  }, [history, overviewStats, growthNaira.balance])

  const weeklySeries = useMemo(() => {
    const scoreByDate = new Map(history.map((entry) => [entry.date, entry.score]))
    const now = new Date()
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(now)
      date.setDate(now.getDate() - (6 - index))
      const key = dateKey(date)
      return {
        date: key,
        label: date.toLocaleDateString('en-US', { weekday: 'short' }),
        fullLabel: date.toLocaleDateString('en-GB', {
          weekday: 'short',
          day: '2-digit',
          month: 'short'
        }),
        score: scoreByDate.get(key) ?? 0
      }
    })
  }, [history])

  const weeklyInsightSignature = useMemo(() => JSON.stringify(weeklyInsightPayload), [weeklyInsightPayload])

  const chartPoints = useMemo(() => {
    return weeklySeries.map((point, index) => {
      const x = (index / 6) * 100
      const y = 100 - point.score
      return `${index === 0 ? 'M' : 'L'} ${x},${y}`
    })
  }, [weeklySeries])

  const chartPath = chartPoints.join(' ')
  const hasChartData = weeklySeries.length > 0
  const selectedChartIndex = activeChartIndex ?? null
  const selectedChartPoint = selectedChartIndex !== null ? weeklySeries[selectedChartIndex] : null
  const selectedChartLeft = selectedChartIndex !== null ? (selectedChartIndex / 6) * 100 : 0
  const todayLabel = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  })
  const growthDeltaText =
    growthNaira.lastDailyChangePct > 0
      ? `+${growthNaira.lastDailyChangePct}% yesterday`
      : growthNaira.lastDailyChangePct < 0
        ? `${growthNaira.lastDailyChangePct}% yesterday`
        : '0% yesterday'
  const growthDeltaClass =
    growthNaira.lastDailyChangePct > 0
      ? 'gn-change-positive'
      : growthNaira.lastDailyChangePct < 0
        ? 'gn-change-negative'
        : 'gn-change-neutral'

  const requestWeeklyInsight = async (options?: { force?: boolean }) => {
    const force = options?.force === true
    const now = Date.now()
    const todayKey = dateKey(new Date())

    if (!weeklyInsightPayload) {
      setWeeklyInsight('No weekly data is available yet. Track a few days to generate AI insights.')
      setWeeklyInsightError(null)
      setWeeklyInsightMeta('Source: fallback (no weekly data)')
      return
    }

    const cachedRaw = localStorage.getItem(WEEKLY_INSIGHT_DAILY_CACHE_KEY)
    if (cachedRaw) {
      try {
        const cached = JSON.parse(cachedRaw) as Partial<WeeklyInsightDailyCache>
        if (cached.date === todayKey && typeof cached.text === 'string' && typeof cached.meta === 'string') {
          setWeeklyInsight(cached.text)
          setWeeklyInsightError(null)
          setWeeklyInsightMeta(`${cached.meta} | Cached today`)
          return
        }
      } catch {
        // Ignore corrupt cache and continue with fresh generation.
      }
    }

    if (weeklyInsightInFlightRef.current) return

    if (!force) {
      if (view !== 'metrics') return
      if (
        weeklyInsightSignature &&
        weeklyInsightLastAutoSignatureRef.current === weeklyInsightSignature
      ) {
        return
      }
      if (now < weeklyInsightRateLimitedUntilRef.current) return
    } else if (now < weeklyInsightRateLimitedUntilRef.current) {
      const waitSeconds = Math.max(
        1,
        Math.ceil((weeklyInsightRateLimitedUntilRef.current - now) / 1000)
      )
      setWeeklyInsightError(`Rate limited. Retry in about ${waitSeconds}s.`)
      return
    }

    weeklyInsightInFlightRef.current = true
    setWeeklyInsightLoading(true)
    setWeeklyInsightError(null)
    setWeeklyInsightMeta('Source: loading...')
    try {
      const response = (await window.electron.ipcRenderer.invoke(
        'generate-weekly-insight',
        weeklyInsightPayload
      )) as WeeklyInsightResult | string

      if (typeof response === 'string') {
        if (response.trim().length > 0) {
          setWeeklyInsight(response.trim())
          setWeeklyInsightMeta('Source: fallback (legacy)')
          localStorage.setItem(
            WEEKLY_INSIGHT_DAILY_CACHE_KEY,
            JSON.stringify({
              date: todayKey,
              text: response.trim(),
              meta: 'Source: fallback (legacy)',
              createdAt: Date.now()
            } satisfies WeeklyInsightDailyCache)
          )
        } else {
          setWeeklyInsight('No weekly insight generated. Try refreshing after more data is tracked.')
          setWeeklyInsightMeta('Source: fallback (empty)')
          localStorage.setItem(
            WEEKLY_INSIGHT_DAILY_CACHE_KEY,
            JSON.stringify({
              date: todayKey,
              text: 'No weekly insight generated. Try refreshing after more data is tracked.',
              meta: 'Source: fallback (empty)',
              createdAt: Date.now()
            } satisfies WeeklyInsightDailyCache)
          )
        }
      } else if (response && typeof response.text === 'string' && response.text.trim().length > 0) {
        const nextText = response.text.trim()
        const nextMeta = `Source: ${response.source}${response.reason ? ` (${response.reason.replaceAll('_', ' ')})` : ''}`
        setWeeklyInsight(nextText)
        setWeeklyInsightMeta(nextMeta)
        localStorage.setItem(
          WEEKLY_INSIGHT_DAILY_CACHE_KEY,
          JSON.stringify({
            date: todayKey,
            text: nextText,
            meta: nextMeta,
            createdAt: Date.now()
          } satisfies WeeklyInsightDailyCache)
        )
        if (response.reason === 'http_429') {
          const retryAfterSeconds =
            typeof response.retryAfterSeconds === 'number' ? response.retryAfterSeconds : 30
          weeklyInsightRateLimitedUntilRef.current = Date.now() + retryAfterSeconds * 1000
          setWeeklyInsightError(`Rate limited by Gemini. Auto-retry paused for ${retryAfterSeconds}s.`)
        }
      } else {
        setWeeklyInsight('No weekly insight generated. Try refreshing after more data is tracked.')
        setWeeklyInsightMeta('Source: fallback (empty)')
        localStorage.setItem(
          WEEKLY_INSIGHT_DAILY_CACHE_KEY,
          JSON.stringify({
            date: todayKey,
            text: 'No weekly insight generated. Try refreshing after more data is tracked.',
            meta: 'Source: fallback (empty)',
            createdAt: Date.now()
          } satisfies WeeklyInsightDailyCache)
        )
      }
      if (!force) {
        weeklyInsightLastAutoSignatureRef.current = weeklyInsightSignature
      }
    } catch (error) {
      console.error('Failed to generate weekly insight:', error)
      const fallbackText = 'Unable to generate AI weekly insight right now. Try again tomorrow.'
      setWeeklyInsight(fallbackText)
      setWeeklyInsightError('Unable to generate AI weekly insight right now.')
      setWeeklyInsightMeta('Source: error')
      localStorage.setItem(
        WEEKLY_INSIGHT_DAILY_CACHE_KEY,
        JSON.stringify({
          date: todayKey,
          text: fallbackText,
          meta: 'Source: error',
          createdAt: Date.now()
        } satisfies WeeklyInsightDailyCache)
      )
    } finally {
      weeklyInsightInFlightRef.current = false
      setWeeklyInsightLoading(false)
    }
  }

  useEffect(() => {
    requestWeeklyInsight()
  }, [weeklyInsightSignature, view])

  const dashboardCards = [
    {
      id: 'github',
      icon: <Github size={18} />,
      title: 'Tech4mation',
      subtitle: `Minimum ${goals.github} local git commits per day across configured repos`,
      badge: metrics.github.completed ? 'Completed' : tech4mationActiveToday ? 'Incomplete' : 'N/A Today',
      badgeClass: metrics.github.completed
        ? 'is-completed'
        : tech4mationActiveToday
          ? 'is-warning'
          : 'is-neutral',
      metric: metrics.github.count,
      target: goals.github,
      unit: 'commits',
      progress: Math.min((metrics.github.count / goals.github) * 100, 100),
      activity: 'Active: Mon, Tue, Wed, Thu, Fri',
      status: formatRelativeTime(metrics.github.lastChecked),
      tone: 'tone-blue',
      canEditGoal: true
    },
    {
      id: 'file',
      icon: <FileText size={18} />,
      title: 'Quant Finance/Algo',
      subtitle: 'Daily edit of Quant Statisticals files',
      badge: metrics.file.completed ? 'Completed' : 'Pending',
      badgeClass: metrics.file.completed ? 'is-completed' : 'is-warning',
      metric: metrics.file.completed ? 1 : 0,
      target: 1,
      unit: 'file edit',
      progress: metrics.file.completed ? 100 : 0,
      activity: 'Active: Mon, Tue, Wed, Thu, Fri, Sat, Sun',
      status: formatRelativeTime(metrics.file.lastEdit),
      tone: 'tone-green',
      canEditGoal: false
    },
    {
      id: 'reading',
      icon: <BookOpen size={18} />,
      title: 'Reading',
      subtitle: `Minimum ${goals.reading} pages read in specified digital book`,
      badge: metrics.reading.completed ? 'Completed' : 'Incomplete',
      badgeClass: metrics.reading.completed ? 'is-completed' : 'is-danger',
      metric: metrics.reading.pages,
      target: goals.reading,
      unit: 'pages',
      progress: Math.min((metrics.reading.pages / goals.reading) * 100, 100),
      activity: 'Active: Mon, Tue, Wed, Thu, Fri, Sat, Sun',
      status: formatRelativeTime(Date.now()),
      tone: 'tone-red',
      canEditGoal: true
    },
    {
      id: 'applications',
      icon: <Briefcase size={18} />,
      title: 'Job Hunting',
      subtitle: 'Track daily posting URLs across LinkedIn, Indeed, and Wellfound',
      badge: metrics.social.completed ? 'Completed' : jobHuntingActiveToday ? 'Incomplete' : 'N/A Today',
      badgeClass: metrics.social.completed
        ? 'is-completed'
        : jobHuntingActiveToday
          ? 'is-warning'
          : 'is-neutral',
      metric: metrics.social.completed
        ? 3
        : [metrics.social.linkedinUrl, metrics.social.indeedUrl, metrics.social.wellfoundUrl].filter(Boolean).length,
      target: 3,
      unit: 'site URLs',
      progress: metrics.social.completed
        ? 100
        : ([metrics.social.linkedinUrl, metrics.social.indeedUrl, metrics.social.wellfoundUrl].filter(Boolean).length / 3) * 100,
      activity: 'Active: Mon, Tue, Wed, Thu, Fri',
      status: metrics.social.lastUpdated
        ? formatRelativeTime(metrics.social.lastUpdated)
        : jobHuntingActiveToday
          ? 'No update yet'
          : 'N/A Today',
      tone: 'tone-blue',
      canEditGoal: false
    }
  ]

  return (
    <div className="tracker-shell">
      <header className="top-bar">
        <div className="brand">
          <div className="brand-mark">
            <Activity size={18} />
          </div>
          <div>
            <h1>Performance Tracker</h1>
            <p>Objective task completion monitoring</p>
          </div>
        </div>

        <div className="top-right">
          <div className="date-badge">
            <span>Today</span>
            <strong>{todayLabel}</strong>
          </div>
          <button className="icon-button" onClick={fetchMetrics} disabled={loading} aria-label="Refresh metrics">
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
          </button>
          <button className="icon-button" onClick={() => setShowSettings(true)} aria-label="Open settings">
            <Settings size={16} />
          </button>
        </div>
      </header>

      <nav className="tab-switcher" aria-label="Page navigation">
        <button className={view === 'dashboard' ? 'tab active' : 'tab'} onClick={() => setView('dashboard')}>
          Dashboard
        </button>
        <button className={view === 'metrics' ? 'tab active' : 'tab'} onClick={() => setView('metrics')}>
          Metrics
        </button>
      </nav>

      <motion.main className="page-content" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.35 }}>
        {view === 'dashboard' && (
          <section className="dashboard-page">
            <h2>Today&apos;s Tracking Fields</h2>
            <div className="tracking-grid">
              {dashboardCards.map((card) => (
                <article key={card.id} className={`tracking-card ${card.tone}`}>
                  <div className="card-top">
                    <div className="title-wrap">
                      <span className="small-icon">{card.icon}</span>
                      <div>
                        <h3>{card.title}</h3>
                        <p>{card.subtitle}</p>
                      </div>
                    </div>
                    <span className={`status-chip ${card.badgeClass}`}>{card.badge}</span>
                  </div>

                  <div className="metric-row">
                    <span className="value">
                      {card.metric}
                      <small> / {card.target}</small>
                    </span>
                    <span className="unit">{card.unit}</span>
                  </div>

                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: `${card.progress}%` }} />
                  </div>

                  <div className="card-meta">
                    <span>{card.activity}</span>
                    <span>{card.status}</span>
                  </div>

                  <button
                    className="outline-button"
                    onClick={() => {
                      if (card.id === 'github') {
                        openGoalEditor('github')
                        return
                      }
                      if (card.id === 'reading') {
                        openGoalEditor('reading')
                        return
                      }
                      if (card.id === 'applications') {
                        openApplicationModal()
                        return
                      }
                      fetchMetrics()
                    }}
                    disabled={loading}
                  >
                    Update Goal
                  </button>
                </article>
              ))}
            </div>

            <article className="gn-card dashboard-gn-card">
              <div className="gn-header">
                <div className="gn-title-wrap">
                  <h2>Growth Naira (GN)</h2>
                  <span className="gn-info" tabIndex={0} aria-label="Growth Naira settlement rules">
                    <Info size={14} />
                    <span className="gn-info-tooltip">
                      Daily settlement: +1% for a 100% score day, -2% for a day below 100%.
                    </span>
                  </span>
                </div>
                <span className="gn-badge">Asset Value</span>
              </div>
              <div className="gn-content">
                <div className="gn-balance-wrap">
                  <span className="gn-label">Current Value</span>
                  <strong className="gn-balance">{growthNaira.balance.toFixed(2)} GN</strong>
                  <p className={`gn-change ${growthDeltaClass}`}>{growthDeltaText}</p>
                </div>
                <div className="gn-meta">
                  <span>Initial grant: 100 GN</span>
                  <span>Refills used: {growthNaira.refillCount}</span>
                </div>
                <button className="outline-button" onClick={recalculateGrowthNairaFromHistory}>
                  Recalculate GN
                </button>
                {growthNaira.balance <= 0 && (
                  <button className="primary-button gn-refill-button" onClick={refillGrowthNaira}>
                    Refill To 100 GN
                  </button>
                )}
              </div>
            </article>

            <Reader
              onProgress={(pages) =>
                setMetrics((prev) => ({
                  ...prev,
                  reading: { ...prev.reading, pages, completed: pages >= goals.reading }
                }))
              }
            />

            <article className="info-card">
              <h3>About This Tracker</h3>
              <p>This is a demonstration version with manual updates. A fully integrated system would:</p>
              <ul>
                <li>
                  <strong>Tech4mation:</strong> Track commits from local repositories on weekdays only (Mon-Fri).
                </li>
                <li>
                  <strong>Quant Finance/Algo:</strong> Monitor file changes at your configured Quant Statisticals directory.
                </li>
                <li>
                  <strong>Reading:</strong> Integrate with e-reader apps or PDF viewers to track page progress.
                </li>
              </ul>
            </article>
          </section>
        )}

        {view === 'metrics' && (
          <section className="metrics-page">
            <article className="metrics-card">
              <h2>Performance Overview</h2>
              <div className="overview-grid">
                <div className="overview-tile tile-a">
                  <strong>{overviewStats.totalDays}</strong>
                  <span>Total Days</span>
                </div>
                <div className="overview-tile tile-b">
                  <strong>{overviewStats.completedDays}</strong>
                  <span>Completed</span>
                </div>
                <div className="overview-tile tile-c">
                  <strong>{overviewStats.currentStreak}</strong>
                  <span>Current Streak</span>
                </div>
                <div className="overview-tile tile-d">
                  <strong>{overviewStats.longestStreak}</strong>
                  <span>Longest Streak</span>
                </div>
                <div className="overview-tile tile-e">
                  <strong>{overviewStats.completionRate}%</strong>
                  <span>Completion Rate</span>
                </div>
              </div>
            </article>

            <article className="metrics-card chart-card">
              <h2>Weekly Completion Rate</h2>
              <div className="chart-layout">
                <div className="y-axis-labels">
                  {[100, 75, 50, 25, 0].map((value) => (
                    <span key={value}>{value}</span>
                  ))}
                </div>
                <div className="chart-plot">
                  <div className="chart-frame">
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Weekly completion rate chart">
                      {[0, 25, 50, 75, 100].map((value) => (
                        <line key={`y-${value}`} x1="0" x2="100" y1={100 - value} y2={100 - value} className="grid-line" />
                      ))}
                      {weeklySeries.map((_, index) => (
                        <line
                          key={`x-${index}`}
                          x1={(index / 6) * 100}
                          x2={(index / 6) * 100}
                          y1="0"
                          y2="100"
                          className="grid-line"
                        />
                      ))}
                      {chartPath && <path d={chartPath} className="line-path" />}
                      {weeklySeries.map((point, index) => (
                        <circle
                          key={point.date}
                          cx={(index / 6) * 100}
                          cy={100 - point.score}
                          r={selectedChartIndex === index ? 1.9 : 1.2}
                          className={selectedChartIndex === index ? 'line-point active' : 'line-point'}
                        />
                      ))}
                    </svg>
                    <div className="chart-hotzones">
                      {weeklySeries.map((point, index) => (
                        <button
                          key={`hotzone-${point.date}`}
                          type="button"
                          className="chart-hotzone"
                          onMouseEnter={() => setActiveChartIndex(index)}
                          onFocus={() => setActiveChartIndex(index)}
                          onBlur={() => setActiveChartIndex(null)}
                          aria-label={`${point.fullLabel}: ${point.score}%`}
                        />
                      ))}
                    </div>
                    {hasChartData && selectedChartPoint && (
                      <>
                        <div className="chart-focus-line" style={{ left: `${selectedChartLeft}%` }} />
                        <div className="chart-tooltip" style={{ left: `${selectedChartLeft}%` }}>
                          <strong>{selectedChartPoint.score}%</strong>
                          <span>{selectedChartPoint.fullLabel}</span>
                        </div>
                      </>
                    )}
                  </div>

                  <div className="chart-axis">
                    {weeklySeries.map((point) => (
                      <span key={point.date}>{point.label}</span>
                    ))}
                  </div>
                </div>
              </div>
              <p className="chart-legend">Completion Rate (%)</p>
            </article>

            <article className="metrics-card ai-insight-card">
              <div className="ai-insight-header">
                <div className="ai-title">
                  <Bot size={16} />
                  <h2>AI Weekly Insight</h2>
                </div>
                <button
                  className="icon-button"
                  onClick={() => requestWeeklyInsight({ force: true })}
                  disabled={weeklyInsightLoading}
                  aria-label="Refresh weekly AI insight"
                >
                  <RefreshCw size={14} className={weeklyInsightLoading ? 'spin' : ''} />
                </button>
              </div>

              {weeklyInsightError ? (
                <p className="ai-insight-error">{weeklyInsightError}</p>
              ) : (
                renderInsightText(weeklyInsightLoading ? 'Generating weekly insight...' : weeklyInsight)
              )}
              <p className="ai-insight-meta">{weeklyInsightMeta}</p>
            </article>
          </section>
        )}
      </motion.main>

      <footer className="bottom-status">
        <div>
          <CheckCircle2 size={14} />
          <span>Active Monitoring</span>
          <small>Synced with local git repository and local filesystem</small>
        </div>
        <span>Build 1.2.0</span>
      </footer>

      <AnimatePresence>
        {showSettings && (
          <motion.div
            className="settings-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.section
              className="settings-modal"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 16 }}
              transition={{ duration: 0.2 }}
            >
              <div className="settings-header">
                <h3>Tracker Settings</h3>
                <button className="icon-button" onClick={() => setShowSettings(false)} aria-label="Close settings">
                  <X size={16} />
                </button>
              </div>

              <div className="settings-form">
                <label>
                  Local Git Repository Paths (one per line)
                  <textarea
                    value={config.localRepoPathsText}
                    onChange={(event) => setConfig((prev) => ({ ...prev, localRepoPathsText: event.target.value }))}
                    placeholder={'C:\\path\\to\\repo-one\nC:\\path\\to\\repo-two'}
                    style={{
                      minHeight: '110px',
                      resize: 'vertical',
                      borderRadius: '9px',
                      border: '1px solid var(--line)',
                      background: 'rgba(255, 255, 255, 0.04)',
                      color: 'white',
                      padding: '10px',
                      fontFamily: 'inherit'
                    }}
                  />
                </label>
              </div>

              <div className="settings-actions">
                <button className="outline-button" onClick={saveGithubConfig}>
                  Update Path
                </button>
                <button className="outline-button" onClick={() => setShowSettings(false)}>
                  Close
                </button>
              </div>
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showApplicationModal && (
          <motion.div
            className="settings-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.section
              className="settings-modal"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 16 }}
              transition={{ duration: 0.2 }}
            >
              <div className="settings-header">
                <h3>Update Daily Posting URLs</h3>
                <button className="icon-button" onClick={() => setShowApplicationModal(false)} aria-label="Close application modal">
                  <X size={16} />
                </button>
              </div>

              <div className="settings-form">
                <label>
                  LinkedIn Post URL
                  <input
                    value={applicationForm.linkedinUrl}
                    onChange={(event) =>
                      setApplicationForm((prev) => ({ ...prev, linkedinUrl: event.target.value }))
                    }
                    placeholder="https://www.linkedin.com/feed/update/urn:li:activity:[target ID]/..."
                  />
                </label>
                <label>
                  Indeed Job URL
                  <input
                    value={applicationForm.indeedUrl}
                    onChange={(event) =>
                      setApplicationForm((prev) => ({ ...prev, indeedUrl: event.target.value }))
                    }
                    placeholder="https://ng.indeed.com/viewjob?...&jk=[target ID]&..."
                  />
                </label>
                <label>
                  Wellfound Application URL
                  <input
                    value={applicationForm.wellfoundUrl}
                    onChange={(event) =>
                      setApplicationForm((prev) => ({ ...prev, wellfoundUrl: event.target.value }))
                    }
                    placeholder="https://wellfound.com/jobs/applications/[target ID]"
                  />
                </label>
                {applicationFormError && <p className="ai-insight-error">{applicationFormError}</p>}
              </div>

              <div className="settings-actions">
                <button className="primary-button" onClick={saveApplicationIds}>
                  Save URLs
                </button>
                <button className="outline-button" onClick={() => setShowApplicationModal(false)}>
                  Cancel
                </button>
              </div>
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {goalEditor && (
          <motion.div
            className="settings-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.section
              className="settings-modal"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 16 }}
              transition={{ duration: 0.2 }}
            >
              <div className="settings-header">
                <h3>{goalEditor.type === 'github' ? 'Update GitHub Goal' : 'Update Reading Goal'}</h3>
                <button className="icon-button" onClick={() => setGoalEditor(null)} aria-label="Close goal editor">
                  <X size={16} />
                </button>
              </div>

              <div className="settings-form">
                <label>
                  {goalEditor.type === 'github' ? 'Daily commits target' : 'Daily pages target'}
                  <input
                    type="number"
                    min={0}
                    value={goalEditor.value}
                    onChange={(event) =>
                      setGoalEditor((prev) =>
                        prev
                          ? {
                              ...prev,
                              value: Number.parseInt(event.target.value, 10) || 0
                            }
                          : prev
                      )
                    }
                  />
                </label>
              </div>

              <div className="settings-actions">
                <button className="primary-button" onClick={saveGoalFromEditor}>
                  Save Goal
                </button>
                <button className="outline-button" onClick={() => setGoalEditor(null)}>
                  Cancel
                </button>
              </div>
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default App
