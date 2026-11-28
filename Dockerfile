FROM node:22-bookworm-slim@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb
LABEL org.opencontainers.image.source="https://github.com/Plagnito/soundmcp"

WORKDIR /app
COPY --chown=node:node package.json LICENSE ./
COPY --chown=node:node src ./src
COPY --chown=node:node banks/studio ./banks/studio
RUN mkdir -p /app/output && chown node:node /app/output

USER node
ENV SOUNDMCP_TOOLSET=full
ENTRYPOINT ["node", "/app/src/index.js"]
