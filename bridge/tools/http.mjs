/**
 * Calling a provider's HTTP API and reporting what actually came back.
 *
 * Every connector (Google, WhatsApp, Home Assistant) uses this, so a 401 is
 * always "not connected", a 429 is always "rate limited", and an unreachable
 * host is never mistaken for an empty result. The provider's own message is
 * passed through, because "Recipient phone number not in allowed list" is
 * worth more to the user than any paraphrase.
 */

import { ToolError, ERR } from './registry.mjs'

const STATUS_CODES = {
  400: [ERR.INVALID_ARGS, false],
  401: [ERR.NOT_CONNECTED, false],
  403: [ERR.PERMISSION_DENIED, false],
  404: [ERR.NOT_FOUND, false],
  409: [ERR.CONFLICT, false],
  429: [ERR.RATE_LIMITED, true],
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string,string>, body?: any,
 *           signal?: AbortSignal, provider: string, raw?: boolean }} opts
 */
export async function requestJson(fetchImpl, url, { method = 'GET', headers = {}, body, signal, provider, raw = false }) {
  let res
  try {
    res = await fetchImpl(url, {
      method,
      headers: body !== undefined && !raw ? { 'content-type': 'application/json', ...headers } : headers,
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') throw err
    const why = err?.cause?.code ?? err?.code ?? err?.message ?? 'network error'
    throw new ToolError(ERR.NETWORK, `${provider} could not be reached (${why}).`, { retryable: true })
  }
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (res.ok) return data ?? {}
  const message =
    data?.error?.error_user_msg ??
    data?.error?.message ??
    data?.error_description ??
    data?.message ??
    (typeof data?.error === 'string' ? data.error : null) ??
    `HTTP ${res.status}`
  const [code, retryable] = STATUS_CODES[res.status] ?? (res.status >= 500 ? [ERR.PROVIDER_ERROR, true] : [ERR.PROVIDER_ERROR, false])
  throw new ToolError(code, `${provider}: ${String(message).slice(0, 300)}`, {
    retryable,
    details: { http_status: res.status, ...(data?.error?.code != null ? { provider_code: data.error.code } : {}) },
  })
}
