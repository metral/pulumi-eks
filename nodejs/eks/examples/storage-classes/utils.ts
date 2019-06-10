import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function checkStorageClasses(storageClasses: eks.UserStorageClasses) {
    storageClasses.apply(scs => {
        for (const key of Object.keys(scs)) {
            const sc = scs[key];
            sc.metadata.apply(m => {
                // TODO: @metral remove this when issue is fixed.
                // 'defaultName' is used per suggestion in https://git.io/fjVYi due to
                // https://github.com/pulumi/pulumi/issues/2433
                const name = m.name || "defaultName";
                if (!name || name === "defaultName") {
                    throw Error("storageClass error: name has no value");
                }
            });
        }
    });
}
