"""
Pod Resource Monitor — Tool Logic

This module manages the "initial selection" state for the pod resource monitor.

When the AI assistant knows which pod the user wants to monitor, it passes
the pod_name and namespace to pod_resource_monitor(). This state is stored
in a module-level variable and consumed once by the dashboard UI on startup
via get_initial_pod_selection().

Flow:
  1. User asks: "Show me resources for pod X"
  2. AI calls: pod_resource_monitor(pod_name="X", namespace="default")
  3. This stores the selection and returns a confirmation message
  4. The dashboard UI opens and calls get_initial_pod_selection()
  5. The UI receives {"pod_name": "X", "namespace": "default"}
  6. The UI auto-selects that pod and begins polling metrics
"""

import json

# Module-level state: holds the pod that was pre-selected by the AI assistant.
# This is consumed once by get_initial_pod_selection() and then cleared.
_initial_selection: dict | None = None


def pod_resource_monitor(pod_name: str | None = None, namespace: str | None = None) -> str:
    """Store the pre-selected pod (if any) and signal the dashboard to open.

    Args:
        pod_name: Optional pod name to pre-select in the dashboard.
        namespace: Optional namespace of the pod.

    Returns:
        A confirmation message string.
    """
    global _initial_selection
    if pod_name:
        _initial_selection = {"pod_name": pod_name, "namespace": namespace}
    else:
        _initial_selection = None
    return "Opened pod resource monitor UI."


def get_initial_pod_selection() -> str:
    """Return and clear the pre-selected pod.

    Called once by the dashboard UI on startup. Returns a JSON string
    with the pod selection, or an empty object if no pod was pre-selected.
    """
    global _initial_selection
    selection = _initial_selection
    _initial_selection = None  # Consume the selection (one-time use)
    return json.dumps(selection or {})
