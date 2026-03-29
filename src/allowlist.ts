/**
 * Domain allowlist — bypass whitelist checks for URLs on trusted domains.
 *
 * Used for CDN domains whose URLs are synthesized client-side and never
 * appear on-chain (e.g. YouTube video thumbnails).
 */

import * as config from 'config'
import * as fs from 'fs'
import {URL} from 'url'
import {logger} from './logger'

class DomainAllowlist {
    private domains: Set<string>
    private dynamicListFilename?: string

    constructor(defaultDomains: string[], dynamicListFilename?: string) {
        this.domains = new Set(defaultDomains)
        this.dynamicListFilename = dynamicListFilename
        this.reloadDynamicList()
        if (this.dynamicListFilename) {
            fs.watchFile(this.dynamicListFilename, () => {
                this.reloadDynamicList()
            })
        }
    }

    public reloadDynamicList() {
        if (this.dynamicListFilename) {
            try {
                const data = JSON.parse(fs.readFileSync(this.dynamicListFilename, 'utf8'))
                if (Array.isArray(data)) {
                    for (const domain of data) {
                        this.domains.add(domain)
                    }
                    logger.info('Loaded domain allowlist file: %d domains', data.length)
                }
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
                    logger.error('Failed to parse domain allowlist file', this.dynamicListFilename, e)
                }
            }
        }
    }

    /** Check if a URL's domain is in the allowlist. */
    public matchesDomain(url: URL): boolean {
        return this.domains.has(url.hostname)
    }
}

/** YouTube thumbnail CDNs — URLs are synthesized client-side from video links. */
const defaultAllowedDomains: string[] = [
    'img.youtube.com',
    'i.ytimg.com',
]

export const domainAllowlist = new DomainAllowlist(
    defaultAllowedDomains,
    config.has('allowlist.domainAllowList') ? config.get('allowlist.domainAllowList') : undefined
)
