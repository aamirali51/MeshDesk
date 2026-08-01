import { useEffect, useState } from 'react'
import { Link2, Copy, Check, FileText, Clock, ShieldCheck, FolderOpen } from 'lucide-react'
import { useData } from '@/hooks/useData'
import { useToast } from '@/hooks/useToast'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/Modal'
import { formatBytes } from '@/lib/format'
import type { PendingShareStatus } from '@/types'

type ExpirationPreset = '5m' | '15m' | '30m' | '1h' | '6h' | '24h'

const PRESETS: { value: ExpirationPreset; label: string }[] = [
  { value: '5m', label: '5 min' },
  { value: '15m', label: '15 min' },
  { value: '30m', label: '30 min' },
  { value: '1h', label: '1 hour' },
  { value: '6h', label: '6 hours' },
  { value: '24h', label: '24 hours' }
]

interface PickedFile {
  filePath: string
  filename: string
  fileSize: number
}

interface DropShare {
  id: string
  code: string
  filename: string
  fileSize: number
  expiresAt: number
  expirationPreset: string
  status: PendingShareStatus
}

function formatRemaining(expiresAt: number): string {
  if (!expiresAt || expiresAt <= 0) return 'Never expires'
  const ms = expiresAt - Date.now()
  if (ms <= 0) return 'Expired'
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function DropCodeModal() {
  const {
    isDropCodeModalOpen,
    toggleDropCodeModal,
    createDropCode,
    pendingShares,
    cancelShareCode
  } = useData()
  const { toast } = useToast()
  const [file, setFile] = useState<PickedFile | null>(null)
  const [preset, setPreset] = useState<ExpirationPreset>('30m')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [share, setShare] = useState<DropShare | null>(null)
  const [copied, setCopied] = useState(false)
  const [tick, setTick] = useState(0) // re-render driver for the countdown
  useEffect(() => {
    if (!isDropCodeModalOpen) return
    const t = setInterval(() => setTick((v) => v + 1), 1000)
    return () => clearInterval(t)
  }, [isDropCodeModalOpen])

  const liveShare = share ? pendingShares.find((s) => s.id === share.id) || share : null
  const shareStatus: PendingShareStatus = liveShare?.status || 'waiting'
  const isExpired = liveShare ? liveShare.expiresAt > 0 && Date.now() >= liveShare.expiresAt : false

  const STATUS_LABEL: Record<PendingShareStatus, string> = {
    waiting: 'Waiting for receiver…',
    claimed: 'Download started',
    completed: 'Completed',
    expired: 'Expired',
    cancelled: 'Revoked'
  }

  const STATUS_STYLE: Record<PendingShareStatus, string> = {
    waiting: 'text-primary border-primary/30 bg-primary/10',
    claimed: 'text-accent border-accent/30 bg-accent/10',
    completed: 'text-status-online border-status-online/30 bg-status-online/10',
    expired: 'text-destructive border-destructive/30 bg-destructive/10',
    cancelled: 'text-muted-foreground border-border/40 bg-muted/20'
  }

  const handleRevoke = async () => {
    if (!share) return
    try {
      await cancelShareCode(share.id)
      toast.success('Code Revoked', `${share.code} is no longer valid.`)
    } catch (err: any) {
      toast.error('Revoke Failed', err?.message || 'Could not revoke the code.')
    }
  }

  const reset = () => {
    setFile(null)
    setPreset('30m')
    setLoading(false)
    setError('')
    setShare(null)
    setCopied(false)
  }

  const handleClose = () => {
    // Closing the dialog does NOT stop the share: the code keeps advertising
    // in the worker until claimed, revoked, or expired. Say so explicitly so
    // the sender knows they can close the window and share the code later.
    if (share && (shareStatus === 'waiting' || shareStatus === 'claimed') && !isExpired) {
      const remaining = formatRemaining(liveShare?.expiresAt || share.expiresAt)
      toast.success(
        'Code Still Active',
        `${share.code} stays valid for ${remaining} even after closing this window.`
      )
    }
    reset()
    toggleDropCodeModal()
  }

  const handleChooseFile = async () => {
    if (!window.bridge?.openFileDialog) {
      toast.error('Unavailable', 'File dialogs are only available in the desktop app')
      return
    }
    setError('')
    try {
      const picked = await window.bridge.openFileDialog()
      if (picked) {
        setFile({ filePath: picked.filePath, filename: picked.filename, fileSize: picked.fileSize })
        setShare(null)
        setCopied(false)
      }
    } catch {
      toast.error('File Pick Failed', 'Could not open the file picker.')
    }
  }

  const handleGenerate = async () => {
    if (!file) return
    setLoading(true)
    setError('')
    try {
      const result = (await createDropCode(file, preset)) as DropShare
      setShare(result)
      toast.success('Code Created', `${result.code} is ready to share.`)
    } catch (err: any) {
      setError(err?.message || 'Could not create the share code.')
      toast.error('Share Failed', err?.message || 'Could not create the share code.')
    } finally {
      setLoading(false)
    }
  }

  const handleCopy = async () => {
    if (!share?.code) return
    try {
      await navigator.clipboard.writeText(share.code)
      setCopied(true)
      toast.success('Code Copied', `${share.code} copied to clipboard.`)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Copy Failed', 'Could not copy the code.')
    }
  }

  return (
    <Modal
      open={isDropCodeModalOpen}
      onOpenChange={(o) => !o && handleClose()}
      title='Share via One-Time Code'
      description='Create a DROP code that claims this file once, securely'
      className='max-w-lg'
    >
      {share ? (
        /* ── Result: the generated code ─────────────────────────────── */
        <div className='flex flex-col items-center gap-y-5 py-1'>
          <div className='flex h-12 w-12 items-center justify-center rounded-2xl border border-status-online/30 bg-status-online/15 text-status-online'>
            <Link2 className='h-6 w-6' />
          </div>

          <div className='space-y-1.5 text-center'>
            <span className='block text-[10px] font-bold uppercase tracking-wider text-muted-foreground'>
              One-Time Code
            </span>
            <div className='flex items-center justify-center gap-2'>
              <span className='min-w-0 whitespace-nowrap overflow-x-auto rounded-xl border border-primary/30 bg-primary/10 px-4 py-2 font-mono text-xl font-black tracking-widest text-primary'>
                {share.code}
              </span>
              <Button
                size='icon'
                variant='ghost'
                onClick={handleCopy}
                className='h-9 w-9 shrink-0 text-primary hover:bg-primary/15'
                aria-label='Copy one-time code'
              >
                {copied ? (
                  <Check className='h-4 w-4 text-status-online' />
                ) : (
                  <Copy className='h-4 w-4' />
                )}
              </Button>
            </div>
            <p className='flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground'>
              <FileText className='h-3 w-3' />
              {share.filename} · {formatBytes(share.fileSize)}
            </p>
          </div>

          <div className='w-full space-y-1.5 rounded-xl border border-border/40 bg-card/40 p-3 text-xs'>
            <div className='flex items-center justify-between'>
              <span className='flex items-center gap-1.5 font-semibold text-muted-foreground'>
                <Clock className='h-3.5 w-3.5 text-primary' /> Expires in
              </span>
              <span className='font-mono text-sm font-black tabular-nums text-foreground'>
                {isExpired ? '0:00' : formatRemaining(liveShare?.expiresAt || share.expiresAt)}
              </span>
            </div>
            <div className='flex items-center justify-between'>
              <span className='font-semibold text-muted-foreground'>Status</span>
              <span
                className={`rounded-full border px-2.5 py-0.5 text-[10px] font-extrabold ${STATUS_STYLE[shareStatus]}`}
              >
                {STATUS_LABEL[shareStatus]}
              </span>
            </div>
            {shareStatus === 'waiting' && (
              <p className='flex items-center gap-1.5 text-[10px] text-muted-foreground'>
                <span className='h-3 w-3 animate-pulse rounded-full bg-primary/60' />
                Stays active until claimed, revoked, or the timer expires — you can close this
                window anytime.
              </p>
            )}
            <div className='flex items-center gap-1.5 border-t border-border/30 pt-2 text-[10px] text-muted-foreground'>
              <ShieldCheck className='h-3 w-3 shrink-0 text-status-online' />
              Single-use, end-to-end encrypted, no pairing or device records.
            </div>
          </div>

          <div className='flex w-full items-center gap-3 pt-1'>
            {shareStatus === 'waiting' || shareStatus === 'claimed' ? (
              <Button
                variant='ghost'
                onClick={handleRevoke}
                className='flex-1 font-semibold text-destructive hover:bg-destructive/10'
              >
                Revoke Code
              </Button>
            ) : (
              <Button variant='outline' onClick={reset} className='flex-1 font-semibold'>
                Share Another
              </Button>
            )}
            <Button onClick={handleClose} className='flex-1 font-bold'>
              Done
            </Button>
          </div>
        </div>
      ) : (
        /* ── Setup: pick a file and choose expiration ────────────────── */
        <div className='space-y-4'>
          {pendingShares.filter((s) => s.status === 'waiting' || s.status === 'claimed').length >
            0 && (
            <div className='space-y-1.5'>
              <span className='block text-[10px] font-bold uppercase tracking-wider text-muted-foreground'>
                Active One-Time Sends
              </span>
              {pendingShares
                .filter((s) => s.status === 'waiting' || s.status === 'claimed')
                .map((s) => (
                  <div
                    key={s.id}
                    className='flex items-center gap-2 rounded-xl border border-border/60 bg-card/40 px-3 py-2 text-xs'
                  >
                    <span className='min-w-0 flex-1 truncate font-mono font-bold text-primary'>
                      {s.code}
                    </span>
                    <span className='min-w-0 flex-1 truncate text-muted-foreground'>
                      {s.filename}
                    </span>
                    <span className='font-mono tabular-nums text-muted-foreground'>
                      {s.expiresAt > 0 ? formatRemaining(s.expiresAt) : '—'}
                    </span>
                    <Button
                      size='sm'
                      variant='ghost'
                      className='h-6 px-1.5 text-[10px] font-bold text-destructive'
                      onClick={() => {
                        cancelShareCode(s.id)
                          .then(() =>
                            toast.success('Code Revoked', `${s.code} is no longer valid.`)
                          )
                          .catch(() => {})
                      }}
                    >
                      Revoke
                    </Button>
                  </div>
                ))}
            </div>
          )}
          {file ? (
            <div className='flex items-center gap-3 rounded-xl border border-border/60 bg-card/40 p-3'>
              <div className='flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary'>
                <FileText className='h-4 w-4' />
              </div>
              <div className='min-w-0 flex-1'>
                <p className='truncate text-sm font-bold text-foreground'>{file.filename}</p>
                <p className='text-xs text-muted-foreground'>{formatBytes(file.fileSize)}</p>
              </div>
              <Button
                variant='ghost'
                size='sm'
                className='shrink-0 text-xs font-semibold'
                onClick={handleChooseFile}
              >
                Change
              </Button>
            </div>
          ) : (
            <button
              onClick={handleChooseFile}
              className='flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-8 text-center transition-colors hover:border-primary/50 hover:bg-card/60'
            >
              <FolderOpen className='h-8 w-8 text-muted-foreground/50' />
              <span className='text-sm font-bold text-foreground'>Choose a file to share</span>
              <span className='text-[11px] text-muted-foreground'>
                Opens your system file picker
              </span>
            </button>
          )}

          <div className='space-y-2'>
            <span className='block text-[10px] font-bold uppercase tracking-wider text-muted-foreground'>
              Expiration
            </span>
            <div className='flex flex-wrap gap-1.5'>
              {PRESETS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => setPreset(p.value)}
                  className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition-all ${
                    preset === p.value
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'border border-border/60 bg-card/40 text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {error && <p className='text-xs font-medium text-destructive'>{error}</p>}

          <div className='flex items-center gap-3 pt-1'>
            <Button variant='outline' onClick={handleClose} className='flex-1 font-semibold'>
              Cancel
            </Button>
            <Button
              onClick={handleGenerate}
              disabled={!file || loading}
              className='flex-1 gap-2 font-bold'
            >
              {loading ? (
                <>
                  <span className='h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white' />
                  Creating…
                </>
              ) : (
                <>
                  <Link2 className='h-4 w-4' />
                  Generate Code
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
