import { watch } from 'chokidar'
import { ipcMain } from 'electron'
import { readdirSync, statSync } from 'fs'
import { join } from 'path'

export class FileTracker {
  private watcher: any
  private lastEditTime = 0
  private targetPath: string
  private channelName: string

  constructor(targetPath: string, channelName = 'get-file-edit-status') {
    this.targetPath = targetPath
    this.channelName = channelName
    this.initWatcher()
    this.initIpc()
  }

  private getLatestModifiedTime(dirPath: string): number {
    let latest = 0

    try {
      const entries = readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name)
        try {
          if (entry.isDirectory()) {
            latest = Math.max(latest, this.getLatestModifiedTime(fullPath))
            continue
          }

          if (entry.isFile()) {
            const stats = statSync(fullPath)
            latest = Math.max(latest, stats.mtimeMs)
          }
        } catch {
          // Ignore inaccessible files and continue scanning others.
        }
      }
    } catch {
      return 0
    }

    return latest
  }

  private refreshLatestEditFromDisk(): void {
    this.lastEditTime = this.getLatestModifiedTime(this.targetPath)
  }

  private initWatcher(): void {
    console.log(`Watching directory for file saves: ${this.targetPath}`)
    this.refreshLatestEditFromDisk()

    this.watcher = watch(this.targetPath, {
      persistent: true,
      ignoreInitial: false,
      depth: 99
    })

    this.watcher.on('all', (event: string, path: string) => {
      // We only care about file writes/updates (and creation), not generic non-file events.
      if (event !== 'change' && event !== 'add') return

      try {
        const stats = statSync(path)
        this.lastEditTime = Math.max(this.lastEditTime, stats.mtimeMs)
      } catch {
        // If we can't stat this specific path, do a full refresh as fallback.
        this.refreshLatestEditFromDisk()
      }
      console.log(`File modified: ${path}`)
    })
  }

  private initIpc(): void {
    ipcMain.handle(this.channelName, () => {
      // Re-scan for correctness in case external edits happened between watcher events.
      this.refreshLatestEditFromDisk()
      const today = new Date().setHours(0, 0, 0, 0)
      return {
        lastEdit: this.lastEditTime,
        completed: this.lastEditTime >= today
      }
    })
  }

  public stop(): void {
    if (this.watcher) {
      this.watcher.close()
    }
  }
}
