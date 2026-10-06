FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
# Optional extra root CAs for networks with HTTPS inspection (see extra-ca/README.md).
COPY --from=extra-ca . /extra-ca/
RUN if ls /extra-ca/*.crt >/dev/null 2>&1; then \
        cat /extra-ca/*.crt > /tmp/extra-ca.pem && export NODE_EXTRA_CA_CERTS=/tmp/extra-ca.pem; \
    fi \
    && npm ci --omit=dev --no-audit --no-fund
COPY config ./config
COPY src ./src
COPY public ./public
ENV PORT=8900
EXPOSE 8900
CMD ["node", "src/server.js"]
