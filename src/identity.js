// identity — secp256k1 keypairs, the same curve web3auth / Ethereum wallets use.
//
// In production a principal's public key arrives from the user's wallet via a
// verified web3auth idToken, and the server is what verifies it. filespace
// treats a principal as an opaque string, so a readable handle OR a pubkey hex
// both work as `principal`. This helper lets tests and demos mint a real
// cryptographic identity locally instead of using a bare name — and shows the
// "users sign what they own" path that the edge auth-gateway will enforce.
//
// Zero dependencies — node:crypto speaks secp256k1 natively.

import {
  generateKeyPairSync, createSign, createVerify, createPublicKey, createPrivateKey,
} from 'node:crypto';

const encode = (message) => (typeof message === 'string' ? message : JSON.stringify(message));

function toIdentity(privateKey) {
  const publicKeyHex = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('hex');
  return {
    publicKey: publicKeyHex,
    privateKey,
    sign(message) {
      return sign(privateKey, message);
    },
  };
}

export function newIdentity() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  return toIdentity(privateKey);
}

// Persist / restore a keypair — used by the test keyring (a "hosted" keypair
// store). In production a principal's key lives in their own wallet; this is only
// so tooling can act as a user by holding their key locally.
export function exportPrivateKeyPem(identity) {
  return identity.privateKey.export({ type: 'pkcs8', format: 'pem' });
}

export function identityFromPrivateKeyPem(pem) {
  return toIdentity(createPrivateKey(pem));
}

export function sign(privateKey, message) {
  const signer = createSign('SHA256');
  signer.update(encode(message));
  signer.end();
  return signer.sign(privateKey).toString('hex');
}

export function verify(publicKeyHex, message, signatureHex) {
  const key = createPublicKey({ key: Buffer.from(publicKeyHex, 'hex'), type: 'spki', format: 'der' });
  const verifier = createVerify('SHA256');
  verifier.update(encode(message));
  verifier.end();
  return verifier.verify(key, Buffer.from(signatureHex, 'hex'));
}
