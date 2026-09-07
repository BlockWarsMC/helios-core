import { Distribution as BaseDistribution, Server as BaseServer, Module as BaseModule } from 'helios-distribution-types'

export type FileSyncPolicy = 'sync' | 'install-once'

export interface Module extends BaseModule {
    /** Only applies to File modules. Omission preserves normal synchronization. */
    syncPolicy?: FileSyncPolicy
    subModules?: Module[]
}

export interface Server extends BaseServer {
    modules: Module[]
}

export interface Distribution extends BaseDistribution {
    servers: Server[]
}
