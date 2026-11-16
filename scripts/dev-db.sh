#!/usr/bin/env bash
# Crée la base de développement et les deux rôles (propriétaire + applicatif soumis à la RLS).
set -euo pipefail
DB=${1:-jamystock}
PSQL=${PSQL:-"sudo -u postgres psql -v ON_ERROR_STOP=1"}
$PSQL <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jamystock') THEN CREATE ROLE jamystock LOGIN PASSWORD 'jamystock'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jamystock_app') THEN CREATE ROLE jamystock_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jamystock_api') THEN CREATE ROLE jamystock_api LOGIN PASSWORD 'jamystock_api' IN ROLE jamystock_app; END IF;
END \$\$;
SELECT 'CREATE DATABASE $DB OWNER jamystock' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname='$DB') \gexec
SQL
$PSQL -d "$DB" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS btree_gist;"
echo "Base $DB prête."
