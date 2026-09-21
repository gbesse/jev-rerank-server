# Purpose: Run the rerank server from source on a small Node image; no build step, no runtime dependencies.
FROM node:24-alpine
WORKDIR /app
COPY package.json README.md LICENSE ./
COPY src ./src
COPY bin ./bin
ENV NODE_ENV=production
# The container must listen on all interfaces so the published port reaches it; keep it behind your own network policy.
EXPOSE 8787
USER node
CMD ["node", "bin/jev-rerank-server.mjs", "--host", "0.0.0.0", "--port", "8787"]
