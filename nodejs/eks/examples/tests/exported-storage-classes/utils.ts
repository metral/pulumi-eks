import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function checkStorageClass(storageClasses: k8s.storage.v1.StorageClass[]) {
    storageClasses.map(sc => {
        console.log("sc: " + sc);
        sc.metadata.apply(m => {
            console.log("name: " + m.name);
            if (!m.name) {
                throw Error("storageClass error: name has no value");
            }
        });
    });
}
