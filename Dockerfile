# Stage 1: Build the dashboard UI into a single HTML file
FROM node:20-slim AS ui-builder
WORKDIR /app/ui
COPY ui/package.json ui/package-lock.json* ./
RUN npm install
COPY ui/ .
RUN npm run build

# Stage 2: Python runtime for the MCP server
FROM python:3.12-slim
WORKDIR /app

# Install Python dependencies (FastMCP + Kubernetes client)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the MCP server code
COPY mcp-server.py .
COPY tools/ tools/
COPY utils/ utils/
COPY sampling/ sampling/

# Copy the built dashboard from stage 1
COPY --from=ui-builder /app/ui/dist ui/dist/

EXPOSE 8000
CMD ["python", "mcp-server.py"]
