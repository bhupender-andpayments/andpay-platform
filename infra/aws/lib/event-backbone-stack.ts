import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as msk from 'aws-cdk-lib/aws-msk'
import * as glue from 'aws-cdk-lib/aws-glue'
import { FACT_SCHEMAS } from './topics'

export interface EventBackboneStackProps extends StackProps {
  isDr: boolean
}

/**
 * The event backbone infrastructure: one MSK (Kafka) cluster and the Glue Schema
 * Registry, pinned to an India region (S6). MSK is the production target behind
 * the swappable PublisherPort; Glue behind the swappable schema-registry port
 * (Decision 120). This is config-as-code, CODEOWNERS-gated, CI-deployed (S23);
 * nothing is created by a runtime control-plane call.
 */
export class EventBackboneStack extends Stack {
  constructor(scope: Construct, id: string, props: EventBackboneStackProps) {
    super(scope, id, props)

    // Residency guard as policy-as-code (S6): the backbone lives only in India.
    const region = props.env?.region
    if (region !== 'ap-south-1' && region !== 'ap-south-2') {
      throw new Error(
        `residency violation (S6): region ${String(region)} is not an India region (ap-south-1 primary, ap-south-2 DR)`,
      )
    }

    const vpc = new ec2.Vpc(this, 'BackboneVpc', {
      maxAzs: 3,
      natGateways: props.isDr ? 0 : 1,
    })

    const brokerSg = new ec2.SecurityGroup(this, 'MskBrokerSg', {
      vpc,
      description: 'AndPayments MSK broker security group',
      allowAllOutbound: true,
    })

    const cluster = new msk.CfnCluster(this, 'MskCluster', {
      clusterName: `andpay-backbone-${props.isDr ? 'dr' : 'primary'}`,
      kafkaVersion: '3.6.0',
      numberOfBrokerNodes: 3,
      brokerNodeGroupInfo: {
        instanceType: 'kafka.m5.large',
        clientSubnets: vpc.privateSubnets.map((s) => s.subnetId),
        securityGroups: [brokerSg.securityGroupId],
        storageInfo: { ebsStorageInfo: { volumeSize: 100 } },
      },
      encryptionInfo: {
        // Encryption in transit (client-broker TLS) and in cluster (S4).
        encryptionInTransit: { clientBroker: 'TLS', inCluster: true },
        // Encryption at rest uses an AWS-managed key by default; pin a CMK in prod.
      },
      clientAuthentication: {
        // IAM auth and mutual TLS (SPIFFE-style SVIDs), zero-trust: no anonymous
        // access (S11, S12). Broker ACLs are generated single-source from the
        // allowlist and applied out of band (S11, S23), see README.
        sasl: { iam: { enabled: true } },
        tls: { enabled: true },
        unauthenticated: { enabled: false },
      },
    })

    // Glue Schema Registry (Decision 120): JSON Schemas at FULL compatibility.
    const registry = new glue.CfnRegistry(this, 'SchemaRegistry', {
      name: `andpay-backbone-${props.isDr ? 'dr' : 'primary'}`,
      description: 'AndPayments event backbone schemas (JSON, FULL compatibility)',
    })

    for (const fact of FACT_SCHEMAS) {
      new glue.CfnSchema(this, `Schema-${fact.name}`, {
        registry: { arn: registry.attrArn },
        name: fact.name,
        dataFormat: 'JSON',
        compatibility: 'FULL',
        schemaDefinition: JSON.stringify(fact.schema),
      })
    }

    new CfnOutput(this, 'ResidencyRegion', { value: this.region })
    new CfnOutput(this, 'MskClusterArn', { value: cluster.attrArn })
    new CfnOutput(this, 'SchemaRegistryArn', { value: registry.attrArn })
  }
}
