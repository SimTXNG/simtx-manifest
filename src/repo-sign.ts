import * as openpgp from "openpgp";

// Fingerprint of the SimTX package-signing key
// (SimTX Package Signing <packages@simtx.net>). Repo metadata must be
// signed by this key; anything else fails startup validation.
export const EXPECTED_SIGNING_FPR = "18DDFED1FFF7FE5B0BFB20EDBF9413DA974E8B09";

export class SignError extends Error {}

// loadSigningKey parses the armored private key and asserts it is the
// expected key. Returns the key ready for signing (no passphrase: the
// repo key is generated without one for automation).
export async function loadSigningKey(
  armored: string,
  expectedFpr = EXPECTED_SIGNING_FPR,
) {
  let key;
  try {
    key = await openpgp.readPrivateKey({ armoredKey: armored.trim() });
  } catch (e) {
    throw new SignError(`signing key unparsable: ${(e as Error).message}`);
  }
  const fpr = key.getFingerprint().toUpperCase();
  if (fpr !== expectedFpr.toUpperCase()) {
    throw new SignError(
      `signing key fingerprint ${fpr} != expected ${expectedFpr}`,
    );
  }
  return key;
}

// clearSign returns the RFC4880 cleartext-signed message (InRelease).
export async function clearSign(
  key: Awaited<ReturnType<typeof loadSigningKey>>,
  text: string,
): Promise<string> {
  openpgp.config.preferredHashAlgorithm = openpgp.enums.hash.sha256;
  const message = await openpgp.createCleartextMessage({ text });
  return openpgp.sign({ message, signingKeys: key, format: "armored" });
}

// detachSign returns the armored detached signature (Release.gpg, *.db.sig).
export async function detachSign(
  key: Awaited<ReturnType<typeof loadSigningKey>>,
  data: string | Uint8Array,
): Promise<string> {
  openpgp.config.preferredHashAlgorithm = openpgp.enums.hash.sha256;
  // Non-stream inputs yield a plain armored string at runtime; the
  // overloads only model streams loosely, hence the cast.
  if (typeof data === "string") {
    const message = await openpgp.createMessage({ text: data });
    const signed = await openpgp.sign({ message, signingKeys: key, detached: true, format: "armored" });
    return signed as unknown as string;
  }
  const message = await openpgp.createMessage({ binary: data });
  const signed = await openpgp.sign({ message, signingKeys: key, detached: true, format: "armored" });
  return signed as unknown as string;
}
