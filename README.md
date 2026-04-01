# Productivity Informant

Productivity Informant is a desktop performance-tracking application built with Electron, React, and TypeScript.  
It is designed to track real work signals from your local system and daily workflow, not just checklist toggles.

## Why this project exists

Most productivity tools fail in two ways:

1. They rely too heavily on manual checkboxes, which are easy to game.
2. They do not connect daily consistency to long-term growth behavior.

Productivity Informant was built to solve both problems by:

1. Pulling evidence from actual activity (local git, file modifications, reading progress, URL-based job posting proof).
2. Translating daily outcomes into a compounding feedback system (Growth Naira).
3. Producing weekly insight reports that summarize trends and momentum.

## What the app does

The app has two core pages:

1. Dashboard
2. Metrics

### Dashboard: 4 integrated tracking cards

1. Tech4mation (Mon-Fri active)
   - Tracks local git commit activity across one or more configured repositories.
   - Uses local repository paths entered in settings (one path per line).

2. Quant Finance/Algo (daily active)
   - Tracks whether files in the monitored Quant folder were modified/saved today.

3. Reading (daily active)
   - Embedded PDF reader with recent-file reopen and page progress tracking.
   - Persists reading progress in local storage by day.

4. Job Hunting (Mon-Fri active)
   - Accepts LinkedIn, Indeed, and Wellfound URLs.
   - Marks complete only when today’s URLs are unique versus previous days for each site.

### Growth Naira (GN) panel

A built-in behavioral growth indicator:

1. Start value: 100 GN
2. Daily settlement:
   - 100% score day: +1%
   - <100% score day: -2%
3. Supports refill when value reaches 0
4. Includes recalculation from historical records to correct drift/mismatch

### Metrics page

1. KPI overview tiles
   - Total days, completed days, current streak, longest streak, completion rate
2. Weekly completion chart
   - Interactive chart with hover/focus feedback
3. AI Weekly Insight panel
   - Uses Gemini API when available
   - Falls back gracefully when unavailable or rate-limited
   - Daily caching prevents repeated API calls within the same day

## Notifications

The app sends progress reminders during the day:

1. Every 4 hours under normal conditions
2. Every 1 hour when less than 4 hours remain to deadline
3. No reminders when daily score is already 100%

## Tech stack

1. Electron
2. React + TypeScript
3. electron-vite
4. localStorage for local persistence
5. Gemini API for weekly AI summaries

## Local data and persistence

The app stores local tracking state such as:

1. daily metrics history
2. goals and tracker config
3. recent PDF metadata and reading progress
4. GN settlement state
5. job hunting URL log
6. daily AI insight cache

## Environment variables

Create a `.env` file in the project root:

```env
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-2.5-flash
```

Use `.env.example` as reference.  
Do not commit your real `.env`.

## Getting started

### Install dependencies

```bash
npm install
```

### Run in development

```bash
npm run dev
```

### Typecheck

```bash
npm run typecheck
```

### Build for production

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

## Core project structure

```text
src/
  main/         # Electron main process, IPC handlers, system integrations
  preload/      # Secure bridge APIs exposed to renderer
  renderer/     # React UI (Dashboard, Metrics, Reader, styles)
```

## Intended users

This project is ideal for users who want accountability tied to real outputs:

1. developers tracking code consistency
2. researchers/analysts tracking file-work cadence
3. learners tracking reading progress
4. job seekers tracking disciplined application activity

## License

Private/internal project unless otherwise specified by repository owner.
