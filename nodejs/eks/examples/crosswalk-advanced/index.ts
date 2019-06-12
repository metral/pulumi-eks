// Copyright 2016-2019, Pulumi Corporation.
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import * as iam from "./iam";

/*
 * VPC
 */
// Create a vpc with non-default config.
const vpc = new awsx.ec2.Vpc("myVpc", {
    cidrBlock: "192.168.0.0/16",
    enableDnsHostnames: true,
    enableDnsSupport: true,
});

/*
 * IAM
 */
// Create an IAM role and instanceProfile to use with the Cluster & NodeGroup.
const role = iam.createRole("myRole");
const instanceProfile = new aws.iam.InstanceProfile("myInstanceProfile", {role: role});

/*
 * EKS Cluster with non-default config & settings.
 */
const cluster2 = new eks.Cluster("myAdvancedCluster", {
    vpcId: vpc.id,
    subnetIds: vpc.publicSubnetIds,
    desiredCapacity: 2,
    minSize: 2,
    maxSize: 2,
    deployDashboard: false,
    enabledClusterLogTypes: [
        "api",
        "audit",
        "authenticator",
    ],
    tags: {
        "project": "foo",
        "org": "bar",
    },
    clusterSecurityGroupTags: { "myClusterSecurityGroupTag": "true" },
    nodeSecurityGroupTags: { "myNodeSecurityGroupTag": "true" },
});

// Create a spot instance NodeGroup in cluster2.
const spot = new eks.NodeGroup("example-nodegroup-spot", {
    cluster: cluster2,
    instanceType: "t2.medium",
    spotPrice: "1",
    labels: {"preemptible": "true"},
    taints: {
        "special": {
            value: "true",
            effect: "NoSchedule",
        },
    },
    instanceProfile: instanceProfile,
    autoScalingGroupTags: cluster2.core.cluster.name.apply(clusterName => ({
        "myAutoScalingGroupTag": "true",
        "k8s.io/cluster-autoscaler/enabled": "true",
        [`k8s.io/cluster-autoscaler/${clusterName}`]: "true",
    })),
    cloudFormationTags: { "myCloudFormationTag": "true" },
}, {
    providers: { kubernetes: cluster2.provider},
});

// Export the cluster2 kubeconfig.
export const kubeconfig2 = cluster2.kubeconfig;

// /*
//  * Deploy NGINX Deployment & LB-typed Service
//  */
// // Create a NGINX Deployment that targets the cluster2 provider.
// const appName = "nginx";
// const appLabels = { appClass: appName };
// const deployment = new k8s.apps.v1.Deployment(`${appName}-dep`,
//     {
//         metadata: { labels: appLabels },
//         spec: {
//             replicas: 2,
//             selector: { matchLabels: appLabels },
//             template: {
//                 metadata: { labels: appLabels },
//                 spec: {
//                     containers: [{
//                         name: appName,
//                         image: "nginx",
//                         ports: [{ name: "http", containerPort: 80 }],
//                     }],
//                 },
//             },
//         },
//     },
//     {
//         // Use the cluster2 custom provider for this object.
//         provider: cluster2.provider,
//     },
// );
//
// // Create a NGINX LoadBalancer typed Service.
// const service = new k8s.core.v1.Service(`${appName}-svc`,
//     {
//         metadata: { labels: appLabels },
//         spec: {
//             type: "LoadBalancer",
//             ports: [{ port: 80, targetPort: "http" }],
//             selector: appLabels,
//         },
//     },
//     {
//         // Use the cluster2 custom provider for this object.
//         provider: cluster2.provider,
//     },
// );
//
// // Export the URL for the load balanced service.
// export const url = service.status.loadBalancer.ingress[0].hostname;
