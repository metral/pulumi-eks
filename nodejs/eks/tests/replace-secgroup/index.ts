import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";
import * as pulumi from "@pulumi/pulumi";
import * as iam from "./iam";
import * as secgroup from "./securitygroup";

const projectName = pulumi.getProject();

// Create an EKS cluster with non-default configuration
const role = iam.createRole(`${projectName}-role`);
const instanceProfile = new aws.iam.InstanceProfile(`${projectName}-instanceProfile`, {role: role});
const vpc = new awsx.Network(`${projectName}-vpc`, { usePrivateSubnets: true });
const testCluster = new eks.Cluster(`${projectName}`, {
    skipDefaultNodeGroup: true,
    instanceRole: role,
    vpcId: vpc.vpcId,
    subnetIds: vpc.subnetIds,
    deployDashboard: true,
});

// Create an external nodeSecurityGroup for the NodeGroup and set up its rules.
const secgroupName = `${projectName}-extNodeSecurityGroup`;
const nodeSecurityGroup = secgroup.createNodeGroupSecurityGroup(secgroupName, {
    vpcId: vpc.vpcId,
    clusterSecurityGroup: testCluster.clusterSecurityGroup,
    eksCluster: testCluster.core.cluster,
}, testCluster);
const eksClusterIngressRule = new aws.ec2.SecurityGroupRule(`${secgroupName}-eksClusterIngressRule`, {
    description: "Allow pods to communicate with the cluster API Server",
    type: "ingress",
    fromPort: 443,
    toPort: 443,
    protocol: "tcp",
    securityGroupId: testCluster.clusterSecurityGroup.id,
    sourceSecurityGroupId: nodeSecurityGroup.id,
}, { parent: testCluster });

// Create the second node group using a spot price instance and resource tags.
const spot = new eks.NodeGroup(`${projectName}-ng-tags-spot`, {
    cluster: testCluster,
    instanceType: "t2.medium",
    desiredCapacity: 2,
    nodeSecurityGroup: nodeSecurityGroup,
    clusterIngressRule: eksClusterIngressRule,
    minSize: 1,
    maxSize: 3,
    spotPrice: "1",
    instanceProfile: instanceProfile,
    labels: {"preemptible": "true"},
}, {
    providers: { kubernetes: testCluster.provider},
});

// Export the cluster kubeconfig.
export const kubeconfig = testCluster.kubeconfig;
