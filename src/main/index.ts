import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { basename } from 'path'
import { existsSync, readFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { GitHubTracker } from './metrics/GitHubTracker'
import { FileTracker } from './metrics/FileTracker'

function loadEnvFromFile(filePath: string): void {
  if (!existsSync(filePath)) return

  try {
    const raw = readFileSync(filePath, 'utf8')
    const lines = raw.split(/\r?\n/)

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue

      const separatorIndex = trimmed.indexOf('=')
      if (separatorIndex <= 0) continue

      const key = trimmed.slice(0, separatorIndex).trim()
      const valueRaw = trimmed.slice(separatorIndex + 1).trim()
      if (!key || process.env[key] !== undefined) continue

      const isQuoted =
        (valueRaw.startsWith('"') && valueRaw.endsWith('"')) ||
        (valueRaw.startsWith("'") && valueRaw.endsWith("'"))
      const value = isQuoted ? valueRaw.slice(1, -1) : valueRaw
      process.env[key] = value
    }
  } catch (error) {
    console.error(`[Env Loader] Failed to read ${filePath}:`, error)
  }
}

function bootstrapEnv(): void {
  // Prefer .env at project root when running in dev.
  loadEnvFromFile(join(process.cwd(), '.env'))

  // Fallback for packaged/alternate run paths.
  try {
    loadEnvFromFile(join(app.getAppPath(), '.env'))
  } catch {
    // Ignore app path resolution failures at early startup.
  }
}

bootstrapEnv()

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform !== 'darwin' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function loadPdfFromPath(filePath: string) {
  if (!filePath || !existsSync(filePath)) return null
  const data = readFileSync(filePath)
  return {
    filePath,
    fileName: basename(filePath),
    data: new Uint8Array(data)
  }
}

interface WeeklyInsightDay {
  date: string
  score: number
  githubCount: number
  githubCompleted: boolean
  fileCompleted: boolean
  readingPages: number
  readingCompleted: boolean
}

interface WeeklyInsightPayload {
  weekLabel: string
  days: WeeklyInsightDay[]
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

function buildFallbackInsight(payload: WeeklyInsightPayload): string {
  const trackedDays = payload.days.length
  const bestDay = [...payload.days].sort((a, b) => b.score - a.score)[0]
  const lowestDay = [...payload.days].sort((a, b) => a.score - b.score)[0]
  const firstScore = payload.days[0]?.score ?? 0
  const lastScore = payload.days[payload.days.length - 1]?.score ?? 0
  const trendLabel = lastScore > firstScore ? 'improved' : lastScore < firstScore ? 'declined' : 'held steady'
  const gnWeeklyDelta = payload.summary.growthNaira?.weeklyChangePct ?? 0
  const gnDeltaLabel = gnWeeklyDelta >= 0 ? `+${gnWeeklyDelta.toFixed(2)}%` : `${gnWeeklyDelta.toFixed(2)}%`
  const gnStart = payload.summary.growthNaira?.estimatedStartOfWeekValue ?? 0
  const gnEnd = payload.summary.growthNaira?.estimatedEndOfWeekValue ?? 0

  return [
    `Week ${payload.weekLabel}: Average score was ${payload.summary.avgScore}% across ${trackedDays} tracked day${trackedDays === 1 ? '' : 's'}.`,
    `Completion rate finished at ${payload.summary.completionRate}%, with a current streak of ${payload.summary.currentStreak} and best streak of ${payload.summary.longestStreak}.`,
    `Growth Naira (priority metric): ${gnStart.toFixed(2)} GN -> ${gnEnd.toFixed(2)} GN this week (${gnDeltaLabel}).`,
    `Best day: ${bestDay?.date ?? 'N/A'} (${bestDay?.score ?? 0}%). Lowest day: ${lowestDay?.date ?? 'N/A'} (${lowestDay?.score ?? 0}%).`,
    `Productivity totals: ${payload.summary.totalCommits} commits and ${payload.summary.totalPages} pages read.`,
    `Momentum ${trendLabel} from the start (${firstScore}%) to end (${lastScore}%) of the week.`,
    `Pep talk: Every consistent win compounds growth over time, while missed days create decay. Keep stacking small daily wins.`
  ].join('\n')
}

async function generateAiWeeklyInsight(payload: WeeklyInsightPayload): Promise<WeeklyInsightResult> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    return {
      text: buildFallbackInsight(payload),
      source: 'fallback',
      reason: 'missing_api_key'
    }
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20000)
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash'
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text:
                  'You are a performance coach. Generate a concise, insightful weekly report in 5-7 short bullet points. Treat Growth Naira (GN) as a priority metric and include a short pep talk about compounding growth vs decaying from missed days.'
              },
              {
                text: `Create a weekly report for this data:\n${JSON.stringify(payload, null, 2)}`
              }
            ]
          }
        ]
      }),
      signal: controller.signal
    })
    clearTimeout(timeout)

    if (!response.ok) {
      const errorText = await response.text()
      let retryAfterSeconds: number | undefined
      if (response.status === 429) {
        try {
          const parsedError = JSON.parse(errorText) as {
            error?: { details?: Array<{ retryDelay?: string }> }
          }
          const retryDelayRaw = parsedError?.error?.details?.find(
            (detail) => typeof detail?.retryDelay === 'string'
          )?.retryDelay
          if (retryDelayRaw) {
            const seconds = Number.parseInt(retryDelayRaw.replace(/s$/i, ''), 10)
            if (Number.isFinite(seconds) && seconds > 0) retryAfterSeconds = seconds
          }
        } catch {
          // Ignore parsing errors and keep fallback behavior.
        }
      }
      console.error(
        'AI weekly insight request failed:',
        response.status,
        response.statusText,
        errorText
      )
      return {
        text: buildFallbackInsight(payload),
        source: 'fallback',
        reason: `http_${response.status}`,
        retryAfterSeconds
      }
    }

    const data = await response.json()
    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map((part: { text?: string }) => part?.text || '')
        .join('\n')
        .trim() || ''

    if (text.length > 0) {
      return {
        text,
        source: 'gemini'
      }
    }

    return {
      text: buildFallbackInsight(payload),
      source: 'fallback',
      reason: 'empty_response'
    }
  } catch (error) {
    console.error('AI weekly insight error:', error)
    return {
      text: buildFallbackInsight(payload),
      source: 'fallback',
      reason: 'request_error'
    }
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron.productivity')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Initialize Trackers
  new GitHubTracker()
  new FileTracker('C:\\Users\\Connekt.me\\Documents\\Quant Statisticals')

  ipcMain.handle('toggle-window-maximize', () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!window) return false

    if (window.isMaximized()) {
      window.unmaximize()
      return false
    }

    window.maximize()
    return true
  })

  ipcMain.handle('get-window-maximized', () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    return window ? window.isMaximized() : false
  })

  ipcMain.handle('pick-pdf-file', async () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!window) return null

    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
    })

    if (result.canceled || result.filePaths.length === 0) return null
    return loadPdfFromPath(result.filePaths[0])
  })

  ipcMain.handle('load-pdf-file', (_, filePath: string) => {
    return loadPdfFromPath(filePath)
  })

  ipcMain.handle('generate-weekly-insight', async (_, payload: WeeklyInsightPayload) => {
    console.log(
      `[AI Weekly Insight] request received. days=${Array.isArray(payload?.days) ? payload.days.length : 0}, hasKey=${Boolean(process.env.GEMINI_API_KEY)}`
    )

    if (!payload || !Array.isArray(payload.days) || payload.days.length === 0) {
      return {
        text: 'No weekly data is available yet. Track a few days to generate AI insights.',
        source: 'fallback',
        reason: 'no_weekly_data'
      } satisfies WeeklyInsightResult
    }
    const result = await generateAiWeeklyInsight(payload)
    console.log(
      `[AI Weekly Insight] result source=${result.source}${result.reason ? ` reason=${result.reason}` : ''}`
    )
    return result
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
