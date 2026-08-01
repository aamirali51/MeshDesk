import { useState } from 'react'
import {
  Zap,
  Monitor,
  ArrowLeftRight,
  Activity,
  ShieldCheck,
  ArrowRight,
  Sparkles,
  Clock,
  HardDrive,
  Wifi,
  Copy,
  Check,
  QrCode,
  Laptop,
  Link2,
  Download
} from 'lucide-react'
import { useData } from '@/hooks/useData'
import { useNavigation } from '@/hooks/useNavigation'
import { useToast } from '@/hooks/useToast'
import { call } from '@/lib/ipc'
import { METHODS } from '@/types/protocol'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DeviceCard } from '@/components/DeviceCard'
import { ConfirmDialog } from '@/components/Modal'
import { formatTime } from '@/lib/format'
import type { Device } from '@/types'

function looksLikePairCode(s: string) {
  const clean = s.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return /^MD/.test(s.toUpperCase()) || clean.length === 16
}

function looksLikeDropCode(s: string) {
  const clean = s.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return /^DROP/.test(s.toUpperCase()) || clean.length === 8
}

export function Dashboard() {
  const {
    identity,
    devices,
    activity,
    diagnostics,
    transfers,
    sendFileToDevice,
    sendFilePath,
    toggleQRCodeModal,
    toggleTrustDevice,
    toggleFavoriteDevice,
    removeDevice,
    setInspectingDevice,
    toggleDropCodeModal,
    toggleOneTimeReceiveModal
  } = useData()
  const { navigate } = useNavigation()
  const { toast } = useToast()
  const [quickCode, setQuickCode] = useState('')
  const [copiedCode, setCopiedCode] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<Device | null>(null)

  const trustedDevices = devices.filter((d) => d.isTrusted)
  const recentActivity = activity.filter((a) => a.type !== 'notification').slice(0, 4)
  const pendingTransfers = transfers.filter(
    (t) => t.status === 'pending_approval' || t.status === 'queued'
  ).length
  const myCode = identity.pairingCode || ''

  const handleCopyMyCode = () => {
    navigator.clipboard.writeText(myCode)
    setCopiedCode(true)
    toast.success('Device Address Copied', `${myCode} copied to clipboard.`)
    setTimeout(() => setCopiedCode(false), 2000)
  }

  const handleSendDrop = async (dev: Device, file: File) => {
    try {
      await sendFilePath(dev, file)
    } catch (err: any) {
      toast.error('Send Failed', err?.message || 'Could not start the transfer.')
    }
  }

  const handleQuickSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const raw = quickCode.trim()
    if (!raw) return

    try {
      if (looksLikePairCode(raw)) {
        await call(METHODS.DEVICES_PAIR_CODE, { code: raw })
        toast.success(
          'Pairing Initiated',
          `${raw.toUpperCase()} — waiting for secure pairing handshake.`
        )
      } else if (looksLikeDropCode(raw)) {
        await call(METHODS.FILES_CLAIM_CODE, { code: raw })
        toast.success(
          'Claiming Share',
          `${raw.toUpperCase()} — downloading to your Downloads folder.`
        )
      } else {
        toast.error('Unknown Code', 'Enter an MD- pairing code or a DROP- file code.')
        return
      }
      setQuickCode('')
      navigate('/devices')
    } catch (err: any) {
      toast.error('Failed', err?.message || 'Could not process that code.')
    }
  }

  return (
    <div className='space-y-6 pb-12'>
      {/* Hero Pairing & Quick Connect Banner */}
      <Card className='glass-card overflow-hidden relative border-border/60'>
        <div className='absolute -right-20 -top-20 h-64 w-64 rounded-full bg-primary/20 blur-3xl' />
        <CardContent className='p-6 md:p-8 space-y-6 relative z-10'>
          <div className='flex flex-col md:flex-row md:items-center justify-between gap-4'>
            <div className='space-y-1'>
              <span className='rounded-full bg-primary/15 px-3 py-1 text-xs font-bold text-primary border border-primary/20 flex items-center gap-1.5 w-fit'>
                <Sparkles className='h-3.5 w-3.5' /> Private P2P File Sharing
              </span>
              <h2 className='text-2xl md:text-3xl font-black tracking-tight text-foreground'>
                MeshDesk
              </h2>
              <p className='text-xs md:text-sm text-muted-foreground max-w-lg'>
                Pair devices securely and share files directly — no accounts, no cloud.
              </p>
            </div>
          </div>

          {/* Pairing Code + Connect Two-Column Box */}
          {/* Stacks vertically below lg (1024px) so the two cards never crowd. */}
          <div className='grid grid-cols-1 lg:grid-cols-2 gap-4 pt-2'>
            {/* THIS DEVICE ADDRESS CARD */}
            <div className='rounded-2xl border border-primary/40 bg-primary/10 p-4 space-y-2 relative overflow-hidden shadow-inner'>
              <div className='flex flex-wrap items-center justify-between gap-2'>
                <span className='text-xs font-bold uppercase tracking-wider text-primary flex items-center gap-1.5'>
                  <Laptop className='h-4 w-4' /> Your Device Address
                </span>
                <button
                  onClick={toggleQRCodeModal}
                  className='flex items-center gap-1 text-xs font-bold text-primary hover:underline bg-primary/15 px-2 py-0.5 rounded-lg border border-primary/30'
                  title='View Pairing QR Code'
                >
                  <QrCode className='h-3.5 w-3.5' /> QR Code
                </button>
              </div>

              <div className='flex flex-wrap gap-2 items-center justify-between pt-1'>
                <span className='truncate min-w-0 font-mono text-xl md:text-2xl font-black tracking-widest text-foreground'>
                  {myCode}
                </span>
                <Button
                  size='sm'
                  variant='outline'
                  onClick={handleCopyMyCode}
                  className='h-9 shrink-0 px-3 font-bold text-xs gap-1.5 border-primary/40 hover:bg-primary/20'
                >
                  {copiedCode ? (
                    <Check className='h-4 w-4 text-emerald-400' />
                  ) : (
                    <Copy className='h-4 w-4 text-primary' />
                  )}
                  {copiedCode ? 'Copied!' : 'Copy Code'}
                </Button>
              </div>
              <span className='text-[10px] text-muted-foreground font-mono'>
                Give this code to another MeshDesk device to pair securely. Valid for 15 minutes.
              </span>
            </div>

            {/* CONNECT TO DEVICE INPUT CARD */}
            <div className='rounded-2xl border border-border/80 bg-card/40 p-4 space-y-2 shadow-inner'>
              <span className='text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5'>
                <Zap className='h-4 w-4 text-amber-400' /> Connect to a Device
              </span>

              <form
                onSubmit={handleQuickSubmit}
                className='flex flex-col sm:flex-row gap-2 items-stretch sm:items-center pt-1'
              >
                <input
                  type='text'
                  value={quickCode}
                  onChange={(e) => setQuickCode(e.target.value.toUpperCase())}
                  placeholder='Enter a code (MD-… pairing or DROP-… file code)'
                  className='min-w-0 w-full flex-1 rounded-xl border border-border/80 bg-background/80 px-3.5 py-2.5 text-xs font-mono font-bold tracking-wider text-foreground placeholder:text-slate-500 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary dark:placeholder:text-muted-foreground/50'
                />
                <Button
                  type='submit'
                  className='h-9 px-4 font-bold text-xs gap-1.5 shrink-0 sm:w-auto w-full'
                >
                  Connect
                  <ArrowRight className='h-3.5 w-3.5' />
                </Button>
              </form>
              <p className='text-[10px] text-muted-foreground font-mono'>
                MD- codes pair devices; DROP- codes claim a one-time file share.
              </p>
            </div>
          </div>

          {/* Anonymous one-time sharing actions */}
          <div className='grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2'>
            <Button
              variant='outline'
              className='h-11 gap-2 border-primary/40 text-xs font-bold hover:bg-primary/15'
              onClick={toggleDropCodeModal}
            >
              <Link2 className='h-4 w-4 text-primary' />
              One-Time Send
              <span className='ml-auto text-[10px] font-semibold text-muted-foreground'>
                no pairing needed
              </span>
            </Button>
            <Button
              variant='outline'
              className='h-11 gap-2 border-primary/40 text-xs font-bold hover:bg-primary/15'
              onClick={toggleOneTimeReceiveModal}
            >
              <Download className='h-4 w-4 text-primary' />
              One-Time Receive
              <span className='ml-auto text-[10px] font-semibold text-muted-foreground'>
                enter a DROP code
              </span>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Metrics Stat Cards: 1 col mobile, 2 cols >=sm, 4 cols >=xl */}
      <div className='grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4'>
        <Card className='glass-card border-border/60'>
          <CardContent className='p-4 flex items-center justify-between'>
            <div className='space-y-1'>
              <p className='text-xs font-semibold text-muted-foreground'>Pending Transfers</p>
              <p className='text-2xl font-black text-foreground'>{pendingTransfers}</p>
              <span className='text-[10px] text-muted-foreground font-bold flex items-center gap-1'>
                {pendingTransfers > 0 ? (
                  <span className='flex items-center gap-1 truncate'>
                    <span className='h-2 w-2 rounded-full bg-status-online' />
                    Awaiting approval
                  </span>
                ) : (
                  <span className='flex items-center gap-1'>
                    <span className='h-2 w-2 rounded-full bg-muted-foreground/40' /> All caught up
                  </span>
                )}
              </span>
            </div>
            <div className='flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary border border-primary/20'>
              <ArrowLeftRight className='h-5 w-5' />
            </div>
          </CardContent>
        </Card>

        <Card className='glass-card border-border/60'>
          <CardContent className='p-4 flex items-center justify-between'>
            <div className='space-y-1'>
              <p className='text-xs font-semibold text-muted-foreground'>Trusted Devices</p>
              <p className='text-2xl font-black text-foreground'>{trustedDevices.length}</p>
              <span className='text-[10px] text-primary font-bold flex items-center gap-1'>
                <ShieldCheck className='h-3 w-3' /> End-to-end encrypted
              </span>
            </div>
            <div className='flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary border border-primary/20'>
              <Monitor className='h-5 w-5' />
            </div>
          </CardContent>
        </Card>

        <Card className='glass-card border-border/60'>
          <CardContent className='p-4 flex items-center justify-between'>
            <div className='space-y-1'>
              <p className='text-xs font-semibold text-muted-foreground'>P2P Latency</p>
              <p className='text-2xl font-mono font-black text-foreground'>
                {diagnostics.avgLatencyMs != null ? `${diagnostics.avgLatencyMs} ms` : '—'}
              </p>
              <span className='text-[10px] text-muted-foreground font-bold flex items-center gap-1'>
                <Wifi className='h-3 w-3' /> Direct connection, no cloud
              </span>
            </div>
            <div className='flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary border border-primary/20'>
              <Activity className='h-5 w-5' />
            </div>
          </CardContent>
        </Card>

        <Card className='glass-card border-border/60'>
          <CardContent className='p-4 flex items-center justify-between'>
            <div className='space-y-1'>
              <p className='text-xs font-semibold text-muted-foreground'>Peer Connections</p>
              <p className='text-2xl font-mono font-black text-foreground'>
                {diagnostics.connectedPeersCount != null ? diagnostics.connectedPeersCount : '—'}
              </p>
              <span className='text-[10px] text-muted-foreground font-bold flex items-center gap-1'>
                <HardDrive className='h-3 w-3' /> Your devices only
              </span>
            </div>
            <div className='flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary border border-primary/20'>
              <HardDrive className='h-5 w-5' />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Grid Section */}
      <div className='grid grid-cols-1 lg:grid-cols-3 gap-6'>
        {/* Trusted Devices Section */}
        <div className='lg:col-span-2 space-y-4'>
          <div className='flex items-center justify-between'>
            <h3 className='text-base font-extrabold text-foreground flex items-center gap-2'>
              <Monitor className='h-4 w-4 text-primary' />
              Trusted Devices Quick Launch
            </h3>
            <Button
              variant='ghost'
              size='sm'
              onClick={() => navigate('/devices')}
              className='gap-1 text-xs font-semibold text-primary hover:text-primary/80'
            >
              View All ({devices.length})
              <ArrowRight className='h-3.5 w-3.5' />
            </Button>
          </div>

          {trustedDevices.length === 0 ? (
            <div className='rounded-2xl border border-dashed border-border/80 glass-card p-8 text-center space-y-2'>
              <Monitor className='h-8 w-8 text-muted-foreground/40 mx-auto' />
              <p className='text-xs font-bold text-foreground'>No Trusted Devices Paired</p>
              <p className='text-[11px] text-muted-foreground'>
                Pair a device using Quick Connect or a device code to start sending files directly.
              </p>
            </div>
          ) : (
            <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
              {trustedDevices.map((dev) => (
                <DeviceCard
                  key={dev.id}
                  device={dev}
                  onSend={(d) => d.isOnline && sendFileToDevice(d)}
                  onSendDrop={handleSendDrop}
                  onViewDetails={setInspectingDevice}
                  onToggleTrust={(d) => toggleTrustDevice(d.id)}
                  onToggleFavorite={(d) => toggleFavoriteDevice(d.id)}
                  onRemove={setRemoveTarget}
                  onShareCode={() => toggleDropCodeModal()}
                />
              ))}
            </div>
          )}
        </div>

        {/* Recent Activity & Mesh Health Widget */}
        <div className='space-y-6'>
          {/* Recent Activity Card */}
          <Card className='glass-card border-border/60'>
            <CardContent className='p-4 space-y-3'>
              <div className='flex items-center justify-between border-b border-border/40 pb-3'>
                <h3 className='text-sm font-bold text-foreground flex items-center gap-2'>
                  <Clock className='h-4 w-4 text-amber-400' />
                  Recent Activity
                </h3>
                <button
                  onClick={() => navigate('/history')}
                  className='text-[11px] font-semibold text-primary hover:underline'
                >
                  History
                </button>
              </div>

              {recentActivity.length === 0 ? (
                <div className='py-6 text-center text-xs text-muted-foreground'>
                  No recent activity recorded.
                </div>
              ) : (
                <div className='space-y-2.5'>
                  {recentActivity.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => navigate('/activity')}
                      className='flex w-full items-center justify-between p-2.5 rounded-xl border border-border/30 bg-card/30 hover:bg-card/60 transition-all text-xs text-left'
                    >
                      <div className='space-y-0.5 min-w-0'>
                        <p className='font-bold text-foreground truncate'>{item.title}</p>
                        <p className='text-[10px] text-muted-foreground truncate'>
                          {item.description || formatTime(item.timestamp)}
                        </p>
                      </div>
                      <ArrowRight className='h-3.5 w-3.5 shrink-0 text-muted-foreground' />
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Network Health Card */}
          <Card className='glass-card border-border/60'>
            <CardContent className='p-4 space-y-3'>
              <h3 className='text-sm font-bold text-foreground flex items-center gap-2'>
                <Activity className='h-4 w-4 text-cyan-400' />
                Mesh P2P Health
              </h3>
              <div className='space-y-2 text-xs'>
                <div className='flex justify-between border-b border-border/30 pb-1.5'>
                  <span className='text-muted-foreground'>NAT Traversal</span>
                  <span className='font-bold text-emerald-400'>{diagnostics.natType || '—'}</span>
                </div>
                <div className='flex justify-between border-b border-border/30 pb-1.5'>
                  <span className='text-muted-foreground'>Connected Peers</span>
                  <span className='font-mono font-bold text-foreground'>
                    {diagnostics.connectedPeersCount != null
                      ? `${diagnostics.connectedPeersCount}`
                      : '—'}
                  </span>
                </div>
                <div className='flex justify-between'>
                  <span className='text-muted-foreground'>Security Protocol</span>
                  <span className='font-mono text-[10px] font-bold text-primary'>
                    Noise_XX_25519
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Remove Device Confirmation */}
      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(o) => !o && setRemoveTarget(null)}
        title={`Remove ${removeTarget?.name ?? 'Device'}?`}
        description='The device will be unpaired and removed from your device list. This cannot be undone.'
        confirmLabel='Remove Device'
        onConfirm={() => removeTarget && removeDevice(removeTarget.id)}
      />
    </div>
  )
}
