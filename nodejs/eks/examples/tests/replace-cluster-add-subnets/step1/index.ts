import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as eks from "@pulumi/eks";

const projectName = pulumi.getProject();
const zones = aws.getAvailabilityZones();
const tags = { "Name": `${projectName}` };

/**
 * VPC
 */
const vpcCidr = "10.0.0.0/16";
const vpc = new aws.ec2.Vpc(projectName, {
    cidrBlock: vpcCidr,
    enableDnsSupport: true,
    enableDnsHostnames: true,
    tags: { ...tags },
});
export const vpcId = vpc.id;

/**
 * Internet Gateway
 */
const internetGateway = new aws.ec2.InternetGateway(`${projectName}-igw`, {
    vpcId: vpc.id,
    tags: { ...tags },
}, { parent: vpc });

/**
 * Public subnets
 */

const publicSubnetCidrList = ["10.0.0.0/24", "10.0.1.0/24", "10.0.2.0/24"]; // assumes 3 AZ's in the region
const publicSubnetList = publicSubnetCidrList.map((cidr, index) => {
    const name = `${projectName}-public-${index}`;
    const subnet = new aws.ec2.Subnet(name, {
        vpcId: vpc.id,
        cidrBlock: cidr,
        mapPublicIpOnLaunch: true,
        availabilityZone: zones.then(z => z.names[Math.abs(index) % z.names.length]), // avoid out of bounds error
        tags: { ...tags },
    }, { parent: vpc });
    return subnet;
});

/**
 * Configure RouteTables & Associations
 */
publicSubnetList.forEach((subnet, index) => {
    const name = `${projectName}-public-${index}`;

    const routeTable = new aws.ec2.RouteTable(`${name}-rtb`, {
        vpcId: vpc.id,
        tags: { ...tags },
    }, { parent: subnet });

    // Set the default route to the NAT Gateway
    const route = new aws.ec2.Route(`${name}-route`, {
        routeTableId: routeTable.id,
        destinationCidrBlock: "0.0.0.0/0",
        gatewayId: internetGateway.id,
    }, { parent: routeTable });

    const association = new aws.ec2.RouteTableAssociation(`${name}-rtb-assoc`, {
        subnetId: subnet.id,
        routeTableId: routeTable.id,
    }, { parent: routeTable });
});

/**
 * EKS
 */
const subnetIds = publicSubnetList.map(s => s.id);
const cluster = new eks.Cluster(projectName, {
    vpcId: vpc.id,
    subnetIds: subnetIds,
    instanceType: "t2.medium",
    desiredCapacity: 2,
    minSize: 1,
    maxSize: 2,
    storageClasses: "gp2",
    deployDashboard: false,
});

// Export the cluster name
export const clusterName = cluster.core.cluster.name;

// Export the cluster kubeconfig
export const kubeconfig = cluster.kubeconfig;
