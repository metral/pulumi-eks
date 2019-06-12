// Copyright 2016-2019, Pulumi Corporation.
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import * as iam from "./iam";

// Create an EKS cluster with the default configuration.
const cluster1 = new eks.Cluster("myCluster");

// Export the cluster1 kubeconfig.
export const kubeconfig1 = cluster1.kubeconfig;

/*
// Create a NGINX Deployment that targets the cluster1 provider.
const appName = "nginx";
const appLabels = { appClass: appName };
const deployment = new k8s.apps.v1.Deployment(`${appName}-dep`,
    {
        metadata: { labels: appLabels },
        spec: {
            replicas: 2,
            selector: { matchLabels: appLabels },
            template: {
                metadata: { labels: appLabels },
                spec: {
                    containers: [{
                        name: appName,
                        image: "nginx",
                        ports: [{ name: "http", containerPort: 80 }],
                    }],
                },
            },
        },
    },
    {
        // Use the cluster1 custom provider for this object.
        provider: cluster1.provider,
    },
);

// Create a NGINX LoadBalancer typed Service.
const service = new k8s.core.v1.Service(`${appName}-svc`,
    {
        metadata: { labels: appLabels },
        spec: {
            type: "LoadBalancer",
            ports: [{ port: 80, targetPort: "http" }],
            selector: appLabels,
        },
    },
    {
        // Use the cluster1 custom provider for this object.
        provider: cluster1.provider,
    },
);

// Export the URL for the load balanced service.
export const url = service.status.loadBalancer.ingress[0].hostname;
*/
