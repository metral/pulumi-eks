import * as aws from "@pulumi/aws";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

const managedPolicyArns: string[] = [
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
];

// Creates a role and attches the EKS worker node IAM managed policies
export function createRole(name: string): aws.iam.Role {
    const role = new aws.iam.Role(name, {
        assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
            Service: "ec2.amazonaws.com",
        }),
    });

    let counter = 0;
    for (const policy of managedPolicyArns) {
        // Create RolePolicyAttachment without returning it.
        const rpa = new aws.iam.RolePolicyAttachment(`${name}-policy-${counter++}`,
            { policyArn: policy, role: role },
        );
    }

    return role;
}

// IAM roles for the node groups.
const role1 = createRole("example-role1");

// Create an EKS cluster.
const cluster = new eks.Cluster("example-managed-nodegroups", {
    skipDefaultNodeGroup: true,
    deployDashboard: false,
    instanceRoles: [role1],
    createOidcProvider: true,
});

// Export the cluster's kubeconfig.
export const kubeconfig = cluster.kubeconfig;

// Create a simple AWS managed node group using a cluster as input.
const managedNodeGroup1 = eks.createManagedNodeGroup("example-managed-ng1", {
    cluster: cluster,
    nodeGroupName: "aws-managed-ng1",
    nodeRoleArn: role1.arn,
    version: "1.14",
}, cluster);

const clusterOidcProvider = cluster.core.oidcProvider;
if (!clusterOidcProvider) {
    throw new Error("Invalid cluster OIDC provider URL");
}

// Export the cluster OIDC provider URL.
export const clusterOidcProviderUrl = cluster.core.oidcProvider.url;

// Setup Pulumi Kubernetes provider.
const provider = new k8s.Provider("eks-k8s", {
    kubeconfig: kubeconfig.apply(JSON.stringify),
});

// Create a cluster-services Namespace.
const ns = new k8s.core.v1.Namespace("apps", undefined, {provider: provider});

// Create the IAM target policy and role for the Service Account.
const saName = "s3-readonly";
const saAssumeRolePolicy = pulumi.all([clusterOidcProviderUrl, clusterOidcProvider.arn]).apply(([url, arn]) => aws.iam.getPolicyDocument({
    statements: [{
        actions: ["sts:AssumeRoleWithWebIdentity"],
        conditions: [{
            test: "StringEquals",
            values: [`system:serviceaccount:${ns.metadata.name}:${saName}`],
            variable: `${url.replace("https://", "")}:sub`,
        }],
        effect: "Allow",
        principals: [{
            identifiers: [arn],
            type: "Federated",
        }],
    }],
}));

const saRole = new aws.iam.Role(saName, {
    assumeRolePolicy: saAssumeRolePolicy.json,
});

// Attach the S3 read only access policy.
const saS3Rpa = new aws.iam.RolePolicyAttachment(saName, {
    policyArn: "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
    role: saRole,
});

// Create the Service Account with the IAM role annotated.
const sa = new k8s.core.v1.ServiceAccount(saName, {
    metadata: {
        namespace: ns.metadata.name,
        name: saName,
        annotations: {
            "eks.amazonaws.com/role-arn": saRole.arn,
        },
    },
}, { provider: provider});

// Use the Service Account in a Deployment.
const labels = {"app": saName};
const deployment = new k8s.apps.v1.Deployment(saName,
    {
        metadata: { labels: labels, namespace: ns.metadata.name},
        spec: {
            replicas: 1,
            selector: { matchLabels: labels },
            template: {
                metadata: { labels: labels, namespace: ns.metadata.name},
                spec: {
                    serviceAccountName: sa.metadata.name,
                    containers: [
                        {
                            name: saName,
                            image: "debian",
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
