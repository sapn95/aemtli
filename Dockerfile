# ämtli: goose plus what its recipes need to start MCP servers (node for npx,
# uv and python for uvx), plus the runner and the web UI.
#
# Every base is pinned by digest; Dependabot moves digest and tag together.
FROM docker.io/library/node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS node
FROM ghcr.io/astral-sh/uv:0.13.9@sha256:d3b601f0c7b118bc1753febf7c41cc80981df678445e0254284eecf84db79a7d AS uv

# goose's own image is Debian bookworm, like the node image above, so node's
# binary runs on it unchanged.
FROM ghcr.io/aaif-goose/goose:v1.60.2@sha256:afabea595fe5acbec5fd1760e4673f238dd2d29bba874db6f3006d5730987893

USER root
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=uv /uv /uvx /usr/local/bin/
RUN set -eu; \
    ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm; \
    ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx; \
    apt-get update; \
    # node 26 links libatomic, which goose's slim base does not carry.
    apt-get install -y --no-install-recommends libatomic1 python3 jq poppler-utils; \
    rm -rf /var/lib/apt/lists/*; \
    # As root with HOME pointing at goose's home, a version check would
    # leave root-owned state there that goose then cannot write to.
    HOME=/tmp node --version; HOME=/tmp goose --version; HOME=/tmp uv --version; jq --version; pdftotext -v; pdftoppm -v; pdfinfo -v; \
    rm -rf /tmp/* /tmp/.[!.]*

WORKDIR /app
COPY package.json package-lock.json ./
RUN HOME=/tmp npm ci --omit=dev --ignore-scripts && rm -rf /tmp/* /tmp/.[!.]*
COPY bin ./bin
COPY src ./src
COPY public ./public
RUN chmod 755 /app/bin/aemtli.mjs && ln -s /app/bin/aemtli.mjs /usr/local/bin/aemtli

# goose reads its provider and model from the environment; nothing is meant
# to come from a keyring in a container.
ENV GOOSE_DISABLE_KEYRING=1 \
    NODE_ENV=production

USER goose
WORKDIR /home/goose
ENTRYPOINT []
CMD ["aemtli", "web"]
