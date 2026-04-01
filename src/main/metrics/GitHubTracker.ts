import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { existsSync } from 'fs'

interface GitStatusPayload {
  repoPath?: string
  repoPaths?: string[]
}

export class GitHubTracker {
  private lastCommitCount = 0
  private lastChecked = 0

  constructor() {
    this.initIpc()
  }

  private initIpc(): void {
    ipcMain.handle('get-github-status', async (_, data: GitStatusPayload) => {
      const repoPaths = this.normalizeRepoPaths(data)
      await this.refreshCommits(repoPaths)

      return {
        count: this.lastCommitCount,
        lastChecked: this.lastChecked,
        completed: this.lastCommitCount >= 3
      }
    })
  }

  private isTrackingDay(date: Date): boolean {
    const day = date.getDay()
    return day >= 1 && day <= 5
  }

  private runGit(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd }, (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout.toString().trim())
      })
    })
  }

  private getLocalDayStartString(): string {
    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    return `${year}-${month}-${day} 00:00:00`
  }

  private async getRepoAuthorEmail(repoPath: string): Promise<string | null> {
    try {
      const email = await this.runGit(['config', '--get', 'user.email'], repoPath)
      const normalized = email.trim()
      return normalized.length > 0 ? normalized : null
    } catch {
      return null
    }
  }

  private normalizeRepoPaths(data: GitStatusPayload | undefined): string[] {
    const fromList = Array.isArray(data?.repoPaths) ? data.repoPaths : []
    const fromSingle = data?.repoPath ? [data.repoPath] : []
    const merged = [...fromList, ...fromSingle]
      .map((item) => item.trim())
      .filter((item) => item.length > 0)

    return [...new Set(merged)]
  }

  private async countCommitsForRepo(repoPath: string): Promise<number> {
    if (!existsSync(repoPath)) return 0

    const sinceLocal = this.getLocalDayStartString()

    await this.runGit(['rev-parse', '--is-inside-work-tree'], repoPath)
    const authorEmail = await this.getRepoAuthorEmail(repoPath)
    const logArgs = ['log', '--all', `--since=${sinceLocal}`, '--pretty=format:%H']
    if (authorEmail) {
      logArgs.push(`--author=${authorEmail}`)
    }

    const rawHashes = await this.runGit(logArgs, repoPath)
    if (!rawHashes) return 0

    const uniqueHashes = new Set(
      rawHashes
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    )

    return uniqueHashes.size
  }

  private async refreshCommits(repoPaths: string[]): Promise<void> {
    if (!this.isTrackingDay(new Date())) {
      // Tech4mation is only active on weekdays.
      this.lastCommitCount = 0
      this.lastChecked = 0
      return
    }

    if (repoPaths.length === 0) {
      this.lastCommitCount = 0
      this.lastChecked = 0
      return
    }

    let total = 0
    let validRepoCount = 0

    for (const repoPath of repoPaths) {
      try {
        const count = await this.countCommitsForRepo(repoPath)
        total += count
        validRepoCount += 1
      } catch (error) {
        console.error(`Local Git Tracker Error (${repoPath}):`, error)
      }
    }

    this.lastCommitCount = total
    this.lastChecked = validRepoCount > 0 ? Date.now() : 0
    console.log(
      `Local Git Tracker: Found ${this.lastCommitCount} commits today across ${validRepoCount}/${repoPaths.length} configured repositories`
    )
  }
}
