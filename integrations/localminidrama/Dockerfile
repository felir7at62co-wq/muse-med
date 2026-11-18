FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
ARG LOCALMINIDRAMA_REVISION=3fbcda9713ca545979dff9e75d21bed53694188f
WORKDIR /opt/upstream
RUN git init . && git remote add origin https://github.com/xuanyustudio/LocalMiniDrama.git \
    && git config core.longpaths true \
    && git fetch --depth 1 --filter=blob:none origin ${LOCALMINIDRAMA_REVISION} \
    && git sparse-checkout init --cone && git sparse-checkout set backend-node frontweb \
    && git checkout --detach FETCH_HEAD
COPY patch-upstream.mjs /opt/muse/patch-upstream.mjs
COPY compatibility /opt/muse/compatibility
COPY extensions /opt/muse/extensions
COPY build-web.mjs verify-web-build.py verify-web-imports.mjs /opt/muse/
COPY assets /opt/muse/assets
RUN node /opt/muse/patch-upstream.mjs /opt/upstream
RUN npm ci --prefix backend-node --omit=dev && npm ci --prefix frontweb && node /opt/muse/build-web.mjs /opt/upstream --base /

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/upstream/backend-node /opt/upstream/backend-node
COPY --from=build /opt/upstream/frontweb/dist /opt/upstream/frontweb/dist
COPY --from=build /opt/upstream/LICENSE /opt/upstream/LICENSE
COPY config.yaml start-companion.mjs /opt/muse/
RUN mkdir -p /var/lib/localminidrama && chown -R node:node /var/lib/localminidrama /opt/upstream/backend-node/configs
USER node
WORKDIR /opt/upstream/backend-node
ENV PORT=5679 WEB_DIST_PATH=/opt/upstream/frontweb/dist NODE_ENV=production
EXPOSE 5679
VOLUME ["/var/lib/localminidrama"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:5679/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "/opt/muse/start-companion.mjs"]
