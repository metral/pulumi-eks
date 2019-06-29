import * as pulumi from "@pulumi/pulumi";

const pulumiConfig = new pulumi.Config(pulumi.getProject());
export const config = {
    createNodeGroup2xlarge: "false",
    createNodeGroup4xlarge: "true",
    nginxNodeSelectorTermValues: ["c5.4xlarge"],
};
