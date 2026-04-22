/**
 * Shared Redis client — initialised from Upstash env vars set by Vercel integration.
 *
 * When you connect an Upstash Redis database through the Vercel marketplace,
 * Vercel auto-adds UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to
 * the project. This module reads those vars and exports a single client instance.
 */

import { Redis } from '@upstash/redis';

if (!process.env['UPSTASH_REDIS_REST_URL'] || !process.env['UPSTASH_REDIS_REST_TOKEN']) {
    console.warn('[redis] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — KV operations will fail');
}

export const kv = new Redis({
    url:   process.env['UPSTASH_REDIS_REST_URL']   ?? '',
    token: process.env['UPSTASH_REDIS_REST_TOKEN'] ?? '',
});
