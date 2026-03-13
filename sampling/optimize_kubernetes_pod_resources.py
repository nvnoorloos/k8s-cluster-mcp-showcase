"""
Optimize Kubernetes Pod Resources — Sampling Example

This module demonstrates MCP Sampling, a feature that allows the server
to request the connected AI/LLM to generate text during tool execution.

How sampling works:
  1. The user asks the AI assistant to optimize a pod's resources.
  2. The AI calls the `optimize_pod_resources` tool on this server.
  3. Inside the tool, we fetch real data from the Kubernetes API:
     - Current resource requests and limits (from the pod spec)
     - Live CPU and memory usage (from the metrics-server)
  4. We call `ctx.sample()` — which sends a prompt BACK to the
     client's LLM — asking it to analyze the data and produce
     structured optimization recommendations as JSON.
  5. The structured JSON response is returned as the tool result.

This is a "server-initiated LLM call": the server gathers data,
then delegates the reasoning to the AI. The client controls which
LLM is used and how the request is processed.

See: https://gofastmcp.com/servers/sampling
"""

import json

from fastmcp.server.context import Context

from utils.kubernetes import get_k8s_clients


def _extract_json_object(text: str) -> dict | None:
    """Extract a JSON object from LLM output, handling markdown fences."""
    candidate = text.strip()
    if candidate.startswith("```"):
        lines = candidate.splitlines()
        if len(lines) >= 3:
            candidate = "\n".join(lines[1:-1]).strip()

    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        start = candidate.find("{")
        end = candidate.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return None
        try:
            parsed = json.loads(candidate[start : end + 1])
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            return None


async def optimize_pod_resources(pod_name: str, namespace: str, ctx: Context) -> str:
    """Analyze a pod's resource usage and generate optimization recommendations.

    This tool:
      1. Fetches the pod's configured resource requests/limits from the K8s API
      2. Fetches the pod's live CPU/memory usage from the metrics-server
      3. Uses MCP Sampling (ctx.sample) to ask the LLM to analyze the data
         and return a structured JSON recommendation

    Args:
        pod_name: Name of the pod to analyze.
        namespace: Kubernetes namespace of the pod.
        ctx: MCP Context — injected automatically by FastMCP. Provides
             access to sampling, logging, and other MCP features.

    Returns:
        JSON string with structured optimization guidance.
    """
    await ctx.info(f"Fetching resource data for pod {pod_name} in {namespace}...")

    # ── Step 1: Get the pod's configured resource requests and limits ───
    core_v1, custom_api = get_k8s_clients()
    pod = core_v1.read_namespaced_pod(name=pod_name, namespace=namespace)

    container_specs = []
    for container in pod.spec.containers:
        requests = container.resources.requests if container.resources and container.resources.requests else {}
        limits = container.resources.limits if container.resources and container.resources.limits else {}
        container_specs.append({
            "name": container.name,
            "requests": {"cpu": requests.get("cpu", "none"), "memory": requests.get("memory", "none")},
            "limits": {"cpu": limits.get("cpu", "none"), "memory": limits.get("memory", "none")},
        })

    # ── Step 2: Get live metrics from the metrics-server ────────────────
    metrics_timestamp = ""
    try:
        metrics = custom_api.get_namespaced_custom_object(
            group="metrics.k8s.io",
            version="v1beta1",
            namespace=namespace,
            plural="pods",
            name=pod_name,
        )
        metrics_timestamp = metrics.get("timestamp", "")
        container_metrics = [
            {
                "name": c["name"],
                "current_cpu": c.get("usage", {}).get("cpu", "unknown"),
                "current_memory": c.get("usage", {}).get("memory", "unknown"),
            }
            for c in metrics.get("containers", [])
        ]
    except Exception as e:
        await ctx.warning(f"Could not fetch live metrics: {e}")
        container_metrics = [{"name": cs["name"], "current_cpu": "unavailable", "current_memory": "unavailable"} for cs in container_specs]

    # ── Step 3: Build the sampling prompt ───────────────────────────────
    # Combine specs and metrics into a single data payload for the LLM.
    pod_data = {
        "pod": pod_name,
        "namespace": namespace,
        "containers": [
            {**spec, **met}
            for spec, met in zip(container_specs, container_metrics)
        ],
    }

    await ctx.info("Requesting AI analysis of resource data...")

    # ── Step 4: Call ctx.sample() — MCP Sampling ────────────────────────
    # This sends the prompt to the client's LLM for analysis.
    # The server doesn't need its own LLM — it leverages the one the
    # user is already connected to.
    # We ask for structured JSON so the UI can render a clean card.
    try:
        result = await ctx.sample(
            messages=(
                f"Optimize Kubernetes pod resources for {namespace}/{pod_name}.\n\n"
                f"Pod resource data:\n{json.dumps(pod_data, indent=2)}\n\n"
                "Return exactly one JSON object with this schema: "
                '{"summary": string, "findings": string[], "recommendations": string[], '
                '"confidence": "high" | "medium" | "low", "caution": string}. '
                "The confidence field must be exactly one of: high, medium, low. "
                "Do not put reasoning inside confidence. Do not wrap the JSON in markdown fences or add extra commentary."
            ),
            system_prompt=(
                "You are a senior Kubernetes platform engineer. "
                "Provide conservative, actionable resource optimization guidance for CPU and memory requests and limits. "
                "Ground every recommendation in the provided snapshot, mention when a request or limit is missing, "
                "and prefer concrete changes with units when evidence supports them. "
                "Use only this point-in-time snapshot. Avoid claiming sustained patterns or autoscaling behavior. "
                "If the evidence is too thin for an aggressive change, recommend a cautious next step instead. "
                "Set confidence to exactly one word: high, medium, or low. "
                "Your full response must be valid JSON matching the requested schema."
            ),
            max_tokens=700,
        )
    except Exception as exc:
        return json.dumps({
            "pod": pod_name,
            "namespace": namespace,
            "error": (
                "Sampling failed while generating pod optimization guidance. "
                f"The connected client may not support sampling: {exc}"
            ),
        })

    # ── Step 5: Parse and validate the structured response ──────────────
    raw_text = getattr(result, "text", "") or ""
    parsed = _extract_json_object(raw_text)

    if parsed is None:
        return json.dumps({
            "pod": pod_name,
            "namespace": namespace,
            "error": "Sampling returned an invalid optimization payload.",
        })

    # Ensure required fields are present
    required = ("summary", "findings", "recommendations", "confidence", "caution")
    if not all(k in parsed for k in required):
        return json.dumps({
            "pod": pod_name,
            "namespace": namespace,
            "error": "Sampling returned an incomplete optimization payload.",
        })

    confidence = str(parsed["confidence"]).strip().lower()
    if confidence not in {"high", "medium", "low"}:
        if "high" in confidence:
            confidence = "high"
        elif "low" in confidence:
            confidence = "low"
        else:
            confidence = "medium"

    return json.dumps({
        "pod": pod_name,
        "namespace": namespace,
        "summary": parsed["summary"],
        "findings": parsed["findings"],
        "recommendations": parsed["recommendations"],
        "confidence": confidence,
        "caution": parsed["caution"],
        "generated_from_timestamp": metrics_timestamp,
    })
