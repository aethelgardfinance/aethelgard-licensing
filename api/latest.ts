/**
 * Vercel Serverless Function — latest release proxy.
 *
 * Endpoint: GET /api/latest
 *
 * Returns the latest Aethelgard download URLs and version from the public
 * aethelgard-releases repo. No authentication required.
 *
 * Response shape:
 *   version          — release version, e.g. "1.47.0"
 *   download_url     — Windows installer (.exe)   [primary; 404 if missing]
 *   file_name        — Windows installer filename
 *   mac_download_url — macOS disk image (.dmg), or null if the release has none
 *   mac_file_name    — macOS .dmg filename, or null
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

const GITHUB_OWNER = 'aethelgardfinance';
const GITHUB_REPO  = 'aethelgard-releases';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
    try {
        const headers: Record<string, string> = {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        };
        const ghToken = process.env['GITHUB_TOKEN'];
        if (ghToken) headers['Authorization'] = `Bearer ${ghToken}`;

        const resp = await fetch(
            `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
            { headers }
        );

        if (!resp.ok) {
            return res.status(resp.status).json({ error: `GitHub API error: ${resp.status} — no release published yet` });
        }

        const release = await resp.json() as {
            tag_name: string;
            assets: Array<{ name: string; browser_download_url: string }>;
        };

        const version = release.tag_name.replace(/^v/, '');
        const exeAsset = release.assets.find(a => a.name.endsWith('_x64-setup.exe'));

        if (!exeAsset) {
            return res.status(404).json({ error: 'No Windows installer found in latest release' });
        }

        // macOS disk image. Prefer the universal (Intel + Apple Silicon) build
        // when present; fall back to any .dmg. Absent on Windows-only releases,
        // in which case the mac_* fields are null and the site keeps its
        // releases-page fallback.
        const dmgAsset =
            release.assets.find(a => a.name.toLowerCase().endsWith('universal.dmg')) ??
            release.assets.find(a => a.name.toLowerCase().endsWith('.dmg')) ??
            null;

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 's-maxage=300'); // cache for 5 minutes on Vercel edge
        return res.status(200).json({
            version,
            download_url: exeAsset.browser_download_url,
            file_name: exeAsset.name,
            mac_download_url: dmgAsset ? dmgAsset.browser_download_url : null,
            mac_file_name: dmgAsset ? dmgAsset.name : null,
        });

    } catch (err) {
        return res.status(500).json({ error: String(err) });
    }
}
