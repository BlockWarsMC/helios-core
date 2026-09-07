import chai, { expect } from 'chai'
import chaiAsPromised from 'chai-as-promised'
import nock from 'nock'
import { createHash } from 'crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathExists } from 'fs-extra'
import { Type } from 'helios-distribution-types'
import { HeliosDistribution } from '../../../lib/common/distribution/DistributionFactory'
import { FileSyncPolicy, Module } from '../../../lib/common/distribution/DistributionTypes'
import { DistributionIndexProcessor } from '../../../lib/dl/distribution/DistributionIndexProcessor'
import { downloadQueue } from '../../../lib/dl/DownloadEngine'
import { Asset } from '../../../lib/dl/Asset'
import { FullRepairReceiver, FullRepairReply } from '../../../lib/dl/receivers/FullRepairReceiver'
import { MojangIndexProcessor } from '../../../lib/dl/mojang/MojangIndexProcessor'

chai.use(chaiAsPromised)

const defaults = 'music:0.5\n'
const host = 'https://files.example.test'

function fileModule(policy?: FileSyncPolicy): Module {
    return {
        id: 'options.txt', name: 'Default options', type: Type.File,
        ...(policy ? { syncPolicy: policy } : {}),
        artifact: {
            path: 'options.txt', size: Buffer.byteLength(defaults),
            MD5: createHash('md5').update(defaults).digest('hex'),
            url: `${host}/options.txt`
        }
    }
}

describe('Install-once distribution files', () => {
    let root: string
    let destination: string

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'helios-install-once-'))
        destination = join(root, 'instances', 'test', 'options.txt')
        await mkdir(join(root, 'instances', 'test'), { recursive: true })
    })

    afterEach(async () => {
        nock.cleanAll()
        await rm(root, { recursive: true, force: true })
    })

    function distributionFor(modules: Module[]): HeliosDistribution {
        return new HeliosDistribution({
            version: '1.0.0', rss: '', servers: [{
                id: 'test', name: 'Test', description: '', icon: '', version: '1.0.0',
                address: 'localhost:25565', autoconnect: false, minecraftVersion: '1.21.5', modules
            }]
        }, join(root, 'common'), join(root, 'instances'))
    }

    async function validate(modules: Module[]): Promise<Asset[]> {
        const processor = new DistributionIndexProcessor(join(root, 'common'), distributionFor(modules), 'test')
        let stages = 0
        const result = await processor.validate(async () => { stages++ })
        expect(stages).to.equal(1)
        return result.distribution
    }

    it('carries policies from the cached manifest through the repair receiver', async () => {
        const distribution = distributionFor([fileModule('install-once')])
        await writeFile(join(root, 'distribution.json'), JSON.stringify(distribution.rawDistribution))
        const originalInit = Object.getOwnPropertyDescriptor(MojangIndexProcessor.prototype, 'init')!
        const originalValidate = Object.getOwnPropertyDescriptor(MojangIndexProcessor.prototype, 'validate')!
        const originalPostDownload = Object.getOwnPropertyDescriptor(DistributionIndexProcessor.prototype, 'postDownload')!
        const originalSend = Object.getOwnPropertyDescriptor(process, 'send')
        const replies: FullRepairReply[] = []
        try {
            MojangIndexProcessor.prototype.init = async (): Promise<void> => undefined
            MojangIndexProcessor.prototype.validate = async (): Promise<{[category: string]: Asset[]}> => ({})
            DistributionIndexProcessor.prototype.postDownload = async (): Promise<void> => undefined
            process.send = ((message: FullRepairReply) => {
                replies.push(message)
                return true
            }) as typeof process.send
            const receiver = new FullRepairReceiver()
            const validation = {
                action: 'validate' as const, serverId: 'test', launcherDirectory: root,
                commonDirectory: join(root, 'common'), instanceDirectory: join(root, 'instances'), devMode: false
            }
            await receiver.execute(validation)
            expect(replies.at(-1)).to.deep.equal({ response: 'validateComplete', invalidCount: 1 })
            await writeFile(destination, 'created by player')
            await receiver.execute({ action: 'download' })
            expect(await readFile(destination, 'utf8')).to.equal('created by player')
            expect(replies.at(-1)).to.deep.equal({ response: 'downloadComplete' })
            await receiver.execute(validation)
            expect(replies.at(-1)).to.deep.equal({ response: 'validateComplete', invalidCount: 0 })
            await rm(destination)
            await receiver.execute(validation)
            nock(host).get('/options.txt').reply(200, defaults)
            await receiver.execute({ action: 'download' })
            expect(await readFile(destination, 'utf8')).to.equal(defaults)
        } finally {
            Object.defineProperty(MojangIndexProcessor.prototype, 'init', originalInit)
            Object.defineProperty(MojangIndexProcessor.prototype, 'validate', originalValidate)
            Object.defineProperty(DistributionIndexProcessor.prototype, 'postDownload', originalPostDownload)
            if(originalSend) {
                Object.defineProperty(process, 'send', originalSend)
            } else {
                delete process.send
            }
        }
    })

    it('downloads a missing file and preserves subsequent user edits', async () => {
        const modules = [fileModule('install-once')]
        const assets = await validate(modules)
        expect(assets).to.have.length(1)
        expect(assets[0].installOnce).to.equal(true)
        const request = nock(host).get('/options.txt').reply(200, defaults)
        await downloadQueue(assets, received => { expect(received).to.be.at.least(0) })
        expect(request.isDone()).to.equal(true)
        expect(await readFile(destination, 'utf8')).to.equal(defaults)
        await writeFile(destination, 'music:0.0\n')
        expect(await validate(modules)).to.have.length(0)
        expect(await readFile(destination, 'utf8')).to.equal('music:0.0\n')
        expect(await readdir(join(root, 'instances', 'test'))).to.deep.equal(['options.txt'])
    })

    it('downloads the current default again after the user deletes the file', async () => {
        await writeFile(destination, 'old defaults')
        await rm(destination)
        const assets = await validate([fileModule('install-once')])
        nock(host).get('/options.txt').reply(200, defaults)
        await downloadQueue(assets, received => { expect(received).to.be.at.least(0) })
        expect(await readFile(destination, 'utf8')).to.equal(defaults)
    })

    for(const policy of [undefined, 'sync'] as const) {
        it(`repairs modified files with policy ${policy ?? 'omitted'}`, async () => {
            await writeFile(destination, 'modified')
            const assets = await validate([fileModule(policy)])
            expect(assets).to.have.length(1)
            expect(assets[0].installOnce).to.not.equal(true)
            nock(host).get('/options.txt').reply(200, defaults)
            await downloadQueue(assets, received => { expect(received).to.be.at.least(0) })
            expect(await readFile(destination, 'utf8')).to.equal(defaults)
            expect(await validate([fileModule(policy)])).to.have.length(0)
        })
    }

    it('preserves legacy hashless file behavior', async () => {
        const module = fileModule()
        delete module.artifact.MD5
        await writeFile(destination, 'custom')
        expect(await validate([module])).to.have.length(0)
        await rm(destination)
        expect(await validate([module])).to.have.length(1)
    })

    it('still validates children of a preserved file', async () => {
        const parent = fileModule('install-once')
        const child = fileModule()
        child.id = 'child'
        child.artifact.path = 'config/child.txt'
        parent.subModules = [child]
        await writeFile(destination, 'custom')
        const assets = await validate([parent])
        expect(assets.map(asset => asset.id)).to.deep.equal(['child'])
    })

    it('rejects policies on mods and unknown policies', async () => {
        const mod = fileModule('install-once')
        mod.type = Type.FabricMod
        mod.id = 'test:mod:1.0.0'
        await expect(validate([mod])).to.be.rejectedWith('only apply to File modules')
        const file = fileModule('unknown' as FileSyncPolicy)
        await expect(validate([file])).to.be.rejectedWith('Invalid sync policy')
    })

    it('requires an initial download hash', async () => {
        const file = fileModule('install-once')
        delete file.artifact.MD5
        await expect(validate([file])).to.be.rejectedWith('requires an MD5 hash')
    })

    it('rejects a directory at the destination', async () => {
        await mkdir(destination)
        await expect(validate([fileModule('install-once')])).to.be.rejectedWith('Expected a file')
    })

    it('does not install corrupt downloads and can retry', async () => {
        const modules = [fileModule('install-once')]
        const assets = await validate(modules)
        nock(host).get('/options.txt').reply(200, 'corrupt')
        await expect(downloadQueue(assets, received => { expect(received).to.be.at.least(0) })).to.be.rejectedWith('Hash mismatch')
        expect(await pathExists(destination)).to.equal(false)
        expect(await readdir(join(root, 'instances', 'test'))).to.have.length(0)
        expect(await validate(modules)).to.have.length(1)
        nock(host).get('/options.txt').reply(200, defaults)
        await downloadQueue(assets, received => { expect(received).to.be.at.least(0) })
        expect(await readFile(destination, 'utf8')).to.equal(defaults)
    })

    it('leaves no destination after an HTTP failure', async () => {
        const assets = await validate([fileModule('install-once')])
        nock(host).get('/options.txt').reply(404)
        await expect(downloadQueue(assets, received => { expect(received).to.be.at.least(0) })).to.be.rejected
        expect(await pathExists(destination)).to.equal(false)
        expect(await readdir(join(root, 'instances', 'test'))).to.have.length(0)
    })

    it('preserves a file created after validation', async () => {
        const assets = await validate([fileModule('install-once')])
        await writeFile(destination, 'created by user')
        await downloadQueue(assets, received => { expect(received).to.be.at.least(0) })
        expect(await readFile(destination, 'utf8')).to.equal('created by user')
    })

    it('preserves a file created during download', async () => {
        const assets = await validate([fileModule('install-once')])
        nock(host).get('/options.txt').reply(() => {
            writeFileSync(destination, 'created during download')
            return [200, defaults]
        })
        await downloadQueue(assets, received => { expect(received).to.be.at.least(0) })
        expect(await readFile(destination, 'utf8')).to.equal('created during download')
    })
})
