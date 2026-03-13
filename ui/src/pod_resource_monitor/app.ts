/**
 * Pod Resource Monitor — MCP App
 *
 * This is the dashboard UI for the k8s-cluster-mcp MCP server.
 * It runs inside the MCP client (e.g. VS Code) as an "MCP App" — a rich
 * HTML/CSS/JS interface rendered inline in the AI assistant's chat.
 *
 * Communication Flow:
 *   1. This app connects to the MCP server via the App SDK
 *   2. On startup, it calls `list_running_pods` to populate the dropdown
 *   3. It calls `get_initial_pod_selection` to check for a pre-selected pod
 *   4. When a pod is selected, it polls `get_pod_metrics_tool` every second
 *   5. Metrics are rendered as live CPU/memory usage bars
 *
 * Uses: @modelcontextprotocol/ext-apps SDK for MCP App communication
 * See:  https://www.npmjs.com/package/@modelcontextprotocol/ext-apps
 */
import { App, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import "./app.css";

// ─── Types ─────────────────────────────────────────────────────────────

/** Pod information returned by the list_running_pods tool */
interface PodInfo {
  name: string;
  namespace: string;
  status: string;
  node: string;
  containers: string[];
  requests: Record<string, { cpu: string; memory: string }>;
  limits: Record<string, { cpu: string; memory: string }>;
}

/** Per-container CPU/memory usage from the metrics API */
interface ContainerMetrics {
  name: string;
  cpu: string;    // e.g. "15234n" (nanocores)
  memory: string; // e.g. "32768Ki" (kibibytes)
}

/** Response from the get_pod_metrics_tool */
interface PodMetrics {
  pod: string;
  namespace: string;
  timestamp: string;
  containers: ContainerMetrics[];
  error?: string;
}

/** Pre-selected pod from the get_initial_pod_selection tool */
interface InitialSelection {
  pod_name?: string;
  namespace?: string;
}

/** Structured optimization result from the sampling tool */
interface PodOptimization {
  pod: string;
  namespace: string;
  summary: string;
  findings: string[];
  recommendations: string[];
  confidence: string;
  caution: string;
  generated_from_timestamp?: string;
  error?: string;
}

/** Rolling history of metric samples for a single container */
interface MetricHistory {
  cpu: number[];     // millicores over time
  memory: number[];  // bytes over time
}

/** Parsed CPU value in common units */
interface ParsedCpu {
  millicores: number;
  cores: number;
}

/** Parsed memory value in common units */
interface ParsedMemory {
  bytes: number;
  megabytes: number;
}

// ─── DOM References ────────────────────────────────────────────────────
const mainEl = document.querySelector(".main") as HTMLElement;
const podSelect = document.getElementById("pod-select") as HTMLSelectElement;
const optimizeButton = document.getElementById("optimize-button") as HTMLButtonElement;
const podCountEl = document.getElementById("pod-count") as HTMLElement;
const optimizationContainer = document.getElementById("optimization-container") as HTMLElement;
const metricsContainer = document.getElementById("metrics-container") as HTMLElement;
const errorContainer = document.getElementById("error-container") as HTMLElement;
const statusIndicator = document.getElementById("status-indicator") as HTMLElement;
const statusText = document.getElementById("status-text") as HTMLElement;

// ─── State ─────────────────────────────────────────────────────────────
const POLL_INTERVAL = 1000;           // Poll metrics every 1 second
const METRIC_HISTORY_LIMIT = 60;      // Keep last 60 data points for context
let pods: PodInfo[] = [];
let pollTimeoutId: number | null = null;
let isPolling = false;
let isOptimizing = false;
let currentPodKey: string | null = null;
let activePollKey: string | null = null;
const metricHistory = new Map<string, MetricHistory>();

// ─── Kubernetes Resource Parsing ───────────────────────────────────────
// The Kubernetes metrics API returns CPU in nanocores (e.g. "15234n") and
// memory in kibibytes (e.g. "32768Ki"). These functions convert to
// human-readable values for display.

function parseCpu(cpuStr: string): ParsedCpu {
  if (!cpuStr || cpuStr === "0" || cpuStr === "N/A") return { millicores: 0, cores: 0 };
  if (cpuStr.endsWith("n")) {
    const millicores = parseInt(cpuStr, 10) / 1_000_000;
    return { millicores, cores: millicores / 1000 };
  }
  if (cpuStr.endsWith("u")) {
    const millicores = parseInt(cpuStr, 10) / 1_000;
    return { millicores, cores: millicores / 1000 };
  }
  if (cpuStr.endsWith("m")) {
    const millicores = parseInt(cpuStr, 10);
    return { millicores, cores: millicores / 1000 };
  }
  const cores = parseFloat(cpuStr);
  if (Number.isNaN(cores)) return { millicores: 0, cores: 0 };
  return { millicores: cores * 1000, cores };
}

function parseMemory(memStr: string): ParsedMemory {
  if (!memStr || memStr === "0" || memStr === "N/A") return { bytes: 0, megabytes: 0 };
  // Map of suffixes to their byte multipliers
  const suffixes: Record<string, number> = {
    Ki: 1024, Mi: 1024 * 1024, Gi: 1024 ** 3, Ti: 1024 ** 4,
    K: 1000, M: 1_000_000, G: 1_000_000_000, T: 1_000_000_000_000,
  };
  for (const [suffix, multiplier] of Object.entries(suffixes)) {
    if (memStr.endsWith(suffix)) {
      const bytes = parseFloat(memStr) * multiplier;
      return { bytes, megabytes: bytes / 1_000_000 };
    }
  }
  const bytes = parseInt(memStr, 10);
  if (Number.isNaN(bytes)) return { bytes: 0, megabytes: 0 };
  return { bytes, megabytes: bytes / 1_000_000 };
}

// ─── Formatting Utilities ──────────────────────────────────────────────

function formatPercent(percent: number): string {
  if (!Number.isFinite(percent)) return "0%";
  if (percent >= 10) return `${percent.toFixed(0)}%`;
  return `${percent.toFixed(1)}%`;
}

function formatCpuCores(millicores: number): string {
  const cores = millicores / 1000;
  return cores >= 10 ? `${cores.toFixed(1)} cores` : `${cores.toFixed(2)} cores`;
}

function formatMemorySize(bytes: number): string {
  const b = Math.max(bytes, 0);
  if (b >= 1_000_000_000) return `${(b / 1_000_000_000).toFixed(1)} GB`;
  if (b >= 1_000_000) return `${(b / 1_000_000).toFixed(0)} MB`;
  if (b >= 1000) return `${(b / 1000).toFixed(0)} KB`;
  return `${b.toFixed(0)} B`;
}

function formatCpuUsage(currentMillicores: number, configuredMillicores: number | null): string {
  const baseline = configuredMillicores && configuredMillicores > 0 ? configuredMillicores : 1000;
  return formatPercent((currentMillicores / baseline) * 100);
}

// ─── Metric History ────────────────────────────────────────────────────
// We keep a rolling window of metric samples so the usage bars can show
// relative usage even when no limits/requests are configured.

function buildHistoryKey(namespace: string, podName: string, containerName: string): string {
  return `${namespace}/${podName}/${containerName}`;
}

function resetMetricHistory(podKey: string | null = null): void {
  metricHistory.clear();
  currentPodKey = podKey;
}

function recordMetricSnapshot(metrics: PodMetrics): void {
  const podKey = `${metrics.namespace}/${metrics.pod}`;
  if (currentPodKey !== podKey) resetMetricHistory(podKey);

  for (const container of metrics.containers) {
    const key = buildHistoryKey(metrics.namespace, metrics.pod, container.name);
    const history = metricHistory.get(key) ?? { cpu: [], memory: [] };

    history.cpu.push(parseCpu(container.cpu).millicores);
    history.memory.push(parseMemory(container.memory).bytes);

    // Keep only the last N samples
    if (history.cpu.length > METRIC_HISTORY_LIMIT) history.cpu.shift();
    if (history.memory.length > METRIC_HISTORY_LIMIT) history.memory.shift();

    metricHistory.set(key, history);
  }
}

// ─── Resource Config Formatting ────────────────────────────────────────

function formatResourceConfig(label: string, value: string | undefined, kind: "cpu" | "memory"): string {
  if (!value || value === "N/A") return `${label}: none`;
  if (kind === "cpu") return `${label}: ${formatCpuCores(parseCpu(value).millicores)}`;
  return `${label}: ${formatMemorySize(parseMemory(value).bytes)}`;
}

// ─── Usage Calculations ────────────────────────────────────────────────

/** Calculate fill percentage for the usage bar */
function calculateUsageFillPercent(current: number, samples: number[], configuredMax: number | null): number {
  if (configuredMax && configuredMax > 0) {
    return Math.max(4, Math.min((current / configuredMax) * 100, 100));
  }
  // No configured max: auto-scale based on recent peak
  const recentPeak = Math.max(...samples, current, 1);
  const autoscaleMax = recentPeak * 1.15;
  return Math.max(8, Math.min((current / autoscaleMax) * 100, 100));
}

/** Get color class for the usage bar based on percentage */
function getBarColorClass(percent: number, type: "cpu" | "memory"): string {
  if (percent >= 90) return "danger";
  if (percent >= 70) return "warning";
  return type;
}

/** Get usage context (percent + human-readable detail) for CPU */
function getUsageContext(
  current: number, limit: number | null, request: number | null,
): { percent: number; detail: string } {
  if (limit && limit > 0) {
    const percent = (current / limit) * 100;
    return { percent, detail: `${formatPercent(percent)} of configured limit` };
  }
  if (request && request > 0) {
    const percent = (current / request) * 100;
    return { percent, detail: `${formatPercent(percent)} of requested CPU` };
  }
  const percent = (current / 1000) * 100;
  return { percent, detail: `${formatPercent(percent)} of a 1-core baseline` };
}

/** Get usage context for memory */
function getMemoryUsageContext(
  currentBytes: number, limitBytes: number | null, requestBytes: number | null,
): { percent: number | null; detail: string } {
  if (limitBytes && limitBytes > 0) {
    const percent = (currentBytes / limitBytes) * 100;
    return { percent, detail: `${formatPercent(percent)} of configured limit` };
  }
  if (requestBytes && requestBytes > 0) {
    const percent = (currentBytes / requestBytes) * 100;
    return { percent, detail: `${formatPercent(percent)} of requested memory` };
  }
  return { percent: null, detail: `${formatMemorySize(currentBytes)} live usage` };
}

// ─── UI Rendering ──────────────────────────────────────────────────────

/** Update the status indicator (green dot + timestamp when polling) */
function updateStatus(text: string, polling = false, error = false): void {
  statusText.textContent = text;
  statusIndicator.classList.remove("polling", "error");
  if (error) statusIndicator.classList.add("error");
  else if (polling) statusIndicator.classList.add("polling");
}

function showError(msg: string): void {
  errorContainer.innerHTML = `<div class="error-banner">${escapeHtml(msg)}</div>`;
}

function clearError(): void {
  errorContainer.innerHTML = "";
}

function escapeHtml(s: string): string {
  const el = document.createElement("span");
  el.textContent = s;
  return el.innerHTML;
}

/** Process a metrics update: record history and re-render the UI */
function applyMetricsUpdate(data: PodMetrics): void {
  // Ignore stale updates if user switched pods
  const selectedKey = podSelect.value;
  if (selectedKey && selectedKey !== `${data.namespace}/${data.pod}`) return;

  if (data.error) {
    showError(data.error);
  } else {
    clearError();
    recordMetricSnapshot(data);
  }

  const pod = pods.find((item) => item.name === data.pod && item.namespace === data.namespace);
  renderMetrics(data, pod);

  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  updateStatus(time, true);
}

/** Render the pod selector dropdown, grouped by namespace */
function renderPodSelect(): void {
  const selectedValue = podSelect.value;
  podSelect.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose a pod…";
  podSelect.appendChild(placeholder);

  // Group pods by namespace for a cleaner dropdown
  const namespaces = [...new Set(pods.map((p) => p.namespace))].sort();
  for (const ns of namespaces) {
    const group = document.createElement("optgroup");
    group.label = ns;
    for (const pod of pods.filter((p) => p.namespace === ns)) {
      const opt = document.createElement("option");
      opt.value = `${pod.namespace}/${pod.name}`;
      opt.textContent = pod.name;
      group.appendChild(opt);
    }
    podSelect.appendChild(group);
  }

  podSelect.disabled = false;
  // Restore previous selection if the pod still exists
  if ([...podSelect.options].some((option) => option.value === selectedValue)) {
    podSelect.value = selectedValue;
  }
  podCountEl.textContent = `${pods.length} pods`;
  updateOptimizeButton();
}
function renderMetrics(metrics: PodMetrics, pod: PodInfo | undefined): void {
  metricsContainer.innerHTML = "";

  for (const container of metrics.containers) {
    const cpu = parseCpu(container.cpu);
    const mem = parseMemory(container.memory);
    const history = metricHistory.get(buildHistoryKey(metrics.namespace, metrics.pod, container.name));
    const cpuSamples = history?.cpu ?? [cpu.millicores];
    const memSamples = history?.memory ?? [mem.bytes];

    // Get configured requests and limits for this container
    const cpuRequest = pod?.requests?.[container.name]?.cpu;
    const memRequest = pod?.requests?.[container.name]?.memory;
    const cpuRequestP = cpuRequest ? parseCpu(cpuRequest) : null;
    const memRequestP = memRequest ? parseMemory(memRequest) : null;
    const cpuLimit = pod?.limits?.[container.name]?.cpu;
    const memLimit = pod?.limits?.[container.name]?.memory;
    const cpuLimitP = cpuLimit ? parseCpu(cpuLimit) : null;
    const memLimitP = memLimit ? parseMemory(memLimit) : null;

    // Calculate usage context (percentage relative to limit/request/baseline)
    const cpuUsageContext = getUsageContext(
      cpu.millicores, cpuLimitP?.millicores ?? null, cpuRequestP?.millicores ?? null,
    );
    const memUsageContext = getMemoryUsageContext(
      mem.bytes, memLimitP?.bytes ?? null, memRequestP?.bytes ?? null,
    );

    // Calculate bar fill widths
    const cpuFill = calculateUsageFillPercent(
      cpu.millicores, cpuSamples, cpuLimitP?.millicores ?? cpuRequestP?.millicores ?? null,
    );
    const memFill = calculateUsageFillPercent(
      mem.bytes, memSamples, memLimitP?.bytes ?? memRequestP?.bytes ?? null,
    );

    const cpuBarContext = cpuUsageContext.percent;
    const memBarContext = memUsageContext.percent ?? memFill;
    const cpuUsageLabel = formatCpuUsage(cpu.millicores, cpuLimitP?.millicores ?? cpuRequestP?.millicores ?? null);
    const memUsageLabel = memUsageContext.percent !== null
      ? formatPercent(memUsageContext.percent)
      : "Live";

    // Build the container metrics card
    const card = document.createElement("div");
    card.className = "container-card";
    card.innerHTML = `
      <div class="container-header">
        <div class="container-name">
          <span class="container-dot"></span>
          ${escapeHtml(container.name)}
        </div>
      </div>
      <div class="metrics-grid">
        <div class="metric-card">
          <div class="metric-header">
            <span class="metric-label">CPU</span>
            <span class="metric-value">${cpuUsageLabel}</span>
          </div>
          <div class="metric-meta">
            <span>${escapeHtml(formatResourceConfig("Request", cpuRequest, "cpu"))}</span>
            <span>${escapeHtml(formatResourceConfig("Limit", cpuLimit, "cpu"))}</span>
          </div>
          <div class="usage-bar-container" role="img" aria-label="${escapeHtml(container.name)} CPU live usage bar">
            <div class="usage-bar">
              <div class="usage-bar-fill ${getBarColorClass(cpuBarContext, "cpu")}" style="width: ${cpuFill}%"></div>
            </div>
            <span class="usage-percent">${cpuUsageLabel}</span>
          </div>
          <div class="usage-detail">${cpuUsageContext.detail} | ${formatCpuCores(cpu.millicores)} in use</div>
        </div>
        <div class="metric-card">
          <div class="metric-header">
            <span class="metric-label">Memory</span>
            <span class="metric-value">${formatMemorySize(mem.bytes)}</span>
          </div>
          <div class="metric-meta">
            <span>${escapeHtml(formatResourceConfig("Request", memRequest, "memory"))}</span>
            <span>${escapeHtml(formatResourceConfig("Limit", memLimit, "memory"))}</span>
          </div>
          <div class="usage-bar-container" role="img" aria-label="${escapeHtml(container.name)} memory live usage bar">
            <div class="usage-bar">
              <div class="usage-bar-fill ${getBarColorClass(memBarContext, "memory")}" style="width: ${memFill}%"></div>
            </div>
            <span class="usage-percent">${memUsageLabel}</span>
          </div>
          <div class="usage-detail">${memUsageContext.detail}</div>
        </div>
      </div>
    `;
    metricsContainer.appendChild(card);
  }
}

// ─── Optimize Button & Optimization Rendering ─────────────────────────

function confidenceClass(confidence: string): string {
  const normalized = confidence.trim().toLowerCase();
  if (normalized.includes("high")) return "high";
  if (normalized.includes("low")) return "low";
  return "medium";
}

function confidenceLabel(confidence: string): string {
  const normalized = confidenceClass(confidence);
  if (normalized === "high") return "High";
  if (normalized === "low") return "Low";
  return "Medium";
}

function updateOptimizeButton(): void {
  optimizeButton.disabled = !podSelect.value || isOptimizing;
  optimizeButton.innerHTML = isOptimizing
    ? `<span class="spinner" aria-hidden="true"></span><span>Analyzing…</span>`
    : "Resource recommendations";
}

function clearOptimization(): void {
  optimizationContainer.innerHTML = "";
}

function renderOptimizationLoading(podName: string, namespace: string): void {
  optimizationContainer.innerHTML = `
    <section class="optimization-card" aria-live="polite">
      <div class="optimization-header">
        <h2 class="optimization-title">Optimization guidance</h2>
        <p class="optimization-subtitle">${escapeHtml(namespace)}/${escapeHtml(podName)}</p>
      </div>
      <div class="optimization-pending">
        <span class="spinner" aria-hidden="true"></span>
        <span>Generating sampling-backed recommendations from the current resource snapshot…</span>
      </div>
    </section>
  `;
}

function renderOptimization(result: PodOptimization): void {
  const findings = result.findings.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const recommendations = result.recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const timestamp = result.generated_from_timestamp
    ? new Date(result.generated_from_timestamp).toLocaleTimeString("en-US", { hour12: false })
    : "Latest snapshot";

  optimizationContainer.innerHTML = `
    <section class="optimization-card" aria-live="polite">
      <div class="optimization-header">
        <div>
          <h2 class="optimization-title">Optimization guidance</h2>
          <p class="optimization-subtitle">${escapeHtml(result.namespace)}/${escapeHtml(result.pod)} • ${escapeHtml(timestamp)}</p>
        </div>
        <span class="confidence-badge ${confidenceClass(result.confidence)}">${confidenceLabel(result.confidence)}</span>
      </div>
      <p class="optimization-summary">${escapeHtml(result.summary)}</p>
      <div class="optimization-grid">
        <section>
          <h3 class="optimization-section-title">Findings</h3>
          <ul class="optimization-list">${findings}</ul>
        </section>
        <section>
          <h3 class="optimization-section-title">Recommendations</h3>
          <ul class="optimization-list">${recommendations}</ul>
        </section>
      </div>
      <p class="optimization-caution">${escapeHtml(result.caution)}</p>
    </section>
  `;
}

function renderOptimizationError(message: string): void {
  optimizationContainer.innerHTML = `<div class="optimization-card optimization-error">${escapeHtml(message)}</div>`;
}

// ─── MCP App Communication ─────────────────────────────────────────────
// The App SDK provides a bridge between this UI and the MCP server.
// We use app.callServerTool() to invoke server tools and get data.
// See: https://www.npmjs.com/package/@modelcontextprotocol/ext-apps

const app = new App({ name: "PodMonitor", version: "1.0.0" });

/** Fetch all running pods from the server and populate the dropdown */
async function fetchPods(): Promise<void> {
  try {
    const result = await app.callServerTool({ name: "list_running_pods", arguments: {} });
    const content = result?.content;
    if (content && content.length > 0 && content[0].type === "text") {
      pods = JSON.parse(content[0].text);
      renderPodSelect();
      clearError();
    }
  } catch (e: any) {
    showError(`Failed to load pods: ${e.message}`);
    updateStatus("Error", false, true);
  }
}

/** Check if a pod was pre-selected (e.g. user asked about a specific pod) */
async function fetchInitialSelection(): Promise<void> {
  try {
    const result = await app.callServerTool({ name: "get_initial_pod_selection", arguments: {} });
    const content = result?.content;
    if (content && content.length > 0 && content[0].type === "text") {
      const selection: InitialSelection = JSON.parse(content[0].text);
      if (!selection.pod_name) return;

      // Try to find the pod: exact match first, then partial match
      let match: PodInfo | undefined;
      if (selection.namespace) {
        match = pods.find((p) => p.name === selection.pod_name && p.namespace === selection.namespace);
      }
      if (!match) match = pods.find((p) => p.name === selection.pod_name);
      if (!match) match = pods.find((p) => p.name.includes(selection.pod_name!));

      if (match) {
        podSelect.value = `${match.namespace}/${match.name}`;
        startPolling(match.name, match.namespace);
      }
    }
  } catch {
    // Pre-selection is best-effort; ignore failures
  }
}

/** Fetch live metrics for a specific pod */
async function fetchMetrics(podName: string, namespace: string): Promise<void> {
  try {
    const result = await app.callServerTool({
      name: "get_pod_metrics_tool",
      arguments: { pod_name: podName, namespace },
    });

    // Abort if user switched to a different pod while we were fetching
    if (activePollKey !== `${namespace}/${podName}`) return;

    const content = result?.content;
    if (content && content.length > 0 && content[0].type === "text") {
      const data: PodMetrics = JSON.parse(content[0].text);
      applyMetricsUpdate(data);
    }
  } catch (e: any) {
    showError(`Failed to load metrics: ${e.message}`);
    updateStatus("Error", false, true);
  }
}

/** Call the optimize_pod_resources tool (uses MCP Sampling on the server) */
async function optimizeSelectedPod(): Promise<void> {
  const val = podSelect.value;
  if (!val || isOptimizing) return;

  const [namespace, ...podNameParts] = val.split("/");
  const podName = podNameParts.join("/");
  isOptimizing = true;
  updateOptimizeButton();
  renderOptimizationLoading(podName, namespace);

  try {
    const result = await app.callServerTool({
      name: "optimize_pod_resources",
      arguments: { pod_name: podName, namespace },
    });
    const content = result?.content;
    if (content && content.length > 0 && content[0].type === "text") {
      const data: PodOptimization = JSON.parse(content[0].text);
      if (podSelect.value !== val) return;
      if (data.error) {
        renderOptimizationError(data.error);
      } else {
        renderOptimization(data);
      }
    }
  } catch (e: any) {
    if (podSelect.value === val) {
      renderOptimizationError(`Failed to optimize pod resources: ${e.message}`);
    }
  } finally {
    isOptimizing = false;
    updateOptimizeButton();
  }
}

// ─── Polling ───────────────────────────────────────────────────────────
// When a pod is selected, we poll its metrics every POLL_INTERVAL ms.

function startPolling(podName: string, namespace: string): void {
  stopPolling();
  const podKey = `${namespace}/${podName}`;
  activePollKey = podKey;
  if (currentPodKey !== podKey) resetMetricHistory(podKey);
  isPolling = true;
  updateStatus("Starting…", true);
  void pollMetrics(podName, namespace, podKey);
}

function stopPolling(): void {
  if (pollTimeoutId !== null) {
    clearTimeout(pollTimeoutId);
    pollTimeoutId = null;
  }
  activePollKey = null;
  isPolling = false;
}

async function pollMetrics(podName: string, namespace: string, podKey: string): Promise<void> {
  if (activePollKey !== podKey) return;
  await fetchMetrics(podName, namespace);
  if (activePollKey !== podKey) return;

  pollTimeoutId = window.setTimeout(() => {
    void pollMetrics(podName, namespace, podKey);
  }, POLL_INTERVAL);
}

// ─── Event Handlers ────────────────────────────────────────────────────

podSelect.addEventListener("change", () => {
  const val = podSelect.value;
  clearOptimization();
  if (!val) {
    stopPolling();
    resetMetricHistory();
    metricsContainer.innerHTML = "";
    updateStatus("Ready");
    updateOptimizeButton();
    return;
  }
  const [ns, ...nameParts] = val.split("/");
  const name = nameParts.join("/");
  updateOptimizeButton();
  startPolling(name, ns);
});

optimizeButton.addEventListener("click", () => {
  void optimizeSelectedPod();
});

// ─── Host Context ──────────────────────────────────────────────────────
// The MCP client may provide safe area insets (e.g. for mobile or sidebars).

function handleHostContextChanged(ctx: McpUiHostContext): void {
  if (ctx.safeAreaInsets) {
    mainEl.style.paddingTop = `${ctx.safeAreaInsets.top}px`;
    mainEl.style.paddingRight = `${ctx.safeAreaInsets.right}px`;
    mainEl.style.paddingBottom = `${ctx.safeAreaInsets.bottom}px`;
    mainEl.style.paddingLeft = `${ctx.safeAreaInsets.left}px`;
  }
}

// ─── Initialize ────────────────────────────────────────────────────────
// Connect to the MCP server, load pods, and check for pre-selection.

app.onerror = console.error;

// Refresh pod list when any tool call completes (e.g. new pods deployed)
app.ontoolresult = () => {
  fetchPods();
};

app.onhostcontextchanged = handleHostContextChanged;

app.connect().then(async () => {
  const ctx = app.getHostContext();
  if (ctx) handleHostContextChanged(ctx);
  await fetchPods();
  await fetchInitialSelection();
  updateOptimizeButton();
});
