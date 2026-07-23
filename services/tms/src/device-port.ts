// The TMS DEVICE PORT (Fork C, D116). Activation orchestration flows through
// this interface. Device identity and activation facts are IDENTICAL across
// adapter families (C6/T11 applied to devices): partner-mediated (CWD: their
// broker, portal, activation API) and direct-broker (a later vendor's firmware
// on AWS IoT Core). Both adapters are deferred (external-dependency-bound); the
// interface and the fact contract are built now.
export interface ActivationCommand {
  asgnId: string
  deviceRef: string
}
export interface ActivationResult {
  activatedAt: string
}
export interface DevicePort {
  activate(cmd: ActivationCommand): Promise<ActivationResult>
}

// The stubbed port. The CWD and AWS IoT families land behind this seam later.
export class UnwiredDevicePort implements DevicePort {
  activate(_cmd: ActivationCommand): Promise<ActivationResult> {
    return Promise.reject(new Error('device port not wired: CWD and AWS IoT adapters are deferred (Fork C)'))
  }
}
