# Networking (VPC)

In this guide, we'll walk through various networking scenarios and how to work
through them to provision an AWS EKS cluster.

## Quick Links

* [Creating a new VPC](#creating-a-new-vpc)
    * [Examples](#new-vpc-examples)
* [Using an existing VPC](#using-an-existing-vpc)
    * [VPC Preflight Checklist](#vpc-preflight-checklist)
    * [Examples](#existing-vpc-examples)
    * [Notes & References](#notes--references)

## Creating a new VPC

This section demonstrates the default case of creating a *new* VPC,
and how to use it to create a new EKS cluster.

### <a name="new-vpc-examples">Examples</a>

#### Creating an EKS cluster in a new VPC's Public Subnets

```typescript
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";

// Create a new VPC.
const vpc = new awsx.Network("myVpc");

// Create a new EKS cluster.
// By default, EKS will places Workers in the public subnets of the new VPC.
const cluster = new eks.Cluster("myCluster", {
    vpcId: vpc.vpcId,
    subnetIds: vpc.subnetIds,
    desiredCapacity: 2,
    minSize: 1,
    maxSize: 2,
    storageClasses: "gp2",
    deployDashboard: false,
});

// Export the cluster kubeconfig.
export const kubeconfig = cluster.kubeconfig
```

## Using an existing VPC

This section demonstrates how to use an *existing* VPC to create a new
EKS cluster.

### VPC Preflight Checklist

Below is a preflight checklist of requirements and recommendations to
use an existing VPC with Pulumi and EKS.

See [notes & references](#notes--references) below for definitions and gotchas.

1. VPC
    * [Requirements](https://docs.aws.amazon.com/eks/latest/userguide/network_reqs.html)
        * Must have DNS hostname enabled.
        * Must have DNS resolution enabled.
1. Internet Gateway
    * [Recommendations](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Scenario2.html)
        * Attach an Internet Gateway to the VPC for Internet access.
1. NAT Gateway
    * [Recommendations](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Scenario2.html)
        * Attach a NAT Gateway to a public subnet so private subnet instances
          can route out to the Internet.
1. Subnets
    * [Requirements](https://docs.aws.amazon.com/eks/latest/userguide/network_reqs.html)
        * Subnets in at least 2 Availability Zones of the region (use of all region AZs is strongly recommended).
    * [Recommendations](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Scenario2.html)
        * Workers are in private subnets (strongly recommended).
        * Public subnets exist for NAT gateways.
        * Public subnets exist and are [tagged](https://docs.aws.amazon.com/eks/latest/userguide/network_reqs.html#vpc-subnet-tagging) for use with Kubernetes Public LoadBalancers.
        * Private subnets exist and are [tagged](https://docs.aws.amazon.com/eks/latest/userguide/network_reqs.html#vpc-subnet-tagging ) for use with Kubernetes Private LoadBalancers.

### <a name="existing-vpc-examples">Examples</a>

#### Create an EKS cluster in subnets of an existing VPC (specified by value)

```typescript
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";

// Create a new EKS cluster.
//
// The cluster's `subnetIds` are used by EKS to place the running
// worker instances in the listed subnets. These subnets can be public or private.
const cluster = new eks.Cluster("myCluster", {
    vpcId: "vpc-0c1d5365c16ce5118",
    subnetIds: ["subnet-086098b97f4156b23", "subnet-086098b97f4156b23", "subnet-06501cf86e7393712"],
    desiredCapacity: 2,
    minSize: 1,
    maxSize: 2,
    storageClasses: "gp2",
    deployDashboard: false,
});

// Export the cluster kubeconfig.
export const kubeconfig = cluster.kubeconfig
```

#### Create an EKS cluster in subnets of an existing VPC (specified by ref)

```typescript
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";

// Retrieve an existing VPC.
//
// Note: The `vpc` object is not required for the cluster configuration below
// as we're only referencing the `vpcId` and `subnetIds` props. However, retrieving
// a reference to the `vpc` can be useful to have, if needed.
//
// vpcId: the VPC ID.
// subnetIds: the private subnets of the VPC.
// usePrivateSubnets: true: run compute instances in private subnets | false: run instances in public subnets.
// securityGroupIds: the security group IDs of the VPC.
// publicSubnetIds: the public subnets of the VPC.
const vpc = awsx.Network.fromVpc("myExistingVpc",
    {
        vpcId: "vpc-0c1d5365c16ce5118",
        subnetIds: ["subnet-086098b97f4156b23", "subnet-086098b97f4156b23", "subnet-06501cf86e7393712"],
        usePrivateSubnets: true,
        securityGroupIds: ["sg-0afe2322759ba7c79"],
        publicSubnetIds: ["subnet-051b5f38f4c98cc8a", "subnet-01b38cf7cf7910494", "subnet-075ea3b86b7b97620"],
    }
);

// Create a new EKS cluster.
//
// The `cluster.subnetIds` are used by EKS to place the running worker
// instances in the specificed subnets. These subnets can be public or private.
//
// Here we chose to deploy the EKS workers into the private subnets of our
// existing VPC from above.
const cluster = new eks.Cluster("myCluster", {
    vpcId: vpc.vpcId,
    subnetIds: vpc.subnetIds,
    desiredCapacity: 2,
    minSize: 1,
    maxSize: 2,
    storageClasses: "gp2",
    deployDashboard: false,
});

// Export the cluster kubeconfig.
export const kubeconfig = cluster.kubeconfig
```

### Notes & References

* Public subnets automatically map a public IP on launch to
instances, and have an association with a route table that has
a default route to an Internet Gateway.
* Private subnets do not assign a public IP on launch to instances,
and have an association with a route table that has a default
route to a NAT Gateway in a public subnet.
* Subnets that are intended to be used with Private or Public LoadBalancers
  *must* be [appropriately tagged in AWS](https://docs.aws.amazon.com/eks/latest/userguide/network_reqs.html#vpc-subnet-tagging) with key: `kubernetes.io/cluster/${clusterName}` and value: `shared`, where `${clusterName}` is the name of the new EKS cluster once its been stood up by Pulumi.
  * [Issue](https://github.com/pulumi/pulumi-eks/issues/64): All subnets provided should be tagged automatically by `@pulumi/eks`. Currently, EKS only automatically tags the subnets used to deploy the workers into, public or private, and this only occurs *once* an instance has actually launched in the subnet, but not before.
      * **Short-term fix**: for any other public or private subnets, the user must appropriately tag the subets with the required tag for Kubernetes to discover and use the subnets for public and private Load Balancers.
      * Use cases of when a user needs other subnets to be tagged:
          * If workers are deployed in private subnets, the public subnets provided and needed for Public LoadBalancers are not currently automatically tagged, and Kubernetes has no means to discover them for usage.
          * Similarly, if this cluster with workers in private subnets wishes to use other private subnets for Private LoadBalancers, they too are not currently automatically tagged nor discoverable by Kubernetes.
