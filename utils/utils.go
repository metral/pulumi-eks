package utils

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/pulumi/pulumi/pkg/apitype"
	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v2"
	v1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	restclient "k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// Each resource request will be fetched from the Kubernetes API Server at a
// max of 12 retries, with 10 seconds in between each attempt.
// This creates a max wait time of upto 2 minutes that a resource request
// must successfully return within, before moving on.

// MaxRetries is the maximum number of retries that a resource will be
// attempted to be fetched from the Kubernetes API Server.
const MaxRetries = 12

// RetryInterval is the number of seconds to sleep in between requests
// to the Kubernetes API Server.
const RetryInterval = 10

// RunEKSSmokeTest instantiates the EKS Smoke Test based on the Pulumi stack
// resources and the exported kubeconfig outputs.
func RunEKSSmokeTest(t *testing.T, resources []apitype.ResourceV3, kubeconfigs ...interface{}) {
	// Map the cluster name to the KubeAccess client-go tool bag.
	kubeAccess, err := MapClusterToKubeAccess(kubeconfigs...)
	if err != nil {
		t.Error(err)
	}

	// Map the cluster name to the total desired Node count across all
	// NodeGroups.
	clusterNodeCount, err := MapClusterToNodeCount(resources)
	if err != nil {
		t.Error(err)
	}

	// Run the smoke test against each cluster, expecting the total desired
	// Node count.
	for clusterName := range kubeAccess {
		fmt.Printf("Testing Cluster: %s\n", clusterName)
		t.Logf("Testing Cluster: %s\n", clusterName)
		clientset := kubeAccess[clusterName].Clientset
		EKSSmokeTest(t, clientset, clusterNodeCount[clusterName])
	}
}

// EKSSmokeTest runs a checklist of operational successes required to deem the
// EKS cluster as successfully running and ready for use.
func EKSSmokeTest(t *testing.T, clientset *kubernetes.Clientset, desiredNodeCount int) {
	// Print API Server info.
	APIServerVersionInfo(t, clientset)

	// Run all tests.
	AssertEKSConfigMapReady(t, clientset)
	AssertAllNodesReady(t, clientset, desiredNodeCount)
	AssertAllPodsReady(t, clientset)
}

// APIServerVersionInfo prints out the API Server versions.
func APIServerVersionInfo(t *testing.T, clientset *kubernetes.Clientset) {
	version, err := clientset.DiscoveryClient.ServerVersion()
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("API Server Version: %s.%s\n", version.Major, version.Minor)
	fmt.Printf("API Server GitVersion: %s\n", version.GitVersion)
}

// AssertEKSConfigMapReady ensures that the EKS aws-auth ConfigMap
// exists and has data.
func AssertEKSConfigMapReady(t *testing.T, clientset *kubernetes.Clientset) {
	awsAuthReady, retries := false, MaxRetries
	configMapName, namespace := "aws-auth", "kube-system"
	var awsAuth *v1.ConfigMap
	var err error

	// Attempt to validate that the aws-auth ConfigMap exists.
	for !awsAuthReady && retries > 0 {
		awsAuth, err = clientset.CoreV1().ConfigMaps(namespace).Get(configMapName, metav1.GetOptions{})
		if err != nil {
			fmt.Printf("Waiting for %q ConfigMap to be returned. Retrying...\n", configMapName)
			retries--
			time.Sleep(RetryInterval * time.Second)
			continue
		}
		awsAuthReady = true
		break
	}

	require.Equal(t, true, awsAuthReady, "EKS ConfigMap %q does not exist in namespace %q", configMapName, namespace)
	require.NotNil(t, awsAuth.Data, "%s ConfigMap should not be nil", configMapName)
	require.NotEmpty(t, awsAuth.Data, "%q ConfigMap should not be empty", configMapName)
	fmt.Printf("EKS ConfigMap %q exists and has data\n", configMapName)
	t.Logf("EKS ConfigMap %q exists and has data:\n%s", configMapName, awsAuth.Data)
}

// AssertAllNodesReady ensures that all Nodes are running & have a "Ready"
// status condition.
func AssertAllNodesReady(t *testing.T, clientset *kubernetes.Clientset, desiredNodeCount int) {
	var nodes *v1.NodeList
	var err error

	fmt.Printf("Total Desired Worker Node Count: %d\n", desiredNodeCount)

	// Attempt to validate that the total desired worker Node count of
	// instances are up & running.
	for i := 0; i < MaxRetries; i++ {
		nodes, err = clientset.CoreV1().Nodes().List(metav1.ListOptions{})
		if err != nil {
			WaitFor(fmt.Sprintf("desired worker Node count of (%d) instances", desiredNodeCount), "running")
			continue
		}
		if desiredNodeCount != len(nodes.Items) {
			WaitFor(fmt.Sprintf("desired worker Node count of (%d) instances", desiredNodeCount), "running")
		} else {
			break
		}
	}

	// Require that the Nodes returned are not empty & match the
	// desiredNodeCount.
	require.NotEmpty(t, nodes, "The Nodes list returned should not be empty")
	require.Equal(t, desiredNodeCount, len(nodes.Items),
		"%d out of %d desired worker Nodes are instantiated and running", len(nodes.Items), desiredNodeCount)

	// Attempt to validate each Node has a "Ready" status.
	var readyCount int
	for _, node := range nodes.Items {
		nodeReady := false
		// Attempt to check if a Node is ready, and output the resulting status.
		for i := 0; i < MaxRetries; i++ {
			if IsNodeReady(clientset, &node) {
				nodeReady = true
				readyCount++
				break
			} else {
				WaitFor(fmt.Sprintf("Node %q", node.Name), "ready")
			}
		}
		t.Logf("Node: %s | Ready Status: %t\n", node.Name, nodeReady)
	}

	// Require that the readyCount matches the desiredNodeCount / total Nodes.
	require.Equal(t, readyCount, len(nodes.Items),
		"%d out of %d Nodes are ready", readyCount, len(nodes.Items))

	// Output the status to stdout & test logs
	t.Logf("%d out of %d Nodes are ready", readyCount, len(nodes.Items))
	fmt.Printf("%d out of %d Nodes are ready\n", readyCount, len(nodes.Items))
}

// WaitFor is a helper func that prints to stdout & sleeps to indicate a
// wait & retry on a given resource, with an expected status.
func WaitFor(resource, status string) {
	fmt.Printf("Waiting for %s to be %s. Retrying...\n", resource, status)
	time.Sleep(RetryInterval * time.Second)
}

// IsNodeReady attempts to check if the Node status condition is ready.
func IsNodeReady(clientset *kubernetes.Clientset, node *v1.Node) bool {
	// Attempt to retrieve Node.
	n, err := clientset.CoreV1().Nodes().Get(node.Name, metav1.GetOptions{})
	if err != nil {
		WaitFor(fmt.Sprintf("Node %q", node.Name), "returned")
	}

	// Check the returned Node's conditions for readiness.
	for _, condition := range n.Status.Conditions {
		if condition.Type == v1.NodeReady {
			return condition.Status == v1.ConditionTrue
		}
	}

	return false
}

// IsPodReady attempts to check if the Pod's status & condition is ready.
func IsPodReady(clientset *kubernetes.Clientset, pod *v1.Pod) bool {
	// Attempt to retrieve Pods.
	p, err := clientset.CoreV1().Pods(pod.Namespace).Get(pod.Name, metav1.GetOptions{})
	if err != nil {
		WaitFor(fmt.Sprintf("Pod %q", pod.Name), "returned")
	}

	// Check the returned Pod's status & conditions for readiness.
	if p.Status.Phase == v1.PodRunning || p.Status.Phase == v1.PodSucceeded {
		for _, condition := range p.Status.Conditions {
			if condition.Type == v1.PodReady {
				return condition.Status == v1.ConditionTrue
			}
		}
	}

	return false
}

// AssertAllPodsReady ensures all Pods have a "Running" or "Succeeded" status
// phase, and a "Ready" status condition.
func AssertAllPodsReady(t *testing.T, clientset *kubernetes.Clientset) {
	var pods *v1.PodList
	var err error

	// Assume first non-error return of a list of Pods is correct & complete,
	// as we currently do not have a way of knowing ahead of time how many
	// total Pods to expect in each cluster before it is up and running.
	for i := 0; i < MaxRetries; i++ {
		pods, err = clientset.CoreV1().Pods("").List(metav1.ListOptions{})
		if err != nil {
			WaitFor("list of all Pods", "returned")
		} else {
			break
		}
	}

	// Require that the Pods returned are not empty.
	require.NotEmpty(t, pods, "The Pods list returned should not be empty")

	// Attempt to validate each Pod has a "Ready" status.
	var readyCount int
	for _, pod := range pods.Items {
		podReady := false
		// Attempt to check if a Pod is ready, and output the resulting status.
		for i := 0; i < MaxRetries; i++ {
			if IsPodReady(clientset, &pod) {
				podReady = true
				readyCount++
				break
			} else {
				WaitFor(fmt.Sprintf("Pod %q", pod.Name), "ready")
			}
		}
		t.Logf("Pod: %s | Ready Status: %t\n", pod.Name, podReady)
	}

	// Validate that the readyCount is not 0, and matches the total Pods
	// returned.
	require.NotEqual(t, readyCount, 0, "No Pods are ready")
	require.Equal(t, readyCount, len(pods.Items),
		"%d out of %d Pods are ready", readyCount, len(pods.Items))

	t.Logf("%d out of %d Pods are ready", readyCount, len(pods.Items))
	fmt.Printf("%d out of %d Pods are ready\n", readyCount, len(pods.Items))
}

// IsKubeconfigValid checks that the kubeconfig provided is valid and error-free.
func IsKubeconfigValid(kubeconfig []byte) error {
	// Create a ClientConfig to confirm & validate that the kubeconfig provided is valid
	clientConfig, err := clientcmd.NewClientConfigFromBytes(kubeconfig)
	if err != nil {
		return err
	}

	// Get the raw ClientConfig API Config
	rawConfig, err := clientConfig.RawConfig()
	if err != nil {
		return err
	}

	// Confirms there are no errors or conflicts in the cliendcmd config.
	err = clientcmd.Validate(rawConfig)
	if err != nil {
		return err
	}

	return nil
}

// KubeAccess holds the Kubernetes client-go client bag of tools to work with the
// APIServer: the RESTConfig, and Clientset for the various API groups.
type KubeAccess struct {
	RESTConfig *restclient.Config
	Clientset  *kubernetes.Clientset
}

// KubeconfigToKubeAccess creates a KubeAccess object from a serialized kubeconfig.
func KubeconfigToKubeAccess(kubeconfig []byte) (*KubeAccess, error) {
	if err := IsKubeconfigValid(kubeconfig); err != nil {
		return nil, err
	}

	// Create a REST config that uses the current context in the kubeconfig.
	restConfig, err := clientcmd.RESTConfigFromKubeConfig(kubeconfig)
	if err != nil {
		return nil, err
	}

	// Create the Clientset using the REST config
	clientset, err := kubernetes.NewForConfig(restConfig)
	if err != nil {
		return nil, err
	}

	return &KubeAccess{
		restConfig,
		clientset,
	}, nil
}

// ClusterKubeAccessMap implements a map of Kubernetes cluster names to their
// respective KubeAccess bag.
type ClusterKubeAccessMap map[string]*KubeAccess

// MapClusterToKubeAccess creates a map of the EKS cluster name to its
// KubeAccess client tool bag, based on the kubeconfigs.
func MapClusterToKubeAccess(kubeconfigs ...interface{}) (ClusterKubeAccessMap, error) {
	// Map EKS cluster names to its KubeAccess.
	clusterToKubeAccess := make(ClusterKubeAccessMap)
	for _, kubeconfig := range kubeconfigs {
		// Convert kubconfig to KubeAccess
		kc, err := json.Marshal(kubeconfig)
		if err != nil {
			return nil, err
		}
		kubeAccess, err := KubeconfigToKubeAccess(kc)
		if err != nil {
			return nil, err
		}

		// Parse the kubeconfig user auth exec args for the cluster name.
		clusterName := kubeAccess.RESTConfig.ExecProvider.Args[2]
		clusterToKubeAccess[clusterName] = kubeAccess
	}

	return clusterToKubeAccess, nil
}

type cloudFormationTemplateBody struct {
	Resources struct {
		NodeGroup struct {
			Properties struct {
				DesiredCapacity int                 `yaml:"DesiredCapacity"`
				Tags            []map[string]string `yaml:"Tags"`
			} `yaml:"Properties"`
		} `yaml:"NodeGroup"`
	} `yaml:"Resources"`
}

// ClusterNodeCountMap implements a map of Kubernetes cluster names to their
// respective total desired worker Node count for *all* NodeGroups.
type ClusterNodeCountMap map[string]int

// MapClusterToNodeCount iterates through all Pulumi stack resources
// looking for CloudFormation template bodies to extract, and aggregate
// the total desired worker Node count per cluster in the Pulumi stack resources.
//
// Note: There can be many CF template bodies if multiple NodeGroups are used,
// but all NodeGroups belonging to the same cluster get their desired Node count
// aggregated into a total per cluster.
func MapClusterToNodeCount(resources []apitype.ResourceV3) (ClusterNodeCountMap, error) {
	clusterToNodeCount := make(ClusterNodeCountMap)

	// Map cluster to its NodeGroups.
	cfnPrefix := "arn:aws:cloudformation"
	for _, res := range resources {
		// Find CloudFormation resources
		if strings.HasPrefix(res.ID.String(), cfnPrefix) {
			var templateBody cloudFormationTemplateBody
			body := res.Outputs["templateBody"].(string)
			err := yaml.Unmarshal([]byte(body), &templateBody)
			if err != nil {
				return nil, err
			}

			// Find the CF "Name" tag to extract the cluster name.
			tags := templateBody.Resources.NodeGroup.Properties.Tags
			nameTag := ""
			for _, tag := range tags {
				if tag["Key"] == "Name" {
					nameTag = tag["Value"]
				}
			}
			clusterName := strings.Split(nameTag, "-worker")[0]

			// Update map of cluster name to total desired Node count.
			clusterToNodeCount[clusterName] =
				clusterToNodeCount[clusterName] +
					templateBody.Resources.NodeGroup.Properties.DesiredCapacity
		}
	}

	return clusterToNodeCount, nil
}
