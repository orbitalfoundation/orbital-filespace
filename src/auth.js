// auth — authentication in the core, not at the server. A request may carry a
// signed envelope proving the caller holds the private key for the `principal` it
// claims. filespace verifies it directly, so it doesn't merely *authorize* (may
// principal P do this?) but *authenticates* (is the caller really P?).
//
// This lives below any server: not every deployment is remote, and a server
// should be a transport shim, not the bouncer. Verification is a property of the
// message, so it travels with the message.
//
// A request is { op, ...params, auth?: { nonce, exp, sig } }. The signature binds
// op + params (incl. principal) + nonce + exp, is verified against `principal` (a
// public key), and each nonce is single-use so a captured request can't be
// replayed. The signer and verifier both go through signingString(), so they
// never drift.

import { verify as verifySecp256k1 } from './identity.js';

// Deterministic JSON: keys sorted recursively, so signer and verifier produce
// byte-identical messages regardless of insertion order.
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

// The params of a request are everything except the op and the envelope.
export function requestParams(req) {
  const { op, auth, ...params } = req ?? {};
  return params;
}

// The exact bytes signed/verified for a request.
function signingString(op, params, nonce, exp) {
  return stableStringify({ op, params, nonce, exp });
}

function randomNonce() {
  return crypto.randomUUID();
}

// Client helper: build a signed request. The caller's principal is taken from the
// identity, so it can't be spoofed by the args.
//   signAction(alice, 'claim', { slug: '/alice' })
//   -> { op: 'claim', slug: '/alice', principal: <alice pub>, auth: { nonce, exp, sig } }
export function signAction(identity, op, args = {}, { ttlMs = 30_000, now = Date.now, nonce = randomNonce() } = {}) {
  const params = { ...args, principal: identity.publicKey };
  const exp = now() + ttlMs;
  const sig = identity.sign(signingString(op, params, nonce, exp));
  return { op, ...params, auth: { nonce, exp, sig } };
}

// Envelope builders — the single reserved bus key, split query (reads) vs command
// (writes). Reads may be anonymous (no identity → no signature).
export function fsCommand(identity, op, args = {}, opts) {
  return { filespace: { command: signAction(identity, op, args, opts) } };
}

export function fsQuery(op, args = {}, identity = null, opts) {
  const request = identity ? signAction(identity, op, args, opts) : { op, ...args };
  return { filespace: { query: request } };
}

// Core side: authenticate a request's envelope. `verify(principalPublicKey,
// message, signatureHex) -> boolean` is pluggable; default is secp256k1, the
// curve web3auth / Ethereum wallets use.
export function makeAuthGuard({ verify = verifySecp256k1, now = Date.now, maxFutureMs = 5 * 60 * 1000 } = {}) {
  const seen = new Map(); // nonce -> exp, pruned once expired

  function prune(t) {
    for (const [n, e] of seen) if (e < t) seen.delete(n);
  }

  return function check(req) {
    const params = requestParams(req);
    const principal = params.principal;
    const op = req?.op;
    const auth = req?.auth;
    if (!principal) return { ok: false, error: 'principal required' };
    if (!op) return { ok: false, error: 'op required' };
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
      valid = verify(principal, signingString(op, params, auth.nonce, auth.exp), auth.sig);
    } catch {
      return { ok: false, error: 'bad signature' };
    }
    if (!valid) return { ok: false, error: 'signature mismatch' };

    seen.set(auth.nonce, auth.exp); // burn the nonce
    return { ok: true };
  };
}
