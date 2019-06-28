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

/*
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
*/

// Create a 4xlarge node group of c5.4xlarge workers, with similar taints on
// the nodes as the 2xlarge nodegroup. This new  node group will be used to
// migrate the Pods in the 2xlarge node group over to 4xlarge instance types.
const ng4xAmiId = "ami-0e8d353285e26a68c"; // v1.12.7
const ng4xlarge = new eks.NodeGroup(`${projectName}-ng-ondemand-4xlarge`, {
    cluster: myCluster,
    nodeSecurityGroup: myCluster.nodeSecurityGroup,
    clusterIngressRule: myCluster.eksClusterIngressRule,
    instanceType: "c5.4xlarge",
    amiId: ng4xAmiId,
    desiredCapacity: 6,
    minSize: 6,
    maxSize: 10,
    instanceProfile: instanceProfile1,
    labels: {"ondemand": "true", "amiId": ng4xAmiId},
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
const nginxServicePorts = [{port: 80, protocol: "TCP", targetPort: "http"}];
const nginxService = nginx.createService("nginx-ing-cntlr", myCluster.provider, { app: "nginx-v2" },
    namespaceName, "LoadBalancer", nginxServicePorts);
export const nginxServiceUrl = nginxService.status.loadBalancer.ingress[0].hostname;

/*
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
const nginxDeployment1 = nginx.createDeployment(nginxName1, 3, namespaceName, {app: nginxName1},
    myCluster, nodeSelector1, nginxName1);
*/

/*
 * Deploy v1 of the Workload.
 */

/*
const workloadName1 = "echoserver-v1";
const workloadServicePorts = [{port: 80, protocol: "TCP", targetPort: "http"}];

// Create v1 of the the Workload Service with an Ingress class for v1 of NGINX.
const workloadService1 = echoserver.createService(workloadName1, myCluster.provider, { app: workloadName1 },
    namespaceName, "ClusterIP", workloadServicePorts);
const workloadService1Name = workloadService1.metadata.apply(m => m.name);

// Deploy v1 of the Workload (echoserver) in the general, standard nodegroup.
const workloadDeployment1 = echoserver.createDeployment(workloadName1, 3, namespaceName, {app: workloadName1},
    myCluster.provider);

// Create v1 of the Workload Ingress.
const workloadIngress = echoserver.createIngress(workloadName1, myCluster.provider, {app: workloadName1}, namespaceName, "nginx-v1", workloadService1Name);
*/

/*
 * Deploy v2 of the NGINX Ingress Controller.
 */

// Deploy v2 of the NGINX Ingress Controller, preferably on c5.4xlarge workers.
const nginxName2 = "nginx-v2";
const nodeSelector2: input.core.v1.PreferredSchedulingTerm[] = [
    {
        weight: 100,
        preference: {
            matchExpressions: [
                { key: "beta.kubernetes.io/instance-type", operator: "In", values: [ "c5.4xlarge" ]},
            ],
        },
    },
];
const nginxDeployment2 = nginx.createDeployment(nginxName2, 3, namespaceName, {app: nginxName2},
    myCluster, nodeSelector2, nginxName2);

/*
 * Deploy v2 of the Workload.
 */

const workloadName2 = "echoserver-v2";
const workloadServicePorts2 = [{port: 80, protocol: "TCP", targetPort: "http"}];

// Create v2 of the the Workload Service with an Ingress class for v2 of NGINX.
const workloadService2 = echoserver.createService(workloadName2, myCluster.provider, { app: workloadName2 },
    namespaceName, "ClusterIP", workloadServicePorts2);
const workloadService2Name = workloadService2.metadata.apply(m => m.name);

// Deploy v2 of the Workload (echoserver) in the general, standard nodegroup.
const workloadDeployment2 = echoserver.createDeployment(workloadName2, 3, namespaceName, {app: workloadName2},
    myCluster.provider);

// Create v2 of the Workload Ingress.
const workloadIngress2 = echoserver.createIngress(workloadName2, myCluster.provider, {app: workloadName2}, namespaceName, "nginx-v2", workloadService2Name);
