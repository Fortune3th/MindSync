FROM node:22-bookworm-slim
WORKDIR /app
COPY dev/frontend/package.json dev/frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY dev/frontend/vite.config.mjs ./vite.config.mjs
COPY server/src/admin ./src/admin
CMD ["npm", "run", "dev"]
