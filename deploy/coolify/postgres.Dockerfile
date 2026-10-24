FROM pgvector/pgvector:pg18@sha256:2358fcba361ed2233a5ed81b5fe4ca779ccb304120ce531a3bf51c0ed7e2bc11
COPY --chmod=0644 deploy/coolify/init-postgres.sh /docker-entrypoint-initdb.d/10-agentconnex.sh
