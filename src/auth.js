// auth — authentication in the core, not at the server. A write action may carry
// a signed envelope proving the caller holds the private key for the `principal`
// it claims. filespace verifies it directly, so it doesn't merely *authorize*
// (may principal P do this?) but *authenticates* (is the caller really P?).
//
// This deliberately lives below any server: not every deployment is remote, and a
// server should be a transport shim, not the bouncer. Verification is a property
// of the message, so it travels with the message.
//
// Envelope: an action's args carry `auth: { nonce, exp, sig }`.
//   - the signed message binds op + all args (incl. principal) + nonce + exp
//   - `sig` is verified against `principal` (a public key)
//   - `exp` bounds the lifetime; `nonce` is single-use → replay is rejected
//
// The signer and the verifier MUST build the message identically — both go
// through signingString(), so the two never drift.

import { verify as verifySecp256k1 } from './identity.js';

// Deterministic JSON: object keys sorted recursively, so the signer and verifier
// produce byte-identical messages regardless of key insertion order.
export function stableStringify(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

const stripAuth = (args) => {
  const { auth, ...rest } = args ?? {};
  return rest;
};

// The exact bytes that get signed/verified for an action.
function signingString(op, argsWithoutAuth, nonce, exp) {
  return stableStringify({ op, args: argsWithoutAuth, nonce, exp });
}

// Client helper: wrap an action's args in a signed envelope.
//   signAction(identity, 'fs_create', { slug: '/macy/ces' })
// `identity` is { publicKey, sign } from newIdentity(). The caller's own
// principal is set from the identity, so it cannot be spoofed by the args.
export function signAction(identity, op, args = {}, { ttlMs = 30_000, now = Date.now, nonce = randomNonce() } = {}) {
  const rest = { ...args, principal: identity.publicKey };
  const exp = now() + ttlMs;
  const sig = identity.sign(signingString(op, rest, nonce, exp));
  return { ...rest, auth: { nonce, exp, sig } };
}

function randomNonce() {
  return crypto.randomUUID();
}

// Server/core side: build a guard that authenticates an action's envelope.
// `verify(principalPublicKey, message, signatureHex) -> boolean` is pluggable;
// the default is secp256k1, the curve web3auth / Ethereum wallets use.
export function makeAuthGuard({ verify = verifySecp256k1, now = Date.now, maxFutureMs = 5 * 60 * 1000 } = {}) {
  const seen = new Map(); // nonce -> exp, pruned once expired

  function prune(t) {
    for (const [n, e] of seen) if (e < t) seen.delete(n);
  }

  return function check(op, args) {
    const principal = args?.principal;
    const auth = args?.auth;
    if (!principal) return { ok: false, error: 'principal required' };
    if (!auth || !auth.sig || !auth.nonce || typeof auth.exp !== 'number') {
      return { ok: false, error: 'signed envelope required (nonce, exp, sig)' };
    }

    const t = now();
    if (auth.exp < t) return { ok: false, error: 'expired' };
    if (auth.exp > t + maxFutureMs) return { ok: false, error: 'exp too far in future' };

    prune(t);
    if (seen.has(auth.nonce)) return { ok: false, error: 'replay detected' };

    let valid = false;
    try {
      valid = verify(principal, signingString(op, stripAuth(args), auth.nonce, auth.exp), auth.sig);
    } catch {
      return { ok: false, error: 'bad signature' };
    }
    if (!valid) return { ok: false, error: 'signature mismatch' };

    seen.set(auth.nonce, auth.exp); // burn the nonce
    return { ok: true };
  };
}
