FROM node:24

ARG COCKPIT_VERSION=latest
RUN --mount=type=cache,target=/root/.npm \
    npm install -g --no-audit --no-fund "@surething/cockpit@${COCKPIT_VERSION}"

RUN install -d -o node -g node /home/node/projects
USER node
WORKDIR /home/node/projects
ENV PORT=3457 COCKPIT_NO_OPEN=1 SHELL=/bin/bash
# Run the server directly so Docker's init forwards SIGTERM to the process that owns the instance lock.
CMD ["sh", "-c", "cd /usr/local/lib/node_modules/@surething/cockpit && exec node server.mjs"]
