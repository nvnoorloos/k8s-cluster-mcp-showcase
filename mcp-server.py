"""
k8s-cluster-mcp — MCP Server for Kubernetes Pod Resource Monitoring

This is the main entry point for the MCP (Model Context Protocol) server.
It registers tools that allow an AI assistant to:

  1. Open an interactive pod resource monitoring dashboard (the "app")
  2. List all running pods in the cluster
  3. Fetch live CPU/memory metrics for a specific pod

The server uses FastMCP (https://gofastmcp.com) which provides:
  - Tool registration via @mcp.tool() decorators
  - App support via AppConfig for rich UI rendering
  - Resource serving for the HTML dashboard
  - Streamable HTTP transport for communication with clients

Architecture:
  Client (e.g. VS Code Copilot) <-> MCP Server <-> Kubernetes API
                                         |
                                    HTML Dashboard
                                    (served as MCP App)
"""

from pathlib import Path

from fastmcp import FastMCP
from fastmcp.server.apps import AppConfig
from fastmcp.server.context import Context

from tools.get_pod_metrics import get_pod_metrics as _get_pod_metrics
from tools.list_running_pods import list_running_pods as _list_running_pods
from tools.pod_resource_monitor import (
    get_initial_pod_selection as _get_initial_pod_selection,
    pod_resource_monitor as _pod_resource_monitor,
)
from sampling.optimize_kubernetes_pod_resources import (
    optimize_pod_resources as _optimize_pod_resources,
)

# Path to the built single-file HTML dashboard.
# Produced by `npm run build` in the ui/ directory (Vite + vite-plugin-singlefile).
UI_HTML_PATH = Path(__file__).parent / "ui" / "dist" / "src" / "pod_resource_monitor" / "index.html"

# ── Create the MCP Server ───────────────────────────────────────────────
# The `instructions` field tells the AI assistant when and how to use this
# server's tools. The assistant reads these instructions to decide which
# tool to call for a given user request.
# See: https://gofastmcp.com/servers/fastmcp#instructions
mcp = FastMCP(
    "k8s-cluster-mcp",
    instructions=(
        "Kubernetes cluster resource monitoring and optimization. "
        "IMPORTANT: For ANY question about pod resources, CPU, memory, metrics, "
        "usage, or performance, ALWAYS call pod_resource_monitor. "
        "When pod_resource_monitor is called, open the dashboard and do not add "
        "explanatory or summary text unless the user explicitly asks for analysis. "
        "When asked to OPTIMIZE a specific pod's resources, call optimize_pod_resources "
        "with the pod name and namespace. "
        "NEVER call list_running_pods or get_pod_metrics_tool directly — "
        "those are internal helpers used only by the monitoring UI."
    ),
)


# ── UI Resource ──────────────────────────────────────────────────────────
# Serve the dashboard HTML as an MCP resource. The MCP client fetches this
# to render the monitoring UI inline.
# See: https://gofastmcp.com/servers/resources
@mcp.resource("ui://k8s-cluster/pod-monitor.html", mime_type="text/html")
def pod_monitor_html() -> str:
    return UI_HTML_PATH.read_text()


# ── Primary Tool: Pod Resource Monitor ──────────────────────────────────
# This is the main tool the AI assistant calls. It opens a rich interactive
# dashboard as an MCP "app" — a tool that renders a UI in the client.
#
# The `app=AppConfig(...)` parameter tells FastMCP to render the linked
# resource as an interactive app when this tool is invoked.
# See: https://gofastmcp.com/servers/apps
@mcp.tool(
    app=AppConfig(resource_uri="ui://k8s-cluster/pod-monitor.html"),
)
def pod_resource_monitor(pod_name: str | None = None, namespace: str | None = None) -> str:
    """Show an interactive live dashboard for monitoring CPU and memory usage
    of pods in the Kubernetes cluster.

    ALWAYS use this tool for ANY question about pod resources, CPU, memory,
    metrics, usage, limits, requests, or performance.

    This opens a rich visual UI with pod selection and live metrics.
    After calling this tool, do not narrate the dashboard contents unless
    the user explicitly asks.

    If a specific pod is known, pass pod_name and namespace to pre-select
    it in the dashboard."""
    return _pod_resource_monitor(pod_name, namespace)


# ── Sampling Tool: Optimize Pod Resources ────────────────────────────────
# This tool demonstrates MCP Sampling — a feature where the server requests
# the client's LLM to generate text. The tool fetches real pod data from
# Kubernetes, then calls ctx.sample() to ask the AI to analyze it.
#
# The `ctx: Context` parameter is injected by FastMCP's dependency system.
# See: https://gofastmcp.com/servers/sampling
# See: https://gofastmcp.com/servers/context
@mcp.tool()
async def optimize_pod_resources(pod_name: str, namespace: str, ctx: Context) -> str:
    """Analyze a Kubernetes pod's resource usage and suggest optimized
    CPU/memory requests and limits.

    Uses MCP Sampling to delegate the analysis to the connected LLM.
    The server fetches real pod data, then asks the AI to reason about it.

    Args:
        pod_name: Name of the pod to optimize.
        namespace: Namespace of the pod."""
    return await _optimize_pod_resources(pod_name, namespace, ctx)


# ── Internal Tools (called by the dashboard UI, not for direct use) ─────
# These tools are invoked by the JavaScript running inside the dashboard.
# The dashboard uses `app.callServerTool(...)` from @modelcontextprotocol/ext-apps
# to communicate back to this server.
# See: https://gofastmcp.com/servers/tools

@mcp.tool()
def get_initial_pod_selection() -> str:
    """Internal: called by the pod_resource_monitor UI on startup to check
    if a pod was pre-selected. Do NOT call directly."""
    return _get_initial_pod_selection()


@mcp.tool()
def list_running_pods() -> str:
    """Internal: returns all running pods in the cluster as JSON.
    Called by the dashboard UI to populate the pod dropdown. Do NOT call directly."""
    return _list_running_pods()


@mcp.tool()
def get_pod_metrics_tool(pod_name: str, namespace: str) -> str:
    """Internal: returns live CPU/memory metrics for a specific pod.
    Called by the dashboard on a 1-second polling interval. Do NOT call directly."""
    return _get_pod_metrics(pod_name, namespace)


# ── Health Check ─────────────────────────────────────────────────────────
# Simple HTTP health endpoint used by Kubernetes readiness/liveness probes.
@mcp.custom_route("/health", methods=["GET"])
async def health_check(request):
    from starlette.responses import JSONResponse

    return JSONResponse({"status": "ok"})


# ── Run the Server ───────────────────────────────────────────────────────
# Start the MCP server using Streamable HTTP transport on port 8000.
# See: https://gofastmcp.com/servers/fastmcp#running-the-server
if __name__ == "__main__":
    mcp.run(transport="streamable-http", host="0.0.0.0", port=8000)
