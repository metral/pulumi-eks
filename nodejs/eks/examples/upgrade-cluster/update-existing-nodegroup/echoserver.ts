import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import * as input from "@pulumi/kubernetes/types/input";
import * as pulumi from "@pulumi/pulumi";

// Create a k8s-demo Ingress
export function createIngress(
    name: string,
    provider: k8s.Provider,
    labels: pulumi.Input<any>,
    namespace: pulumi.Input<string>,
    ingressClass: pulumi.Input<string>,
    serviceName: pulumi.Input<string>,
): k8s.extensions.v1beta1.Ingress {
    return new k8s.extensions.v1beta1.Ingress(name, {
        metadata: {
            labels: labels,
            namespace: namespace,
            annotations: {
                "kubernetes.io/ingress.class": ingressClass,
            },
        },
        spec: {
            rules: [
                {
                    host: "apps.example.com",
                    http: {
                        paths: [
                            {
                                path: "/echoserver",
                                backend: {
                                    serviceName: serviceName,
                                    servicePort: "http",
                                },
                            },
                        ],
                    },
                },
            ],
        },
    });
}

// Create a Service.
export function createService(
    name: string,
    provider: k8s.Provider,
    labels: pulumi.Input<any>,
    namespace: pulumi.Input<string>,
    serviceType: pulumi.Input<string>,
    servicePorts: pulumi.Input<any>): k8s.core.v1.Service {
    return new k8s.core.v1.Service(
        name,
        {
            metadata: {
                name: name,
                labels: labels,
                namespace: namespace,
            },
            spec: {
                type: serviceType,
                ports: servicePorts,
                selector: labels,
            },
        },
        {
            provider: provider,
        },
    );
}

// Create the Deployment
export function createDeployment(
    name: string,
    replicas: pulumi.Input<number>,
    namespace: pulumi.Input<string>,
    labels: pulumi.Input<any>,
    provider: k8s.Provider,
): k8s.apps.v1.Deployment {
    return new k8s.apps.v1.Deployment(name,
        {
            metadata: {
                labels: labels,
                namespace: namespace,
            },
            spec: {
                replicas: replicas,
                selector: { matchLabels: labels },
                template: {
                    metadata: { labels: labels, namespace: namespace },
                    spec: {
                        restartPolicy: "Always",
                        containers: [
                            {
                                name: name,
                                image: "gcr.io/google-containers/echoserver:1.5",
                                ports: [{ name: "http", containerPort: 8080 }],
                            },
                        ],
                    },
                },
            },
        },
        {
            provider: provider,
        },
    );
}

