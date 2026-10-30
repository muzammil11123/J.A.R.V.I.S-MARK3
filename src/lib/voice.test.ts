import { describe, expect, it } from 'vitest'
import { afterWake, holdFor, isEcho } from './voice'
import { useStore } from '../store'

/**
 * The existing voice-command pipeline's text handling: what it does with a
 * transcript once speech-to-text has produced one. Voice is for understanding
 * commands only — nothing here, or anywhere, identifies who is speaking.
 */

describe('speech-to-text: wake word and command', () => {
  it('finds the command after his name', () => {
    expect(afterWake("Hey Jarvis, what's the weather in London")).toBe("what's the weather in London")
    expect(afterWake('ok jarvis open my email')).toBe('open my email')
  })

  it('accepts the common mishearings of "Jarvis"', () => {
    for (const heard of ['Travis what time is it', 'Jervis what time is it', "Java's what time is it"]) {
      expect(afterWake(heard)).toBe('what time is it')
    }
  })

  it('a bare name carries no command', () => {
    expect(afterWake('Jarvis')).toBe('')
  })

  it('ignores speech that does not address him', () => {
    expect(afterWake('what is the weather')).toBe('')
  })
})

describe('speech-to-text: when a sentence is finished', () => {
  it('sends a complete sentence at once', () => {
    expect(holdFor('what is the weather in London?')).toBe(0)
  })

  it('waits when the sentence clearly continues', () => {
    expect(holdFor('what is the weather in')).toBeGreaterThan(0)
    expect(holdFor('remind me to call mum and')).toBeGreaterThan(0)
  })
})

describe('speech-to-text: his own voice through the speakers', () => {
  const said = 'The forecast for London is light rain with highs of fourteen degrees'

  it('recognises his own words coming back as echo', () => {
    expect(isEcho('forecast for London light rain highs fourteen degrees', said)).toBe(true)
  })

  it('does not swallow a real follow-up question', () => {
    expect(isEcho('what about tomorrow in Paris', said)).toBe(false)
  })
})

describe('voice and face are independent', () => {
  it('the face popup has no say over the voice phase, and vice versa', () => {
    useStore.setState({ phase: 'listening', faceId: null })
    useStore.getState().setFaceId({ mode: 'verify', stage: 'searching', hint: '', box: null, progress: 0, attempts: 1, score: null })
    expect(useStore.getState().phase).toBe('listening')
    useStore.getState().setPhase('thinking')
    expect(useStore.getState().faceId?.stage).toBe('searching')
    useStore.getState().setFaceId(null)
    expect(useStore.getState().phase).toBe('thinking')
  })
})
