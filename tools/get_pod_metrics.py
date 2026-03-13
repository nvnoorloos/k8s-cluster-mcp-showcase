"""
Get Pod Metrics — Tool Logic

Fetches live CPU and memory usage for a specific pod from the Kubernetes
Metrics API (metrics.k8s.io/v1beta1). This requires a metrics-server to
be running in the cluster.

The dashboard polls this tool every second to update the live usage bars.
"""

import json

from kubernetes.client.exceptions import ApiException

from utils.kubernetes import get_k8s_clients


def get_pod_metrics(pod_name: str, namespace: str) -> str:
    """Fetch current CPU and memory usage for a pod from the Kubernetes Metrics API.

    Args:
        pod_name: Name of the pod.
        namespace: Namespace of the pod.

    Returns:
        JSON string with per-container CPU/memory usage, or an error message
        if the metrics-server is unavailable or the pod is not found.
    """
    _, custom_api = get_k8s_clients()

    try:
        # Query the metrics.k8s.io API for real-time pod resource usage
        metrics = custom_api.get_namespaced_custom_object(
            group="metrics.k8s.io",
            version="v1beta1",
            namespace=namespace,
            plural="pods",
            name=pod_name,
        )
    except ApiException as e:
        if e.status == 404:
            return json.dumps(
                {"error": f"Metrics not found for pod {pod_name} in {namespace}. Is metrics-server running?"}
            )
        raise

    # Extract per-container CPU and memory usage values
    containers = []
    for container in metrics.get("containers", []):
        usage = container.get("usage", {})
        containers.append(
            {
                "name": container["name"],
                "cpu": usage.get("cpu", "0"),       # e.g. "15234n" (nanocores)
                "memory": usage.get("memory", "0"),  # e.g. "32768Ki" (kibibytes)
            }
        )

    return json.dumps(
        {
            "pod": pod_name,
            "namespace": namespace,
            "timestamp": metrics.get("timestamp", ""),
            "containers": containers,
        }
    )
