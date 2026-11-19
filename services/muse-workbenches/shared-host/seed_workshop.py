"""Restore schema-only PostgreSQL objects and bind the deployment operator to a fresh user."""
import json
import re
import subprocess
from pathlib import Path

base = Path("/srv/muse-workbenches")
private = base / "config/bootstrap"
keys = json.loads((private / "secrets.json").read_text())
identity = json.loads((private / "identity.json").read_text())
sql_file = Path(__file__).with_name("schema.sql")
schema = sql_file.read_text()
if ("-- PostgreSQL database dump complete" not in schema or "CREATE TABLE public.users" not in schema
        or re.search(r"^(?:COPY |INSERT |CREATE ROLE|CREATE FUNCTION|ALTER .* OWNER TO )", schema, re.M | re.I)):
    raise ValueError("Expected a complete schema-only pg_restore output without owners or row data")
pg = ["docker", "exec", "-i", "-u", "postgres", "muse-wb-pg17", "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-d", "workshop"]


def run(sql):
    return subprocess.run(pg, input=sql, capture_output=True, check=True, text=True).stdout.strip()


if not run("SELECT 1 FROM pg_roles WHERE rolname='workshop';"):
    run("CREATE ROLE workshop LOGIN PASSWORD '" + keys["dbuser"] + "' NOSUPERUSER NOCREATEROLE NOCREATEDB; ALTER DATABASE workshop OWNER TO workshop;")
if run("SELECT to_regclass('public.users') IS NULL;") == 't':
    run("BEGIN; SET LOCAL ROLE workshop;\n" + schema + "\nCOMMIT;")
username = identity["username"].replace("'", "''")
uid = int(identity["id"])
existing = run(f"SELECT username FROM public.users WHERE id={uid};")
if existing and existing != identity["username"]:
    raise ValueError("Native user ID is in use")
if not existing:
    run(f"SET ROLE workshop; INSERT INTO public.users(id,username,login_id,display_name,role,status) VALUES ({uid},'{username}','{username}','{username}','user','active');")
print("Workshop database ready. Tables and indexes:", run("SELECT count(*) FROM pg_tables WHERE schemaname IN ('public','agent_ckpt');SELECT count(*) FROM pg_indexes WHERE schemaname IN ('public','agent_ckpt');").splitlines())
