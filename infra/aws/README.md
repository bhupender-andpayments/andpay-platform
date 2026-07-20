# Event backbone AWS infrastructure (CDK)

Config-as-code for the production event backbone: one AWS MSK (Kafka) cluster and
the AWS Glue Schema Registry, pinned to India regions (S6). This is the
production target behind the swappable `PublisherPort` and schema-registry port
(C6, Decision 120). Local dev uses Redpanda instead (see
`infra/docker-compose.dev.yml`); the application code is identical, only the
client config differs.

This project is a STANDALONE pnpm root (its own `pnpm-workspace.yaml` and
`pnpm-lock.yaml`), deliberately isolated from the repo-root workspace so the
heavy, deploy-only `aws-cdk-lib` toolchain never bloats the main `pnpm install`
or CI. Run all pnpm commands from THIS directory. Claude Code never runs AWS
commands; apply this yourself.

## What it creates

- MSK cluster (`andpay-backbone-primary`), Kafka 3.6, 3 brokers, TLS in transit
  and in cluster, IAM auth plus mutual TLS, no unauthenticated access (S4, S11,
  S12).
- Glue Schema Registry with the fact schemas as JSON at FULL compatibility
  (Decision 120, E3).
- A residency guard: the stack throws unless the region is `ap-south-1` or
  `ap-south-2` (S6, policy-as-code).

## Deploy

```
cd infra/aws
pnpm install          # standalone (this dir is its own pnpm root)
pnpm exec cdk synth   # renders the CloudFormation; ResidencyRegion output shows ap-south-1 (no AWS calls)
pnpm exec cdk deploy --all  # requires AWS credentials; deploys primary (ap-south-1) and DR (ap-south-2)
```

Verify residency (acceptance check 7), on your machine with AWS access:

```
aws kafka list-clusters --region ap-south-1
aws glue list-registries --region ap-south-1
# both must return the andpay-backbone resources; neither must appear outside India
```

## Deferred / applied separately (config-as-code, S23)

- Kafka topic creation on MSK: apply the topic definitions (see
  `packages/bus` SOUNDBOX_TOPICS and `lib/topics.ts`) with the idempotent
  provisioning step against the cluster, never a runtime call.
- Broker ACLs: generated single-source from the S11 allowlist and applied as IAM
  policies (kafka-cluster actions scoped per workload) or Kafka ACLs, CODEOWNERS
  gated. The mesh does authN and coarse reachability only; the grant is never
  encoded in the mesh.
- Encryption-at-rest CMK, SPIRE/SVID trust store, and the multi-region KMS key
  are on the DR-readiness checklist (decision 79) and pinned at deploy.
