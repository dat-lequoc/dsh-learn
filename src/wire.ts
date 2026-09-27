/**
 * Wire helpers for the `/learn/api` JSON routes: bounded body reading,
 * response writing, and a shared error envelope, mirroring dsh-better-sidebar's
 * `/sidebar/api` convention so both plugins' routes read the same way from the
 * browser: `{ ok: true, value }` or `{ ok: false, error: { code, message } }`.
 *
 * @module dsh-learn/wire
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Machine-readable error codes of the `/learn/api` routes. */
export type LearnErrorCode = 'bad-request' | 'not-found' | 'forbidden' | 'method-error' | 'internal'

/** One API failure with its wire code and HTTP status. */
export class LearnApiError extends Error {
  constructor(readonly code: LearnErrorCode, message: string, readonly status = 400) {
    super(message)
  }
}

const MAX_BODY_BYTES = 1 << 20

/** Read and parse the JSON request body (bounded; malformed → bad-request). */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Uint8Array)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new LearnApiError('bad-request', 'request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new LearnApiError('bad-request', 'request body is not valid JSON')
  }
}

/** Write a JSON response with the given status. */
export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/** Write the success envelope. */
export function writeOk(res: ServerResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

/** Write the failure envelope for any thrown value (unknown → internal 500). */
export function writeError(res: ServerResponse, error: unknown): void {
  if (error instanceof LearnApiError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { ok: false, error: { code: 'internal', message } })
}

/** Narrow an unknown payload value to a non-empty string, else throw bad-request. */
export function requireString(payload: unknown, key: string): string {
  const record = payload as Record<string, unknown> | null
  const value = record?.[key]
  if (typeof value !== 'string' || value === '') {
    throw new LearnApiError('bad-request', `missing or invalid "${key}"`)
  }
  return value
}

/** Narrow an unknown payload value to a string, allowing empty (used for free-text send). */
export function requireStringAllowEmpty(payload: unknown, key: string): string {
  const record = payload as Record<string, unknown> | null
  const value = record?.[key]
  if (typeof value !== 'string') throw new LearnApiError('bad-request', `missing or invalid "${key}"`)
  return value
}
