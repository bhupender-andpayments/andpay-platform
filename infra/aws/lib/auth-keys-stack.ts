import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'

/**
 * The Auth key material (handoff spec 04), config-as-code, CODEOWNERS-gated,
 * CI-deployed (S23); nothing is created by a runtime control-plane call.
 * Deployed out of band by the owner (Claude Code runs no AWS command).
 *
 * Two custodied secrets, both India-resident (S6):
 *  - the Decision-3 access-token ES256 signing key (16.3), a MULTI-REGION KMS key
 *    (Decision 79) so the same key id survives regional failover (ap-south-1
 *    primary, ap-south-2 replica). Issuance calls Sign off the hot path;
 *    verifiers hold only the JWKS public key and never call KMS (T4).
 *  - the 5c pepper for the class-6 credential HMAC, in Secrets Manager,
 *    replicated to the DR region, never in code, config, logs, or events (S4).
 */
export class AuthKeysStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props)

    // Residency guard as policy-as-code (S6): auth key material lives only in India.
    const region = props.env?.region
    if (region !== 'ap-south-1' && region !== 'ap-south-2') {
      throw new Error(
        `residency violation (S6): region ${String(region)} is not an India region (ap-south-1 primary, ap-south-2 DR)`,
      )
    }

    const signingKey = new kms.CfnKey(this, 'D3SigningKey', {
      description: 'AndPayments D3 access-token ES256 signing key (16.3, Decision 79 multi-region)',
      keySpec: 'ECC_NIST_P256',
      keyUsage: 'SIGN_VERIFY',
      multiRegion: true,
    })

    const pepper = new secretsmanager.CfnSecret(this, 'ClassSixPepper', {
      description: 'AndPayments class-6 credential HMAC pepper (5c)',
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
      },
      // Replicate to the DR region so both planes are India-resident (S6).
      replicaRegions: [{ region: 'ap-south-2' }],
    })

    new CfnOutput(this, 'ResidencyRegion', { value: this.region })
    new CfnOutput(this, 'D3SigningKeyId', { value: signingKey.attrKeyId })
    new CfnOutput(this, 'ClassSixPepperArn', { value: pepper.ref })
  }
}
