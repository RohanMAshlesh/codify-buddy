# Codify Buddy team server.
#   docker build -t codify-team .
#   docker run -p 8787:8787 -v $PWD/team:/data -e ANTHROPIC_API_KEY=sk-ant-... codify-team
# /data must contain team.json; its dataDir resolves relative to it.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8787
VOLUME ["/data"]
CMD ["node", "dist/cli.js", "team", "serve", "--config", "/data/team.json"]
