const express = require("express");
const path = require("path");
const { escapeId, format } = require("mysql2");
const con = require("../server/connection");
const { getSchema, findColumn, getRowCounts } = require("../server/schema");

const router = express.Router();
const db = con.promise();

const MAX_ROWS = 1000;          // most rows any query API call returns
const TIME_LIMIT_MS = 10000;    // MySQL max_execution_time for console queries

// A problem with the request itself; sent back as a 400 with its message
class QueryError extends Error {}

// Quote one identifier; dots stay inside it (used for labels like `squads.squad_name`)
const id = name => escapeId(name, true);

function sendError(res, err) {
    if (err instanceof QueryError) return res.status(400).json({ error: err.message });
    if (err.sqlMessage) return res.status(400).json({ error: err.sqlMessage, code: err.code });
    console.error("Query API error:", err);
    res.status(500).json({ error: "Unexpected server error. Check the server console for details." });
}

// -------------------- Pages ------------------------------

router.get("/query_builder", (req, res) => {
    res.sendFile(path.join(__dirname, "../pages/query_builder.html"));
});

router.get("/sql_console", (req, res) => {
    res.sendFile(path.join(__dirname, "../pages/sql_console.html"));
});

// -------------------- Schema ------------------------------

router.get("/api/schema", async (req, res) => {
    try {
        const schema = await getSchema();
        const counts = await getRowCounts(schema);
        res.json({
            database: schema.database,
            tables: [...schema.tables.values()].map(t => ({ ...t, rowCount: counts[t.name] ?? null })),
            foreignKeys: schema.foreignKeys,
        });
    } catch (err) {
        sendError(res, err);
    }
});

// Distinct values of one column, for filter suggestions
router.get("/api/values", async (req, res) => {
    try {
        const schema = await getSchema();
        const { table, column } = req.query;
        if (!findColumn(schema, table, column)) throw new QueryError("Unknown table or column.");
        const [rows] = await db.query({
            sql: "SELECT DISTINCT ?? FROM ?? WHERE ?? IS NOT NULL ORDER BY 1 LIMIT ?",
            values: [column, table, column, MAX_ROWS],
            rowsAsArray: true,
        });
        res.json({ values: rows.map(r => r[0]) });
    } catch (err) {
        sendError(res, err);
    }
});

// -------------------- Query builder ------------------------------

const AGGREGATES = new Set(["COUNT", "COUNT_DISTINCT", "SUM", "AVG", "MIN", "MAX"]);
const JOIN_TYPES = { INNER: "INNER JOIN", LEFT: "LEFT JOIN" };
const COMPARISONS = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
const HAVING_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "between"];
const ALIAS_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;

function clampInt(value, min, max, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
}

function escapeLike(value) {
    return value.replace(/[\\%_]/g, ch => "\\" + ch);
}

function requireValue(value, what) {
    if (value === undefined || value === null || String(value).trim() === "") {
        throw new QueryError(`${what} needs a value.`);
    }
    return String(value).trim();
}

// Numbers compared with numeric columns are sent as numbers so the SQL reads naturally
function toParam(value, numeric) {
    return numeric && NUMBER_PATTERN.test(value) ? Number(value) : value;
}

// Turns one filter row into a SQL condition, pushing its values onto params
function buildCondition(expr, numeric, filter, what, params) {
    const { op } = filter;
    if (COMPARISONS[op]) {
        params.push(toParam(requireValue(filter.value, what), numeric));
        return `${expr} ${COMPARISONS[op]} ?`;
    }
    switch (op) {
        case "contains":
        case "not_contains":
            params.push(`%${escapeLike(requireValue(filter.value, what))}%`);
            return `${expr} ${op === "contains" ? "LIKE" : "NOT LIKE"} ?`;
        case "starts":
            params.push(`${escapeLike(requireValue(filter.value, what))}%`);
            return `${expr} LIKE ?`;
        case "ends":
            params.push(`%${escapeLike(requireValue(filter.value, what))}`);
            return `${expr} LIKE ?`;
        case "in":
        case "not_in": {
            const list = requireValue(filter.value, what).split(",").map(v => v.trim()).filter(Boolean);
            if (!list.length) throw new QueryError(`${what} needs at least one value.`);
            if (list.length > 200) throw new QueryError(`${what} can list at most 200 values.`);
            params.push(...list.map(v => toParam(v, numeric)));
            return `${expr} ${op === "in" ? "IN" : "NOT IN"} (${list.map(() => "?").join(", ")})`;
        }
        case "between":
            params.push(
                toParam(requireValue(filter.value, what), numeric),
                toParam(requireValue(filter.value2, what), numeric)
            );
            return `${expr} BETWEEN ? AND ?`;
        case "null":
            return `${expr} IS NULL`;
        case "not_null":
            return `${expr} IS NOT NULL`;
        default:
            throw new QueryError(`${what}: unknown condition "${op}".`);
    }
}

// Builds a SELECT from the query builder's JSON spec. Every table, column, alias,
// function and operator is checked against the schema or a fixed list, and every
// value becomes a ? placeholder.
function buildQuery(spec, schema) {
    const params = [];
    const aliases = new Map(); // alias -> table name

    function addAlias(alias, table) {
        if (typeof alias !== "string" || !ALIAS_PATTERN.test(alias)) throw new QueryError(`Invalid table alias "${alias}".`);
        if (aliases.has(alias)) throw new QueryError(`The alias "${alias}" is used twice.`);
        aliases.set(alias, table);
    }

    function tableWithAlias(table, alias) {
        return table === alias ? id(table) : `${id(table)} AS ${id(alias)}`;
    }

    function columnRef(ref, what) {
        const table = aliases.get(ref && ref.alias);
        const column = table && findColumn(schema, table, ref.column);
        if (!column) throw new QueryError(`${what}: unknown column "${ref && ref.alias}.${ref && ref.column}".`);
        return { sql: `${id(ref.alias)}.${id(ref.column)}`, column };
    }

    // FROM and JOINs. A join may only follow a real foreign key, in either direction.
    const base = spec.base || {};
    if (!schema.tables.has(base.table)) throw new QueryError(`Unknown table "${base.table}".`);
    addAlias(base.alias, base.table);
    const fromLines = [`FROM ${tableWithAlias(base.table, base.alias)}`];

    for (const join of spec.joins || []) {
        const fromTable = aliases.get(join.from);
        const fk = schema.foreignKeys.find(f => f.name === join.fk);
        const joinType = JOIN_TYPES[join.type];
        if (!fromTable || !fk || !joinType) throw new QueryError("One of the joins is invalid.");

        let table, on;
        if (fk.table === fromTable) {
            table = fk.refTable;
            on = `${id(join.from)}.${id(fk.column)} = ${id(join.alias)}.${id(fk.refColumn)}`;
        } else if (fk.refTable === fromTable) {
            table = fk.table;
            on = `${id(join.alias)}.${id(fk.column)} = ${id(join.from)}.${id(fk.refColumn)}`;
        } else {
            throw new QueryError(`"${join.from}" is not linked by the foreign key ${join.fk}.`);
        }
        addAlias(join.alias, table);
        fromLines.push(`${joinType} ${tableWithAlias(table, join.alias)} ON ${on}`);
    }

    // SELECT list. With several tables, labels carry the alias so they stay unambiguous.
    const multiTable = aliases.size > 1;
    let items = (spec.columns || []).map((col, i) => {
        if (col.column === "*") {
            if (col.agg !== "COUNT") throw new QueryError("* can only be used as COUNT(*).");
            return { expr: "COUNT(*)", label: "COUNT(*)", aggregate: true };
        }
        const ref = columnRef(col, `Column ${i + 1}`);
        const name = multiTable ? `${col.alias}.${col.column}` : col.column;
        if (!col.agg) return { expr: ref.sql, label: name, aggregate: false, plainName: col.column };
        if (!AGGREGATES.has(col.agg)) throw new QueryError(`Unknown function "${col.agg}".`);
        return col.agg === "COUNT_DISTINCT"
            ? { expr: `COUNT(DISTINCT ${ref.sql})`, label: `COUNT(DISTINCT ${name})`, aggregate: true }
            : { expr: `${col.agg}(${ref.sql})`, label: `${col.agg}(${name})`, aggregate: true };
    });
    if (!items.length) {
        for (const [alias, table] of aliases) {
            for (const column of schema.tables.get(table).columns) {
                items.push({
                    expr: `${id(alias)}.${id(column.name)}`,
                    label: multiTable ? `${alias}.${column.name}` : column.name,
                    aggregate: false,
                    plainName: column.name,
                });
            }
        }
    }
    // Output names must be unique: the row count wraps the query in a subquery
    const seen = new Map();
    for (const item of items) {
        const n = (seen.get(item.label) || 0) + 1;
        seen.set(item.label, n);
        if (n > 1) item.label += ` (${n})`;
    }

    // WHERE (its values come first in params, matching their order in the SQL)
    const where = (spec.filters || []).map(f => {
        const what = `Filter on ${f.alias}.${f.column}`;
        const ref = columnRef(f, what);
        return buildCondition(ref.sql, ref.column.numeric, f, what, params);
    });

    // GROUP BY every plain column as soon as one column is aggregated
    const aggregated = items.some(i => i.aggregate);
    const groupBy = aggregated ? items.filter(i => !i.aggregate).map(i => i.expr) : [];

    const having = (spec.having || []).map((h, i) => {
        const item = items[h.index];
        if (!item || !item.aggregate) {
            throw new QueryError(`Group filter ${i + 1} must use a column with a function (COUNT, SUM, ...).`);
        }
        if (!HAVING_OPS.includes(h.op)) throw new QueryError(`Group filter ${i + 1}: unknown condition "${h.op}".`);
        return buildCondition(item.expr, true, h, `Group filter on ${item.label}`, params);
    });

    const orderBy = (spec.orderBy || []).map((o, i) => {
        const dir = o.dir === "DESC" ? "DESC" : "ASC";
        if (o.index !== undefined && o.index !== null) {
            const item = items[o.index];
            if (!item) throw new QueryError(`Sort ${i + 1} refers to a column that is not selected.`);
            return `${id(item.label)} ${dir}`;
        }
        return `${columnRef(o, `Sort ${i + 1}`).sql} ${dir}`;
    });

    const limit = clampInt(spec.limit, 1, MAX_ROWS, 50);
    const offset = clampInt(spec.offset, 0, 1e9, 0);

    const selectList = items.map(i => (i.label === i.plainName ? i.expr : `${i.expr} AS ${id(i.label)}`));
    const lines = [`SELECT ${spec.distinct ? "DISTINCT " : ""}${selectList.join(",\n       ")}`, ...fromLines];
    if (where.length) lines.push(`WHERE ${where.join(spec.match === "any" ? "\n   OR " : "\n  AND ")}`);
    if (groupBy.length) lines.push(`GROUP BY ${groupBy.join(", ")}`);
    if (having.length) lines.push(`HAVING ${having.join("\n   AND ")}`);
    const core = lines.join("\n");
    const ordering = orderBy.length ? `\nORDER BY ${orderBy.join(", ")}` : "";

    return {
        sql: `${core}${ordering}\nLIMIT ${limit} OFFSET ${offset}`,
        countSql: `SELECT COUNT(*) AS total FROM (\n${core}\n) AS counted`,
        params,
        offset,
    };
}

router.post("/api/query", async (req, res) => {
    try {
        const schema = await getSchema();
        const spec = req.body || {};
        const query = buildQuery(spec, schema);
        const shownSql = format(query.sql, query.params);
        if (spec.preview) return res.json({ sql: shownSql });

        const started = Date.now();
        const [[rows, fields], [countRows]] = await Promise.all([
            db.query({ sql: query.sql, values: query.params, rowsAsArray: true }),
            db.query(query.countSql, query.params),
        ]);
        res.json({
            sql: shownSql,
            columns: fields.map(f => f.name),
            rows,
            total: Number(countRows[0].total),
            offset: query.offset,
            elapsedMs: Date.now() - started,
        });
    } catch (err) {
        sendError(res, err);
    }
});

// -------------------- SQL console ------------------------------

const READ_ONLY_START = /^(select|with|show|describe|desc|explain|table)\b/i;
const LEADING_COMMENTS = /^(\s+|--[^\n]*(\n|$)|#[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)+/;
const GAP = String.raw`(?:\s|/\*[\s\S]*?\*/|--[^\n]*\n|#[^\n]*\n)+`;
const FILE_ACCESS = new RegExp(String.raw`\binto${GAP}(outfile|dumpfile)\b|\bload_file\b`, "i");

// Accepts a single read-only statement and returns it without leading comments
// or a trailing semicolon. It then runs inside a READ ONLY transaction, so this
// check is the first of two safeguards against changing data.
function readOnlyStatement(input) {
    const raw = String(input || "");
    const sql = raw.replace(LEADING_COMMENTS, "").replace(/[\s;]+$/, "");
    if (!sql) throw new QueryError("Type a query to run.");
    if (raw.includes("/*!")) throw new QueryError("Executable comments (/*! ... */) are not allowed in the console.");
    if (!READ_ONLY_START.test(sql)) {
        throw new QueryError("The console is read-only. Start your query with SELECT, WITH, SHOW, DESCRIBE, EXPLAIN or TABLE.");
    }
    if (FILE_ACCESS.test(sql)) throw new QueryError("Reading or writing files on the server is not allowed.");
    return sql;
}

// Runs a query but keeps at most maxRows rows in memory. If more arrive, the
// query is cancelled with KILL QUERY so a huge result can't exhaust memory.
function streamRows(connection, sql, maxRows) {
    return new Promise((resolve, reject) => {
        const rows = [];
        let columns = [];
        let truncated = false;
        const done = () => resolve({ columns, rows, truncated });

        connection.query({ sql, rowsAsArray: true })
            .on("fields", fields => { columns = (fields || []).map(f => f.name); })
            .on("result", row => {
                if (!Array.isArray(row)) return; // OK packet, not a row
                if (rows.length < maxRows) return void rows.push(row);
                if (!truncated) {
                    truncated = true;
                    db.query("KILL QUERY ?", [connection.threadId]).catch(() => {});
                }
            })
            .on("error", err => (truncated ? done() : reject(err))) // after KILL QUERY the error is expected
            .on("end", done);
    });
}

router.post("/api/sql", async (req, res) => {
    let conn;
    let discardConnection = false;
    try {
        const sql = readOnlyStatement(req.body && req.body.sql);
        conn = await db.getConnection();
        await conn.query(`SET SESSION max_execution_time = ${TIME_LIMIT_MS}`);
        await conn.query("START TRANSACTION READ ONLY");

        const started = Date.now();
        const result = await streamRows(conn.connection, sql, MAX_ROWS);
        discardConnection = result.truncated; // a late KILL QUERY must not hit the next user of this connection
        res.json({ ...result, elapsedMs: Date.now() - started });
    } catch (err) {
        sendError(res, err);
    } finally {
        if (conn) {
            try {
                if (discardConnection) throw new Error("discard");
                await conn.query("ROLLBACK");
                await conn.query("SET SESSION max_execution_time = DEFAULT");
                conn.release();
            } catch {
                conn.destroy();
            }
        }
    }
});

module.exports = router;
