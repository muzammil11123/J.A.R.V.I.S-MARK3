import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { watchConfirm, type ConfirmRequest } from '../lib/bridge'
import { play } from '../lib/sfx'

/**
 * The approval prompt for actions the bridge's policy will not run unasked.
 *
 * On screen, not spoken. A "yes" picked up by a microphone that can also hear
 * a television or a second person is not consent to delete a folder, so the
 * answer is a click or a key: Enter or Y approves, Escape or N declines. The
 * bridge gives up after a minute and treats silence as a no, and the countdown
 * here says so.
 *
 * Requests queue rather than stack — a turn can ask twice, and the second
 * prompt must not hide the first.
 */

const WINDOW_S = 60

/**
 * A yes is ignored for this long after a prompt appears. Two quick presses
 * of Enter, or a double click, otherwise answer the prompt that was showing
 * and then the one queued behind it — approving a second send nobody read.
 */
const ARM_MS = 600

type Pending = ConfirmRequest & { answer: (yes: boolean) => void; shownAt: number }

const RISK_LABEL: Record<string, string> = {
  destructive: 'DESTRUCTIVE',
  high: 'HIGH IMPACT',
  communication: 'SENDS DATA',
  reversible: 'CHANGE',
}

export function Approval() {
  const [queue, setQueue] = useState<Pending[]>([])
  const [now, setNow] = useState(() => Date.now())
  const queueRef = useRef(queue)
  queueRef.current = queue

  useEffect(() => {
    watchConfirm(
      (req) =>
        new Promise<boolean>((resolve) => {
          play('error')
          setQueue((q) => [
            ...q,
            {
              ...req,
              shownAt: Date.now(),
              answer: (yes) => {
                setQueue((rest) => rest.filter((p) => p.id !== req.id))
                resolve(yes)
              },
            },
          ])
        }),
      (id) => setQueue((q) => q.filter((p) => p.id !== id)),
    )
  }, [])

  // A prompt counts as shown from the render that puts it at the head of the
  // queue, not from when it was queued behind another. Set during render, so
  // a key pressed before any effect runs already sees it.
  const headId = queue[0]?.id
  const armed = useRef<{ id?: string; at: number }>({ at: 0 })
  if (armed.current.id !== headId) armed.current = { id: headId, at: Date.now() + ARM_MS }
  const approve = (p: Pending) => {
    if (armed.current.id === p.id && Date.now() >= armed.current.at) p.answer(true)
  }

  // The countdown, and the client-side half of the timeout: the bridge has
  // already counted it as a no, so the prompt must not linger offering a yes
  // that would be ignored.
  useEffect(() => {
    if (!queue.length) return
    const t = setInterval(() => {
      setNow(Date.now())
      const head = queueRef.current[0]
      if (head && Date.now() - head.shownAt > WINDOW_S * 1000) head.answer(false)
    }, 250)
    return () => clearInterval(t)
  }, [queue.length])

  // Captured ahead of the app's own shortcuts: while a prompt is up, Escape
  // means "no" to this action, not "stand the whole assistant down", and Space
  // must not open the microphone underneath it.
  useEffect(() => {
    if (!queue.length) return
    const onKey = (e: KeyboardEvent) => {
      const head = queueRef.current[0]
      if (!head) return
      const k = e.key.toLowerCase()
      if (k === 'enter' || k === 'y') approve(head)
      else if (k === 'escape' || k === 'n') head.answer(false)
      else if (e.code !== 'Space') return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [queue.length])

  const head = queue[0]
  const left = head ? Math.max(0, Math.ceil(WINDOW_S - (now - head.shownAt) / 1000)) : 0

  return (
    <AnimatePresence>
      {head && (
        <motion.div
          key={head.id}
          className="approval"
          role="alertdialog"
          aria-labelledby="approval-title"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.18 }}
        >
          <div className="approval-head">
            <span id="approval-title">APPROVAL REQUIRED</span>
            <span className={`approval-risk risk-${head.risk}`}>
              {RISK_LABEL[head.risk] ?? head.risk.toUpperCase()}
            </span>
          </div>
          <p className="approval-reason">
            JARVIS wants to run something that {head.reason}.
          </p>
          <code className="approval-summary">{head.summary}</code>
          <div className="approval-meta">
            {head.tool}
            {queue.length > 1 ? ` · ${queue.length - 1} more waiting` : ''} · declines in {left}s
          </div>
          <div className="approval-actions">
            <button type="button" className="approval-no" onClick={() => head.answer(false)}>
              Deny <kbd>Esc</kbd>
            </button>
            <button type="button" className="approval-yes" onClick={() => approve(head)}>
              Approve <kbd>Enter</kbd>
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
