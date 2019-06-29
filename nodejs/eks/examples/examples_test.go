// Copyright 2016-2019, Pulumi Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package examples

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"os"
	"os/exec"
	"path"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"github.com/pulumi/pulumi-eks/utils"
	"github.com/pulumi/pulumi/pkg/testing/integration"
)

func Test_Examples(t *testing.T) {
	t.Parallel()
	region := os.Getenv("AWS_REGION")
	if region == "" {
		t.Skipf("Skipping test due to missing AWS_REGION environment variable")
	}
	fmt.Printf("AWS Region: %v\n", region)

	cwd, err := os.Getwd()
	if !assert.NoError(t, err, "expected a valid working directory: %v", err) {
		return
	}

	shortTests := []integration.ProgramTestOptions{
		{
			Dir: path.Join(cwd, "./cluster"),
			Config: map[string]string{
				"aws:region": region,
			},
			Dependencies: []string{
				"@pulumi/eks",
			},
			ExpectRefreshChanges: true,
			ExtraRuntimeValidation: func(t *testing.T, info integration.RuntimeValidationStackInfo) {
				utils.RunEKSSmokeTest(t,
					info.Deployment.Resources,
					info.Outputs["kubeconfig1"],
					info.Outputs["kubeconfig2"],
				)
			},
		},
		{
			Dir: path.Join(cwd, "./nodegroup"),
			Config: map[string]string{
				"aws:region": region,
			},
			Dependencies: []string{
				"@pulumi/eks",
			},
			ExpectRefreshChanges: true,
			ExtraRuntimeValidation: func(t *testing.T, info integration.RuntimeValidationStackInfo) {
				utils.RunEKSSmokeTest(t,
					info.Deployment.Resources,
					info.Outputs["kubeconfig1"],
					info.Outputs["kubeconfig2"],
				)
			},
		},
		{
			Dir: path.Join(cwd, "./private-cluster"),
			Config: map[string]string{
				"aws:region": region,
			},
			Dependencies: []string{
				"@pulumi/eks",
			},
			ExpectRefreshChanges: true,
			ExtraRuntimeValidation: func(t *testing.T, info integration.RuntimeValidationStackInfo) {
				utils.RunEKSSmokeTest(t,
					info.Deployment.Resources,
					info.Outputs["kubeconfig"],
				)
			},
		},
		{
			Dir: path.Join(cwd, "./tags"),
			Config: map[string]string{
				"aws:region": region,
			},
			Dependencies: []string{
				"@pulumi/eks",
			},
			ExpectRefreshChanges: true,
			ExtraRuntimeValidation: func(t *testing.T, info integration.RuntimeValidationStackInfo) {
				utils.RunEKSSmokeTest(t,
					info.Deployment.Resources,
					info.Outputs["kubeconfig1"],
					info.Outputs["kubeconfig2"],
				)
			},
		},
		{
			Dir: path.Join(cwd, "migrate-nodegroups"),
			Config: map[string]string{
				"aws:region": region,
			},
			Dependencies: []string{
				"@pulumi/eks",
			},
			ExpectRefreshChanges: true,
			EditDirs: []integration.EditDir{
				// Add the new, 4xlarge node group
				{
					Dir:      path.Join(cwd, "migrate-nodegroups", "steps", "step1"),
					Additive: true,
					ExtraRuntimeValidation: func(t *testing.T, stack integration.RuntimeValidationStackInfo) {
						maxWait := 10 * time.Minute
						endpoint := fmt.Sprintf("%s/echoserver", stack.Outputs["nginxServiceUrl"].(string))
						headers := map[string]string{
							"Host": "apps.example.com",
						}
						utils.AssertHTTPResultWithRetry(t, endpoint, headers, maxWait, func(body string) bool {
							return assert.NotEmpty(t, body, "Body should not be empty")
						})
					},
				},
				// Retarget NGINX to node select 4xlarge nodegroup, and force
				// its migration via rolling update. Then drain & delete
				// 2xlarge node group from k8s.
				{
					Dir:      path.Join(cwd, "migrate-nodegroups", "steps", "step2"),
					Additive: true,
					ExtraRuntimeValidation: func(t *testing.T, stack integration.RuntimeValidationStackInfo) {
						maxWait := 10 * time.Minute
						endpoint := fmt.Sprintf("%s/echoserver", stack.Outputs["nginxServiceUrl"].(string))
						headers := map[string]string{
							"Host": "apps.example.com",
						}
						utils.AssertHTTPResultWithRetry(t, endpoint, headers, maxWait, func(body string) bool {
							return assert.NotEmpty(t, body, "Body should not be empty")
						})

						var err error
						var out []byte
						scriptsDir := path.Join(cwd, "migrate-nodegroups", "scripts")

						// Wait for all pods across all namespaces to be ready after migration
						kubeconfig, err := json.Marshal(stack.Outputs["kubeconfig"])
						kubeAccess, err := utils.KubeconfigToKubeAccess(kubeconfig)
						if !assert.NoError(t, err, "expected kubeconfig clients to be created: %v", err) {
							return
						}
						utils.AssertAllPodsReady(t, kubeAccess.Clientset)

						// Drain & delete t3.2xlarge node group
						// TODO(metral): look into draining & deleting using
						// client-go instead of shell'ing out to kubectl

						// Write kubeconfig from stack to temp file for use
						// with kubectl drain & delete.
						if !assert.NoError(t, err, "expected kubeconfig json marshaling to not error: %v", err) {
							return
						}
						kubeconfigFile, err := ioutil.TempFile(os.TempDir(), "kubeconfig-*.json")
						if !assert.NoError(t, err, "expected tempfile to be created: %v", err) {
							return
						}
						fmt.Printf("kubeconfigFile: %s", kubeconfigFile.Name())
						defer os.Remove(kubeconfigFile.Name())
						_, err = kubeconfigFile.Write(kubeconfig)
						if !assert.NoError(t, err, "expected kubeconfig to be written to tempfile with no error: %v", err) {
							return
						}
						os.Setenv("KUBECONFIG", kubeconfigFile.Name())
						defer os.Remove(kubeconfigFile.Name())
						err = kubeconfigFile.Close()
						if !assert.NoError(t, err, "expected kubeconfig file to close with no error: %v", err) {
							return
						}

						// Exec kubectl drain
						out, err = exec.Command("/bin/bash", path.Join(scriptsDir, "drain-t3.2xlarge-nodes.sh")).Output()
						if !assert.NoError(t, err, "expected no errors during kubectl drain: %v", err) {
							return
						}
						t.Logf("kubectl drain output:%s", out)

						// Exec kubectl delete
						out, err = exec.Command("/bin/bash", path.Join(scriptsDir, "delete-t3.2xlarge-nodes.sh")).Output()
						if !assert.NoError(t, err, "expected no errors during kubectl delete: %v", err) {
							return
						}
						t.Logf("kubectl delete output:%s", out)
					},
				},
				// Remove the 2xlarge node group
				{
					Dir:      path.Join(cwd, "migrate-nodegroups", "steps", "step3"),
					Additive: true,
					ExtraRuntimeValidation: func(t *testing.T, stack integration.RuntimeValidationStackInfo) {
						maxWait := 10 * time.Minute
						endpoint := fmt.Sprintf("%s/echoserver", stack.Outputs["nginxServiceUrl"].(string))
						headers := map[string]string{
							"Host": "apps.example.com",
						}
						utils.AssertHTTPResultWithRetry(t, endpoint, headers, maxWait, func(body string) bool {
							return assert.NotEmpty(t, body, "Body should not be empty")
						})
					},
				},
			},
		},
	}

	longTests := []integration.ProgramTestOptions{}

	tests := shortTests
	if !testing.Short() {
		tests = append(tests, longTests...)
	}

	for _, ex := range tests {
		example := ex.With(integration.ProgramTestOptions{
			ReportStats: integration.NewS3Reporter("us-west-2", "eng.pulumi.com", "testreports"),
			Tracing:     "https://tracing.pulumi-engineering.com/collector/api/v1/spans",
		})
		t.Run(example.Dir, func(t *testing.T) {
			integration.ProgramTest(t, &example)
		})
	}
}
