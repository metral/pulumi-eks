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
// attempted to be fetched from the Kubernetes API Server. All transient
// request attempts count towards the retries.
const MaxRetries = 12

// RetryInterval is the number of seconds to sleep in between requests
// to the Kubernetes API Server.
const RetryInterval = 10

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

	for !awsAuthReady && retries > 0 {
		awsAuth, err = clientset.CoreV1().ConfigMaps(namespace).Get(configMapName, metav1.GetOptions{})
		if err != nil {
			fmt.Printf("Waiting for '%s' ConfigMap to be returned. Retrying...\n", configMapName)
			retries--
			time.Sleep(RetryInterval * time.Second)
			continue
		}
		awsAuthReady = true
		break
	}

	require.Equal(t, true, awsAuthReady, "EKS ConfigMap '%s' does not exist in namespace '%s'", configMapName, namespace)
	require.NotNil(t, awsAuth.Data, "%s ConfigMap should not be nil", configMapName)
	require.NotEmpty(t, awsAuth.Data, "'%s' ConfigMap should not be empty", configMapName)
	fmt.Printf("EKS ConfigMap '%s' exists and has data\n", configMapName)
	t.Logf("EKS ConfigMap '%s' exists and has data:\n%s", configMapName, awsAuth.Data)
}

// AssertAllNodesReady ensures that all nodes are running & have a "Ready"
// status condition.
func AssertAllNodesReady(t *testing.T, clientset *kubernetes.Clientset, desiredNodeCount int) {
	var nodes *v1.NodeList
	var err error

	fmt.Printf("Total Desired Worker Node Count: %d\n", desiredNodeCount)

	// Validate that the desired worker node count of instances are running.
	retries := MaxRetries
	for retries > 0 {
		nodes, err = clientset.CoreV1().Nodes().List(metav1.ListOptions{})
		if err != nil || desiredNodeCount != len(nodes.Items) {
			fmt.Printf("Waiting for a desired worker Node count of (%d) instances to be running. Retrying...\n", desiredNodeCount)
			retries--
			time.Sleep(RetryInterval * time.Second)
		} else {
			break
		}
	}

	require.NotEmpty(t, nodes, "The Nodes list returned should not be empty")
	require.Equal(t, desiredNodeCount, len(nodes.Items),
		"%d out of %d desired worker nodes are instantiated and running", len(nodes.Items), desiredNodeCount)

	// Validate each node has a "Ready" status.
	i, readyCount := 0, 0
	nodeReady, retries := false, MaxRetries
	for i < len(nodes.Items) && retries > 0 {
		node := nodes.Items[i]
		n, err := clientset.CoreV1().Nodes().Get(node.Name, metav1.GetOptions{})
		if err != nil {
			fmt.Printf("Waiting for Node '%s' to be returned. Retrying...\n", node.Name)
			retries--
			time.Sleep(RetryInterval * time.Second)
			continue
		}
		for _, condition := range n.Status.Conditions {
			if condition.Type == "Ready" {
				nodeReady = condition.Status == "True"
			}
		}
		if nodeReady {
			readyCount++
			t.Logf("Node: %s | Ready Status: %t\n", node.Name, nodeReady)
			i++ // reset vars for next run
			nodeReady = false
			retries = MaxRetries
			continue
		}
		retries--
		if retries == 0 {
			t.Logf("Node: %s | Ready Status: %t\n", node.Name, nodeReady)
			i++ // reset vars for next run
			nodeReady = false
			retries = MaxRetries
		} else {
			fmt.Printf("Waiting for Node '%s' to be ready. Retrying...\n", node.Name)
			time.Sleep(RetryInterval * time.Second)
		}
	}
	require.Equal(t, readyCount, len(nodes.Items),
		"%d out of %d Nodes are ready", readyCount, len(nodes.Items))

	t.Logf("%d out of %d Nodes are ready", readyCount, len(nodes.Items))
	fmt.Printf("%d out of %d Nodes are ready\n", readyCount, len(nodes.Items))
}

// AssertAllPodsReady ensures all pods have a "Running" or "Succeeded" status
// phase, and a "Ready" status condition.
func AssertAllPodsReady(t *testing.T, clientset *kubernetes.Clientset) {
	var pods *v1.PodList
	var err error

	// Assume first non-error return of a list of pods is correct, as we
	// currently do not know how many pods to anticipate in the cluster before
	// it has been stood up.
	retries := MaxRetries
	for retries > 0 {
		pods, err = clientset.CoreV1().Pods("").List(metav1.ListOptions{})
		if err != nil {
			fmt.Printf("Waiting for the list of all Pods to be returned. Retrying...\n")
			retries--
			time.Sleep(RetryInterval * time.Second)
		} else {
			break
		}
	}

	require.NotEmpty(t, pods, "The Pods list returned should not be empty")

	// Validate each pod has a "Running" or "Succeeded" status phase,
	// and has a "Ready" status condition.
	i, readyCount := 0, 0
	podReady, retries := false, MaxRetries
	for i < len(pods.Items) && retries > 0 {
		pod := pods.Items[i]
		p, err := clientset.CoreV1().Pods(pod.Namespace).Get(pod.Name, metav1.GetOptions{})
		if err != nil {
			retries--
			fmt.Printf("Waiting for Pod '%s' to be returned. Retrying...\n", pod.Name)
			time.Sleep(RetryInterval * time.Second)
			continue
		}
		if p.Status.Phase == "Running" || p.Status.Phase == "Succeeded" {
			for _, condition := range p.Status.Conditions {
				if condition.Type == "Ready" {
					podReady = condition.Status == "True"
				}
			}
		}
		if podReady {
			readyCount++
			t.Logf("Pod: %s | Ready Status: %t\n", pod.Name, podReady)
			i++ // reset vars for next run
			podReady = false
			retries = MaxRetries
			continue
		}
		retries--
		if retries == 0 {
			t.Logf("Pod: %s | Ready Status: %t\n", pod.Name, podReady)
			i++ // reset vars for next run
			podReady = false
			retries = MaxRetries
		} else {
			fmt.Printf("Waiting for Pod '%s' to be ready. Retrying...\n", pod.Name)
			time.Sleep(RetryInterval * time.Second)
		}
	}

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

// KubeAccess holds the Kubernetes client-go RESTConfig and Clientset
// for the various API groups.
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

// MapClusterToKubeAccess creates a map of the Kubernetes cluster name to a
// its KubeAccess bag for all Pulumi kubeconfig outputs in a stack, to be able
// to programmatically access any given cluster by referencing its name.
func MapClusterToKubeAccess(outputs ...interface{}) (ClusterKubeAccessMap, error) {
	clusterToKubeAccess := make(ClusterKubeAccessMap)

	// Map cluster to its kubeconfig clientset.
	for _, output := range outputs {
		kubeconfig, err := json.Marshal(output)
		if err != nil {
			return nil, err
		}
		kubeAccess, err := KubeconfigToKubeAccess(kubeconfig)
		if err != nil {
			return nil, err
		}
		// TODO(metral): find alt. approach to discovering which cluster a
		// kubeconfig belongs to
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
// total desired worker node count for all NodeGroups in the cluster.
type ClusterNodeCountMap map[string]int

// MapClusterToNodeCount iterates through all Pulumi stack resources
// looking for CloudFormation template bodies to extract the desired worker
// node count for each cluster in the stack.
// Note: there can be many template bodies if multiple NodeGroups are used, but
// all NodeGroups belonging to the same cluster get their desired node count
// aggregated per cluster.
func MapClusterToNodeCount(resources []apitype.ResourceV3) (ClusterNodeCountMap, error) {
	clusterToNodeCount := make(ClusterNodeCountMap)

	// Map cluster to its NodeGroups.
	cfnPrefix := "arn:aws:cloudformation"
	for _, res := range resources {
		if strings.HasPrefix(res.ID.String(), cfnPrefix) {
			var templateBody cloudFormationTemplateBody
			body := res.Outputs["templateBody"].(string)
			err := yaml.Unmarshal([]byte(body), &templateBody)
			if err != nil {
				return nil, err
			}

			// TODO(metral): find alt. approach to discovering which cluster a
			// NodePool belongs to
			tags := templateBody.Resources.NodeGroup.Properties.Tags
			nameTag := ""
			for _, tag := range tags {
				if tag["Key"] == "Name" {
					nameTag = tag["Value"]
				}
			}
			clusterName := strings.Split(nameTag, "-worker")[0]
			clusterToNodeCount[clusterName] =
				clusterToNodeCount[clusterName] +
					templateBody.Resources.NodeGroup.Properties.DesiredCapacity
		}
	}

	return clusterToNodeCount, nil
}
