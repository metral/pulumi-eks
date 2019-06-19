import * as k8s from "@pulumi/kubernetes";
import * as input from "@pulumi/kubernetes/types/input";
import * as pulumi from "@pulumi/pulumi";
import * as rbac from "./nginx-ing-cntlr-rbac";

export function create(
    name: string,
    labels: pulumi.Input<any>,
    provider: k8s.Provider,
    replicas: pulumi.Input<number>,
    namespace: pulumi.Input<string>,
    ingressClass: pulumi.Input<string>,
    affinity: input.core.v1.Affinity,
    tolerations: input.core.v1.Toleration[],
): k8s.apps.v1.Deployment {

    const defaultHttpBackendName = "nginx-default-http-backend";

    // ServiceAccount.
    const serviceAccount = rbac.makeNginxServiceAccount(
        name, provider, namespace);
    const serviceAccountName = serviceAccount.metadata.apply(m => m.name);

    // RBAC ClusterRole & Role.
    const clusterRole = rbac.makeNginxClusterRole(
        name, provider);
    const clusterRoleName = clusterRole.metadata.apply(m => m.name);
    const clusterRoleBinding = rbac.makeNginxClusterRoleBinding(
        name, provider, namespace,
        serviceAccountName, clusterRoleName);

    const role = rbac.makeNginxRole(
        name, provider, namespace, ingressClass);
    const roleName = role.metadata.apply(m => m.name);
    const roleBinding = rbac.makeNginxRoleBinding(
        name, provider, namespace,
        serviceAccountName, roleName);

    // Custom Headers ConfigMap.
    const headersConfigMap = makeHeadersConfigMap(name, provider, labels, namespace);
    const headersConfigMapName = headersConfigMap.metadata.apply(m => m.name);

    // NGINX Settings ConfigMap.
    const configMap = makeConfigMap(name, provider, labels, headersConfigMapName, namespace);
    const configMapName = configMap.metadata.apply(m => m.name);

    // Assemble the resources.
    // Per: https://itnext.io/kubernetes-ingress-controllers-how-to-choose-the-right-one-part-1-41d3554978d2
    const resources = {
        requests: {memory: "2048Mi"},
        limits: {memory: "4096Mi"},
    };

    // Create the Deployment.
    const deployment = makeDeployment(name, provider,
        labels, replicas, resources, namespace, ingressClass,
        serviceAccountName, configMapName, affinity, tolerations);

    // Create the PodDisruptionBudget with a 66% minimum availability of the
    // pods.
    const pdb = makePodDisruptionBudget(name, provider, labels,
        namespace, "66%");

    return deployment;
}

// Create a ConfigMap for the NGINX Ingress Controller custom headers..
export function makeHeadersConfigMap(
    name: string,
    provider: k8s.Provider,
    labels: pulumi.Input<any>,
    namespace: pulumi.Input<string>,
): k8s.core.v1.ConfigMap {
    return new k8s.core.v1.ConfigMap(
        `${name}-custom-headers`,
        {
            metadata: {
                labels: labels,
                namespace: namespace,
            },
            data: {
                "Connection": "", // http://nginx.org/en/docs/http/ngx_http_upstream_module.html#keepalive
            },
        },
        {
            provider: provider,
        },
    );
}

// Create a ConfigMap for the NGINX Ingress Controller settings.
export function makeConfigMap(
    name: string,
    provider: k8s.Provider,
    labels: pulumi.Input<any>,
    headersConfigMapName: pulumi.Input<string>,
    namespace: pulumi.Input<string>,
): k8s.core.v1.ConfigMap {
    return new k8s.core.v1.ConfigMap(
        name,
        {
            metadata: {
                labels: labels,
                namespace: namespace,
            },
            data: {
                "keep-alive": "200", // https://www.nginx.com/blog/testing-performance-nginx-ingress-controller-kubernetes/
                "keep-alive-requests": "10000",
                "proxy-connect-timeout": "10", // https://git.io/fjwCj
                "proxy-read-timeout": "120", // https://git.io/fjwCj
                "proxy-send-timeout": "120", // https://git.io/fjwCj
                "proxy-next-upstream": "error timeout http_502 http_503 http_504", // https://git.io/fjwWe
                // "proxy-set-headers": pulumi.concat(namespace, "/", headersConfigMapName),
                "upstream-keepalive-connections": "128",
                "upstream-keepalive-timeout": "315", // https://www.nginx.com/blog/testing-performance-nginx-ingress-controller-kubernetes/
                "upstream-keepalive-requests": "1000000", // https://www.nginx.com/blog/testing-performance-nginx-ingress-controller-kubernetes/
                "worker-processes": "8", // https://itnext.io/kubernetes-ingress-controllers-how-to-choose-the-right-one-part-1-41d3554978d2
                "worker-shutdown-timeout": "30s",
            },
        },
        {
            provider: provider,
        },
    );
}

// Create the Deployment
export function makeDeployment(
    name: string,
    provider: k8s.Provider,
    labels: pulumi.Input<any>,
    replicas: pulumi.Input<number>,
    resources: pulumi.Input<any>,
    namespace: pulumi.Input<string>,
    ingressClass: pulumi.Input<string>,
    serviceAccountName: pulumi.Input<string>,
    configMapName: pulumi.Input<string>,
    affinity: input.core.v1.Affinity,
    tolerations: input.core.v1.Toleration[],
): k8s.apps.v1.Deployment {
    return new k8s.apps.v1.Deployment(name,
        {
            metadata: {
                labels: labels,
                annotations: {
                    "prometheus.io/port": "10254",
                    "prometheus.io/scrape": "true",
                },
                namespace: namespace,
            },
            spec: {
                strategy: {
                    type: "RollingUpdate",
                    rollingUpdate: { maxUnavailable: "33%" },
                },
                replicas: replicas,
                selector: { matchLabels: labels },
                template: {
                    metadata: { labels: labels, namespace: namespace },
                    spec: {
                        serviceAccountName: serviceAccountName,
                        terminationGracePeriodSeconds: 60,
                        affinity: affinity,
                        tolerations: tolerations,
                        containers: [
                            {
                                name: name,
                                image: "quay.io/kubernetes-ingress-controller/nginx-ingress-controller:0.24.1",
                                resources: resources,
                                ports: [{ name: "http", containerPort: 80 }],
                                securityContext: {
                                    allowPrivilegeEscalation: true,
                                    capabilities: {
                                        drop: ["ALL"],
                                        add: ["NET_BIND_SERVICE"],
                                    },
                                    // www-data is user 33
                                    runAsUser: 33,
                                },
                                env: [
                                    {
                                        name: "POD_NAME",
                                        valueFrom: {
                                            fieldRef: {
                                                fieldPath: "metadata.name",
                                           },
                                        },
                                    },
                                    {
                                        name: "POD_NAMESPACE",
                                        valueFrom: {
                                            fieldRef: {
                                                fieldPath: "metadata.namespace",
                                            },
                                        },
                                    },
                                ],
                                readinessProbe: {
                                    httpGet: {
                                        path: "/healthz",
                                        port: 10254,
                                        scheme: "HTTP",
                                    },
                                    periodSeconds: 10,
                                    successThreshold: 1,
                                    timeoutSeconds: 10,
                                },
                                livenessProbe: {
                                    httpGet: {
                                        path: "/healthz",
                                        port: 10254,
                                        scheme: "HTTP",
                                    },
                                    initialDelaySeconds: 10,
                                    periodSeconds: 10,
                                    successThreshold: 1,
                                    timeoutSeconds: 10,
                                    failureThreshold: 3,
                                },
                                // For more info on all CLI args available:
                                // https://github.com/kubernetes/ingress-nginx/blob/master/docs/user-guide/cli-arguments.md
                                args: pulumi.all([
                                    "/nginx-ingress-controller",
                                    pulumi.concat(
                                    "--configmap=$(POD_NAMESPACE)/",
                                    configMapName,
                                    ),
                                    pulumi.concat(
                                        "--publish-service=$(POD_NAMESPACE)/",
                                        "nginx-ing-cntlr",
                                    ),
                                    "--annotations-prefix=nginx.ingress.kubernetes.io",
                                    "--ingress-class=" + ingressClass,
                                    "--v=2",
                                ]),
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

// Create a PodDisruptionBudget for the Deployment Pods.
export function makePodDisruptionBudget(
    name: string,
    provider: k8s.Provider,
    labels: pulumi.Input<any>,
    namespace: pulumi.Input<string>,
    minAvailable: pulumi.Input<string>,
): k8s.policy.v1beta1.PodDisruptionBudget {
    return new k8s.policy.v1beta1.PodDisruptionBudget(
        name,
        {
            metadata: {
                labels: labels,
                namespace: namespace,
            },
            spec: {
                minAvailable: minAvailable,
                selector: { matchLabels: labels },
            },
        },
        {
            provider: provider,
        },
    );
}
