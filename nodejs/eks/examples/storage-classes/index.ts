import * as eks from "@pulumi/eks";
import * as pulumi from "@pulumi/pulumi";
import * as utils from "./utils";

const projectName = pulumi.getProject();

// Create an EKS cluster with a single storage class as a string.
const cluster1 = new eks.Cluster(`${projectName}-1`, {
    deployDashboard: false,
    storageClasses: "io1",
});

if (cluster1.core.storageClasses) {
    utils.checkStorageClasses(cluster1.core.storageClasses);

    // Use a single storage class.
    cluster1.core.storageClasses.apply(scs => {
        scs["io1"].metadata.apply(m => {
            console.log(m.name);
        });
    });
}
export const kubeconfig1 = cluster1.kubeconfig;

// Create an EKS cluster with many storage classes as a map.
const cluster2 = new eks.Cluster(`${projectName}-2`, {
    deployDashboard: false,
    storageClasses: {
        "mygp2": {
            type: "gp2",
            default: true,
            encrypted: true,
        },
        "mysc1": {
            type: "sc1",
        },
    },
});

if (cluster2.core.storageClasses) {
    utils.checkStorageClasses(cluster2.core.storageClasses);

    // Use many storage classes.
    cluster2.core.storageClasses.apply(scs => {
        scs["mygp2"].metadata.apply(m => {
            console.log(m.name);
        });
        scs["mysc1"].metadata.apply(m => {
            console.log(m.name);
        });
    });
}
export const kubeconfig2 = cluster2.kubeconfig;
