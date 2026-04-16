/**
 * Vercel Serverless Function — latest release proxy.
 *
 * Endpoint: GET /api/latest
 *
 * Returns the latest Aethelgard Windows installer download URL and version,
 * fetched server-side from the GitHub API so the repo can remain private.
 *
 * Required environment variable:
 *   GITHUB_TOKEN — a GitHub fine-grained PAT with Contents: read permission
 *                  on the CherieCAF/aethelgard repo
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

const GITHUB_OWNER = 'CherieCAF';
const GITHUB_REPO  = 'aethelgard';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
    const token = process.env['GITHUB_TOKEN'];
    if (!token) {
        return res.status(500).json({ error: 'GITHUB_TOKEN not configured' });
    }

    try {
        const resp = await fetch(
            `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            }
        );

        if (!resp.ok) {
            return res.status(resp.status).json({ error: `GitHub API error: ${resp.status}` });
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

        res.setHeader('Access-Control-Allow-Origin', 'https://aethelgard.finance');
        res.setHeader('Cache-Control', 's-maxage=300'); // cache for 5 minutes on Vercel edge
        return res.status(200).json({
            version,
            download_url: exeAsset.browser_download_url,
            file_name: exeAsset.name,
        });

    } catch (err) {
        return res.status(500).json({ error: String(err) });
    }
}
