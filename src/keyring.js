// keyring — a local "hosted keypair" store for testing and tooling.
//
// Normally every user holds their own private key (in a wallet); filespace only
// ever sees public keys and signatures. But to *exercise* the system from a CLI,
// something has to hold keys and sign on a user's behalf. This keyring does that:
// it generates and retains named keypairs on disk so `--as alice` can load
// alice's key and sign an action as her.
//
// SECURITY: private keys are stored in plaintext. This is a test/dev convenience,
// NOT a production credential store. Keep the keyring file out of git.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { newIdentity, exportPrivateKeyPem, identityFromPrivateKeyPem } from './identity.js';

export function makeKeyring(path) {
  let data = { users: {} };
  if (existsSync(path)) {
    try {
      data = JSON.parse(readFileSync(path, 'utf8'));
      data.users ??= {};
    } catch {
      data = { users: {} };
    }
  }

  const flush = () => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2));
  };

  return {
    path,
    has(name) {
      return Boolean(data.users[name]);
    },
    list() {
      return Object.entries(data.users).map(([name, u]) => ({ name, publicKey: u.publicKey }));
    },
    publicKeyOf(name) {
      return data.users[name]?.publicKey ?? null;
    },
    identity(name) {
      const u = data.users[name];
      return u ? identityFromPrivateKeyPem(u.privateKeyPem) : null;
    },
    create(name) {
      if (data.users[name]) throw new Error(`user already exists: ${name}`);
      const id = newIdentity();
      data.users[name] = { publicKey: id.publicKey, privateKeyPem: exportPrivateKeyPem(id) };
      flush();
      return id;
    },
    remove(name) {
      const existed = Boolean(data.users[name]);
      delete data.users[name];
      flush();
      return existed;
    },
  };
}
