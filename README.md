# k8s-cluster-mcp

A Model Context Protocol (MCP) server that provides a **live, interactive Kubernetes pod resource monitoring dashboard** — directly inside your AI coding assistant.

<img src="https://raw.githubusercontent.com/nvnoorloos/k8s-cluster-mcp-showcase/refs/heads/main/showcase-k8s-cluster-mcp.gif" alt="k8s-cluster-mcp" width="80%">

## What it does

When you ask your AI assistant about Kubernetes pod resources, it opens a rich interactive dashboard that shows:

- **Live CPU and memory usage** with real-time polling (1-second intervals)
- **Resource requests and limits** per container
- **Usage percentage bars** with color-coded warnings
- **Pod selector** to switch between pods across all namespaces

The dashboard is rendered as an [MCP App](https://apps.extensions.modelcontextprotocol.io/api/) — a tool that returns a full HTML/CSS/JS UI, displayed inline in your AI assistant.

## Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [kind](https://kind.sigs.k8s.io/docs/user/quick-start/#installation) (Kubernetes in Docker)
- [kubectl](https://kubernetes.io/docs/tasks/tools/)

### One-Command Demo

```bash
./showcase-k8s-cluster-mcp.sh
```

This will:
1. Create a kind cluster with metrics-server
2. Deploy a demo pod with fluctuating CPU/memory usage
3. Build and deploy the MCP server
4. Start port-forwarding on `localhost:8000`
5. Print prompts to try in your AI assistant

### Connect Your MCP Client

Add to your MCP client configuration (tested with GitHub Copilot):

```json
{
  "mcp": {
    "servers": {
      "k8s-cluster-mcp": {
        "type": "http",
        "url": "http://localhost:8000/mcp"
      }
    }
  }
}
```

Then try these prompts:

| Prompt | What happens |
|--------|-------------|
| "Show me pod resource usage" | Opens the dashboard to select a pod |
| "Show me the resources of the mcp-showcase-pod" | Opens the dashboard with the demo pod pre-selected |

## How it Works

### Architecture

```
┌─────────────────────────┐     ┌───────────────────────┐     ┌──────────────┐
│  AI Assistant (Client)  │────▸│  MCP Server (FastMCP) │────▸│ Kubernetes   │
│  e.g. GitHub Copilot    │◂────│  Port 8000            │◂────│ API + Metrics│
└─────────────────────────┘     └───────────────────────┘     └──────────────┘
         │                              │
         │    Opens MCP App             │ Serves HTML
         └──────────────────────────────┘
```

### MCP Concepts Used

This project demonstrates four key MCP features:

#### 1. Tools ([FastMCP docs](https://gofastmcp.com/servers/tools))

Tools are functions the AI assistant can call. This server registers four tools:

- **`pod_resource_monitor`** — The primary tool. Opens the monitoring dashboard.
- **`optimize_pod_resources`** — Uses Sampling to get AI-powered optimization advice.
- **`get_initial_pod_selection`** — Returns the pre-selected pod (internal).
- **`list_running_pods`** — Returns all running pods as JSON (internal).
- **`get_pod_metrics_tool`** — Returns live CPU/memory for a pod (internal).

#### 2. Apps ([FastMCP docs](https://gofastmcp.com/apps/overview))

An MCP App is a tool that renders a rich HTML UI in the client. The `pod_resource_monitor` tool uses `AppConfig` to link to an HTML resource:

```python
@mcp.tool(
    app=AppConfig(resource_uri="ui://k8s-cluster/pod-monitor.html"),
)
def pod_resource_monitor(...):
    ...
```

The HTML dashboard uses [`@modelcontextprotocol/ext-apps`](https://www.npmjs.com/package/@modelcontextprotocol/ext-apps) to call server tools from the browser:

```typescript
const app = new App({ name: "PodMonitor", version: "1.0.0" });
const result = await app.callServerTool({
  name: "get_pod_metrics_tool",
  arguments: { pod_name: "my-pod", namespace: "default" },
});
```

#### 3. Resources ([FastMCP docs](https://gofastmcp.com/servers/resources))

The dashboard HTML is served as an MCP Resource with a custom URI scheme:

```python
@mcp.resource("ui://k8s-cluster/pod-monitor.html", mime_type="text/html")
def pod_monitor_html() -> str:
    return UI_HTML_PATH.read_text()
```

#### 4. Sampling ([FastMCP docs](https://gofastmcp.com/servers/sampling))

Sampling allows the server to request the client's LLM to generate text during tool execution. The `optimize_pod_resources` tool demonstrates this:

1. Fetches real pod resource data from the Kubernetes API
2. Fetches live CPU/memory metrics from the metrics-server
3. Calls `ctx.sample()` — sending the data back to the client's LLM for analysis
4. Returns the LLM's optimization recommendations

```python
@mcp.tool()
async def optimize_pod_resources(pod_name: str, namespace: str, ctx: Context) -> str:
    # ... fetch pod data from Kubernetes ...
    result = await ctx.sample(
        messages=prompt,
        system_prompt="You are a Kubernetes resource optimization expert...",
        max_tokens=1024,
    )
    return result.text
```

The server doesn't need its own LLM — it leverages the one the user is already connected to.

### Server Instructions ([FastMCP docs](https://gofastmcp.com/servers/server#param-instructions))

The server provides `instructions` that guide the AI assistant on when to use this server:

```python
mcp = FastMCP(
    "k8s-cluster-mcp",
    instructions="For ANY question about pod resources, ALWAYS call pod_resource_monitor...",
)
```

## Project Structure

```
├── mcp-server.py                 # MCP server entry point (FastMCP)
├── tools/
│   ├── pod_resource_monitor.py   # Dashboard open/selection logic
│   ├── list_running_pods.py      # List pods from Kubernetes API
│   └── get_pod_metrics.py        # Fetch live metrics from metrics-server
├── sampling/
│   └── optimize_kubernetes_pod_resources.py  # Sampling example (ctx.sample)
├── utils/
│   └── kubernetes.py             # Kubernetes client helpers
├── ui/
│   └── src/
│       └── pod_resource_monitor/
│           ├── index.html        # Dashboard HTML
│           ├── app.ts            # Dashboard logic (TypeScript)
│           └── app.css           # Dashboard styles
├── k8s/
│   ├── deployment.yaml           # MCP server deployment
│   ├── rbac.yaml                 # Service account & permissions
│   └── demo-pod.yaml             # Demo pod for the showcase
├── Dockerfile                    # Multi-stage build (UI + Python)
├── requirements.txt              # Python dependencies
└── showcase-k8s-cluster-mcp.sh   # One-command demo setup
```

## Development

### Building Manually

```bash
# Build the UI
cd ui && npm install && npm run build && cd ..

# Run the MCP server locally (requires kubectl access to a cluster)
pip install -r requirements.txt
python mcp-server.py
```

### Requirements

- Python 3.12+
- Node.js 20+ (for building the UI)
- A Kubernetes cluster with metrics-server
