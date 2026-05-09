FROM node:22-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine
RUN apk add --no-cache python3 make g++ docker-cli docker-cli-compose
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY backend/server.js backend/cli.js ./
COPY backend/lib ./lib
COPY backend/routes ./routes
COPY examples/minecraft.example.yml /app/default-mc-compose.yml
COPY --from=frontend /build/dist ./public

RUN chmod +x cli.js && ln -s /app/cli.js /usr/local/bin/s23

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
