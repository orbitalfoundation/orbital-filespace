// @orbitalfoundation/filespace — public API.
//
//   import { createBus } from '@orbitalfoundation/bus'
//   import { attach, makeFileStore } from '@orbitalfoundation/filespace'
//
//   const bus = createBus()
//   const fs  = attach(bus, { store: makeFileStore('.filespace/nodes.json') })
//
//   await fs.claim({ slug: '/anselm', principal: 'anselm' })
//   await bus.resolve({ fs_list_query: { slug: '/' } })

export { createFilespace, attach, makeService } from './filespace.js';
export { makeMemoryStore } from './store/memory.js';
export { makeFileStore } from './store/file.js';
export { seedDir } from './seed.js';
export { makeNode } from './node.js';
export { newIdentity, sign, verify } from './identity.js';
export * as paths from './paths.js';
export * as policy from './policy.js';
