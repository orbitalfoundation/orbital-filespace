// @orbitalfoundation/filespace — public API.
//
//   import { createBus } from '@orbitalfoundation/bus'
//   import { attach, makeFileStore } from '@orbitalfoundation/filespace'
//
//   const bus = createBus()
//   const fs  = attach(bus, { store: makeFileStore('.filespace/nodes.json') })
//
//   await fs.claim({ slug: '/anselm', principal: 'anselm' })
//   await bus.resolve({ filespace: { query: { op: 'list', slug: '/' } } })

export { createFilespace, attach, makeService } from './filespace.js';
export { makeMemoryStore } from './store/memory.js';
export { makeFileStore } from './store/file.js';
export { findManifest, readJsonManifest, MANIFEST_NAMES } from './seed.js';
export { makeNode } from './node.js';
export { newIdentity, sign, verify, exportPrivateKeyPem, identityFromPrivateKeyPem } from './identity.js';
export { signAction, fsCommand, fsQuery, makeAuthGuard, stableStringify } from './auth.js';
export { makeKeyring } from './keyring.js';
export * as paths from './paths.js';
export * as policy from './policy.js';
