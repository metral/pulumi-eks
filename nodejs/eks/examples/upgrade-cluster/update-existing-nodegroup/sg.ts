import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";
import * as pulumi from "@pulumi/pulumi";

interface NodeSecurityGroupData {
    nodeSecurityGroup: aws.ec2.SecurityGroup;
    clusterIngressRule: aws.ec2.SecurityGroupRule;
}

export function configSecGroups(
    name: string,
    quantity: number,
    vpc: awsx.ec2.Vpc,
    cluster: eks.Cluster,
): NodeSecurityGroupData[] {
    const allNodeSecurityGroupData: NodeSecurityGroupData[] = [];

    // Create the quantity of nodeSecurityGroups and eksClusterIngressRules.
    for (let i = 0; i < quantity; i++) {
        let nodeSecurityGroup: aws.ec2.SecurityGroup;
        let clusterIngRule: aws.ec2.SecurityGroupRule;

        [nodeSecurityGroup, clusterIngRule] = eks.createNodeGroupSecurityGroup(`${name}-${i}`, {
            vpcId: vpc.id,
            clusterSecurityGroup: cluster.clusterSecurityGroup,
            eksCluster: cluster.core.cluster,
        }, cluster);

        const rule = new aws.ec2.SecurityGroupRule(`${name}-sg${i}-defaultNodeSecurityGroup`, {
            description: "Allow nodes to communicate with each other",
            type: "ingress",
            fromPort: 0,
            toPort: 0,
            protocol: "-1", // all
            securityGroupId: nodeSecurityGroup.id,
            sourceSecurityGroupId: cluster.nodeSecurityGroup.id,
        });

        allNodeSecurityGroupData.push(<NodeSecurityGroupData>{
            nodeSecurityGroup: nodeSecurityGroup,
            clusterIngressRule: clusterIngRule,
        });
    }

    for (let i = 0; i < allNodeSecurityGroupData.length; i++) {
        // Create the ingress secgroup rule for the default nodeSecurityGroup.
        const r = new aws.ec2.SecurityGroupRule(`${name}-defaultNodeSecurityGroup-srcsg${i}`, {
            description: "Allow nodes to communicate with each other",
            type: "ingress",
            fromPort: 0,
            toPort: 0,
            protocol: "-1", // all
            securityGroupId: cluster.nodeSecurityGroup.id,
            sourceSecurityGroupId: allNodeSecurityGroupData[i].nodeSecurityGroup.id,
        });
        // Create the ingress secgroup rules for each permutation pair of
        // node secgroups. This allows each pair of secgroups to accept
        // ingress worker node traffic from each other.
        for (let j = 0; j < allNodeSecurityGroupData.length; j++) {
            if (i === j) {
                continue;
            }
            const rule = new aws.ec2.SecurityGroupRule(`${name}-sg${i}-srcsg${j}`, {
                description: "Allow nodes to communicate with each other",
                type: "ingress",
                fromPort: 0,
                toPort: 0,
                protocol: "-1", // all
                securityGroupId: allNodeSecurityGroupData[i].nodeSecurityGroup.id,
                sourceSecurityGroupId: allNodeSecurityGroupData[j].nodeSecurityGroup.id,
            });
        }
    }

    return allNodeSecurityGroupData;
}
