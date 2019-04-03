# examples/nodegroup-iam

Creates 2 IAM roles, and creates an EKS cluster in the default VPC without
worker nodes. Then create and attach the following node groups to the cluster:

* ondemand1 t2.large node group with 1 node, an instanceRole, and labels.
* ondemand2 t2.large node group with 1 node, an instanceRole, labels, and taints.
