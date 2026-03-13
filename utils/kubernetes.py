"""
Kubernetes Client Utilities

Shared helpers for connecting to the Kubernetes API and serializing pod data.
Supports both in-cluster config (when running as a pod) and local kubeconfig
(for development with kind, minikube, etc.).
"""

from kubernetes import client, config
from kubernetes.client.exceptions import ApiException


def get_k8s_clients() -> tuple[client.CoreV1Api, client.CustomObjectsApi]:
    """Create authenticated Kubernetes API clients.

    Tries in-cluster config first (for running inside a pod), then falls
    back to local kubeconfig (for development).

    Returns:
        A tuple of (CoreV1Api, CustomObjectsApi) clients.
    """
    try:
        config.load_incluster_config()
    except config.ConfigException:
        config.load_kube_config()
    return client.CoreV1Api(), client.CustomObjectsApi()


def serialize_pod(pod: client.V1Pod) -> dict:
    """Convert a Kubernetes V1Pod object into a plain dictionary.

    Extracts the key information the dashboard needs:
      - Pod metadata (name, namespace, status, node)
      - Container names
      - Resource requests and limits per container

    Args:
        pod: A Kubernetes V1Pod object from the API.

    Returns:
        A dictionary with pod details suitable for JSON serialization.
    """
    return {
        "name": pod.metadata.name,
        "namespace": pod.metadata.namespace,
        "status": pod.status.phase,
        "node": pod.spec.node_name,
        "containers": [c.name for c in pod.spec.containers],
        "requests": {
            c.name: {
                "cpu": (c.resources.requests or {}).get("cpu", "N/A"),
                "memory": (c.resources.requests or {}).get("memory", "N/A"),
            }
            for c in pod.spec.containers
            if c.resources
        },
        "limits": {
            c.name: {
                "cpu": (c.resources.limits or {}).get("cpu", "N/A"),
                "memory": (c.resources.limits or {}).get("memory", "N/A"),
            }
            for c in pod.spec.containers
            if c.resources
        },
    }
