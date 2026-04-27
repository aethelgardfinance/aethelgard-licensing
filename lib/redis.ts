/**
 * Shared Redis client — initialised from Upstash env vars set by Vercel integration.
 *
 * Vercel uses two different naming conventions for the same Upstash Redis
 * connection depending on how the integration was wired up:
 *   - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (older Marketplace flow)
 *   - KV_REST_API_URL / KV_REST_API_TOKEN              (newer Storage flow)
 * This module accepts either, so re-linking the integration doesn't break the
 * webhook.
 */

import { Redis } from '@upstash/redis';

const url   = process.env['UPSTASH_REDIS_REST_URL']   ?? process.env['KV_REST_API_URL']   ?? '';
const token = process.env['UPSTASH_REDIS_REST_TOKEN'] ?? process.env['KV_REST_API_TOKEN'] ?? '';

export const kv = new Redis({ url, token });
