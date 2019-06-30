import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import * as input from "@pulumi/kubernetes/types/input";
import * as pulumi from "@pulumi/pulumi";
import * as echoserver from "./echoserver";
import * as iam from "./iam";
import * as nginx from "./nginx";
import * as nginxIngCntlr from "./nginx-ing-cntlr";
import * as utils from "./utils";

const projectName = pulumi.getProject();

// Define tags to use on the cluster and any taggable resource under management.
const tags = { "project": "PulumiEKSUpgrade", "org": "KubeTeam" };

/*
 * Set up Networking and IAM.
 */

// Allocate a new VPC with custom settings, and a public & private subnet per AZ.
const vpc = new awsx.ec2.Vpc(`${projectName}`, {
    cidrBlock: "172.16.0.0/16",
    numberOfAvailabilityZones: "all",
    subnets: [
        { type: "public", tags: tags },
        { type: "private", tags: tags },
    ],
});

// Export VPC ID and Subnets.
export const vpcId = vpc.id;
export const allVpcSubnets = vpc.privateSubnetIds.concat(vpc.publicSubnetIds);

// Create 3 IAM Roles and InstanceProfiles to use on each of the 3 nodegroups.
export const roles = iam.createRoles(projectName, 3);
export const instanceProfiles = iam.createInstanceProfiles(projectName, roles);

/*
 * Create the EKS cluster.
 */

// Create an EKS cluster with no default node group, IAM roles for two node groups
// logging, private subnets for the nodegroup workers, and resource tags.
const myCluster = new eks.Cluster(`${projectName}`, {
    version: "1.13",
    vpcId: vpcId,
    subnetIds: allVpcSubnets,
    nodeAssociatePublicIpAddress: false,
    skipDefaultNodeGroup: true,
    deployDashboard: false,
    instanceRoles: roles,
    enabledClusterLogTypes: [
        "api",
        "audit",
        "authenticator",
        "controllerManager",
        "scheduler",
    ],
    tags: tags,
    clusterSecurityGroupTags: { "myClusterSecurityGroupTag": "true" },
    nodeSecurityGroupTags: { "myNodeSecurityGroupTag": "true" },
});

// Export the cluster's kubeconfig.
export const kubeconfig = myCluster.kubeconfig;

/*
 * Create various Node Groups in the EKS cluster.
 */

// Create a standard node group of t2.medium workers.
const ngStandard = utils.createNodeGroup(`${projectName}-ng-standard`,
    "ami-0e8d353285e26a68c", // k8s v1.12.7
    "t2.medium",
    3,
    myCluster,
    instanceProfiles[0],
);

// Create a 2xlarge node group of t3.2xlarge workers, with taints on the nodes.
// This allows us to dedicate the node group tothe NGINX Ingress Controller,
// which must tolerate the nodes to run on them.
const ng2xlarge = utils.createNodeGroup(`${projectName}-ng-2xlarge`,
    "ami-0e8d353285e26a68c", // k8s v1.12.7
    "t3.2xlarge",
    3,
    myCluster,
    instanceProfiles[1],
    {"nginx": { value: "true", effect: "NoSchedule"}},
);
