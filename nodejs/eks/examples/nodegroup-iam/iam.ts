import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { ServiceRole } from "../../../../nodejs/eks/servicerole";

export function createRole(name: string): pulumi.Output<aws.iam.Role> {
    return (new ServiceRole(`${name}-instanceRole`, {
        service: "ec2.amazonaws.com",
        managedPolicyArns: [
            "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
            "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
            "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
        ],
    })).role;
}

export function createInstanceProfile(name: string, role: pulumi.Output<aws.iam.Role>): aws.iam.InstanceProfile {
    return new aws.iam.InstanceProfile(`${name}-instanceProfile`, {
        role: role,
    });
}
