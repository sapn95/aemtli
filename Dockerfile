# ämtli: goose plus what its recipes need to start MCP servers (node for npx,
# uv and python for uvx), plus the runner and the web UI.
#
# Every base is pinned by digest; Dependabot moves digest and tag together.
FROM docker.io/library/node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS node
FROM ghcr.io/astral-sh/uv:0.13.0@sha256:cdc6093146eb3ff6a40107b38f008b789e050e77ad87865e381d9917da55a168 AS uv

# goose's own image is Debian bookworm, like the node image above, so node's
# binary runs on it unchanged.
FROM ghcr.io/aaif-goose/goose:1.54.0@sha256:c8a6b66718fafc405055bb642ab1cccbb9a31ed76d1fbd1e4385d18c43cdb4d0

USER root
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=uv /uv /uvx /usr/local/bin/
RUN set -eu; \
    ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm; \
    ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx; \
    apt-get update; \
    apt-get install -y --no-install-recommends python3 jq poppler-utils; \
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
