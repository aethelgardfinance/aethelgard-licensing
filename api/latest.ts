/**
 * Vercel Serverless Function — latest release proxy.
 *
 * Endpoint: GET /api/latest
 *
 * Returns the latest Aethelgard Windows installer download URL and version
 * from the public aethelgard-releases repo. No authentication required.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

const GITHUB_OWNER = 'CherieCAF';
const GITHUB_REPO  = 'aethelgard-releases';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
    try {
        const resp = await fetch(
            `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
            {
                headers: {
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            }
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
