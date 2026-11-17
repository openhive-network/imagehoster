/** Cluster master: keeps the worker pool at size, recycles bloated workers. */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cluster = require('cluster')
import * as fs from 'fs'

import {logger} from './logger'

/** More than this many unexpected worker deaths within the window stops the master. */
const _DEATH_LIMIT = 5
const _DEATH_WINDOW_MS = 60 * 1000

export interface SupervisorOptions {
    numWorkers: number
    /** Recycle a worker whose resident plus swapped memory exceeds this; 0 disables sampling. */
    maxRssMb: number
    /** How often worker memory is sampled. */
    rssCheckIntervalMs: number
    /** How long a worker asked to stop may take before it is killed. */
    stopTimeoutMs: number
}

interface _Recycle {
    old: any
    replacement: any
}

/** Reads a worker's VmRSS + VmSwap in MB from procfs, or null when the process is gone. */
async function _readMemoryMb(pid: number): Promise<{rss: number, swap: number} | null> {
    let status: string
    try {
        status = await fs.promises.readFile(`/proc/${ pid }/status`, 'utf8')
    } catch (error: any) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') {
            return null
        }
        throw error
    }
    const field = (name: string) => {
        const match = status.match(new RegExp(`^${ name }:\\s+(\\d+) kB`, 'm'))
        return match ? Number.parseInt(match[1]) / 1024 : 0
    }
    return {rss: field('VmRSS'), swap: field('VmSwap')}
}

/**
 * Forks `numWorkers` workers and supervises them for the life of the process:
 * replaces workers that die, recycles workers over the memory limit (replacement
 * listening before the old one is asked to stop), and on SIGTERM/SIGINT stops all
 * workers and exits 0. More than 5 unexpected deaths within 60 s makes the master
 * stop its workers and exit 1, leaving the restart to the container's policy.
 */
export function superviseWorkers(options: SupervisorOptions) {
    const {numWorkers, maxRssMb, rssCheckIntervalMs, stopTimeoutMs} = options
    const stopping = new Set<number>()
    let deaths: number[] = []
    let recycle: _Recycle | null = null
    let shuttingDown = false
    let watchdog: NodeJS.Timeout | undefined

    const fork = () => cluster.fork()

    const stopWorker = (worker: any) => {
        if (stopping.has(worker.id)) {
            return
        }
        stopping.add(worker.id)
        const timer = setTimeout(() => {
            logger.warn({worker: worker.id, worker_pid: worker.process.pid, timeout_ms: stopTimeoutMs},
                'worker did not stop in time, killing it')
            worker.process.kill('SIGKILL')
        }, stopTimeoutMs)
        worker.once('exit', () => { clearTimeout(timer) })
        worker.process.kill('SIGTERM')
    }

    const shutdown = (code: number) => {
        shuttingDown = true
        if (watchdog) {
            clearInterval(watchdog)
        }
        const workers = Object.values(cluster.workers || {}) as any[]
        if (workers.length === 0) {
            process.exit(code)
        }
        cluster.on('exit', () => {
            if (Object.keys(cluster.workers || {}).length === 0) {
                process.exit(code)
            }
        })
        workers.forEach(stopWorker)
    }

    const onUnexpectedExit = (worker: any, code: number | null, signal: string | null) => {
        const now = Date.now()
        deaths = deaths.filter((t) => now - t < _DEATH_WINDOW_MS)
        deaths.push(now)
        if (deaths.length > _DEATH_LIMIT) {
            logger.error({worker: worker.id, worker_pid: worker.process.pid, code, signal},
                '%d worker deaths within %d s, not respawning: stopping workers and exiting with code 1',
                deaths.length, _DEATH_WINDOW_MS / 1000)
            shutdown(1)
            return
        }
        if (recycle && recycle.replacement === worker) {
            logger.warn({worker: worker.id, worker_pid: worker.process.pid, code, signal},
                'recycle replacement died before listening, keeping worker %d', recycle.old.id)
            recycle = null
            return
        }
        if (recycle && recycle.old === worker) {
            logger.warn({worker: worker.id, worker_pid: worker.process.pid, code, signal},
                'worker died while being recycled, its replacement takes its place')
            recycle = null
            return
        }
        logger.warn({worker: worker.id, worker_pid: worker.process.pid, code, signal}, 'worker died, respawning')
        fork()
    }

    cluster.on('listening', (worker: any, address: any) => {
        logger.info({worker: worker.id, worker_pid: worker.process.pid, port: address.port}, 'worker listening')
        if (recycle && recycle.replacement === worker && !shuttingDown) {
            logger.info({worker: recycle.old.id, worker_pid: recycle.old.process.pid, replacement: worker.id},
                'replacement listening, stopping recycled worker')
            stopWorker(recycle.old)
        }
    })

    cluster.on('exit', (worker: any, code: number | null, signal: string | null) => {
        const expected = stopping.delete(worker.id)
        if (expected) {
            logger.info({worker: worker.id, worker_pid: worker.process.pid, code, signal}, 'worker stopped')
            if (recycle && recycle.old === worker) {
                recycle = null
            }
        } else if (!shuttingDown) {
            onUnexpectedExit(worker, code, signal)
        }
    })

    const sampleMemory = async () => {
        if (recycle || shuttingDown) {
            return
        }
        const workers = (Object.values(cluster.workers || {}) as any[]).filter((w) => !stopping.has(w.id))
        const samples = await Promise.all(workers.map(async (worker) => ({
            worker, memory: await _readMemoryMb(worker.process.pid)
        })))
        if (recycle || shuttingDown) {
            return
        }
        let worst: {worker: any, memory: {rss: number, swap: number}, total: number} | undefined
        for (const {worker, memory} of samples) {
            if (memory && !worker.isDead() && !stopping.has(worker.id)) {
                const total = memory.rss + memory.swap
                if (total > maxRssMb && (!worst || total > worst.total)) {
                    worst = {worker, memory, total}
                }
            }
        }
        if (!worst) {
            return
        }
        logger.warn({
            worker: worst.worker.id, worker_pid: worst.worker.process.pid,
            rss_mb: Math.round(worst.memory.rss), swap_mb: Math.round(worst.memory.swap), limit_mb: maxRssMb
        }, 'worker memory over limit, recycling')
        recycle = {old: worst.worker, replacement: fork()}
    }

    if (maxRssMb > 0) {
        if (fs.existsSync('/proc/self/status')) {
            watchdog = setInterval(() => {
                sampleMemory().catch((error) => {
                    logger.error(error, 'worker memory sampling failed, retrying next interval')
                })
            }, rssCheckIntervalMs)
        } else {
            logger.warn('no /proc filesystem, worker memory recycling disabled')
        }
    }

    for (const signal of ['SIGTERM', 'SIGINT']) {
        process.on(signal, () => {
            if (shuttingDown) {
                return
            }
            logger.info('got %s, stopping workers...', signal)
            shutdown(0)
        })
    }

    logger.info({max_rss_mb: maxRssMb}, 'spawning %d workers', numWorkers)
    for (let i = 0; i < numWorkers; i++) {
        fork()
    }
}
