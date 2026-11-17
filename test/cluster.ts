import 'mocha'
import assert from 'assert'
import * as child_process from 'child_process'
import needle from 'needle'
import * as path from 'path'

interface LogRecord {
    msg: string
    worker?: number
    pid: number
    worker_pid: number
    [key: string]: any
}

/** The service started as `node src/app.ts` in cluster mode, with its master's log. */
class Service {
    public readonly records: LogRecord[] = []
    public readonly exited: Promise<number | null>
    private readonly child: child_process.ChildProcess
    private waiters: Array<() => void> = []

    constructor(public readonly port: number, env: {[key: string]: string}) {
        this.child = child_process.spawn(process.execPath, ['-r', 'ts-node/register', 'src/app.ts'], {
            cwd: path.resolve(__dirname, '..'),
            env: {
                ...process.env,
                NODE_ENV: 'test',
                TS_NODE_TRANSPILE_ONLY: 'true',
                LOG_LEVEL: 'info',
                PORT: String(port),
                NUM_WORKERS: '2',
                ...env
            },
            stdio: ['ignore', 'pipe', 'inherit']
        })
        let buffer = ''
        this.child.stdout!.on('data', (chunk: Buffer) => {
            buffer += chunk.toString()
            const lines = buffer.split('\n')
            buffer = lines.pop()!
            for (const line of lines) {
                try {
                    this.records.push(JSON.parse(line))
                } catch (error) {
                    continue
                }
            }
            this.waiters.forEach((wake) => wake())
        })
        this.exited = new Promise((resolve) => {
            this.child.on('exit', (code) => {
                this.waiters.forEach((wake) => wake())
                resolve(code)
            })
        })
    }

    get masterPid() {
        return this.child.pid!
    }

    /** Master log records (workers log under their own pid). */
    master(msg: string) {
        return this.records.filter((r) => r.pid === this.masterPid && r.msg === msg)
    }

    async waitFor(description: string, done: () => boolean, timeoutMs = 30000) {
        const deadline = Date.now() + timeoutMs
        while (!done()) {
            if (this.child.exitCode !== null || this.child.signalCode !== null) {
                assert.fail(`service exited while waiting for ${ description }; ${ this.recentLog() }`)
            }
            if (Date.now() > deadline) {
                assert.fail(`timed out waiting for ${ description }; ${ this.recentLog() }`)
            }
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, 200)
                this.waiters.push(() => { clearTimeout(timer); resolve() })
            })
            this.waiters = []
        }
    }

    /** The master's last log messages, for failure reports. */
    recentLog() {
        const lines = this.records.filter((r) => r.pid === this.masterPid).slice(-15)
            .map((r) => `${ r.time } ${ r.msg } worker=${ r.worker } code=${ r.code } signal=${ r.signal }`)
        return `master log:\n${ lines.join('\n') }`
    }

    async listeningWorkers(count: number) {
        await this.waitFor(`${ count } listening workers`, () => this.liveListening().length >= count)
        return this.liveListening()
    }

    /** `worker listening` records of workers that have not exited since. */
    liveListening() {
        const gone = new Set(this.records
            .filter((r) => r.pid === this.masterPid && r.worker !== undefined &&
                ['worker stopped', 'worker died, respawning'].includes(r.msg))
            .map((r) => r.worker))
        return this.master('worker listening').filter((r) => !gone.has(r.worker))
    }

    async healthcheck() {
        const response = await needle('get', `http://localhost:${ this.port }/.well-known/healthcheck.json`)
        assert.equal(response.statusCode, 200, 'healthcheck status')
    }

    kill(signal: NodeJS.Signals = 'SIGTERM') {
        if (this.child.exitCode === null && this.child.signalCode === null) {
            this.child.kill(signal)
        }
    }
}

describe('cluster master', function() {
    this.timeout(90000)
    this.slow(10000)

    describe('worker deaths', function() {
        let service: Service
        before(() => { service = new Service(63310, {WORKER_MAX_RSS_MB: '0', WORKER_STOP_TIMEOUT_MS: '8000'}) })
        after(() => { service.kill('SIGKILL') })

        it('should respawn a killed worker', async function() {
            const [victim] = await service.listeningWorkers(2)
            const killedAt = Date.now()
            process.kill(victim.worker_pid, 'SIGKILL')
            await service.waitFor('respawn', () => service.master('worker died, respawning').length > 0)
            const [death] = service.master('worker died, respawning')
            assert.equal(death.worker, victim.worker)
            assert.equal(death.signal, 'SIGKILL')
            assert.ok(Date.parse(death.time) - killedAt < 1000, 'respawned within 1 s')
            const workers = await service.listeningWorkers(2)
            assert.equal(workers.length, 2)
            assert.ok(!workers.some((w) => w.worker === victim.worker))
            await service.healthcheck()
        })

        it('should stop workers on SIGTERM without respawning, killing a stuck one', async function() {
            const [stuck] = await service.listeningWorkers(2)
            process.kill(stuck.worker_pid, 'SIGSTOP')
            const deathsBefore = service.master('worker died, respawning').length
            service.kill('SIGTERM')
            assert.equal(await service.exited, 0)
            const killed = service.master('worker did not stop in time, killing it')
            assert.deepEqual(killed.map((r) => r.worker), [stuck.worker])
            assert.equal(service.master('worker stopped').length, 2)
            assert.equal(service.master('worker died, respawning').length, deathsBefore)
        })
    })

    describe('crash loop', function() {
        let service: Service
        before(() => { service = new Service(63320, {WORKER_MAX_RSS_MB: '0'}) })
        after(() => { service.kill('SIGKILL') })

        it('should exit non-zero instead of respawning without bound', async function() {
            const killed = new Set<number>()
            const killer = setInterval(() => {
                for (const record of service.liveListening()) {
                    if (!killed.has(record.worker_pid)) {
                        killed.add(record.worker_pid)
                        try { process.kill(record.worker_pid, 'SIGKILL') } catch (error) { continue }
                    }
                }
            }, 50)
            try {
                assert.equal(await service.exited, 1)
            } finally {
                clearInterval(killer)
            }
            assert.equal(service.master('worker died, respawning').length, 5)
            const tripped = service.records.filter((r) => r.pid === service.masterPid && r.level === 50)
            assert.equal(tripped.length, 1)
            assert.match(tripped[0].msg, /6 worker deaths within 60 s, not respawning/)
        })
    })

    describe('memory recycle', function() {
        let service: Service
        before(() => {
            service = new Service(63330, {
                WORKER_MAX_RSS_MB: '1', WORKER_RSS_CHECK_INTERVAL_MS: '500', WORKER_STOP_TIMEOUT_MS: '10000'
            })
        })
        after(() => { service.kill('SIGKILL') })

        it('should replace a worker over the memory limit before stopping it', async function() {
            await service.listeningWorkers(2)
            const failures: string[] = []
            let requests = 0
            let polling = true
            // several keep-alive clients, so the recycled worker has a socket kept busy
            const pollers = [1, 2, 3, 4].map(async () => {
                while (polling) {
                    await service.healthcheck().catch((error) => { failures.push(error.code || error.message) })
                    requests++
                }
            })
            await service.waitFor('a recycled worker to stop', () => service.master('worker stopped').length > 0)
            polling = false
            await Promise.all(pollers)

            const [recycle] = service.master('worker memory over limit, recycling')
            assert.ok(recycle.rss_mb > 1, 'recycle logs the measured rss')
            assert.equal(recycle.limit_mb, 1)
            const [stopped] = service.master('worker stopped')
            assert.equal(stopped.worker, recycle.worker)
            assert.equal(stopped.code, 0, 'recycled worker exits through its graceful path')
            assert.equal(service.master('worker did not stop in time, killing it').length, 0)
            const index = (r: LogRecord) => service.records.indexOf(r)
            const replacementUp = service.master('worker listening').find((r) => r.worker! > 2)!
            assert.ok(index(recycle) < index(replacementUp), 'replacement forked after the recycle decision')
            assert.ok(index(replacementUp) < index(stopped), 'replacement listening before the old worker exits')
            assert.equal(service.master('worker died, respawning').length, 0)
            assert.ok(requests > 0)
            assert.deepEqual(failures, [], 'requests keep succeeding during the recycle')

            service.kill('SIGTERM')
            assert.equal(await service.exited, 0)
        })
    })
})
