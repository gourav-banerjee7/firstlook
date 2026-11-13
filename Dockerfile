# One image recipe for every app: docker build --build-arg APP=demo-api .
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm install --frozen-lockfile
ARG APP
RUN pnpm --filter "@firstlook/${APP}" build

# Runtime: Node plus one bundled file. No node_modules, no build tools, not root.
FROM node:22-alpine
ARG APP
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/apps/${APP}/dist/ ./
USER node
CMD ["node", "index.js"]
