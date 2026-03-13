"""
List Running Pods — Tool Logic

Returns all pods in the cluster with status "Running" as a JSON array.
Each pod includes metadata (name, namespace, status, node), container names,
and resource requests/limits — used by the dashboard to populate the pod
dropdown and display resource configuration alongside live metrics.
"""

import json

from utils.kubernetes import get_k8s_clients, serialize_pod


def list_running_pods() -> str:
    """Fetch all running pods across all namespaces from the Kubernetes API.

    Returns:
        JSON string containing an array of serialized pod objects.
    """
    core_v1, _ = get_k8s_clients()
    pods = core_v1.list_pod_for_all_namespaces(field_selector="status.phase=Running")
    return json.dumps([serialize_pod(pod) for pod in pods.items])
