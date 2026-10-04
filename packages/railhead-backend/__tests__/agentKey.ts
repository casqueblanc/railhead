// An agent's SSH key for tests that enroll and log in an agent: Ed25519 from WebCrypto, signing
// armored SSHSIG as `ssh-keygen -Y sign` does.

const enc = new TextEncoder();

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function str(bytes: Uint8Array | string): number[] {
  const raw = typeof bytes === "string" ? enc.encode(bytes) : bytes;
  return [...u32(raw.length), ...raw];
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** An Ed25519 SSH key that signs as `ssh-keygen -Y sign`. */
export class AgentKey {
  private constructor(
    readonly privateKey: CryptoKey,
    readonly blob: Uint8Array,
  ) {}

  static async create(): Promise<AgentKey> {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    if (!("privateKey" in pair)) throw new Error("Ed25519 generateKey returned a single key");
    const exported = await crypto.subtle.exportKey("raw", pair.publicKey);
    if (!(exported instanceof ArrayBuffer)) throw new Error("raw export is not bytes");
    const blob = Uint8Array.from([...str("ssh-ed25519"), ...str(new Uint8Array(exported))]);
    return new AgentKey(pair.privateKey, blob);
  }

  get publicKey(): string {
    return `ssh-ed25519 ${base64(this.blob)}`;
  }

  async sign(message: string, namespace = "railhead-auth"): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", enc.encode(message)));
    const signed = Uint8Array.from([
      ...enc.encode("SSHSIG"),
      ...str(namespace),
      ...str(""),
      ...str("sha512"),
      ...str(digest),
    ]);
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "Ed25519" }, this.privateKey, signed),
    );
    const sig = Uint8Array.from([
      ...enc.encode("SSHSIG"),
      ...u32(1),
      ...str(this.blob),
      ...str(namespace),
      ...str(""),
      ...str("sha512"),
      ...str(Uint8Array.from([...str("ssh-ed25519"), ...str(raw)])),
    ]);
    const lines = base64(sig).match(/.{1,70}/g) ?? [];
    return `-----BEGIN SSH SIGNATURE-----\n${lines.join("\n")}\n-----END SSH SIGNATURE-----\n`;
  }
}
