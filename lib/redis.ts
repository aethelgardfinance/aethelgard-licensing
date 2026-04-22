/**
 * Shared Redis client — initialised from Upstash env vars set by Vercel integration.
 *
 * When you connect an Upstash Redis database through the Vercel marketplace,
 * Vercel auto-adds UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to
 * the project. This module reads those vars and exports a single client instance.
 */

import { Redis } from '@upstash/redis';

export const kv = new Redis({
    url:   process.env['UPSTASH_REDIS_REST_URL']   ?? '',
    token: process.env['UPSTASH_REDIS_REST_TOKEN'] ?? '',
});
