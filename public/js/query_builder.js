// Query builder. The page keeps the query as plain data in `state`, draws form
// controls for it, and sends it to /api/query, which validates it and writes the SQL.
(function () {
    const { api, el, debounce, fmt, highlightSql, renderResult, errorBox, loadingBox } = window.QueryKit;

    const FUNCTIONS = [
        ["", "no function"], ["COUNT", "COUNT"], ["COUNT_DISTINCT", "COUNT DISTINCT"],
        ["SUM", "SUM"], ["AVG", "AVG"], ["MIN", "MIN"], ["MAX", "MAX"],
    ];
    const FUNCTION_NAMES = new Set(FUNCTIONS.map(f => f[0]).filter(Boolean));
    const NUMERIC_FUNCTIONS = new Set(["SUM", "AVG"]);
    const OPERATOR_LABELS = {
        eq: "=", ne: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", between: "between",
        contains: "contains", not_contains: "doesn't contain", starts: "starts with", ends: "ends with",
        in: "is one of", not_in: "is not one of", null: "is empty (NULL)", not_null: "is not empty",
    };
    const NO_VALUE_OPS = new Set(["null", "not_null"]);
    const HAVING_OPS = ["gt", "gte", "eq", "ne", "lt", "lte", "between"];
    const PAGE_SIZES = [10, 25, 50, 100, 500, 1000];
    const ALIAS_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

    // Examples use this database's foreign-key names; any that don't fit the schema are hidden
    const EXAMPLES = [
        {
            name: "Top 10 scorers with their squad",
            base: "players_stats",
            joins: [
                { alias: "all_players_info", from: "players_stats", fk: "fk_player_id", type: "INNER" },
                { alias: "squads", from: "all_players_info", fk: "fk_squad_id", type: "INNER" },
            ],
            columns: [
                { id: 1, alias: "all_players_info", column: "player_name" },
                { id: 2, alias: "squads", column: "squad_name" },
                { id: 3, alias: "players_stats", column: "goals" },
                { id: 4, alias: "players_stats", column: "assists" },
            ],
            filters: [{ alias: "players_stats", column: "goals", op: "gt", value: "0" }],
            orderBy: [{ key: "out:3", dir: "DESC" }, { key: "out:4", dir: "DESC" }],
            limit: 10,
        },
        {
            name: "Squads with more than 10 goals (GROUP BY + HAVING)",
            base: "squads",
            joins: [
                { alias: "all_players_info", from: "squads", fk: "fk_squad_id", type: "INNER" },
                { alias: "players_stats", from: "all_players_info", fk: "fk_player_id", type: "INNER" },
            ],
            columns: [
                { id: 1, alias: "squads", column: "squad_name" },
                { id: 2, alias: "players_stats", column: "goals", agg: "SUM" },
                { id: 3, alias: "players_stats", column: "assists", agg: "SUM" },
                { id: 4, alias: "all_players_info", column: "player_id", agg: "COUNT" },
            ],
            having: [{ columnId: 2, op: "gt", value: "10" }],
            orderBy: [{ key: "out:2", dir: "DESC" }],
            limit: 50,
        },
        {
            name: "Match results with team and stadium names",
            base: "matches",
            joins: [
                { alias: "squad_1", from: "matches", fk: "fk_squad_1_id", type: "INNER" },
                { alias: "squad_2", from: "matches", fk: "fk_squad_2_id", type: "INNER" },
                { alias: "stadiums", from: "matches", fk: "fk_stadium_id", type: "INNER" },
            ],
            columns: [
                { id: 1, alias: "matches", column: "match_date" },
                { id: 2, alias: "squad_1", column: "squad_name" },
                { id: 3, alias: "matches", column: "score_squad_1" },
                { id: 4, alias: "matches", column: "score_squad_2" },
                { id: 5, alias: "squad_2", column: "squad_name" },
                { id: 6, alias: "stadiums", column: "stadium_name" },
            ],
            orderBy: [{ key: "col:matches.match_id", dir: "ASC" }],
            limit: 100,
        },
        {
            name: "Goalkeepers ranked by saves",
            base: "keepers_stats",
            joins: [
                { alias: "all_players_info", from: "keepers_stats", fk: "fk_keeper_player_id", type: "INNER" },
                { alias: "squads", from: "all_players_info", fk: "fk_squad_id", type: "INNER" },
                { alias: "clubs", from: "all_players_info", fk: "fk_club_id", type: "INNER" },
            ],
            columns: [
                { id: 1, alias: "all_players_info", column: "player_name" },
                { id: 2, alias: "squads", column: "squad_name" },
                { id: 3, alias: "clubs", column: "club_name" },
                { id: 4, alias: "keepers_stats", column: "saves" },
                { id: 5, alias: "keepers_stats", column: "clean_sheets" },
                { id: 6, alias: "keepers_stats", column: "goals_against" },
            ],
            orderBy: [{ key: "out:4", dir: "DESC" }],
            limit: 25,
        },
        {
            name: "Clubs that sent 5 or more players",
            base: "clubs",
            joins: [{ alias: "all_players_info", from: "clubs", fk: "fk_club_id", type: "INNER" }],
            columns: [
                { id: 1, alias: "clubs", column: "club_name" },
                { id: 2, alias: "all_players_info", column: "player_id", agg: "COUNT" },
                { id: 3, alias: "all_players_info", column: "squad_id", agg: "COUNT_DISTINCT" },
            ],
            having: [{ columnId: 2, op: "gte", value: "5" }],
            orderBy: [{ key: "out:2", dir: "DESC" }],
            limit: 50,
        },
        {
            name: "Average age and player count per position",
            base: "all_players_info",
            joins: [{ alias: "position", from: "all_players_info", fk: "fk_position_id", type: "INNER" }],
            columns: [
                { id: 1, alias: "position", column: "position_name" },
                { id: 2, alias: "all_players_info", column: "age", agg: "AVG" },
                { id: 3, alias: "all_players_info", column: "player_id", agg: "COUNT" },
                { id: 4, alias: "all_players_info", column: "minutes_played", agg: "SUM" },
            ],
            orderBy: [{ key: "out:2", dir: "DESC" }],
            limit: 50,
        },
        {
            name: "Players aged 21 or under",
            base: "all_players_info",
            joins: [
                { alias: "position", from: "all_players_info", fk: "fk_position_id", type: "INNER" },
                { alias: "squads", from: "all_players_info", fk: "fk_squad_id", type: "INNER" },
            ],
            columns: [
                { id: 1, alias: "all_players_info", column: "player_name" },
                { id: 2, alias: "all_players_info", column: "age" },
                { id: 3, alias: "position", column: "position_name" },
                { id: 4, alias: "squads", column: "squad_name" },
                { id: 5, alias: "all_players_info", column: "minutes_played" },
            ],
            filters: [{ alias: "all_players_info", column: "age", op: "lte", value: "21" }],
            orderBy: [{ key: "out:2", dir: "ASC" }, { key: "out:5", dir: "DESC" }],
            limit: 50,
        },
        {
            name: "Find a player by name",
            base: "all_players_info",
            joins: [
                { alias: "squads", from: "all_players_info", fk: "fk_squad_id", type: "INNER" },
                { alias: "clubs", from: "all_players_info", fk: "fk_club_id", type: "INNER" },
            ],
            columns: [
                { id: 1, alias: "all_players_info", column: "player_name" },
                { id: 2, alias: "squads", column: "squad_name" },
                { id: 3, alias: "clubs", column: "club_name" },
                { id: 4, alias: "all_players_info", column: "age" },
                { id: 5, alias: "all_players_info", column: "matches_played" },
            ],
            filters: [{ alias: "all_players_info", column: "player_name", op: "contains", value: "Messi" }],
            limit: 50,
        },
    ];

    const $ = id => document.getElementById(id);
    const sqlBox = $("sql");
    const resultsBox = $("results");
    const runButton = $("run");

    let schema = null;   // { tables: Map, tableList, foreignKeys }
    let state = null;
    let examples = [];
    let nextId = 1;
    let offset = 0;
    let currentSql = "";

    // -------------------- Schema helpers --------------------

    const fkByName = name => schema.foreignKeys.find(f => f.name === name);
    const findMeta = (table, column) => {
        const t = schema.tables.get(table);
        return t ? t.columns.find(c => c.name === column) : undefined;
    };
    const aliasList = () => [state.base, ...state.joins.map(j => j.alias)];
    const aliasTable = alias => (alias === state.base ? state.base : (state.joins.find(j => j.alias === alias) || {}).tableName);
    const columnMeta = (alias, column) => findMeta(aliasTable(alias), column);
    const splitKey = key => {
        const dot = key.indexOf(".");
        return [key.slice(0, dot), key.slice(dot + 1)];
    };
    const keyOf = col => (col.column === "*" ? "*" : `${col.alias}.${col.column}`);

    // The table reached from `fromTable` through a foreign key, in either direction
    function joinTarget(fromTable, fkName) {
        const fk = fkByName(fkName);
        if (!fk) return null;
        if (fk.table === fromTable) return fk.refTable;
        if (fk.refTable === fromTable) return fk.table;
        return null;
    }

    function labelOf(col) {
        if (col.column === "*") return "COUNT(*)";
        const name = aliasList().length > 1 ? `${col.alias}.${col.column}` : col.column;
        if (!col.agg) return name;
        return col.agg === "COUNT_DISTINCT" ? `COUNT(DISTINCT ${name})` : `${col.agg}(${name})`;
    }

    function operatorsFor(meta) {
        let ops;
        if (meta.enumValues) ops = ["eq", "ne", "in", "not_in"];
        else if (meta.numeric) ops = ["eq", "ne", "gt", "gte", "lt", "lte", "between", "in", "not_in"];
        else ops = ["contains", "eq", "ne", "starts", "ends", "not_contains", "in", "not_in"];
        return meta.nullable ? ops.concat("null", "not_null") : ops;
    }

    // -------------------- State --------------------

    function blankState(base) {
        return { base, joins: [], columns: [], filters: [], match: "all", having: [], orderBy: [], distinct: false, limit: 50 };
    }

    // Rebuilds a state from untrusted data (a URL or an example), dropping anything
    // that doesn't match the schema and giving every row a fresh id.
    function sanitize(raw) {
        if (!raw || !schema.tables.has(raw.base)) throw new Error("Unknown table");
        const s = blankState(raw.base);
        const aliasTables = new Map([[raw.base, raw.base]]);

        for (const j of raw.joins || []) {
            const target = aliasTables.has(j.from) ? joinTarget(aliasTables.get(j.from), j.fk) : null;
            if (!target || aliasTables.has(j.alias) || !ALIAS_PATTERN.test(j.alias)) continue;
            aliasTables.set(j.alias, target);
            s.joins.push({ alias: j.alias, from: j.from, fk: j.fk, type: j.type === "LEFT" ? "LEFT" : "INNER", tableName: target });
        }

        const exists = (alias, column) => aliasTables.has(alias) && !!findMeta(aliasTables.get(alias), column);
        const ids = new Map();
        for (const c of raw.columns || []) {
            const star = c.column === "*";
            if (!star && !exists(c.alias, c.column)) continue;
            const id = nextId++;
            ids.set(c.id, id);
            s.columns.push({
                id,
                alias: star ? raw.base : c.alias,
                column: c.column,
                agg: star ? "COUNT" : (FUNCTION_NAMES.has(c.agg) ? c.agg : ""),
            });
        }
        s.filters = (raw.filters || []).filter(f => exists(f.alias, f.column)).map(f => ({
            id: nextId++, alias: f.alias, column: f.column, op: String(f.op || ""),
            value: String(f.value ?? ""), value2: String(f.value2 ?? ""),
        }));
        s.match = raw.match === "any" ? "any" : "all";
        s.having = (raw.having || []).filter(h => ids.has(h.columnId)).map(h => ({
            id: nextId++, columnId: ids.get(h.columnId), op: HAVING_OPS.includes(h.op) ? h.op : "gt",
            value: String(h.value ?? ""), value2: String(h.value2 ?? ""),
        }));
        s.orderBy = (raw.orderBy || []).map(o => {
            const key = String(o.key || "");
            const dir = o.dir === "DESC" ? "DESC" : "ASC";
            if (key.startsWith("out:")) {
                const id = ids.get(Number(key.slice(4)));
                return id ? { id: nextId++, key: `out:${id}`, dir } : null;
            }
            if (key.startsWith("col:")) {
                const [alias, column] = splitKey(key.slice(4));
                return exists(alias, column) ? { id: nextId++, key, dir } : null;
            }
            return null;
        }).filter(Boolean);
        s.distinct = !!raw.distinct;
        s.limit = PAGE_SIZES.includes(Number(raw.limit)) ? Number(raw.limit) : 50;
        return s;
    }

    const isComplete = f => NO_VALUE_OPS.has(f.op) ||
        (String(f.value).trim() !== "" && (f.op !== "between" || String(f.value2).trim() !== ""));

    // The JSON the server expects. Unfinished filter rows are left out rather than sent as errors.
    function toSpec(preview) {
        const columns = state.columns;
        const indexOf = id => columns.findIndex(c => c.id === id);
        return {
            base: { table: state.base, alias: state.base },
            joins: state.joins.map(({ alias, from, fk, type }) => ({ alias, from, fk, type })),
            columns: columns.map(({ alias, column, agg }) => ({ alias, column, agg: agg || null })),
            distinct: state.distinct,
            filters: state.filters.filter(isComplete)
                .map(({ alias, column, op, value, value2 }) => ({ alias, column, op, value, value2 })),
            match: state.match,
            having: state.having.filter(h => isComplete(h) && indexOf(h.columnId) >= 0)
                .map(h => ({ index: indexOf(h.columnId), op: h.op, value: h.value, value2: h.value2 })),
            orderBy: state.orderBy.map(o => {
                if (o.key.startsWith("out:")) {
                    const index = indexOf(Number(o.key.slice(4)));
                    return index >= 0 ? { index, dir: o.dir } : null;
                }
                const [alias, column] = splitKey(o.key.slice(4));
                return { alias, column, dir: o.dir };
            }).filter(Boolean),
            limit: state.limit,
            offset,
            preview: !!preview,
        };
    }

    function saveToUrl() {
        const { base, joins, columns, filters, match, having, orderBy, distinct, limit } = state;
        const data = { base, joins: joins.map(({ tableName, ...j }) => j), columns, filters, match, having, orderBy, distinct, limit };
        history.replaceState(null, "", "#q=" + encodeURIComponent(JSON.stringify(data)));
    }

    function stateFromUrl() {
        const match = /^#q=(.+)$/.exec(location.hash);
        if (!match) return null;
        try {
            return sanitize(JSON.parse(decodeURIComponent(match[1])));
        } catch {
            return null;
        }
    }

    // Removes rows that point at aliases or result columns that no longer exist
    function prune() {
        const aliases = new Set(aliasList());
        state.columns = state.columns.filter(c => aliases.has(c.alias));
        state.filters = state.filters.filter(f => aliases.has(f.alias));
        const aggregateIds = new Set(state.columns.filter(c => c.agg).map(c => c.id));
        const columnIds = new Set(state.columns.map(c => c.id));
        state.having = state.having.filter(h => aggregateIds.has(h.columnId));
        state.orderBy = state.orderBy.filter(o => (o.key.startsWith("out:")
            ? columnIds.has(Number(o.key.slice(4)))
            : aliases.has(splitKey(o.key.slice(4))[0])));
    }

    // Call after every edit. Structural edits redraw the form; typing in a box doesn't,
    // so the input keeps focus.
    function changed(redraw = true) {
        offset = 0;
        prune();
        if (redraw) render();
        saveToUrl();
        schedulePreview();
    }

    // -------------------- Joins --------------------

    function joinOptions() {
        const used = new Set();
        for (const j of state.joins) {
            used.add(`${j.from}|${j.fk}`);
            used.add(`${j.alias}|${j.fk}`); // the same key back the other way
        }
        const options = [];
        for (const alias of aliasList()) {
            const table = aliasTable(alias);
            for (const fk of schema.foreignKeys) {
                if (used.has(`${alias}|${fk.name}`)) continue;
                if (fk.table === table) {
                    options.push({ from: alias, fk, target: fk.refTable, forward: true,
                        label: `${fk.refTable}  —  ${alias}.${fk.column} = ${fk.refTable}.${fk.refColumn}` });
                } else if (fk.refTable === table) {
                    options.push({ from: alias, fk, target: fk.table, forward: false,
                        label: `${fk.table}  —  ${alias}.${fk.refColumn} = ${fk.table}.${fk.column}` });
                }
            }
        }
        return options;
    }

    // Aliases read like the relationship: a table joined twice (matches -> squads)
    // gets names from its key columns, so squad_1 and squad_2.
    function chooseAlias(option) {
        const taken = new Set(aliasList());
        const { fk, target, forward } = option;
        const siblings = forward
            ? schema.foreignKeys.filter(f => f.table === fk.table && f.refTable === fk.refTable).length
            : 0;
        let alias = target;
        if (forward && (siblings > 1 || taken.has(alias))) alias = fk.column.replace(/_id$/i, "");
        alias = alias.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 60);
        if (!/^[A-Za-z_]/.test(alias)) alias = "t_" + alias;
        let candidate = alias;
        for (let n = 2; taken.has(candidate); n++) candidate = `${alias}_${n}`;
        return candidate;
    }

    function addJoin(option) {
        state.joins.push({ alias: chooseAlias(option), from: option.from, fk: option.fk.name, type: "INNER", tableName: option.target });
        changed();
    }

    function removeJoin(alias) {
        const doomed = new Set([alias]);
        let grew = true;
        while (grew) {
            grew = false;
            for (const j of state.joins) {
                if (doomed.has(j.from) && !doomed.has(j.alias)) {
                    doomed.add(j.alias);
                    grew = true;
                }
            }
        }
        state.joins = state.joins.filter(j => !doomed.has(j.alias));
        changed();
    }

    // -------------------- Form controls --------------------

    function removeButton(label, onclick) {
        return el("button", { type: "button", class: "btn icon", title: label, "aria-label": label, text: "×", onclick });
    }

    function addButton(text, onclick) {
        return el("button", { type: "button", class: "btn add", text, onclick });
    }

    function tableGroupLabel(alias) {
        const table = aliasTable(alias);
        return alias === table ? table : `${alias} (${table})`;
    }

    function columnPicker(selectedKey, onchange, { star = false } = {}) {
        const groups = aliasList().map(alias => el("optgroup", { label: tableGroupLabel(alias) },
            schema.tables.get(aliasTable(alias)).columns.map(c =>
                el("option", { value: `${alias}.${c.name}`, text: c.primaryKey ? `${c.name} (key)` : c.name }))));
        const options = star ? [el("option", { value: "*", text: "* (count rows)" }), ...groups] : groups;
        return el("select", { class: "grow", "aria-label": "Column", value: selectedKey, onchange: e => onchange(e.target.value) }, options);
    }

    function simpleSelect(label, value, options, onchange, extra = {}) {
        return el("select", { "aria-label": label, value, onchange: e => onchange(e.target.value), ...extra },
            options.map(([v, text, disabled]) => el("option", { value: v, text, disabled: !!disabled })));
    }

    function attachSuggestions(input, table, column) {
        const listId = `values-${table}-${column}`;
        input.setAttribute("list", listId);
        if (document.getElementById(listId)) return;
        const list = el("datalist", { id: listId });
        document.body.append(list);
        api(`/api/values?table=${encodeURIComponent(table)}&column=${encodeURIComponent(column)}`)
            .then(data => list.replaceChildren(...data.values.map(v => el("option", { value: String(v) }))))
            .catch(() => {});
    }

    // One or two value boxes for a filter row, shaped by the column type and operator
    function valueInputs(item, meta) {
        if (NO_VALUE_OPS.has(item.op)) return [];
        const listOp = item.op === "in" || item.op === "not_in";

        const makeInput = (prop, placeholder) => {
            if (meta.enumValues && !listOp) {
                if (!meta.enumValues.includes(item[prop])) item[prop] = meta.enumValues[0];
                return simpleSelect("Value", item[prop], meta.enumValues.map(v => [v, v]), v => {
                    item[prop] = v;
                    changed(false);
                }, { class: "grow" });
            }
            const input = el("input", {
                class: "grow value",
                type: meta.numeric && !listOp ? "number" : "text",
                step: meta.numeric && !listOp ? "any" : null,
                value: item[prop] ?? "",
                placeholder: listOp ? "comma-separated, e.g. 1, 2, 3" : placeholder,
                "aria-label": placeholder,
                oninput: e => {
                    item[prop] = e.target.value;
                    changed(false);
                },
                onkeydown: e => {
                    if (e.key === "Enter") run();
                },
            });
            if (!meta.numeric && !listOp && meta.table) attachSuggestions(input, meta.table, meta.name);
            return input;
        };

        return item.op === "between"
            ? [makeInput("value", "from"), el("span", { class: "muted", text: "and" }), makeInput("value2", "to")]
            : [makeInput("value", "value")];
    }

    // -------------------- Sections --------------------

    function renderSource() {
        const baseSelect = simpleSelect("Main table", state.base,
            schema.tableList.map(t => [t.name, `${t.name}  (${fmt(t.rowCount)} rows)`]),
            value => {
                state = blankState(value);
                changed();
            }, { class: "grow" });

        const joinRows = state.joins.map(join => {
            const fk = fkByName(join.fk);
            const forward = fk.table === aliasTable(join.from);
            const on = forward
                ? `${join.from}.${fk.column} = ${join.alias}.${fk.refColumn}`
                : `${join.alias}.${fk.column} = ${join.from}.${fk.refColumn}`;
            return el("div", { class: "row join-row" }, [
                simpleSelect("Join type", join.type, [["INNER", "INNER JOIN"], ["LEFT", "LEFT JOIN"]], v => {
                    join.type = v;
                    changed(false);
                }),
                el("span", { class: "join-target" }, [
                    el("strong", { text: join.tableName }),
                    join.alias !== join.tableName ? el("span", { class: "muted", text: ` as ${join.alias}` }) : null,
                ]),
                el("code", { class: "join-on", text: `ON ${on}` }),
                removeButton(`Remove join ${join.alias}`, () => removeJoin(join.alias)),
            ]);
        });

        const options = joinOptions();
        let addRow;
        if (options.length) {
            const groups = [];
            for (const alias of aliasList()) {
                const mine = options.filter(o => o.from === alias);
                if (mine.length) {
                    groups.push(el("optgroup", { label: `Related to ${alias}` },
                        mine.map(o => el("option", { value: String(options.indexOf(o)), text: o.label }))));
                }
            }
            const picker = el("select", { class: "grow", "aria-label": "Related table to join" }, groups);
            addRow = el("div", { class: "row" }, [picker, addButton("+ Join", () => addJoin(options[Number(picker.value)]))]);
        } else {
            addRow = el("p", { class: "muted small", text: "No more related tables to join." });
        }

        $("source").replaceChildren(
            el("div", { class: "row" }, [el("span", { class: "label", text: "FROM" }), baseSelect]),
            ...joinRows,
            addRow,
            el("p", { class: "hint", text: "Only tables linked by a foreign key are offered, so every join is valid. LEFT JOIN keeps rows that have no match." })
        );
    }

    function renderColumns() {
        const rows = state.columns.map(col => {
            const meta = col.column === "*" ? { numeric: true } : columnMeta(col.alias, col.column);
            const picker = columnPicker(keyOf(col), key => {
                if (key === "*") {
                    Object.assign(col, { alias: state.base, column: "*", agg: "COUNT" });
                } else {
                    const wasStar = col.column === "*";
                    [col.alias, col.column] = splitKey(key);
                    if (wasStar || (NUMERIC_FUNCTIONS.has(col.agg) && !columnMeta(col.alias, col.column).numeric)) col.agg = "";
                }
                changed();
            }, { star: true });
            const fn = simpleSelect("Function", col.agg || "",
                FUNCTIONS.map(([v, text]) => [v, text, NUMERIC_FUNCTIONS.has(v) && !meta.numeric]),
                v => {
                    col.agg = v;
                    changed();
                }, { disabled: col.column === "*" });
            return el("div", { class: "row" }, [picker, fn, removeButton("Remove column", () => {
                state.columns = state.columns.filter(c => c !== col);
                changed();
            })]);
        });

        const addColumn = () => {
            const taken = new Set(state.columns.map(keyOf));
            let key = null;
            for (const alias of aliasList()) {
                const free = schema.tables.get(aliasTable(alias)).columns.find(c => !taken.has(`${alias}.${c.name}`));
                if (free) {
                    key = `${alias}.${free.name}`;
                    break;
                }
            }
            const [alias, column] = splitKey(key || `${state.base}.${schema.tables.get(state.base).columns[0].name}`);
            state.columns.push({ id: nextId++, alias, column, agg: "" });
            changed();
        };

        const addAll = el("select", {
            "aria-label": "Add every column of a table",
            onchange: e => {
                const alias = e.target.value;
                if (!alias) return;
                const taken = new Set(state.columns.map(keyOf));
                for (const c of schema.tables.get(aliasTable(alias)).columns) {
                    if (!taken.has(`${alias}.${c.name}`)) state.columns.push({ id: nextId++, alias, column: c.name, agg: "" });
                }
                changed();
            },
        }, [el("option", { value: "", text: "+ All columns of…" }), ...aliasList().map(a => el("option", { value: a, text: a }))]);

        const notes = [];
        if (!state.columns.length) {
            notes.push("No columns chosen, so every column of every table is returned.");
        } else if (state.columns.some(c => c.agg)) {
            const plain = state.columns.filter(c => !c.agg);
            notes.push(plain.length
                ? `Rows are grouped by ${plain.map(labelOf).join(", ")} (GROUP BY is added for you).`
                : "All rows are summarised into a single row.");
        }

        $("columns").replaceChildren(
            ...rows,
            el("div", { class: "row" }, [addButton("+ Add column", addColumn), addAll]),
            ...notes.map(text => el("p", { class: "hint", text })),
            el("label", { class: "check" }, [
                el("input", { type: "checkbox", checked: state.distinct, onchange: e => {
                    state.distinct = e.target.checked;
                    changed(false);
                } }),
                " Remove duplicate rows (DISTINCT)",
            ])
        );
    }

    function renderFilters() {
        const rows = state.filters.map(f => {
            const meta = columnMeta(f.alias, f.column);
            const ops = operatorsFor(meta);
            if (!ops.includes(f.op)) f.op = ops[0];
            return el("div", { class: "row" }, [
                columnPicker(`${f.alias}.${f.column}`, key => {
                    [f.alias, f.column] = splitKey(key);
                    f.op = operatorsFor(columnMeta(f.alias, f.column))[0];
                    f.value = f.value2 = "";
                    changed();
                }),
                simpleSelect("Condition", f.op, ops.map(op => [op, OPERATOR_LABELS[op]]), v => {
                    f.op = v;
                    changed();
                }),
                ...valueInputs(f, meta),
                removeButton("Remove filter", () => {
                    state.filters = state.filters.filter(x => x !== f);
                    changed();
                }),
            ]);
        });

        const header = state.filters.length > 1
            ? el("div", { class: "row" }, [
                "Keep rows matching",
                simpleSelect("Match", state.match, [["all", "all"], ["any", "any"]], v => {
                    state.match = v;
                    changed(false);
                }),
                "of these conditions",
            ])
            : null;

        const addFilter = () => {
            const firstText = schema.tables.get(state.base).columns.find(c => !c.numeric && !c.primaryKey);
            const column = (firstText || schema.tables.get(state.base).columns[0]).name;
            state.filters.push({ id: nextId++, alias: state.base, column, op: "", value: "", value2: "" });
            changed();
        };

        $("filters").replaceChildren(...[
            header,
            ...rows,
            el("div", { class: "row" }, [addButton("+ Add filter", addFilter)]),
            state.filters.length ? null : el("p", { class: "hint", text: "No filters, so all rows are included." }),
        ].filter(Boolean));
    }

    function renderHaving() {
        const aggregates = state.columns.filter(c => c.agg);
        if (!aggregates.length) {
            $("having").replaceChildren(el("p", { class: "hint", text:
                "Give a column a function such as COUNT or SUM in step 2. Then you can keep only some groups here, for example squads where SUM(goals) > 10." }));
            return;
        }
        const rows = state.having.map(h => el("div", { class: "row" }, [
            simpleSelect("Aggregated column", String(h.columnId), aggregates.map(c => [String(c.id), labelOf(c)]), v => {
                h.columnId = Number(v);
                changed(false);
            }, { class: "grow" }),
            simpleSelect("Condition", h.op, HAVING_OPS.map(op => [op, OPERATOR_LABELS[op]]), v => {
                h.op = v;
                changed();
            }),
            ...valueInputs(h, { numeric: true }),
            removeButton("Remove group filter", () => {
                state.having = state.having.filter(x => x !== h);
                changed();
            }),
        ]));
        $("having").replaceChildren(
            ...rows,
            el("div", { class: "row" }, [addButton("+ Add group filter", () => {
                state.having.push({ id: nextId++, columnId: aggregates[0].id, op: "gt", value: "", value2: "" });
                changed();
            })])
        );
    }

    function renderSorting() {
        const sortPicker = (value, onchange) => {
            const groups = [];
            if (state.columns.length) {
                groups.push(el("optgroup", { label: "Result columns" },
                    state.columns.map(c => el("option", { value: `out:${c.id}`, text: labelOf(c) }))));
            }
            for (const alias of aliasList()) {
                groups.push(el("optgroup", { label: `Any column of ${tableGroupLabel(alias)}` },
                    schema.tables.get(aliasTable(alias)).columns.map(c =>
                        el("option", { value: `col:${alias}.${c.name}`, text: `${alias}.${c.name}` }))));
            }
            return el("select", { class: "grow", "aria-label": "Sort by", value, onchange: e => onchange(e.target.value) }, groups);
        };

        const rows = state.orderBy.map(o => el("div", { class: "row" }, [
            sortPicker(o.key, v => {
                o.key = v;
                changed(false);
            }),
            simpleSelect("Direction", o.dir, [["ASC", "ascending"], ["DESC", "descending"]], v => {
                o.dir = v;
                changed(false);
            }),
            removeButton("Remove sort", () => {
                state.orderBy = state.orderBy.filter(x => x !== o);
                changed();
            }),
        ]));

        const addSort = () => {
            const key = state.columns.length
                ? `out:${state.columns[0].id}`
                : `col:${state.base}.${schema.tables.get(state.base).columns[0].name}`;
            state.orderBy.push({ id: nextId++, key, dir: "ASC" });
            changed();
        };

        $("sorting").replaceChildren(
            ...rows,
            el("div", { class: "row" }, [addButton("+ Add sort", addSort)]),
            el("div", { class: "row" }, [
                el("span", { class: "label", text: "Rows per page" }),
                simpleSelect("Rows per page", String(state.limit), PAGE_SIZES.map(n => [String(n), String(n)]), v => {
                    state.limit = Number(v);
                    changed(false);
                }),
            ])
        );
    }

    function render() {
        renderSource();
        renderColumns();
        renderFilters();
        renderHaving();
        renderSorting();
    }

    // -------------------- SQL preview and running --------------------

    function showSql(sql) {
        currentSql = sql;
        sqlBox.classList.remove("error");
        sqlBox.innerHTML = highlightSql(sql);
    }

    function showSqlProblem(message) {
        currentSql = "";
        sqlBox.classList.add("error");
        sqlBox.textContent = message;
    }

    let previewSeq = 0;
    const schedulePreview = debounce(async () => {
        const seq = ++previewSeq;
        try {
            const { sql } = await api("/api/query", toSpec(true));
            if (seq === previewSeq) showSql(sql);
        } catch (err) {
            if (seq === previewSeq) showSqlProblem(err.message);
        }
    }, 200);

    let runSeq = 0;
    async function run() {
        const seq = ++runSeq;
        runButton.disabled = true;
        resultsBox.replaceChildren(loadingBox());
        try {
            const data = await api("/api/query", toSpec(false));
            if (seq !== runSeq) return;
            showSql(data.sql);
            renderResult(resultsBox, data, {
                filename: `${state.base}-query.csv`,
                pager: {
                    offset: data.offset, limit: state.limit, total: data.total,
                    onPage: newOffset => {
                        offset = newOffset;
                        run();
                    },
                },
            });
        } catch (err) {
            if (seq === runSeq) resultsBox.replaceChildren(errorBox(err.message));
        } finally {
            if (seq === runSeq) runButton.disabled = false;
        }
    }

    function flash(button, text) {
        const original = button.textContent;
        button.textContent = text;
        setTimeout(() => (button.textContent = original), 1500);
    }

    async function copy(text, button) {
        try {
            await navigator.clipboard.writeText(text);
            flash(button, "Copied!");
        } catch {
            flash(button, "Copy failed");
        }
    }

    // -------------------- Start up --------------------

    async function init() {
        try {
            const data = await api("/api/schema");
            data.tables.forEach(t => t.columns.forEach(c => (c.table = t.name)));
            schema = { tables: new Map(data.tables.map(t => [t.name, t])), tableList: data.tables, foreignKeys: data.foreignKeys };
        } catch (err) {
            document.querySelector(".builder").replaceChildren(errorBox(`Could not load the database structure. ${err.message}`));
            return;
        }
        if (!schema.tableList.length) {
            document.querySelector(".builder").replaceChildren(errorBox("The database has no tables yet."));
            return;
        }

        examples = EXAMPLES.filter(ex => {
            try {
                const s = sanitize(ex);
                return s.joins.length === (ex.joins || []).length && s.columns.length === (ex.columns || []).length;
            } catch {
                return false;
            }
        });
        const exampleSelect = $("examples");
        exampleSelect.replaceChildren(
            el("option", { value: "", text: "Load an example…" }),
            ...examples.map((ex, i) => el("option", { value: String(i), text: ex.name }))
        );
        exampleSelect.addEventListener("change", () => {
            const ex = examples[Number(exampleSelect.value)];
            exampleSelect.value = "";
            if (!ex) return;
            state = sanitize(ex);
            changed();
            run();
        });

        state = stateFromUrl() || (examples.length ? sanitize(examples[0]) : blankState(schema.tableList[0].name));
        render();
        saveToUrl();
        schedulePreview();
        run();
    }

    runButton.addEventListener("click", () => run());
    $("copy-sql").addEventListener("click", e => currentSql && copy(currentSql, e.currentTarget));
    $("copy-link").addEventListener("click", e => {
        saveToUrl();
        copy(location.href, e.currentTarget);
    });
    $("open-console").addEventListener("click", () => {
        if (currentSql) location.href = "/sql_console#sql=" + encodeURIComponent(currentSql);
    });
    $("reset").addEventListener("click", () => {
        state = blankState(state.base);
        changed();
        run();
    });
    document.addEventListener("keydown", e => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            run();
        }
    });

    init();
})();
