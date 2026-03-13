#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# showcase-k8s-cluster-mcp.sh
#
# One-command demo of the k8s-cluster-mcp MCP server.
# Creates a kind cluster, installs metrics-server, deploys a demo pod with
# fluctuating resource usage, builds and deploys the MCP server, and starts
# port-forwarding so your MCP client can connect.
#
# Usage:
#   ./showcase-k8s-cluster-mcp.sh
#
# On exit (Ctrl+C), you'll be asked whether to delete the cluster.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

CLUSTER_NAME="k8s-cluster-mcp-showcase"
IMAGE_NAME="k8s-cluster-mcp:latest"
LOCAL_PORT=8000
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# ── Colors ───────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
step()  { echo -e "\n${CYAN}${BOLD}▸ $1${NC}"; }

# ── Cleanup Trap ─────────────────────────────────────────────────────────
cleanup() {
    echo ""
    echo -e "${YELLOW}${BOLD}Shutting down...${NC}"
    read -r -p "Delete the kind cluster '$CLUSTER_NAME'? [y/N] " answer
    if [[ "${answer:-}" =~ ^[Yy] ]]; then
        kind delete cluster --name "$CLUSTER_NAME" 2>/dev/null \
            && info "Cluster deleted." \
            || warn "Failed to delete cluster."
    else
        info "Cluster '$CLUSTER_NAME' kept. Delete later with: kind delete cluster --name $CLUSTER_NAME"
    fi
}
trap cleanup EXIT

# ── Prerequisite Checks ─────────────────────────────────────────────────
step "Checking prerequisites"

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo -e "${RED}✗${NC} Missing required command: ${BOLD}$1${NC}"
        echo "  Install it from: $2"
        exit 1
    fi
    info "$1 found"
}

require_command docker "https://docs.docker.com/get-docker/"
require_command kind   "https://kind.sigs.k8s.io/docs/user/quick-start/#installation"
require_command kubectl "https://kubernetes.io/docs/tasks/tools/"

# Check Docker daemon is running
if ! docker info >/dev/null 2>&1; then
    echo -e "${RED}✗${NC} Docker daemon is not running. Please start Docker and try again."
    exit 1
fi
info "Docker daemon is running"

# ── Create Kind Cluster ─────────────────────────────────────────────────
step "Creating kind cluster: $CLUSTER_NAME"

if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
    warn "Cluster '$CLUSTER_NAME' already exists, reusing it"
else
    kind create cluster --name "$CLUSTER_NAME" --wait 60s
    info "Cluster created"
fi

# Point kubectl at the new cluster
kubectl cluster-info --context "kind-${CLUSTER_NAME}" >/dev/null 2>&1
info "kubectl connected to cluster"

# ── Install Metrics Server ──────────────────────────────────────────────
step "Installing metrics-server"

# Apply the official metrics-server manifests
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml >/dev/null

# Kind uses self-signed certs, so we need --kubelet-insecure-tls
kubectl patch deployment metrics-server -n kube-system \
    --type='json' \
    -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' \
    >/dev/null 2>&1 || true

info "Waiting for metrics-server to be ready..."
kubectl rollout status deployment/metrics-server -n kube-system --timeout=120s >/dev/null
info "Metrics server is running"

# ── Deploy Demo Pod ──────────────────────────────────────────────────────
step "Deploying demo pod with fluctuating resource usage"

kubectl apply -f "$SCRIPT_DIR/k8s/demo-pod.yaml" >/dev/null
info "Demo pod 'mcp-showcase-pod' deployed"

# ── Build & Deploy MCP Server ───────────────────────────────────────────
step "Building MCP server Docker image"

cd "$SCRIPT_DIR"
docker build -t "$IMAGE_NAME" . --quiet >/dev/null
info "Image built: $IMAGE_NAME"

step "Loading image into kind cluster"

kind load docker-image "$IMAGE_NAME" --name "$CLUSTER_NAME" >/dev/null 2>&1
info "Image loaded into cluster"

step "Deploying MCP server to cluster"

kubectl apply -f k8s/rbac.yaml >/dev/null
kubectl apply -f k8s/deployment.yaml >/dev/null
# Restart if already exists, ignore error if fresh deploy
kubectl rollout restart deployment/k8s-cluster-mcp -n default >/dev/null 2>&1 || true
info "Waiting for MCP server to be ready..."
kubectl rollout status deployment/k8s-cluster-mcp -n default --timeout=120s >/dev/null
info "MCP server is running"

# ── Wait for Metrics to be Available ────────────────────────────────────
step "Waiting for metrics to become available (this may take ~60s)"

for i in $(seq 1 60); do
    if kubectl top pod mcp-showcase-pod -n default >/dev/null 2>&1; then
        info "Metrics are available!"
        break
    fi
    if [ "$i" -eq 60 ]; then
        warn "Metrics not available yet, but you can still try — they may appear shortly"
    fi
    sleep 2
done

# ── Port Forward & Print Instructions ───────────────────────────────────
step "Starting port-forward on localhost:$LOCAL_PORT"

echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║                    🚀 MCP Server is ready!                      ║${NC}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BOLD}MCP Server URL:${NC} http://localhost:${LOCAL_PORT}/mcp"
echo ""
echo -e "${BOLD}Add to your MCP client config (e.g. VS Code settings.json):${NC}"
echo ""
echo -e "  ${CYAN}\"k8s-cluster-mcp\": {${NC}"
echo -e "  ${CYAN}  \"type\": \"http\",${NC}"
echo -e "  ${CYAN}  \"url\": \"http://localhost:${LOCAL_PORT}/mcp\"${NC}"
echo -e "  ${CYAN}}${NC}"
echo ""
echo -e "${BOLD}Try these prompts in your AI assistant:${NC}"
echo ""
echo -e "  ${YELLOW}1.${NC} ${BOLD}\"Show me pod resource usage\"${NC}"
echo -e "     → Opens the dashboard where you can select any pod"
echo ""
echo -e "  ${YELLOW}2.${NC} ${BOLD}\"Show me the resources of the mcp-showcase-pod\"${NC}"
echo -e "     → Opens the dashboard with the demo pod pre-selected"
echo ""
echo -e " ! You can delete the created Kind cluster by running ${CYAN}\"kind delete cluster --name k8s-cluster-mcp-showcase\"${NC}"
echo ""
echo -e "${CYAN}Press Ctrl+C to stop.${NC}"
echo ""

# Start port-forwarding (keeps the script running until Ctrl+C)
exec kubectl port-forward -n default service/k8s-cluster-mcp "$LOCAL_PORT:8000"
