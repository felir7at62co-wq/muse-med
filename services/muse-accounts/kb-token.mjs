// Machine credentials for the cloud knowledge base.
//
// These are deliberately separate from the model-relay token: relay tokens are
// injected into editor containers at creation time, so changing that derivation
// would break every running workroom. This module keeps its own secret and its
// own prefix, and binds each token to the account revision so a password reset,
// administrator reset or account disable retires the token with no stored state.
import {createHmac, timingSafeEqual} from 'node:crypto';

const ID = /^[a-f0-9]{16}$/;
const TOKEN = /^[a-f0-9]{16}\.[a-f0-9]{64}$/;

export function kbToken(secret, id, revision) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Knowledge base secret must be at least 32 characters');
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid account id');
  if (!Number.isSafeInteger(revision)) throw new Error('Invalid account revision');
  return `${id}.${createHmac('sha256', secret).update(`kb.${id}.${revision}`).digest('hex')}`;
}

/** @returns the verified account id, or null when the token is unusable. */
export function verifyKbToken(secret, token, accounts) {
  if (typeof secret !== 'string' || secret.length < 32) return null;
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  const id = token.slice(0, 16);
  const account = accounts?.get?.(id);
  if (!account || account.disabled) return null;
  const expected = Buffer.from(kbToken(secret, id, account.revision));
  const presented = Buffer.from(token);
  if (expected.length !== presented.length) return null;
  return timingSafeEqual(expected, presented) ? id : null;
}
