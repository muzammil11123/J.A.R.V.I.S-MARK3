import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore, type FaceIdStage } from '../store'
import { cameraStream } from '../lib/camera'
import { identityStatus } from '../lib/identity'
import {
  MAX_ATTEMPTS,
  closeFaceId,
  giveConsent,
  openFaceId,
  retry,
  submitPin,
  usePin,
} from '../lib/faceId'
import * as sfx from '../lib/sfx'

/**
 * The face popup: a small floating window over the HUD, never instead of it.
 *
 * It draws what lib/faceId.ts decides and calls back into it — no camera or
 * model code lives here. The preview is the shared camera stream, shown
 * mirrored because a mirror is what a person expects to see of themselves;
 * the frames the models read are the unmirrored originals.
 */

const TITLE: Record<FaceIdStage, string> = {
  consent: 'Enrol your face',
  camera: 'Initializing camera…',
  loading: 'Initializing camera…',
  searching: 'Searching for a face…',
  detected: 'Face detected.',
  recognizing: 'Recognizing…',
  verified: 'Identity verified.',
  rejected: 'Face not recognized.',
  captured: 'Pictures taken.',
  enrolled: 'Face enrolled.',
  pin: 'Verify with PIN',
  error: 'Face check stopped.',
}

/** Stages during which the camera is held and the preview is live. */
const LIVE: FaceIdStage[] = ['loading', 'searching', 'detected']

const tone = (s: FaceIdStage) =>
  s === 'verified' || s === 'enrolled' ? 'ok' : s === 'rejected' || s === 'error' ? 'bad' : 'run'

function Preview({ stage, box }: { stage: FaceIdStage; box: [number, number, number, number] | null }) {
  const ref = useRef<HTMLVideoElement>(null)
  const live = LIVE.includes(stage)

  // Re-point at the shared stream whenever the stage moves: the stream only
  // exists once the controller has its hold.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const s = live ? cameraStream() : null
    if (el.srcObject !== s) el.srcObject = s
    if (s) void el.play().catch(() => {})
  }, [live, stage])

  return (
    <div className={`faceid-view ${live ? 'live' : ''} faceid-${tone(stage)}`}>
      <video ref={ref} className="faceid-video" autoPlay playsInline muted />
      {!live && <div className="faceid-glyph" aria-hidden="true" />}
      {live && <div className="faceid-scanline" aria-hidden="true" />}
      {live && box && (
        // Mirrored to match the preview: x runs from the other side.
        <div
          className="faceid-box"
          aria-hidden="true"
          style={{
            left: `${(1 - box[0] - box[2]) * 100}%`,
            top: `${box[1] * 100}%`,
            width: `${box[2] * 100}%`,
            height: `${box[3] * 100}%`,
          }}
        />
      )}
      <span className="faceid-corner tl" />
      <span className="faceid-corner tr" />
      <span className="faceid-corner bl" />
      <span className="faceid-corner br" />
    </div>
  )
}

function PinForm({ choose, onSubmit, label, focus = true }: { choose: boolean; onSubmit: (pin: string, confirm: string) => void; label: string; focus?: boolean }) {
  const [pin, setPin] = useState('')
  const [confirm, setConfirm] = useState('')
  const valid = /^\d{4,12}$/.test(pin) && (!choose || pin === confirm)
  return (
    <form
      className="faceid-pin"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) onSubmit(pin, confirm)
      }}
    >
      <input
        type="password"
        inputMode="numeric"
        autoComplete="off"
        autoFocus={focus}
        placeholder={choose ? 'choose a PIN (4–12 digits)' : 'PIN'}
        aria-label={choose ? 'Choose a PIN' : 'PIN'}
        value={pin}
        maxLength={12}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
      />
      {choose && (
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          placeholder="repeat PIN"
          aria-label="Repeat the PIN"
          value={confirm}
          maxLength={12}
          onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ''))}
        />
      )}
      <button type="submit" className="faceid-primary" disabled={!valid}>
        {label}
      </button>
    </form>
  )
}

export function FaceIdPopup() {
  const view = useStore((s) => s.faceId)
  const [agreed, setAgreed] = useState(false)
  const [pinSet, setPinSet] = useState<boolean | null>(null)
  const [reenrol, setReenrol] = useState(false)
  const [name, setName] = useState('')

  // Enrolment needs to know whether a PIN exists yet (choose one, or give it)
  // and whether this replaces an earlier face — whose name is the default.
  useEffect(() => {
    if (view?.mode !== 'enroll') return
    setAgreed(false)
    identityStatus()
      .then((s) => {
        setPinSet(s.pin)
        setReenrol(s.face.enrolled)
        setName(s.face.name ?? '')
      })
      .catch(() => setPinSet(null))
  }, [view?.mode])

  // Sound on the two outcomes only; the rest is visual.
  const stage = view?.stage
  useEffect(() => {
    if (stage === 'verified' || stage === 'enrolled') sfx.play('done')
    else if (stage === 'rejected') sfx.play('error')
  }, [stage])

  // Escape closes the popup — and only the popup. Captured on window so it
  // runs before App's Escape, which would otherwise also stand JARVIS down.
  useEffect(() => {
    if (!view) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      closeFaceId()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [view])

  return (
    <AnimatePresence>
      {view && (
        <motion.section
          key="faceid"
          className="faceid"
          role="dialog"
          aria-modal="false"
          aria-label="Face recognition"
          initial={{ opacity: 0, scale: 0.92, y: -10, filter: 'blur(6px)' }}
          animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, scale: 0.94, y: -8, filter: 'blur(6px)' }}
          transition={{ type: 'spring', stiffness: 320, damping: 28 }}
        >
          <header className="faceid-head">
            <span>{view.mode === 'enroll' ? 'FACE ENROLMENT' : 'FACE RECOGNITION'}</span>
            <button type="button" className="faceid-x" onClick={closeFaceId} aria-label="Close face recognition">
              ×
            </button>
          </header>

          {view.stage !== 'consent' && view.stage !== 'pin' && view.stage !== 'captured' && <Preview stage={view.stage} box={view.box} />}

          {view.mode === 'enroll' && !!view.photos?.length && (
            <div className="faceid-photos" aria-label="Pictures of your face taken for enrolment">
              {view.photos.map((src, i) => (
                <img key={i} src={src} alt={['Facing the camera', 'Turned to one side', 'Turned to the other side'][i] ?? 'Face'} />
              ))}
            </div>
          )}

          <div className={`faceid-status faceid-${tone(view.stage)}`} role="status" aria-live="polite">
            <span className="faceid-title">{view.stage === 'verified' && view.name ? `Hello, ${view.name}.` : TITLE[view.stage]}</span>
            {view.hint && view.hint !== TITLE[view.stage] && <span className="faceid-hint">{view.hint}</span>}
            {view.score != null && view.stage === 'rejected' && <span className="faceid-score">match {view.score.toFixed(2)}</span>}
          </div>

          {(view.stage === 'detected' || view.stage === 'recognizing') && (
            <div className="faceid-progress" aria-hidden="true">
              <div style={{ width: `${Math.round(view.progress * 100)}%` }} />
            </div>
          )}

          {view.stage === 'consent' && (
            <div className="faceid-consent">
              <p>
                Look at the camera and blink, then slowly turn your head left and right. JARVIS takes <b>a picture of your face at each angle</b>,
                asks your name, and stores the pictures with a numeric template, encrypted on this PC.
                Matching happens here; nothing is sent anywhere. {reenrol && 'This replaces your current enrolment.'}
              </p>
              <p className="faceid-dim">For best results enrol in the light you usually sit in. You can re-enrol or delete it any time in Console › identity.</p>
              <label className="faceid-check">
                <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />I agree to store pictures and a face template of me on this PC.
              </label>
            </div>
          )}

          {view.stage === 'pin' && (
            <PinForm choose={false} label="Verify" onSubmit={(pin) => void submitPin(pin)} />
          )}

          {view.stage === 'captured' && (
            <>
              <input
                className="faceid-name"
                type="text"
                autoComplete="off"
                autoFocus
                placeholder="your name"
                aria-label="Your name"
                maxLength={40}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <PinForm
                focus={false}
                choose={pinSet === false}
                label={pinSet === false ? 'Set PIN and save' : 'Save face'}
                onSubmit={(pin) => void (pinSet === false ? submitPin('', pin, name) : submitPin(pin, undefined, name))}
              />
            </>
          )}

          <footer className="faceid-actions">
            {view.stage === 'consent' && (
              <button type="button" className="faceid-primary" disabled={!agreed} onClick={giveConsent}>
                Start
              </button>
            )}
            {view.mode === 'verify' && (view.stage === 'rejected' || view.stage === 'error' || view.stage === 'pin') && (
              <button type="button" onClick={retry} disabled={view.attempts >= MAX_ATTEMPTS} title={view.attempts >= MAX_ATTEMPTS ? 'No face attempts left' : undefined}>
                Retry
              </button>
            )}
            {view.mode === 'enroll' && view.stage === 'error' && (
              <button type="button" onClick={retry} disabled={view.attempts >= MAX_ATTEMPTS}>
                Retry
              </button>
            )}
            {view.mode === 'verify' && view.stage !== 'pin' && view.stage !== 'verified' && (
              <button type="button" onClick={usePin}>
                Use PIN
              </button>
            )}
            {view.mode === 'verify' && view.stage === 'error' && /enrol/i.test(view.hint) && (
              <button
                type="button"
                className="faceid-primary"
                onClick={() => {
                  closeFaceId()
                  openFaceId('enroll')
                }}
              >
                Enrol now
              </button>
            )}
            {view.stage !== 'verified' && view.stage !== 'enrolled' && (
              <button type="button" onClick={closeFaceId}>
                Cancel <kbd>Esc</kbd>
              </button>
            )}
          </footer>
        </motion.section>
      )}
    </AnimatePresence>
  )
}
