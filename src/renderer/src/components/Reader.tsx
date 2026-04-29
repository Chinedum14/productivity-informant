import { useEffect, useMemo, useRef, useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import { ChevronLeft, ChevronRight, BookOpen, Maximize2, Minimize2, RotateCcw } from 'lucide-react'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

// Use a bundled local worker so PDF rendering works in Electron without external CDN access.
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

interface ReaderProps {
  onProgress: (pages: number) => void
  currentDateKey: string
}

interface LoadedPdfPayload {
  filePath: string
  fileName: string
  data: unknown
}

interface RecentPdfState {
  filePath: string
  fileName: string
  lastPage: number
  updatedAt: number
}

const RECENT_PDF_KEY = 'reader-recent-pdf'
const PAGE_DWELL_MS = 5000

function localDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function toUint8Array(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (Array.isArray(value) && value.every((item) => typeof item === 'number')) {
    return new Uint8Array(value)
  }

  if (typeof value === 'object' && value !== null) {
    const candidate = value as { type?: string; data?: unknown }
    if (candidate.type === 'Buffer' && Array.isArray(candidate.data)) {
      return new Uint8Array(candidate.data)
    }
    if (Array.isArray(candidate.data) && candidate.data.every((item) => typeof item === 'number')) {
      return new Uint8Array(candidate.data)
    }
  }

  return null
}

export function Reader({ onProgress, currentDateKey }: ReaderProps) {
  const [pdfSourceUrl, setPdfSourceUrl] = useState<string | null>(null)
  const [pdfFileName, setPdfFileName] = useState('')
  const [pdfFilePath, setPdfFilePath] = useState('')
  const [numPages, setNumPages] = useState<number>(0)
  const [pageNumber, setPageNumber] = useState<number>(1)
  const [_pagesViewedToday, _setPagesViewedToday] = useState<Set<string>>(new Set())
  const [isWindowMaximized, setIsWindowMaximized] = useState(false)
  const [isReaderExpanded, setIsReaderExpanded] = useState(false)
  const [recentPdf, setRecentPdf] = useState<RecentPdfState | null>(null)
  const [readerError, setReaderError] = useState<string | null>(null)
  const pdfContentRef = useRef<HTMLDivElement | null>(null)

  const documentFile = useMemo(() => pdfSourceUrl, [pdfSourceUrl])

  const resetPdfSource = () => {
    setPdfSourceUrl((currentUrl) => {
      if (currentUrl) URL.revokeObjectURL(currentUrl)
      return null
    })
  }

  const applyLoadedPdf = (payload: LoadedPdfPayload): boolean => {
    const bytes = toUint8Array(payload.data)
    if (!bytes) {
      setReaderError('Failed to read the selected PDF file. Please try another file.')
      return false
    }

    const bytesCopy = new Uint8Array(bytes.byteLength)
    bytesCopy.set(bytes)
    const blob = new Blob([bytesCopy.buffer], { type: 'application/pdf' })
    const nextUrl = URL.createObjectURL(blob)
    setPdfSourceUrl((currentUrl) => {
      if (currentUrl) URL.revokeObjectURL(currentUrl)
      return nextUrl
    })

    setReaderError(null)
    setPdfFilePath(payload.filePath)
    setPdfFileName(payload.fileName)
    setNumPages(0)
    return true
  }

  const persistRecentPdf = (recent: RecentPdfState) => {
    localStorage.setItem(RECENT_PDF_KEY, JSON.stringify(recent))
    setRecentPdf(recent)
  }

  useEffect(() => {
    const saved = localStorage.getItem(`viewed-${currentDateKey}`)
    if (saved) {
      const parsed = JSON.parse(saved) as unknown
      // Legacy saves were number[] (page-only, cross-PDF deduped). Coerce to string
      // so today's count isn't lost, but new entries written as `${filePath}#${page}`.
      const normalized = Array.isArray(parsed) ? parsed.map((v) => String(v)) : []
      _setPagesViewedToday(new Set(normalized))
      onProgress(normalized.length)
    } else {
      _setPagesViewedToday(new Set())
      onProgress(0)
    }
  }, [currentDateKey])

  useEffect(() => {
    const savedRecent = localStorage.getItem(RECENT_PDF_KEY)
    if (savedRecent) {
      const parsedRecent: RecentPdfState = JSON.parse(savedRecent)
      setRecentPdf(parsedRecent)
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isReaderExpanded) {
        setIsReaderExpanded(false)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isReaderExpanded])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!documentFile) return

      const target = event.target as HTMLElement | null
      const isTextInput =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      if (isTextInput) return

      if (event.key === 'ArrowRight') {
        event.preventDefault()
        changePage(1)
        return
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        changePage(-1)
        return
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        pdfContentRef.current?.scrollBy({ top: 120, behavior: 'smooth' })
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        pdfContentRef.current?.scrollBy({ top: -120, behavior: 'smooth' })
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [documentFile, numPages, pageNumber, pdfFilePath, pdfFileName])

  useEffect(() => {
    return () => {
      if (pdfSourceUrl) URL.revokeObjectURL(pdfSourceUrl)
    }
  }, [pdfSourceUrl])

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const maximized = await window.electron.ipcRenderer.invoke('get-window-maximized')
        if (mounted) setIsWindowMaximized(Boolean(maximized))
      } catch (error) {
        console.warn('Could not fetch window maximize state:', error)
      }
    })()

    return () => {
      mounted = false
    }
  }, [])

  function onDocumentLoadSuccess({ numPages }: { numPages: number }): void {
    setNumPages(numPages)

    const desiredStartPage =
      recentPdf && recentPdf.filePath === pdfFilePath ? Math.min(Math.max(recentPdf.lastPage, 1), numPages) : 1

    setPageNumber(desiredStartPage)

    if (pdfFilePath) {
      persistRecentPdf({
        filePath: pdfFilePath,
        fileName: pdfFileName,
        lastPage: desiredStartPage,
        updatedAt: Date.now()
      })
    }
  }

  function recordPageView(filePath: string, page: number) {
    if (!filePath || page < 1) return
    const viewKey = `${filePath}#${page}`
    const today = localDateKey(new Date())
    const viewedKey = `viewed-${today}`

    let todaySet: Set<string>
    const raw = localStorage.getItem(viewedKey)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown
        const normalized = Array.isArray(parsed) ? parsed.map((v) => String(v)) : []
        todaySet = new Set(normalized)
      } catch {
        todaySet = new Set()
      }
    } else {
      todaySet = new Set()
    }

    if (!todaySet.has(viewKey)) {
      todaySet.add(viewKey)
      localStorage.setItem(viewedKey, JSON.stringify(Array.from(todaySet)))
      const readingData = JSON.parse(localStorage.getItem(`reading-${today}`) || '{"pages": 0}')
      readingData.pages = todaySet.size
      localStorage.setItem(`reading-${today}`, JSON.stringify(readingData))
    }

    _setPagesViewedToday(todaySet)
    onProgress(todaySet.size)
  }

  useEffect(() => {
    if (!pdfFilePath || pageNumber < 1 || numPages < 1) return
    const targetPath = pdfFilePath
    const targetPage = pageNumber
    const timer = window.setTimeout(() => {
      recordPageView(targetPath, targetPage)
    }, PAGE_DWELL_MS)
    return () => window.clearTimeout(timer)
  }, [pdfFilePath, pageNumber, numPages])

  async function openSelectedPdf() {
    try {
      const payload = (await window.electron.ipcRenderer.invoke('pick-pdf-file')) as LoadedPdfPayload | null
      if (!payload) return

      const loaded = applyLoadedPdf(payload)
      if (!loaded) return
      setPageNumber(1)
      persistRecentPdf({
        filePath: payload.filePath,
        fileName: payload.fileName,
        lastPage: 1,
        updatedAt: Date.now()
      })
    } catch (error) {
      console.warn('Could not open PDF file:', error)
    }
  }

  async function reopenRecentPdf() {
    if (!recentPdf?.filePath) return
    try {
      const payload = (await window.electron.ipcRenderer.invoke(
        'load-pdf-file',
        recentPdf.filePath
      )) as LoadedPdfPayload | null

      if (!payload) {
        localStorage.removeItem(RECENT_PDF_KEY)
        setRecentPdf(null)
        resetPdfSource()
        setReaderError('Recent PDF file was not found in its previous location.')
        return
      }

      const loaded = applyLoadedPdf(payload)
      if (!loaded) {
        setReaderError('Failed to reopen recent PDF. The saved file may be invalid.')
        return
      }
      setPageNumber(Math.max(recentPdf.lastPage, 1))
    } catch (error) {
      console.warn('Could not reopen recent PDF:', error)
    }
  }

  function changePage(offset: number) {
    setPageNumber((prevPageNumber) => {
      const next = prevPageNumber + offset
      if (next >= 1 && next <= numPages) {
        if (pdfFilePath) {
          persistRecentPdf({
            filePath: pdfFilePath,
            fileName: pdfFileName,
            lastPage: next,
            updatedAt: Date.now()
          })
        }
        return next
      }
      return prevPageNumber
    })
  }

  async function toggleWindowExpand() {
    setIsReaderExpanded((prev) => !prev)
    try {
      const maximized = await window.electron.ipcRenderer.invoke('toggle-window-maximize')
      setIsWindowMaximized(Boolean(maximized))
    } catch (error) {
      console.warn('Could not toggle maximize state:', error)
    }
  }

  const readerWrapperStyle = isReaderExpanded
    ? {
        position: 'fixed' as const,
        inset: '16px',
        zIndex: 50,
        padding: 0,
        margin: 0,
        borderRadius: '12px',
        border: '1px solid rgba(143, 173, 222, 0.22)',
        background: 'linear-gradient(180deg, rgba(10, 25, 49, 0.98), rgba(9, 21, 40, 0.98))',
        boxShadow: '0 24px 64px rgba(0, 0, 0, 0.55)'
      }
    : { gridColumn: 'span 3', padding: 0 }

  return (
    <div className={isReaderExpanded ? '' : 'card'} style={readerWrapperStyle}>
      {!documentFile ? (
        <div style={{ height: '300px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center' }}>
            <div className="card-icon" style={{ margin: '0 auto 1.5rem', width: '64px', height: '64px' }}>
              <BookOpen size={32} color="var(--accent-green)" />
            </div>
            <h3 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>Start Reading</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '1.5rem' }}>
              Open a PDF and continue from where you left off.
            </p>
            <div style={{ display: 'flex', justifyContent: 'center', gap: '0.65rem' }}>
              <button
                onClick={openSelectedPdf}
                style={{
                  background: 'var(--accent-green)',
                  color: '#041123',
                  padding: '10px 24px',
                  borderRadius: '12px',
                  fontWeight: '700',
                  border: '1px solid rgba(53, 214, 134, 0.6)'
                }}
              >
                Select PDF File
              </button>
              {recentPdf && (
                <button
                  onClick={reopenRecentPdf}
                  style={{
                    background: 'rgba(75, 148, 255, 0.12)',
                    color: '#9bc3ff',
                    border: '1px solid rgba(75, 148, 255, 0.3)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '10px 14px',
                    borderRadius: '12px',
                    fontWeight: '700',
                    lineHeight: 1
                  }}
                >
                  <RotateCcw size={16} />
                  Reopen Recent PDF
                </button>
              )}
            </div>
            {recentPdf && (
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '0.85rem' }}>
                {recentPdf.fileName} (resume page {recentPdf.lastPage})
              </p>
            )}
            {readerError && <p style={{ color: '#ff8f9b', fontSize: '0.8rem', marginTop: '0.85rem' }}>{readerError}</p>}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', height: isReaderExpanded ? 'calc(100vh - 32px)' : '600px' }}>
          <div
            className="pdf-controls"
            style={{
              padding: '1.5rem 2rem',
              borderBottom: '1px solid var(--border-color)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <div className="card-icon" style={{ width: '40px', height: '40px' }}>
                <BookOpen size={20} color="var(--accent-green)" />
              </div>
              <div style={{ maxWidth: '300px' }}>
                <div
                  style={{
                    fontSize: '0.95rem',
                    fontWeight: '700',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}
                >
                  {pdfFileName}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{numPages} total pages</div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <button
                  onClick={() => changePage(-1)}
                  disabled={pageNumber <= 1}
                  style={{ padding: '8px', background: 'transparent', border: '1px solid var(--border-color)', color: 'white' }}
                >
                  <ChevronLeft size={20} />
                </button>
                <div style={{ minWidth: '100px', textAlign: 'center', fontSize: '0.9rem', fontWeight: '600' }}>
                  Page {pageNumber} <span style={{ color: 'var(--text-secondary)', fontWeight: '400' }}>of {numPages}</span>
                </div>
                <button
                  onClick={() => changePage(1)}
                  disabled={pageNumber >= numPages}
                  style={{ padding: '8px', background: 'transparent', border: '1px solid var(--border-color)', color: 'white' }}
                >
                  <ChevronRight size={20} />
                </button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <button
                  onClick={toggleWindowExpand}
                  style={{
                    background: 'rgba(75, 148, 255, 0.12)',
                    color: '#9bc3ff',
                    border: '1px solid rgba(75, 148, 255, 0.3)'
                  }}
                >
                  {isWindowMaximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                  {isWindowMaximized ? 'Restore Window' : 'Expand View'}
                </button>
                <button
                  onClick={() => {
                    resetPdfSource()
                    setPdfFilePath('')
                    setPdfFileName('')
                    setPageNumber(1)
                    setNumPages(0)
                    setIsReaderExpanded(false)
                  }}
                  style={{
                    background: 'rgba(255, 68, 68, 0.1)',
                    color: '#ff4444',
                    border: '1px solid rgba(255, 68, 68, 0.2)'
                  }}
                >
                  Close
                </button>
              </div>
            </div>
          </div>

          <div
            className="pdf-content"
            ref={pdfContentRef}
            style={{ flex: 1, background: '#0a0a0a', padding: '2rem', display: 'flex', justifyContent: 'center', overflow: 'auto' }}
          >
            <Document
              file={documentFile}
              onLoadSuccess={onDocumentLoadSuccess}
              onLoadError={(error) => {
                console.error('PDF load error:', error)
                setReaderError('PDF failed to load. Please re-open the file.')
              }}
            >
              <Page
                pageNumber={pageNumber}
                width={window.innerWidth * (isReaderExpanded || isWindowMaximized ? 0.82 : 0.45)}
                renderTextLayer={true}
                renderAnnotationLayer={true}
                className="pdf-page-shadow"
              />
            </Document>
          </div>
          {readerError && (
            <div style={{ padding: '0.65rem 2rem 1rem', color: '#ff8f9b', fontSize: '0.8rem' }}>{readerError}</div>
          )}
        </div>
      )}
    </div>
  )
}
