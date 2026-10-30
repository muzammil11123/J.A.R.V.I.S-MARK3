import { test } from 'node:test'
import assert from 'node:assert/strict'
import { identityStore, faceSimilarity } from './identity.mjs'

/** The secret store's surface, in memory. */
function fakeSecrets() {
  const m = new Map()
  return {
    encrypted: true,
    has: (k) => m.has(k),
    get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null),
    set: async (k, v) => void m.set(k, structuredClone(v)),
    remove: async (k) => void m.delete(k),
    raw: m,
  }
}

/** A deterministic pseudo-random face embedding, so "same person" can mean
 *  "small nudge" and "stranger" can mean "different seed". */
function face(seed, jitter = 0, jitterSeed = 1) {
  let s = seed
  let j = jitterSeed
  const rnd = (x) => (x * 1103515245 + 12345) % 2 ** 31
  return Array.from({ length: 1024 }, () => {
    s = rnd(s)
    j = rnd(j)
    // Spread over ±1, about the range faceres descriptors occupy; Human's
    // distance is not scale-free, so a tighter fixture makes strangers match.
    return (s / 2 ** 31 - 0.5) * 2 + (j / 2 ** 31 - 0.5) * jitter
  })
}
const me = (j) => face(7, 0.002, j)
const enrolment = [1, 2, 3].map(me)

const setup = (now = () => 1_000_000) => {
  const secrets = fakeSecrets()
  const events = []
  const id = identityStore({ secrets, audit: (e) => events.push(e), env: {}, now })
  return { secrets, events, id }
}

test('similarity: identical faces match perfectly, unrelated ones do not', () => {
  const a = face(7)
  assert.equal(faceSimilarity(a, a), 1)
  assert.ok(faceSimilarity(a, face(99)) < 0.5)
})

test('first enrolment must set a PIN, later ones must give it', async () => {
  const { id } = setup()
  assert.equal((await id.enroll({ name: 'Ayman', samples: enrolment })).status, 400)
  assert.equal((await id.enroll({ name: 'Ayman', samples: enrolment, newPin: '12' })).status, 400)
  assert.equal((await id.enroll({ name: 'Ayman', samples: enrolment, newPin: '4821' })).status, 200)
  // A PIN now exists: a new one is not enough, the old one is required.
  assert.equal((await id.enroll({ name: 'Ayman', samples: enrolment, newPin: '0000' })).status, 403)
  assert.equal((await id.enroll({ name: 'Ayman', samples: enrolment, pin: '4821' })).status, 200)
})

test('enrolment needs a name, keeps the photos, and a match answers with the name', async () => {
  const { id, secrets } = setup()
  assert.equal((await id.enroll({ samples: enrolment, newPin: '4821' })).status, 400)
  assert.equal((await id.enroll({ name: '  ', samples: enrolment, newPin: '4821' })).status, 400)
  assert.equal((await id.enroll({ name: 'Ayman', samples: enrolment, newPin: '4821', photos: ['not a photo'] })).status, 400)

  const photo = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
  assert.equal((await id.enroll({ name: 'Ayman', samples: enrolment, newPin: '4821', photos: [photo, photo] })).status, 200)
  assert.deepEqual(secrets.raw.get('identity-face').photos, [photo, photo])
  const st = await id.status()
  assert.equal(st.face.name, 'Ayman')
  assert.equal(st.face.photos, 2)

  const hit = await id.verify({ embedding: me(9) })
  assert.equal(hit.body.verified, true)
  assert.equal(hit.body.name, 'Ayman')
  const miss = await id.verify({ embedding: face(99) })
  assert.equal(miss.body.verified, false)
  assert.equal('name' in miss.body, false)
})

test('PIN 2006: set first time without a face, hashed, verified, and wrong PINs refused', async () => {
  const { id, secrets, events } = setup()
  assert.equal((await id.changePin({ newPin: '2006' })).status, 200)
  const stored = JSON.stringify(secrets.raw.get('identity-pin'))
  assert.ok(!stored.includes('2006'), 'PIN must not be stored as typed')
  assert.match(stored, /"salt"/)
  assert.ok(!JSON.stringify(events).includes('2006'), 'PIN must not reach the audit log')
  assert.equal((await id.verifyPin({ pin: '2006' })).body.verified, true)
  assert.equal((await id.verifyPin({ pin: '2007' })).body.verified, false)
  // Once set, it cannot be replaced without the current one.
  assert.equal((await id.changePin({ newPin: '1234' })).status, 403)
  assert.equal((await id.changePin({ pin: '2006', newPin: '1234' })).status, 200)
})

test('a spoken PIN is redacted from text before it is written down, however it was misheard', async () => {
  const { id } = setup()
  assert.equal(await id.redactPin('take the pin 2006'), 'take the pin 2006') // no PIN set: nothing to match
  await id.changePin({ newPin: '2006' })
  assert.equal(await id.redactPin('take my face recognition if not take the penis 2006'), 'take my face recognition if not take the penis [PIN]')
  assert.equal(await id.redactPin('it is 20 06 or 2-0-0-6'), 'it is [PIN] or [PIN]')
  assert.equal(await id.redactPin('call 9059550220 at 2007'), 'call 9059550220 at 2007')
})

test('a PIN match never hands out the name; only a face match does', async () => {
  const { id } = setup()
  await id.enroll({ name: 'Ayman', samples: enrolment, newPin: '2006' })
  const byPin = await id.verifyPin({ pin: '2006' })
  assert.equal(byPin.body.verified, true)
  assert.equal('name' in byPin.body, false)
  assert.equal((await id.verify({ embedding: me(9) })).body.name, 'Ayman')
})

test('replacing the enrolled face needs the PIN', async () => {
  const { id } = setup()
  await id.enroll({ name: 'Ayman', samples: enrolment, newPin: '2006' })
  assert.equal((await id.enroll({ name: 'Someone', samples: [1, 2, 3].map((j) => face(55, 0.002, j)) })).status, 403)
  assert.equal((await id.enroll({ name: 'Someone', samples: [1, 2, 3].map((j) => face(55, 0.002, j)), pin: '1111' })).status, 403)
  assert.equal((await id.verify({ embedding: me(9) })).body.name, 'Ayman')
})

test('the profile: PIN-gated edits, personality returned only on a face match, secrets refused', async () => {
  const { id } = setup()
  assert.equal((await id.updateProfile({ pin: '2006', name: 'Ayman' })).status, 404) // no PIN yet
  await id.enroll({ name: 'Ayman', samples: enrolment, newPin: '2006' })
  assert.equal((await id.updateProfile({ pin: '0000', personality: 'Likes short answers.' })).status, 403)
  assert.equal((await id.updateProfile({ pin: '2006', personality: 'my pin is 2006' })).status, 400)
  const ok = await id.updateProfile({ pin: '2006', personality: 'Likes short answers.' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.profile.name, 'Ayman')
  assert.equal(ok.body.profile.personality, 'Likes short answers.')

  // Re-enrolling keeps the personality and updates the name.
  await id.enroll({ name: 'Ayman W', samples: enrolment, pin: '2006' })
  const hit = await id.verify({ embedding: me(9) })
  assert.equal(hit.body.name, 'Ayman W')
  assert.equal(hit.body.personality, 'Likes short answers.')
  assert.equal('personality' in (await id.verify({ embedding: face(99) })).body, false)
})

test('the PIN is stored hashed, never as typed', async () => {
  const { id, secrets } = setup()
  await id.enroll({ name: 'Ayman', samples: enrolment, newPin: '4821' })
  assert.ok(!JSON.stringify(secrets.raw.get('identity-pin')).includes('4821'))
})

test('the enrolled face verifies', async () => {
  const { id } = setup()
  await id.enroll({ name: 'Ayman', samples: enrolment, newPin: '4821' })
  const r = await id.verify({ embedding: me(9) })
  assert.equal(r.body.verified, true)
  assert.equal(id.session().method, 'face')
})

test('an unknown face is rejected, with its score', async () => {
  const { id } = setup()
  await id.enroll({ name: 'Ayman', samples: enrolment, newPin: '4821' })
  const r = await id.verify({ embedding: face(1234) })
  assert.equal(r.status, 200)
  assert.equal(r.body.verified, false)
  assert.ok(r.body.score < r.body.threshold)
  assert.equal(id.session(), null)
})

test('re-enrolling replaces the old face', async () => {
  const { id } = setup()
  await id.enroll({ name: 'Ayman', samples: enrolment, newPin: '4821' })
  await id.enroll({ name: 'Ayman', samples: [1, 2, 3].map((j) => face(55, 0.002, j)), pin: '4821' })
  assert.equal((await id.verify({ embedding: me(9) })).body.verified, false)
  assert.equal((await id.verify({ embedding: face(55, 0.002, 9) })).body.verified, true)
})

test('malformed embeddings are refused before anything is compared', async () => {
  const { id } = setup()
  assert.equal((await id.verify({ embedding: [1, 2, 3] })).status, 400)
  assert.equal((await id.verify({ embedding: new Array(1024).fill(NaN) })).status, 400)
  assert.equal((await id.verify({ embedding: face(1) })).status, 404)
  assert.equal((await id.enroll({ name: 'Ayman', samples: [face(1)], newPin: '4821' })).status, 400)
})

test('five failures lock face and PIN together, then lift', async () => {
  let t = 1_000_000
  const { id } = setup(() => t)
  await id.enroll({ name: 'Ayman', samples: enrolment, newPin: '4821' })
  for (let i = 0; i < 3; i++) await id.verify({ embedding: face(1000 + i) })
  for (let i = 0; i < 2; i++) await id.verifyPin({ pin: '0000' })
  assert.equal((await id.verifyPin({ pin: '4821' })).status, 429)
  assert.equal((await id.verify({ embedding: me(9) })).status, 429)
  // Enrolling over the top is locked too, or it would be the way around.
  assert.equal((await id.enroll({ name: 'Ayman', samples: enrolment, pin: '4821' })).status, 429)
  t += 61_000
  assert.equal((await id.verifyPin({ pin: '4821' })).body.verified, true)
})

test('forgetting needs the PIN; forgetting all clears the PIN too', async () => {
  const { id, secrets } = setup()
  await id.enroll({ name: 'Ayman', samples: enrolment, newPin: '4821' })
  assert.equal((await id.forget({ what: 'face', pin: '1111' })).status, 403)
  assert.equal((await id.forget({ what: 'face', pin: '4821' })).status, 200)
  assert.equal((await id.status()).face.enrolled, false)
  assert.equal((await id.status()).pin, true)
  assert.equal((await id.forget({ what: 'all', pin: '4821' })).status, 200)
  assert.equal(secrets.raw.size, 0)
})

test('neither status nor the audit log carries biometric data', async () => {
  const { id, events } = setup()
  await id.enroll({ name: 'Ayman', samples: enrolment, newPin: '4821' })
  await id.verify({ embedding: me(9) })
  const st = await id.status()
  // The profile is the person's own words; the template and photos never appear.
  delete st.profile
  const s = JSON.stringify(st)
  assert.ok(s.length < 400, s)
  for (const e of events) assert.ok(JSON.stringify(e).length < 200, JSON.stringify(e).slice(0, 200))
})
