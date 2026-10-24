#!/bin/sh
# Invoked by the official PostgreSQL entrypoint only for an empty data volume.
set -eu
: "${APP_DATABASE_PASSWORD:?Missing application database password}"
: "${TEMPORAL_DATABASE_PASSWORD:?Missing Temporal database password}"
psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$APP_DATABASE_PASSWORD" --set=temporal_password="$TEMPORAL_DATABASE_PASSWORD" <<'SQL'
CREATE ROLE agentconnex WITH LOGIN PASSWORD :'app_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE DATABASE agentconnex OWNER agentconnex;
\connect agentconnex
CREATE EXTENSION IF NOT EXISTS vector;
\connect postgres
CREATE ROLE agentconnex_temporal WITH LOGIN PASSWORD :'temporal_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE DATABASE temporal OWNER agentconnex_temporal;
CREATE DATABASE temporal_visibility OWNER agentconnex_temporal;
SQL
