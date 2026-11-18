/**
 * Security-relevant Postgres catalog fingerprint for schema equivalence + stamp.
 *
 * Covers what `pg_dump --schema-only --no-privileges` misses:
 * - table/function/schema/database ACLs (via aclexplode), excluding the
 *   object's owner (migrator role name / PG-version owner privs like MAINTAIN)
 * - column ACLs (attacl)
 * - pg_default_acl
 * - sms_app role attributes, memberships, and role settings
 * - function proconfig (search_path)
 * - relrowsecurity / relforcerowsecurity + pg_policies
 * - column names (unexpected added columns)
 *
 * Schemas in scope: public, app. Excludes pgboss (bootstrap) and
 * public.pgmigrations (legacy bookkeeping).
 *
 * expected-catalog.json lives at drizzle/expected-catalog.json — NOT under
 * drizzle/meta/ (drizzle-kit treats every *.json there as a snapshot).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.dirname(here);

export const EXPECTED_CATALOG_PATH = path.join(backendRoot, "drizzle", "expected-catalog.json");

/** Role name used for PUBLIC in ACL rows (grantee oid 0). */
const PUBLIC = "PUBLIC";

/**
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @returns {Promise<object>}
 */
export async function captureCatalog(client) {
  // Sequential: node-postgres deprecates concurrent query() on one client.
  const roles = await captureRoles(client);
  const roleMembers = await captureRoleMembers(client);
  const roleSettings = await captureRoleSettings(client);
  const tables = await captureTables(client);
  const columns = await captureColumns(client);
  const columnAcls = await captureColumnAcls(client);
  const policies = await capturePolicies(client);
  const functions = await captureFunctions(client);
  const namespaces = await captureNamespaces(client);
  const database = await captureDatabase(client);
  const defaults = await captureDefaultAcls(client);

  return {
    version: 2,
    roles,
    roleMembers,
    roleSettings,
    tables,
    columns,
    columnAcls,
    policies,
    functions,
    namespaces,
    database,
    defaultAcls: defaults,
  };
}

async function captureRoles(client) {
  const { rows } = await client.query(`
    SELECT
      rolname,
      rolsuper,
      rolinherit,
      rolcreaterole,
      rolcreatedb,
      rolcanlogin,
      rolreplication,
      rolbypassrls,
      rolconnlimit
    FROM pg_roles
    WHERE rolname = 'sms_app'
    ORDER BY rolname
  `);
  return rows.map((r) => ({
    rolname: r.rolname,
    rolsuper: r.rolsuper,
    rolinherit: r.rolinherit,
    rolcreaterole: r.rolcreaterole,
    rolcreatedb: r.rolcreatedb,
    rolcanlogin: r.rolcanlogin,
    rolreplication: r.rolreplication,
    rolbypassrls: r.rolbypassrls,
    rolconnlimit: r.rolconnlimit,
  }));
}

async function captureRoleMembers(client) {
  const { rows } = await client.query(`
    SELECT
      r.rolname AS role,
      m.rolname AS member,
      g.rolname AS grantor,
      a.admin_option AS admin_option
    FROM pg_auth_members a
    JOIN pg_roles r ON r.oid = a.roleid
    JOIN pg_roles m ON m.oid = a.member
    JOIN pg_roles g ON g.oid = a.grantor
    WHERE r.rolname = 'sms_app' OR m.rolname = 'sms_app'
    ORDER BY 1, 2, 3
  `);
  return rows.map((r) => ({
    role: r.role,
    member: r.member,
    grantor: r.grantor,
    admin_option: r.admin_option,
  }));
}

async function captureRoleSettings(client) {
  const { rows } = await client.query(`
    SELECT
      r.rolname AS role,
      s.setconfig AS config
    FROM pg_db_role_setting s
    JOIN pg_roles r ON r.oid = s.setrole
    WHERE r.rolname = 'sms_app'
      AND (s.setdatabase = 0 OR s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()))
    ORDER BY r.rolname
  `);
  return rows.map((r) => ({
    role: r.role,
    config: [...(r.config ?? [])].map(String).sort(),
  }));
}

async function captureTables(client) {
  const { rows } = await client.query(`
    SELECT
      n.nspname AS schema,
      c.relname AS name,
      c.relrowsecurity AS rls,
      c.relforcerowsecurity AS force_rls,
      c.relowner::regrole::text AS owner,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,
              'privilege', x.privilege_type,
              'grantable', x.is_grantable
            )
            ORDER BY
              CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,
              x.privilege_type
          )
          FROM aclexplode(c.relacl) AS x(grantor, grantee, privilege_type, is_grantable)
        ),
        '[]'::json
      ) AS acl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'app')
      AND c.relkind = 'r'
      AND NOT (n.nspname = 'public' AND c.relname = 'pgmigrations')
    ORDER BY n.nspname, c.relname
  `);
  return rows.map((r) => ({
    schema: r.schema,
    name: r.name,
    rls: r.rls,
    force_rls: r.force_rls,
    // Omit owner — migrator role name varies; compare non-owner ACL only.
    acl: nonOwnerAcl(r.acl, r.owner),
  }));
}

async function captureColumns(client) {
  const { rows } = await client.query(`
    SELECT
      n.nspname AS schema,
      c.relname AS table,
      a.attname AS name,
      a.attnum AS num
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'app')
      AND c.relkind = 'r'
      AND NOT (n.nspname = 'public' AND c.relname = 'pgmigrations')
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY n.nspname, c.relname, a.attnum
  `);
  return rows.map((r) => ({
    schema: r.schema,
    table: r.table,
    name: r.name,
  }));
}

async function captureColumnAcls(client) {
  const { rows } = await client.query(`
    SELECT
      n.nspname AS schema,
      c.relname AS table,
      a.attname AS column,
      c.relowner::regrole::text AS owner,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,
              'privilege', x.privilege_type,
              'grantable', x.is_grantable
            )
            ORDER BY
              CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,
              x.privilege_type
          )
          FROM aclexplode(a.attacl) AS x(grantor, grantee, privilege_type, is_grantable)
        ),
        '[]'::json
      ) AS acl
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'app')
      AND c.relkind = 'r'
      AND NOT (n.nspname = 'public' AND c.relname = 'pgmigrations')
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND a.attacl IS NOT NULL
    ORDER BY n.nspname, c.relname, a.attname
  `);
  return rows
    .map((r) => ({
      schema: r.schema,
      table: r.table,
      column: r.column,
      acl: nonOwnerAcl(r.acl, r.owner),
    }))
    .filter((r) => r.acl.length > 0);
}

async function capturePolicies(client) {
  const { rows } = await client.query(`
    SELECT
      schemaname AS schema,
      tablename AS table,
      policyname AS name,
      permissive,
      roles::text[] AS roles,
      cmd,
      qual,
      with_check
    FROM pg_policies
    WHERE schemaname IN ('public', 'app')
    ORDER BY schemaname, tablename, policyname
  `);
  return rows.map((r) => ({
    schema: r.schema,
    table: r.table,
    name: r.name,
    permissive: r.permissive,
    roles: [...r.roles].map(String).sort(),
    cmd: r.cmd,
    qual: r.qual,
    with_check: r.with_check,
  }));
}

async function captureFunctions(client) {
  const { rows } = await client.query(`
    SELECT
      n.nspname AS schema,
      p.proname AS name,
      pg_get_function_identity_arguments(p.oid) AS args,
      p.prosecdef AS security_definer,
      p.proowner::regrole::text AS owner,
      COALESCE(p.proconfig, ARRAY[]::text[]) AS config,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,
              'privilege', x.privilege_type,
              'grantable', x.is_grantable
            )
            ORDER BY
              CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,
              x.privilege_type
          )
          FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS x(grantor, grantee, privilege_type, is_grantable)
        ),
        '[]'::json
      ) AS acl
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app'
    ORDER BY n.nspname, p.proname, 3
  `);
  return rows.map((r) => ({
    schema: r.schema,
    name: r.name,
    args: r.args,
    security_definer: r.security_definer,
    config: [...r.config].map(String).sort(),
    acl: nonOwnerAcl(r.acl, r.owner),
  }));
}

async function captureNamespaces(client) {
  const { rows } = await client.query(`
    SELECT
      n.nspname AS name,
      n.nspowner::regrole::text AS owner,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,
              'privilege', x.privilege_type,
              'grantable', x.is_grantable
            )
            ORDER BY
              CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,
              x.privilege_type
          )
          FROM aclexplode(n.nspacl) AS x(grantor, grantee, privilege_type, is_grantable)
        ),
        '[]'::json
      ) AS acl
    FROM pg_namespace n
    WHERE n.nspname IN ('public', 'app')
    ORDER BY n.nspname
  `);
  return rows.map((r) => ({
    name: r.name,
    // Non-owner grantees only (PUBLIC + sms_app, …). Catches GRANT CREATE … TO PUBLIC.
    acl: nonOwnerAcl(r.acl, r.owner),
  }));
}

async function captureDatabase(client) {
  const { rows } = await client.query(`
    SELECT
      d.datname AS name,
      d.datdba::regrole::text AS owner,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,
              'privilege', x.privilege_type,
              'grantable', x.is_grantable
            )
            ORDER BY
              CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,
              x.privilege_type
          )
          FROM aclexplode(d.datacl) AS x(grantor, grantee, privilege_type, is_grantable)
        ),
        '[]'::json
      ) AS acl
    FROM pg_database d
    WHERE d.datname = current_database()
  `);
  const r = rows[0];
  return {
    // Omit database name — differs across temp DBs in equivalence.
    acl: nonOwnerAcl(r?.acl ?? [], r?.owner),
  };
}

async function captureDefaultAcls(client) {
  const { rows } = await client.query(`
    SELECT
      COALESCE(n.nspname, '') AS schema,
      d.defaclobjtype AS objtype,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,
              'privilege', x.privilege_type,
              'grantable', x.is_grantable
            )
            ORDER BY
              CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,
              x.privilege_type
          )
          FROM aclexplode(d.defaclacl) AS x(grantor, grantee, privilege_type, is_grantable)
        ),
        '[]'::json
      ) AS acl
    FROM pg_default_acl d
    JOIN pg_roles r ON r.oid = d.defaclrole
    LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
    WHERE r.rolname = current_user
      AND (n.nspname IS NULL OR n.nspname IN ('public', 'app'))
    ORDER BY COALESCE(n.nspname, ''), d.defaclobjtype
  `);
  return rows.map((r) => ({
    schema: r.schema,
    objtype: r.objtype,
    acl: normalizeAcl(r.acl),
  }));
}

/** Drop the object owner's own ACL rows (role-/PG-version specific). */
function nonOwnerAcl(acl, owner) {
  const ownerName = owner && owner !== "-" ? String(owner) : null;
  return normalizeAcl(acl).filter((e) => e.grantee !== ownerName);
}

function normalizeAcl(acl) {
  const list = Array.isArray(acl) ? acl : [];
  return list
    .map((e) => ({
      grantee: e.grantee === "-" || e.grantee === "0" ? PUBLIC : String(e.grantee),
      privilege: String(e.privilege),
      grantable: Boolean(e.grantable),
    }))
    .sort((a, b) =>
      `${a.grantee}\0${a.privilege}\0${a.grantable}`.localeCompare(
        `${b.grantee}\0${b.privilege}\0${b.grantable}`,
      ),
    );
}

/**
 * Stable JSON for deep equality / diffs.
 * @param {object} catalog
 */
export function stableStringify(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

/**
 * @param {object} left
 * @param {object} right
 * @param {{ leftLabel?: string, rightLabel?: string }} [labels]
 * @returns {string[]} human-readable difference lines (empty = equal)
 */
export function diffCatalogs(left, right, labels = {}) {
  const leftLabel = labels.leftLabel ?? "left";
  const rightLabel = labels.rightLabel ?? "right";
  const diffs = [];

  diffSection(diffs, "roles", left.roles, right.roles, leftLabel, rightLabel, (r) => r.rolname);
  diffSection(
    diffs,
    "roleMembers",
    left.roleMembers,
    right.roleMembers,
    leftLabel,
    rightLabel,
    (r) => `${r.role}←${r.member}`,
  );
  diffSection(
    diffs,
    "roleSettings",
    left.roleSettings,
    right.roleSettings,
    leftLabel,
    rightLabel,
    (r) => r.role,
  );
  diffSection(
    diffs,
    "tables",
    left.tables,
    right.tables,
    leftLabel,
    rightLabel,
    (t) => `${t.schema}.${t.name}`,
  );
  diffSection(
    diffs,
    "columns",
    left.columns,
    right.columns,
    leftLabel,
    rightLabel,
    (c) => `${c.schema}.${c.table}.${c.name}`,
  );
  diffSection(
    diffs,
    "columnAcls",
    left.columnAcls,
    right.columnAcls,
    leftLabel,
    rightLabel,
    (c) => `${c.schema}.${c.table}.${c.column}`,
  );
  diffSection(
    diffs,
    "policies",
    left.policies,
    right.policies,
    leftLabel,
    rightLabel,
    (p) => `${p.schema}.${p.table}.${p.name}`,
  );
  diffSection(
    diffs,
    "functions",
    left.functions,
    right.functions,
    leftLabel,
    rightLabel,
    (f) => `${f.schema}.${f.name}(${f.args})`,
  );
  diffSection(
    diffs,
    "namespaces",
    left.namespaces,
    right.namespaces,
    leftLabel,
    rightLabel,
    (n) => n.name,
  );
  if (JSON.stringify(left.database) !== JSON.stringify(right.database)) {
    diffs.push(
      `database ACL differs:\n  ${leftLabel}: ${JSON.stringify(left.database)}\n  ${rightLabel}: ${JSON.stringify(right.database)}`,
    );
  }
  diffSection(
    diffs,
    "defaultAcls",
    left.defaultAcls,
    right.defaultAcls,
    leftLabel,
    rightLabel,
    (d) => `${d.schema || "(none)"}:${d.objtype}`,
  );

  return diffs;
}

function diffSection(diffs, section, leftArr, rightArr, leftLabel, rightLabel, keyFn) {
  const leftMap = new Map((leftArr ?? []).map((x) => [keyFn(x), x]));
  const rightMap = new Map((rightArr ?? []).map((x) => [keyFn(x), x]));
  const keys = new Set([...leftMap.keys(), ...rightMap.keys()]);
  for (const key of [...keys].sort()) {
    const l = leftMap.get(key);
    const r = rightMap.get(key);
    if (!l) {
      diffs.push(`${section}: ${key} only in ${rightLabel}`);
      continue;
    }
    if (!r) {
      diffs.push(`${section}: ${key} only in ${leftLabel}`);
      continue;
    }
    if (JSON.stringify(l) !== JSON.stringify(r)) {
      diffs.push(
        `${section}: ${key} differs:\n  ${leftLabel}: ${JSON.stringify(l)}\n  ${rightLabel}: ${JSON.stringify(r)}`,
      );
    }
  }
}

/**
 * Load committed expected catalog (produced from a known-good baseline DB).
 * @returns {object}
 */
export function loadExpectedCatalog() {
  return JSON.parse(fs.readFileSync(EXPECTED_CATALOG_PATH, "utf8"));
}

/**
 * Compare a live catalog to the committed expected baseline.
 * @param {object} actual
 * @returns {string[]}
 */
export function diffAgainstExpected(actual) {
  const expected = loadExpectedCatalog();
  return diffCatalogs(expected, actual, {
    leftLabel: "expected-baseline",
    rightLabel: "database",
  });
}

/**
 * Format diffs for a thrown Error / CI log.
 * @param {string[]} diffs
 * @param {string} [header]
 */
export function formatCatalogDiffs(diffs, header = "Catalog differences") {
  return `${header} (${diffs.length}):\n${diffs.map((d) => `  - ${d}`).join("\n")}`;
}

/** CLI: `node scripts/catalog-fingerprint.mjs write` — capture current DB → expected-catalog.json */
async function cliMain() {
  const cmd = process.argv[2];
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("Set MIGRATE_DATABASE_URL");
    process.exit(1);
  }
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const catalog = await captureCatalog(client);
    if (cmd === "write") {
      fs.writeFileSync(EXPECTED_CATALOG_PATH, stableStringify(catalog));
      console.log(`Wrote ${EXPECTED_CATALOG_PATH}`);
      return;
    }
    if (cmd === "check") {
      const diffs = diffAgainstExpected(catalog);
      if (diffs.length) {
        console.error(formatCatalogDiffs(diffs));
        process.exitCode = 1;
        return;
      }
      console.log("Catalog matches expected-catalog.json");
      return;
    }
    process.stdout.write(stableStringify(catalog));
  } finally {
    await client.end();
  }
}

const isCli =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  void cliMain().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
