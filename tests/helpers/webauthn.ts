import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { env } from '../../src/lib/env';

const b64 = (b: Buffer) => b.toString('base64url');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();
const text = (s: string) => Buffer.concat([Buffer.from([0x60 + s.length]), Buffer.from(s)]);
const bytes = (b: Buffer) => Buffer.concat([Buffer.from([0x58, b.length]), b]);

/** A software authenticator: ES256 key pair, `none` attestation, user verification always on. */
export class FakeAuthenticator {
  readonly credentialId = randomBytes(32);
  readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  counter = 0;
  constructor(
    private readonly origin: string,
    private readonly multiDevice = false,
  ) {}

  private get rpIdHash(): Buffer {
    return sha256(env().WEBAUTHN_RP_ID);
  }
  get id(): string {
    return b64(this.credentialId);
  }

  private coseKey(): Buffer {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    const x = Buffer.from(jwk.x!, 'base64url');
    const y = Buffer.from(jwk.y!, 'base64url');
    return Buffer.concat([
      Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21]),
      bytes(x),
      Buffer.from([0x22]),
      bytes(y),
    ]);
  }

  private flags(attested: boolean): number {
    return 0x01 | 0x04 | (attested ? 0x40 : 0) | (this.multiDevice ? 0x08 | 0x10 : 0);
  }

  private authData(attested: boolean): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const head = Buffer.concat([this.rpIdHash, Buffer.from([this.flags(attested)]), counter]);
    if (!attested) return head;
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.credentialId.length);
    return Buffer.concat([head, Buffer.alloc(16), len, this.credentialId, this.coseKey()]);
  }

  /** `RegistrationResponseJSON` for a challenge from the registration options. */
  register(challenge: string, o: { origin?: string } = {}) {
    const authData = this.authData(true);
    const attestation = Buffer.concat([
      Buffer.from([0xa3]),
      text('fmt'),
      text('none'),
      text('attStmt'),
      Buffer.from([0xa0]),
      text('authData'),
      bytes(authData),
    ]);
    const clientData = JSON.stringify({
      type: 'webauthn.create',
      challenge,
      origin: o.origin ?? this.origin,
      crossOrigin: false,
    });
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64(Buffer.from(clientData)),
        attestationObject: b64(attestation),
        transports: ['internal', 'hybrid'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** `AuthenticationResponseJSON`; the counter goes up by one unless `counter` is given. */
  assert(challenge: string, o: { origin?: string; counter?: number; tamper?: boolean } = {}) {
    this.counter = o.counter ?? this.counter + 1;
    const authData = this.authData(false);
    const clientData = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge,
        origin: o.origin ?? this.origin,
        crossOrigin: false,
      }),
    );
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.keys.privateKey);
    if (o.tamper) signature[signature.length - 1] ^= 0xff;
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64(clientData),
        authenticatorData: b64(authData),
        signature: b64(signature),
        userHandle: b64(Buffer.from('1')),
      },
      clientExtensionResults: {},
    };
  }
}
