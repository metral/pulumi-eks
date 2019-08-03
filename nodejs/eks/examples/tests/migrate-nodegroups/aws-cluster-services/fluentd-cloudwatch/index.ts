import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as rbac from "./rbac";

export type FluentdCloudWatchOptions = {
    clusterName: pulumi.Input<string>;
    image: pulumi.Input<string>;
    labels: pulumi.Input<any>;
    namespace: pulumi.Input<string>;
    region: pulumi.Input<string>;
    iamRoleArn: pulumi.Input<string>;
    provider: k8s.Provider;
};

export class FluentdCloudWatch extends pulumi.ComponentResource {
    public readonly clusterName: pulumi.Input<string>;
    public readonly configMap: k8s.core.v1.ConfigMap;
    public readonly daemonSet: k8s.apps.v1.DaemonSet;

    constructor(
        name: string,
        args: FluentdCloudWatchOptions,
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super("kx:lib:FluentdCloudWatch", name, args, opts);

        if (args.clusterName === undefined ||
            args.image === undefined ||
            args.labels === undefined ||
            args.namespace === undefined ||
            args.region === undefined ||
            args.iamRoleArn === undefined ||
            args.provider === undefined
        ) {
            return {} as FluentdCloudWatch;
        }

        this.clusterName = args.clusterName;

        this.configMap = makeConfigMap(name, {
            labels: args.labels,
            namespace: args.namespace,
            provider: args.provider,
        });

        // ServiceAccount.
        const serviceAccount = rbac.makeCloudwatchServiceAccount(name, {
            namespace: args.namespace,
            provider: args.provider,
        });
        const serviceAccountName = serviceAccount.metadata.name;

        // RBAC ClusterRole.
        const clusterRole = rbac.makeCloudwatchClusterRole(name, {
            provider: args.provider,
        });
        const clusterRoleName = clusterRole.metadata.name;
        const clusterRoleBinding = rbac.makeCloudwatchClusterRoleBinding(name, {
            namespace: args.namespace,
            serviceAccountName: serviceAccountName,
            clusterRoleName: clusterRoleName,
            provider: args.provider,
        });

        this.daemonSet = makeDaemonSet(
            name,
            args.image,
            args.labels,
            serviceAccountName,
            args.namespace,
            args.region,
            this.clusterName,
            this.configMap.metadata.name,
            args.iamRoleArn,
            args.provider,
        );
    }
}

// Create a ConfigMap.
interface CloudwatchConfigMapArgs {
    labels: pulumi.Input<any>;
    namespace: pulumi.Input<string>;
    provider: k8s.Provider;
}
export function makeConfigMap(
    name: string,
    args: CloudwatchConfigMapArgs,
): k8s.core.v1.ConfigMap {
    return new k8s.core.v1.ConfigMap(
        name,
        {
            metadata: {
                labels: args.labels,
                namespace: args.namespace,
            },
            data: {
                "fluent.conf": `
                    @include containers.conf
                    @include systemd.conf
                    @include host.conf

                    <match fluent.**>
                        @type null
                    </match>`,
                "containers.conf": `
                    <source>
                        @type tail
                        @id in_tail_container_logs
                        @label @containers
                        path /var/log/containers/*.log
                        pos_file /var/log/fluentd-containers.log.pos
                        tag *
                        read_from_head true
                        <parse>
                        @type json
                        time_format %Y-%m-%dT%H:%M:%S.%NZ
                        </parse>
                    </source>

                    <label @containers>
                        <filter **>
                        @type kubernetes_metadata
                        @id filter_kube_metadata
                        </filter>

                        <filter **>
                        @type record_transformer
                        @id filter_containers_stream_transformer
                        <record>
                            stream_name \${tag_parts[3]}
                        </record>
                        </filter>

                        <match **>
                        @type cloudwatch_logs
                        @id out_cloudwatch_logs_containers
                        region "#{ENV.fetch('REGION')}"
                        log_group_name "/aws/containerinsights/#{ENV.fetch('CLUSTER_NAME')}/application"
                        log_stream_name_key stream_name
                        remove_log_stream_name_key true
                        auto_create_stream true
                        <buffer>
                            flush_interval 5
                            chunk_limit_size 2m
                            queued_chunks_limit_size 32
                            retry_forever true
                        </buffer>
                        </match>
                    </label>`,
                "systemd.conf": `
                    <source>
                        @type systemd
                        @id in_systemd_kubelet
                        @label @systemd
                        filters [{ "_SYSTEMD_UNIT": "kubelet.service" }]
                        <entry>
                        field_map {"MESSAGE": "message", "_HOSTNAME": "hostname", "_SYSTEMD_UNIT": "systemd_unit"}
                        field_map_strict true
                        </entry>
                        path /var/log/journal
                        pos_file /var/log/fluentd-journald-kubelet.pos
                        read_from_head true
                        tag kubelet.service
                    </source>

                    <source>
                        @type systemd
                        @id in_systemd_kubeproxy
                        @label @systemd
                        filters [{ "_SYSTEMD_UNIT": "kubeproxy.service" }]
                        <entry>
                        field_map {"MESSAGE": "message", "_HOSTNAME": "hostname", "_SYSTEMD_UNIT": "systemd_unit"}
                        field_map_strict true
                        </entry>
                        path /var/log/journal
                        pos_file /var/log/fluentd-journald-kubeproxy.pos
                        read_from_head true
                        tag kubeproxy.service
                    </source>

                    <source>
                        @type systemd
                        @id in_systemd_docker
                        @label @systemd
                        filters [{ "_SYSTEMD_UNIT": "docker.service" }]
                        <entry>
                        field_map {"MESSAGE": "message", "_HOSTNAME": "hostname", "_SYSTEMD_UNIT": "systemd_unit"}
                        field_map_strict true
                        </entry>
                        path /var/log/journal
                        pos_file /var/log/fluentd-journald-docker.pos
                        read_from_head true
                        tag docker.service
                    </source>

                    <label @systemd>
                        <filter **>
                        @type kubernetes_metadata
                        @id filter_kube_metadata_systemd
                        </filter>

                        <filter **>
                        @type record_transformer
                        @id filter_systemd_stream_transformer
                        <record>
                            stream_name \${tag}-\${record["hostname"]}
                        </record>
                        </filter>

                        <match **>
                        @type cloudwatch_logs
                        @id out_cloudwatch_logs_systemd
                        region "#{ENV.fetch('REGION')}"
                        log_group_name "/aws/containerinsights/#{ENV.fetch('CLUSTER_NAME')}/dataplane"
                        log_stream_name_key stream_name
                        auto_create_stream true
                        remove_log_stream_name_key true
                        <buffer>
                            flush_interval 5
                            chunk_limit_size 2m
                            queued_chunks_limit_size 32
                            retry_forever true
                        </buffer>
                        </match>
                    </label>`,
                "host.conf": `
                    <source>
                        @type tail
                        @id in_tail_dmesg
                        @label @hostlogs
                        path /var/log/dmesg
                        pos_file /var/log/dmesg.log.pos
                        tag host.dmesg
                        read_from_head true
                        <parse>
                        @type syslog
                        </parse>
                    </source>

                    <source>
                        @type tail
                        @id in_tail_secure
                        @label @hostlogs
                        path /var/log/secure
                        pos_file /var/log/secure.log.pos
                        tag host.secure
                        read_from_head true
                        <parse>
                        @type syslog
                        </parse>
                    </source>

                    <source>
                        @type tail
                        @id in_tail_messages
                        @label @hostlogs
                        path /var/log/messages
                        pos_file /var/log/messages.log.pos
                        tag host.messages
                        read_from_head true
                        <parse>
                        @type syslog
                        </parse>
                    </source>

                    <label @hostlogs>
                        <filter **>
                        @type kubernetes_metadata
                        @id filter_kube_metadata_host
                        </filter>

                        <filter **>
                        @type record_transformer
                        @id filter_containers_stream_transformer_host
                        <record>
                            stream_name \${tag}-\${record["host"]}
                        </record>
                        </filter>

                        <match host.**>
                        @type cloudwatch_logs
                        @id out_cloudwatch_logs_host_logs
                        region "#{ENV.fetch('REGION')}"
                        log_group_name "/aws/containerinsights/#{ENV.fetch('CLUSTER_NAME')}/host"
                        log_stream_name_key stream_name
                        remove_log_stream_name_key true
                        auto_create_stream true
                        <buffer>
                            flush_interval 5
                            chunk_limit_size 2m
                            queued_chunks_limit_size 32
                            retry_forever true
                        </buffer>
                        </match>
                    </label>`,
            },
        },
        {
            provider: args.provider,
        },
    );
}

// Create the DaemonSet.
export function makeDaemonSet(
    name: string,
    image: pulumi.Input<string>,
    labels: pulumi.Input<any>,
    serviceAccountName: pulumi.Input<string>,
    namespace: pulumi.Input<string>,
    region: pulumi.Input<string>,
    clusterName: pulumi.Input<string>,
    configMapName: pulumi.Input<string>,
    iamRoleArn: pulumi.Input<string>,
    provider: k8s.Provider,
): k8s.apps.v1.DaemonSet {
    return new k8s.apps.v1.DaemonSet(
        name,
        {
            metadata: {
                labels: labels,
                namespace: namespace,
            },
            spec: {
                selector: { matchLabels: labels},
                template: {
                    metadata: {
                        labels: labels,
                        annotations: {
                            "iam.amazonaws.com/role": iamRoleArn,
                        },
                    },
                    spec: {
                        serviceAccountName: serviceAccountName,
                        affinity: {
                            nodeAffinity: {
                                requiredDuringSchedulingIgnoredDuringExecution: {
                                    nodeSelectorTerms: [
                                        {
                                            matchExpressions: [
                                                {
                                                    key: "beta.kubernetes.io/os",
                                                    operator: "In",
                                                    values: ["linux"],
                                                },
                                                {
                                                    key: "beta.kubernetes.io/arch",
                                                    operator: "In",
                                                    values: ["amd64"],
                                                },
                                            ],
                                        },
                                    ],
                                },
                            },
                        },
                        tolerations: [{
                            operator: "Exists",
                        }],
                        initContainers: [
                            {
                                name: "copy-fluentd-config",
                                image: "busybox:1.31.0",
                                command: ["sh", "-c", "cp /config-volume/..data/* /fluentd/etc"],
                                volumeMounts: [
                                    {
                                        name: "config-volume",
                                        mountPath: "/config-volume",
                                    },
                                    {
                                        name: "fluentdconf",
                                        mountPath: "/fluentd/etc",
                                    },
                                ],
                            },
                            {
                                name: "update-log-driver",
                                image: "busybox:1.31.0",
                                command: ["sh", "-c", ""],
                            },
                        ],
                        containers: [
                            {
                                name: name,
                                image: image,
                                imagePullPolicy: "Always",
                                resources: {
                                    requests: {cpu: "100m", memory: "200Mi"},
                                    limits: {cpu: "100m", memory: "200Mi"},
                                },
                                env: [
                                    { name: "REGION", value: region },
                                    { name: "CLUSTER_NAME", value: clusterName },
                                ],
                                volumeMounts: [
                                    {
                                        name: "config-volume",
                                        mountPath: "/config-volume",
                                    },
                                    {
                                        name: "fluentdconf",
                                        mountPath: "/fluentd/etc",
                                    },
                                    {
                                        name: "varlog",
                                        mountPath: "/var/log",
                                    },
                                    {
                                        name: "varlibdockercontainers",
                                        mountPath: "/var/lib/docker/containers",
                                        readOnly: true,
                                    },
                                    {
                                        name: "runlogjournal",
                                        mountPath: "/run/log/journal",
                                        readOnly: true,
                                    },
                                    {
                                        name: "dmesg",
                                        mountPath: "/varlog/dmesg",
                                        readOnly: true,
                                    },
                                ],
                            },
                        ],
                        volumes: [
                            {
                                "name": "config-volume",
                                "configMap": {
                                    "name" : configMapName,
                                },
                            },
                            {
                                "name": "fluentdconf",
                                "emptyDir": {},
                            },
                            {
                                "name": "varlog",
                                "hostPath": {
                                    "path" : "/var/log",
                                },
                            },
                            {
                                "name": "varlibdockercontainers",
                                "hostPath": {
                                    "path" : "/var/lib/docker/containers",
                                },
                            },
                            {
                                "name": "runlogjournal",
                                "hostPath": {
                                    "path" : "/run/log/journal",
                                },
                            },
                            {
                                "name": "dmesg",
                                "hostPath": {
                                    "path" : "/var/log/dmesg",
                                },
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
}
