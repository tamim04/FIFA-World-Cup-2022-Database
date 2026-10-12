const con = require("./connection");

const db = con.promise();
let cached = null;

const NUMERIC_TYPES = new Set([
    "tinyint", "smallint", "mediumint", "int", "integer", "bigint",
    "decimal", "numeric", "float", "double", "real", "bit", "year",
]);

// "enum('MF','DF')" -> ["MF", "DF"]; null for any other column type
function parseEnumValues(columnType) {
    const match = /^(?:enum|set)\((.*)\)$/i.exec(columnType);
    if (!match) return null;
    return [...match[1].matchAll(/'((?:[^']|'')*)'/g)].map(m => m[1].replace(/''/g, "'"));
}

// Reads the tables, columns and foreign keys of the connected database from
// information_schema. The query builder and SQL console check every table and
// column name against this, so user input never becomes raw SQL.
async function getSchema() {
    if (cached) return cached;

    const [[{ database }]] = await db.query("SELECT DATABASE() AS `database`");
    const [columns] = await db.query(
        `SELECT table_name AS tableName, column_name AS name, data_type AS dataType,
                column_type AS columnType, column_key AS columnKey, is_nullable AS nullable
         FROM information_schema.columns
         WHERE table_schema = ?
         ORDER BY table_name, ordinal_position`,
        [database]
    );
    const [foreignKeys] = await db.query(
        `SELECT constraint_name AS name, table_name AS \`table\`, column_name AS \`column\`,
                referenced_table_name AS refTable, referenced_column_name AS refColumn
         FROM information_schema.key_column_usage
         WHERE table_schema = ? AND referenced_table_name IS NOT NULL
         ORDER BY table_name, column_name`,
        [database]
    );

    const tables = new Map();
    for (const col of columns) {
        if (!tables.has(col.tableName)) tables.set(col.tableName, { name: col.tableName, columns: [] });
        tables.get(col.tableName).columns.push({
            name: col.name,
            type: col.columnType,
            numeric: NUMERIC_TYPES.has(String(col.dataType).toLowerCase()),
            primaryKey: col.columnKey === "PRI",
            nullable: col.nullable === "YES",
            enumValues: parseEnumValues(col.columnType),
        });
    }

    // The builder joins on single-column foreign keys only
    const columnsPerKey = new Map();
    for (const fk of foreignKeys) columnsPerKey.set(fk.name, (columnsPerKey.get(fk.name) || 0) + 1);

    cached = {
        database,
        tables,
        foreignKeys: foreignKeys.filter(fk =>
            columnsPerKey.get(fk.name) === 1 && tables.has(fk.table) && tables.has(fk.refTable)),
    };
    return cached;
}

function findColumn(schema, tableName, columnName) {
    const table = schema.tables.get(tableName);
    return table ? table.columns.find(c => c.name === columnName) : undefined;
}

// Exact row counts, fetched fresh each time because inserts and deletes change them
async function getRowCounts(schema) {
    const names = [...schema.tables.keys()];
    if (!names.length) return {};
    const sql = names.map(() => "SELECT ? AS name, COUNT(*) AS n FROM ??").join(" UNION ALL ");
    const [rows] = await db.query(sql, names.flatMap(name => [name, name]));
    return Object.fromEntries(rows.map(r => [r.name, r.n]));
}

module.exports = { getSchema, findColumn, getRowCounts };
