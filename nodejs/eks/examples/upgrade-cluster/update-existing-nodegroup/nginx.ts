import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import * as input from "@pulumi/kubernetes/types/input";
import * as pulumi from "@pulumi/pulumi";
import * as nginxIngCntlr from "./nginx-ing-cntlr";

// Deploys the NGINX Ingress Controller Deployment.
export function createDeployment(
    name: string,
    replicas: pulumi.Input<number>,
    namespace: pulumi.Input<string>,
    labels: pulumi.Input<any>,
    cluster: eks.Cluster,
    nodeSelector: input.core.v1.PreferredSchedulingTerm[],
    ingressClass: pulumi.Input<string>,
): k8s.apps.v1.Deployment {

    // Define the Node affinity to target for the NGINX Deployment.
    const affinity: input.core.v1.Affinity = {
        // Target the Pods to run on nodes that match the labels for the node
        // selector.
        nodeAffinity: {
            preferredDuringSchedulingIgnoredDuringExecution: nodeSelector,
        },

        // Don't co-locate running Pods with matching labels on the same node,
        // key'd off the node hostname.
        podAntiAffinity: {
            requiredDuringSchedulingIgnoredDuringExecution: [
                {
                    topologyKey: "kubernetes.io/hostname",
                    labelSelector: {
                        matchExpressions: [
                            {
                                key: "app",
                                operator: "In",
                                values: [ name ],
                            },
                        ],
                    },
                },
            ],
        },
    };

    // Define the Pod tolerations of the tainted Nodes to target.
    const tolerations: input.core.v1.Toleration[] = [
        {
            key: "nginx",
            value: "true",
            effect: "NoSchedule",
        },
    ];

    // Deploy the NGINX Ingress Controller Deployment.
    const deployment = nginxIngCntlr.create(name,
        labels,
        cluster.provider,
        replicas,
        namespace,
        ingressClass,
        affinity,
        tolerations,
    );

    return deployment;
}

// Create a Service.
export function createService(
    name: string,
    provider: k8s.Provider,
    labels: pulumi.Input<any>,
    namespace: pulumi.Input<string>,
    svcType: pulumi.Input<string>,
    svcPorts: pulumi.Input<any>): k8s.core.v1.Service {
    return new k8s.core.v1.Service(
        name,
        {
            metadata: {
                name: "nginx-ing-cntlr",
                labels: labels,
                namespace: namespace,
                annotations: {
                    "service.beta.kubernetes.io/aws-load-balancer-type": "nlb",
                },
            },
            spec: {
                type: svcType,
                ports: svcPorts,
                selector: labels,
            },
        },
        {
            provider: provider,
        },
    );
}

