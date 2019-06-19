import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import * as input from "@pulumi/kubernetes/types/input";
import * as pulumi from "@pulumi/pulumi";
import * as iam from "./iam";
import * as nginx from "./nginx";
import * as nginxIngCntlr from "./nginx-ing-cntlr";

const projectName = pulumi.getProject();

// Define tags to use on the cluster and any taggable resource under management.
const tags = { "project": "PulumiEKSUpgrade", "org": "KubeTeam" };

// Allocate a new VPC with a public and private subnet per AZ.
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

// Create IAM Roles and InstanceProfiles to use on each of the two nodegroups.
const role0 = iam.createRole(`${projectName}-role0`);
const role1 = iam.createRole(`${projectName}-role1`);
const instanceProfile0 = new aws.iam.InstanceProfile(`${projectName}-instanceProfile0`, {role: role0});
const instanceProfile1 = new aws.iam.InstanceProfile(`${projectName}-instanceProfile1`, {role: role1});

/*
 * Create the EKS Cluster
 */

// Create an EKS cluster with no default node group, IAM roles for two node groups
// logging, private subnets for the nodegroup workers, and resource tags.
const myCluster = new eks.Cluster(`${projectName}`, {
    version: "1.12",
    vpcId: vpcId,
    subnetIds: allVpcSubnets,
    nodeAssociatePublicIpAddress: false,
    skipDefaultNodeGroup: true,
    deployDashboard: false,
    instanceRoles: [role0, role1],
    enabledClusterLogTypes: [
        "api",
        "audit",
        "authenticator",
    ],
    tags: tags,
    clusterSecurityGroupTags: { "myClusterSecurityGroupTag": "true" },
    nodeSecurityGroupTags: { "myNodeSecurityGroupTag": "true" },
});

// Export the cluster's kubeconfig.
export const kubeconfig1 = myCluster.kubeconfig;

/*
 * Create two starting nodegroups with different instance types: standard &
 * 2xlarge.
 */

// Create a standard node group of t2.medium workers, with labels & resource tags,
// in the cluster's security group.
const stdAmiId = "ami-088dad958fbfa643e"; // v1.11.9
const ngStandard = new eks.NodeGroup(`${projectName}-ng-ondemand-standard`, {
    cluster: myCluster,
    nodeSecurityGroup: myCluster.nodeSecurityGroup,
    clusterIngressRule: myCluster.eksClusterIngressRule,
    instanceType: "t2.medium",
    amiId: stdAmiId,
    desiredCapacity: 2,
    minSize: 2,
    maxSize: 10,
    instanceProfile: instanceProfile0,
    labels: {"ondemand": "true", "amiId": stdAmiId},
    cloudFormationTags: { "myCloudFormationTag": "true" },
    // Example tags if we were to run cluster-autoscaler: https://git.io/fjwWc
    autoScalingGroupTags: myCluster.core.cluster.name.apply(clusterName => ({
        "k8s.io/cluster-autoscaler/enabled": "true",
        [`k8s.io/cluster-autoscaler/${clusterName}`]: "true",
    })),
}, {
    providers: { kubernetes: myCluster.provider},
});

// Create a 2xlarge node group of t3.2xlarge workers, with taints on the nodes.
// This allows us to dedicate the node group entirely to a particular set of
// Pods (e.g. NGINX ingress controller) that must tolerate the nodes to be able
// to run on them.
const ng2xAmiId = "ami-088dad958fbfa643e"; // v1.11.9
const ng2xlarge = new eks.NodeGroup(`${projectName}-ng-ondemand-2xlarge`, {
    cluster: myCluster,
    nodeSecurityGroup: myCluster.nodeSecurityGroup,
    clusterIngressRule: myCluster.eksClusterIngressRule,
    instanceType: "t3.2xlarge",
    amiId: ng2xAmiId,
    desiredCapacity: 3,
    minSize: 3,
    maxSize: 10,
    instanceProfile: instanceProfile1,
    labels: {"ondemand": "true", "amiId": ng2xAmiId},
    taints: {
        "nginx": {
            value: "true",
            effect: "NoSchedule",
        },
    },
    // Example tags if we were to run cluster-autoscaler: https://git.io/fjwWc
    autoScalingGroupTags: myCluster.core.cluster.name.apply(clusterName => ({
        "k8s.io/cluster-autoscaler/enabled": "true",
        [`k8s.io/cluster-autoscaler/${clusterName}`]: "true",
    })),
    cloudFormationTags: { "myOtherCloudFormationTag": "true" },
}, {
    providers: { kubernetes: myCluster.provider},
});

/*
 * Deploy the NGINX Ingress Controller
 */

// Create a Namespace.
const namespace = new k8s.core.v1.Namespace( "apps", undefined, { provider: myCluster.provider });
const namespaceName = namespace.metadata.apply(m => m.name);

// Create the Service.
const svcType = "LoadBalancer";
const svcPorts = [{port: 80, protocol: "TCP", targetPort: "http"}];
const serviceName = "nginx-ing-cntlr";
const labels = { app: "nginx-v1" };
const service = nginx.createService(serviceName, myCluster.provider, labels,
    namespaceName, svcType, svcPorts);
export const nginxServiceUrl = service.status.loadBalancer.ingress[0].hostname;

// Deploy v1 of the NGINX Ingress Controller, preferably on t3.2xlarge workers.
const nginxName1 = "nginx-v1";
const nodeSelector1: input.core.v1.PreferredSchedulingTerm[] = [
    {
        weight: 100,
        preference: {
            matchExpressions: [
                { key: "beta.kubernetes.io/instance-type", operator: "In", values: [ "t3.2xlarge" ]},
            ],
        },
    },
];
const nginxDeployment1 = nginx.createDeployment(nginxName1, namespaceName, {app: nginxName1},
    myCluster, nodeSelector1, nginxName1);
