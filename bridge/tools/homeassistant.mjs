/**
 * Home Assistant, over its REST API with a long-lived access token.
 *
 * The URL and token come from the environment (HASS_URL, HASS_TOKEN), never
 * from the model. Only entities Home Assistant actually reports can be
 * controlled, and only with services that exist for their domain, so a
 * misheard name cannot become an invented action.
 *
 * What may happen without asking is decided by domain, not by the wording of
 * the request:
 *   lights, switches/plugs, fans            run directly (and are reversible)
 *   locks, alarms, covers (garage doors),
 *   climate, valves, sirens                 approved on screen first
 *   everything else                         refused
 */

import { z } from 'zod'
import { RISK } from '../policy.mjs'
import { defineTool, ToolError, ERR } from './registry.mjs'
import { requestJson } from './http.mjs'

const SERVER = 'jarvis_home'

/** Domain → the services JARVIS may call on it. */
const SERVICES = {
  light: ['turn_on', 'turn_off', 'toggle'],
  switch: ['turn_on', 'turn_off', 'toggle'],
  fan: ['turn_on', 'turn_off', 'toggle'],
  lock: ['lock', 'unlock'],
  alarm_control_panel: ['alarm_arm_home', 'alarm_arm_away', 'alarm_disarm'],
  cover: ['open_cover', 'close_cover', 'stop_cover'],
  climate: ['set_temperature', 'turn_on', 'turn_off'],
  valve: ['open_valve', 'close_valve'],
  siren: ['turn_on', 'turn_off'],
}
const LOW_IMPACT = new Set(['light', 'switch', 'fan'])

const ENTITY = /^[a-z_]+\.[a-z0-9_]+$/

/** @param {{ fetch?: typeof fetch, env?: Record<string,string|undefined> }} [deps] */
export function homeAssistant({ fetch: fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const cfg = () => {
    const url = env.HASS_URL?.replace(/\/+$/, '')
    return url && env.HASS_TOKEN ? { url, token: env.HASS_TOKEN } : null
  }
  const call = (pathname, { method = 'GET', body, signal } = {}) => {
    const c = cfg()
    if (!c) throw new ToolError(ERR.NOT_CONFIGURED, 'Home Assistant is not set up. Set HASS_URL and HASS_TOKEN (a long-lived access token) and restart JARVIS.')
    return requestJson(fetchImpl, `${c.url}${pathname}`, { method, body, signal, provider: 'Home Assistant', headers: { authorization: `Bearer ${c.token}` } })
  }
  return {
    configured: () => Boolean(cfg()),
    call,
    async status(signal) {
      if (!cfg()) return { configured: false, connected: false }
      try {
        const r = await call('/api/', { signal })
        return { configured: true, connected: r?.message === 'API running.', url: cfg().url }
      } catch (err) {
        return { configured: true, connected: false, url: cfg().url, error: err.message }
      }
    },
  }
}

const describe = (s) => ({ entity_id: s.entity_id, name: s.attributes?.friendly_name ?? s.entity_id, state: s.state, ...(s.attributes?.brightness != null ? { brightness: s.attributes.brightness } : {}) })

/** @param {ReturnType<typeof homeAssistant>} ha */
export function homeTools(ha) {
  const entityId = z.string().regex(ENTITY, 'must be an entity id like light.kitchen')
  return [
    defineTool({
      server: SERVER,
      name: 'home_status',
      description: 'Whether Home Assistant is configured and reachable. Read only.',
      input: {},
      risk: RISK.READ,
      async run(_a, { signal }) {
        return await ha.status(signal)
      },
    }),

    defineTool({
      server: SERVER,
      name: 'home_entities',
      description: 'List Home Assistant devices (entities), optionally by domain (light, switch, lock…) or name. Read only.',
      input: { domain: z.string().regex(/^[a-z_]+$/).optional(), search: z.string().max(80).optional() },
      risk: RISK.READ,
      retries: 1,
      async run(args, { signal }) {
        const states = await ha.call('/api/states', { signal })
        const q = args.search?.toLowerCase()
        const list = states
          .filter((s) => !args.domain || s.entity_id.startsWith(`${args.domain}.`))
          .filter((s) => !q || `${s.entity_id} ${s.attributes?.friendly_name ?? ''}`.toLowerCase().includes(q))
          .map((s) => ({ ...describe(s), controllable: Boolean(SERVICES[s.entity_id.split('.')[0]]) }))
        return { count: list.length, entities: list.slice(0, 100) }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'home_state',
      description: 'Current state of one Home Assistant entity. Read only.',
      input: { entity_id: entityId },
      risk: RISK.READ,
      retries: 1,
      async run(args, { signal }) {
        return describe(await ha.call(`/api/states/${args.entity_id}`, { signal }))
      },
    }),

    defineTool({
      server: SERVER,
      name: 'home_control',
      description:
        'Control a Home Assistant entity: lights, switches and fans directly; locks, alarms, covers, climate, valves and sirens after on-screen approval. ' +
        'The entity must exist (find it with home_entities).',
      input: {
        entity_id: entityId,
        service: z.string().regex(/^[a-z_]+$/),
        brightness_pct: z.number().int().min(1).max(100).optional(),
        temperature: z.number().min(5).max(35).optional(),
      },
      risk: RISK.REVERSIBLE,
      permissions: ['home:control'],
      assess(a) {
        const domain = a.entity_id.split('.')[0]
        if (!SERVICES[domain]) return { verdict: 'deny', risk: RISK.HIGH, reason: `controls a ${domain} entity, which JARVIS does not support` }
        if (!SERVICES[domain].includes(a.service)) return { verdict: 'deny', risk: RISK.HIGH, reason: `asks ${domain} to ${a.service}, which is not a supported action` }
        if (!LOW_IMPACT.has(domain)) {
          return { verdict: 'confirm', risk: RISK.HIGH, reason: `${a.service.replace(/_/g, ' ')}s a ${domain.replace(/_/g, ' ')}`, summary: `${a.service.replace(/_/g, ' ')} → ${a.entity_id}${a.temperature != null ? ` (${a.temperature}°)` : ''}` }
        }
        return null
      },
      async run(args, { signal }) {
        const domain = args.entity_id.split('.')[0]
        if (!SERVICES[domain]?.includes(args.service)) throw new ToolError(ERR.UNSUPPORTED, `${args.service} is not supported for ${domain}.`)
        // Exists in Home Assistant, not merely well-formed.
        const before = await ha.call(`/api/states/${args.entity_id}`, { signal })
        const body = {
          entity_id: args.entity_id,
          ...(domain === 'light' && args.brightness_pct != null && args.service === 'turn_on' ? { brightness_pct: args.brightness_pct } : {}),
          ...(domain === 'climate' && args.service === 'set_temperature' ? { temperature: args.temperature } : {}),
        }
        if (domain === 'climate' && args.service === 'set_temperature' && args.temperature == null) throw new ToolError(ERR.INVALID_ARGS, 'set_temperature needs a temperature.')
        const changed = await ha.call(`/api/services/${domain}/${args.service}`, { method: 'POST', body, signal })
        const after = Array.isArray(changed) ? changed.find((s) => s.entity_id === args.entity_id) : null
        return {
          entity_id: args.entity_id,
          service: args.service,
          before: before.state,
          after: after?.state ?? null,
          confirmed: Boolean(after),
          ...(after ? {} : { note: 'Home Assistant accepted the command but did not report a new state yet. Check with home_state.' }),
        }
      },
    }),
  ]
}
