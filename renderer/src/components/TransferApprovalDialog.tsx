import { useData } from '@/hooks/useData'
import { formatBytes } from '@/lib/format'
import { FileText, Check, X, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/Modal'

export function TransferApprovalDialog() {
  const { pendingOffers, acceptTransfer, declineTransfer } = useData()

  if (!pendingOffers || pendingOffers.length === 0) return null

  const offer = pendingOffers[0]
  const totalOffers = pendingOffers.length

  return (
    <Modal
      open={pendingOffers.length > 0}
      onOpenChange={() => {}}
      blockClose
      title='Incoming Transfer Request'
      description={`From ${offer.senderIdentity?.name || 'Remote Peer'}`}
    >
      <div className='space-y-3'>
        <div className='flex items-center gap-3 rounded-xl bg-muted/50 p-3'>
          <div className='flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground'>
            <FileText className='h-4 w-4 text-primary' />
          </div>
          <div className='min-w-0 flex-1'>
            <p className='truncate text-sm font-medium text-foreground'>{offer.filename}</p>
            <p className='text-xs text-muted-foreground'>{formatBytes(offer.fileSize)}</p>
          </div>
          {totalOffers > 1 && (
            <span className='rounded-full border border-primary/20 bg-primary/15 px-2.5 py-1 text-[10px] font-extrabold text-primary'>
              1 of {totalOffers}
            </span>
          )}
        </div>

        <div className='flex items-center gap-1.5 rounded-xl border border-border/40 bg-card/40 p-3 text-[10px] font-mono text-muted-foreground'>
          <ShieldCheck className='h-3 w-3 shrink-0 text-status-online' />
          End-to-end encrypted · Verify the sender before accepting
        </div>
      </div>

      <div className='flex items-center gap-3 pt-4'>
        <Button
          variant='outline'
          className='flex-1 text-destructive hover:bg-destructive/10'
          onClick={() => declineTransfer(offer.transferId)}
        >
          <X className='mr-1.5 h-4 w-4' />
          Decline
        </Button>
        <Button className='flex-1' onClick={() => acceptTransfer(offer.transferId)}>
          <Check className='mr-1.5 h-4 w-4' />
          Accept File
        </Button>
      </div>
    </Modal>
  )
}
