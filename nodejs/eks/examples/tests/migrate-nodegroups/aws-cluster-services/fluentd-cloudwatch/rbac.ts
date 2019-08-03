import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// Create a ServiceAccount.
interface CloudwatchServiceAccountArgs {
    namespace: pulumi.Input<string>;
    provider: k8s.Provider;
}
export function makeCloudwatchServiceAccount(
    name: string,
    args: CloudwatchServiceAccountArgs,
): k8s.core.v1.ServiceAccount {
    return new k8s.core.v1.ServiceAccount(
        name,
        {
            metadata: {
                namespace: args.namespace,
            },
        },
        {
            provider: args.provider,
        },
    );
}

// Create a ClusterRole.
interface CloudwatchClusterRoleArgs {
    provider: k8s.Provider;
}
export function makeCloudwatchClusterRole(
    name: string,
    args: CloudwatchClusterRoleArgs,
): k8s.rbac.v1.ClusterRole {
    return new k8s.rbac.v1.ClusterRole(
        name,
        {
            rules: [
                {
                    apiGroups: [""],
                    resources: ["namespaces", "pods"],
                    verbs: ["get", "list", "watch"],
                },
            ],
        },
        {
            provider: args.provider,
        },
    );
}

// Create a ClusterRoleBinding of the ServiceAccount -> ClusterRole.
interface CloudwatchClusterRoleBindingArgs {
    namespace: pulumi.Input<string>;
    serviceAccountName: pulumi.Input<string>;
    clusterRoleName: pulumi.Input<string>;
    provider: k8s.Provider;
}
export function makeCloudwatchClusterRoleBinding(
    name: string,
    args: CloudwatchClusterRoleBindingArgs,
): k8s.rbac.v1.ClusterRoleBinding {
    return new k8s.rbac.v1.ClusterRoleBinding(
        name,
        {
            subjects: [
                {
                    kind: "ServiceAccount",
                    name: args.serviceAccountName,
                    namespace: args.namespace,
                },
            ],
            roleRef: {
                apiGroup: "rbac.authorization.k8s.io",
                kind: "ClusterRole",
                name: args.clusterRoleName,
            },
        },
        {
            provider: args.provider,
        },
    );
}
