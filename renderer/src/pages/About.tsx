import { ArrowLeftRight, ShieldCheck, Cpu, HardDrive, FileText, ExternalLink } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

export function About() {
  return (
    <div className='space-y-6 pb-12 max-w-4xl'>
      {/* Product Hero */}
      <Card className='glass-card overflow-hidden border-white/10 relative glow-primary p-6'>
        <div className='flex flex-col md:flex-row items-center gap-6'>
          <div className='flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-tr from-primary via-indigo-500 to-purple-600 text-white shadow-xl shrink-0'>
            <ArrowLeftRight className='h-10 w-10' />
          </div>
          <div className='space-y-1.5 text-center md:text-left'>
            <div className='flex items-center justify-center md:justify-start gap-2'>
              <h2 className='text-2xl font-black text-foreground'>MeshDesk</h2>
              <span className='rounded-md bg-primary/20 px-2 py-0.5 text-xs font-mono font-bold text-primary border border-primary/30'>
                v1.0.0 · Open Source
              </span>
            </div>
            <p className='text-xs text-muted-foreground leading-relaxed'>
              Decentralized, end-to-end encrypted file sharing and remote access between your own
              devices — no accounts, no cloud.
            </p>
          </div>
        </div>
      </Card>

      {/* Tech Stack Specs */}
      <Card className='glass-card border-border/60'>
        <CardContent className='p-6 space-y-4 text-xs'>
          <h3 className='text-sm font-bold text-foreground flex items-center gap-2'>
            <Cpu className='h-4 w-4 text-primary' />
            Core Runtime Stack
          </h3>

          <div className='grid grid-cols-1 md:grid-cols-2 gap-3 font-mono'>
            <div className='rounded-xl border border-border/40 bg-card/40 p-3 flex justify-between items-center'>
              <span className='text-muted-foreground'>Desktop Framework</span>
              <span className='font-bold text-foreground'>Electron 40.x</span>
            </div>
            <div className='rounded-xl border border-border/40 bg-card/40 p-3 flex justify-between items-center'>
              <span className='text-muted-foreground'>P2P Swarm Engine</span>
              <span className='font-bold text-primary'>Hyperswarm 4.x</span>
            </div>
            <div className='rounded-xl border border-border/40 bg-card/40 p-3 flex justify-between items-center'>
              <span className='text-muted-foreground'>State Store</span>
              <span className='font-bold text-blue-600 dark:text-accent'>Corestore & Hyperbee</span>
            </div>
            <div className='rounded-xl border border-border/40 bg-card/40 p-3 flex justify-between items-center'>
              <span className='text-muted-foreground'>Cryptographic Security</span>
              <span className='font-bold text-status-online'>Noise_XX_25519</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* License & Information */}
      <Card className='glass-card border-border/60 p-6 space-y-3 text-xs'>
        <div className='flex items-center justify-between'>
          <span className='font-bold text-foreground flex items-center gap-2'>
            <ShieldCheck className='h-4 w-4 text-primary' />
            Open Source License
          </span>
          <span className='font-mono text-muted-foreground font-semibold'>GPL-3.0-only</span>
        </div>
        <p className='text-muted-foreground text-[11px] leading-relaxed'>
          MeshDesk is open-source software provided under the GNU General Public License v3.0.
        </p>
      </Card>
    </div>
  )
}
