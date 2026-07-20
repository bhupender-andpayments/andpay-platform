import { AuthzError } from '@andpay/authz'

// The Identity/enrollment fact-read seam (S10, D121). Class-3 and class-6
// authentication resolve scope WITHOUT reading merchant Identity: class-3 from
// config-as-code role to permission-set, class-6 from the credential's own
// work-queue binding. This interface is the documented seam for class-1/2/4
// scope resolution, wired at Identity-min (step 5), NEVER a cross-context DB
// read (C4). It is not exercised in this slice.
export interface IdentityFactReader {
  merchantById(merchantId: string): Promise<never>
}

// The unwired stub: any call throws, proving the auth slice reads no merchant
// Identity store or fact (check 7).
export class UnwiredIdentityFactReader implements IdentityFactReader {
  async merchantById(_merchantId: string): Promise<never> {
    throw new AuthzError('identity-seam-not-wired')
  }
}
