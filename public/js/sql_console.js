// SQL console: a read-only editor with a schema browser, examples and history.
(function () {
    const { api, el, debounce, fmt, renderResult, errorBox, loadingBox } = window.QueryKit;

    const HISTORY_KEY = "wc-sql-history";
    const DRAFT_KEY = "wc-sql-draft";
    const HISTORY_SIZE = 25;

    const EXAMPLES = [
        {
            name: "Top 5 players by goals (JOIN)",
            sql: `SELECT p.player_name, s.squad_name, ps.goals, ps.assists
FROM players_stats ps
JOIN all_players_info p ON p.player_id = ps.player_id
JOIN squads s ON s.squad_id = p.squad_id
ORDER BY ps.goals DESC, ps.assists DESC
LIMIT 5;`,
        },
        {
            name: "Squads with more than 10 goals (GROUP BY + HAVING)",
            sql: `SELECT s.squad_name, SUM(ps.goals) AS total_goals
FROM squads s
JOIN all_players_info p ON p.squad_id = s.squad_id
JOIN players_stats ps ON ps.player_id = p.player_id
GROUP BY s.squad_name
HAVING SUM(ps.goals) > 10
ORDER BY total_goals DESC;`,
        },
        {
            name: "Players scoring more than average (subquery)",
            sql: `SELECT p.player_name, ps.goals
FROM all_players_info p
JOIN players_stats ps ON ps.player_id = p.player_id
WHERE ps.goals > (SELECT AVG(goals) FROM players_stats)
ORDER BY ps.goals DESC;`,
        },
        {
            name: "Top 10 scorers (common table expression)",
            sql: `WITH top_scorers AS (
  SELECT player_id, goals
  FROM players_stats
  ORDER BY goals DESC
  LIMIT 10
)
SELECT p.player_name, t.goals
FROM top_scorers t
JOIN all_players_info p ON p.player_id = t.player_id
ORDER BY t.goals DESC;`,
        },
        {
            name: "Best scorer in each squad (window function)",
            sql: `SELECT squad_name, player_name, goals
FROM (
  SELECT s.squad_name, p.player_name, ps.goals,
         RANK() OVER (PARTITION BY s.squad_id ORDER BY ps.goals DESC) AS squad_rank
  FROM players_stats ps
  JOIN all_players_info p ON p.player_id = ps.player_id
  JOIN squads s ON s.squad_id = p.squad_id
) AS ranked
WHERE squad_rank = 1 AND goals > 0
ORDER BY goals DESC, squad_name;`,
        },
        {
            name: "Match results with both team names (table joined twice)",
            sql: `SELECT m.match_date, t1.squad_name AS team_1, m.score_squad_1,
       m.score_squad_2, t2.squad_name AS team_2, st.stadium_name
FROM matches m
JOIN squads t1 ON t1.squad_id = m.squad_1_id
JOIN squads t2 ON t2.squad_id = m.squad_2_id
JOIN stadiums st ON st.stadium_id = m.stadium_id
ORDER BY m.match_id;`,
        },
        {
            name: "Goals scored by each team in all matches (UNION ALL)",
            sql: `SELECT s.squad_name, COUNT(*) AS matches_played, SUM(g.goals) AS goals_scored
FROM (
  SELECT squad_1_id AS squad_id, score_squad_1 AS goals FROM matches
  UNION ALL
  SELECT squad_2_id, score_squad_2 FROM matches
) AS g
JOIN squads s ON s.squad_id = g.squad_id
GROUP BY s.squad_name
ORDER BY goals_scored DESC;`,
        },
        {
            name: "Goalkeeper clean-sheet percentage",
            sql: `SELECT p.player_name AS goalkeeper, p.matches_played, k.clean_sheets,
       ROUND(k.clean_sheets * 100.0 / NULLIF(p.matches_played, 0), 1) AS clean_sheet_pct
FROM keepers_stats k
JOIN all_players_info p ON p.player_id = k.player_id
ORDER BY clean_sheet_pct DESC;`,
        },
        {
            name: "Keepers who faced penalties but saved none (EXISTS)",
            sql: `SELECT p.player_name, s.squad_name
FROM all_players_info p
JOIN squads s ON s.squad_id = p.squad_id
WHERE EXISTS (
  SELECT 1
  FROM keepers_stats k
  WHERE k.player_id = p.player_id
    AND k.penalty_kicks_attempted > 0
    AND k.penalty_kicks_saved = 0
);`,
        },
        {
            name: "Most booked teams",
            sql: `SELECT s.squad_name, SUM(ps.yellow_cards) AS yellow_cards, SUM(ps.red_cards) AS red_cards
FROM players_stats ps
JOIN all_players_info p ON p.player_id = ps.player_id
JOIN squads s ON s.squad_id = p.squad_id
GROUP BY s.squad_name
ORDER BY yellow_cards DESC, red_cards DESC;`,
        },
        { name: "List all tables (SHOW)", sql: "SHOW TABLES;" },
        { name: "Structure of a table (DESCRIBE)", sql: "DESCRIBE all_players_info;" },
        {
            name: "How MySQL runs a query (EXPLAIN)",
            sql: `EXPLAIN
SELECT p.player_name, s.squad_name
FROM all_players_info p
JOIN squads s ON s.squad_id = p.squad_id
WHERE p.age < 21;`,
        },
    ];

    const $ = id => document.getElementById(id);
    const editor = $("editor");
    const resultsBox = $("results");
    const runButton = $("run");
    const historySelect = $("history");

    // localStorage can be unavailable (private windows, blocked storage); the page works without it
    function storageGet(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw === null ? fallback : JSON.parse(raw);
        } catch {
            return fallback;
        }
    }

    function storageSet(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch {
            // ignore
        }
    }

    const saveDraft = debounce(() => storageSet(DRAFT_KEY, editor.value), 300);

    function setEditor(text) {
        editor.value = text;
        editor.focus();
        editor.setSelectionRange(text.length, text.length);
        saveDraft();
    }

    function insertAtCursor(text) {
        editor.focus();
        editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, "end");
        saveDraft();
    }

    // The statement under the cursor: text between the semicolons around it,
    // ignoring semicolons inside quotes and comments
    function statementAtCursor(text, pos) {
        const ends = [];
        let quote = null;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (quote) {
                if (ch === "\\" && quote !== "`") i++;
                else if (ch === quote) quote = null;
                continue;
            }
            if (ch === "'" || ch === '"' || ch === "`") quote = ch;
            else if ((ch === "-" && text[i + 1] === "-") || ch === "#") {
                const nl = text.indexOf("\n", i);
                i = nl === -1 ? text.length : nl;
            } else if (ch === "/" && text[i + 1] === "*") {
                const close = text.indexOf("*/", i + 2);
                i = close === -1 ? text.length : close + 1;
            } else if (ch === ";") ends.push(i);
        }
        const parts = [];
        let start = 0;
        for (const end of [...ends, text.length]) {
            parts.push({ start, end, sql: text.slice(start, end) });
            start = end + 1;
        }
        const real = parts.filter(p => p.sql.trim());
        if (!real.length) return "";
        const hit = real.find(p => pos >= p.start && pos <= p.end + 1)
            || [...real].reverse().find(p => p.end < pos)
            || real[0];
        return hit.sql.trim();
    }

    function currentStatement() {
        const { selectionStart, selectionEnd, value } = editor;
        const selected = value.slice(selectionStart, selectionEnd);
        return selected.trim() ? selected.trim() : statementAtCursor(value, selectionStart);
    }

    // -------------------- History --------------------

    function renderHistory() {
        const history = storageGet(HISTORY_KEY, []);
        historySelect.replaceChildren(
            el("option", { value: "", text: history.length ? `Recent queries (${history.length})…` : "No recent queries yet" }),
            ...history.map((sql, i) => el("option", { value: String(i), text: sql.replace(/\s+/g, " ").slice(0, 90) }))
        );
        historySelect.disabled = !history.length;
    }

    function remember(sql) {
        const history = storageGet(HISTORY_KEY, []).filter(s => s !== sql);
        history.unshift(sql);
        storageSet(HISTORY_KEY, history.slice(0, HISTORY_SIZE));
        renderHistory();
    }

    // -------------------- Running --------------------

    let runSeq = 0;
    async function run() {
        const sql = currentStatement();
        if (!sql) {
            resultsBox.replaceChildren(errorBox("Type a query first, for example SELECT * FROM squads;"));
            return;
        }
        const seq = ++runSeq;
        runButton.disabled = true;
        resultsBox.replaceChildren(loadingBox());
        try {
            const data = await api("/api/sql", { sql });
            if (seq !== runSeq) return;
            renderResult(resultsBox, data, { filename: "query-result.csv" });
            remember(sql);
        } catch (err) {
            if (seq === runSeq) resultsBox.replaceChildren(errorBox(err.message));
        } finally {
            if (seq === runSeq) runButton.disabled = false;
        }
    }

    // -------------------- Schema browser --------------------

    function renderSchema(data) {
        $("db-name").textContent = data.database;
        const fkByColumn = new Map(data.foreignKeys.map(f => [`${f.table}.${f.column}`, f]));

        $("schema-tree").replaceChildren(...data.tables.map(t => el("details", { class: "schema-table", "data-name": t.name.toLowerCase() }, [
            el("summary", {}, [
                el("span", { class: "tname", text: t.name }),
                el("span", { class: "muted small", text: `${fmt(t.rowCount)} rows` }),
            ]),
            el("div", { class: "table-actions" }, [
                el("button", {
                    type: "button", class: "btn ghost small", text: "Preview rows",
                    onclick: () => {
                        setEditor(`SELECT *\nFROM ${t.name}\nLIMIT 100;`);
                        run();
                    },
                }),
                el("button", { type: "button", class: "btn ghost small", text: "Insert name", onclick: () => insertAtCursor(t.name) }),
            ]),
            el("ul", { class: "column-list" }, t.columns.map(c => {
                const fk = fkByColumn.get(`${t.name}.${c.name}`);
                const shortType = /^(enum|set)\(/i.test(c.type) ? c.type.slice(0, c.type.indexOf("(")) : c.type;
                return el("li", { "data-name": c.name.toLowerCase() }, el("button", {
                    type: "button", class: "column", title: `Insert ${t.name}.${c.name}  (${c.type})`,
                    onclick: () => insertAtCursor(`${t.name}.${c.name}`),
                }, [
                    el("span", { class: "cname", text: c.name }),
                    c.primaryKey ? el("span", { class: "badge pk", text: "PK" }) : null,
                    fk ? el("span", { class: "badge fk", text: `→ ${fk.refTable}` }) : null,
                    el("span", { class: "ctype", text: shortType }),
                ]));
            })),
        ])));
    }

    function filterSchema(query) {
        const q = query.trim().toLowerCase();
        for (const details of document.querySelectorAll(".schema-table")) {
            const tableMatch = !q || details.dataset.name.includes(q);
            let columnMatches = 0;
            for (const li of details.querySelectorAll("li")) {
                const match = tableMatch || li.dataset.name.includes(q);
                li.hidden = !match;
                if (match) columnMatches++;
            }
            details.hidden = !tableMatch && !columnMatches;
            if (q) details.open = !details.hidden;
        }
    }

    // -------------------- Start up --------------------

    $("examples").replaceChildren(
        el("option", { value: "", text: "Example queries…" }),
        ...EXAMPLES.map((ex, i) => el("option", { value: String(i), text: ex.name }))
    );
    $("examples").addEventListener("change", e => {
        const ex = EXAMPLES[Number(e.target.value)];
        e.target.value = "";
        if (!ex) return;
        setEditor(ex.sql);
        run();
    });
    historySelect.addEventListener("change", () => {
        const sql = storageGet(HISTORY_KEY, [])[Number(historySelect.value)];
        historySelect.value = "";
        if (sql) setEditor(sql);
    });
    runButton.addEventListener("click", run);
    $("clear").addEventListener("click", () => {
        setEditor("");
        resultsBox.replaceChildren();
    });
    $("schema-filter").addEventListener("input", e => filterSchema(e.target.value));

    editor.addEventListener("input", saveDraft);
    editor.addEventListener("keydown", e => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            run();
        } else if (e.key === "Tab" && !e.shiftKey) {
            e.preventDefault();
            insertAtCursor("  ");
        }
    });

    // A query sent from the builder arrives in the URL; otherwise restore the last draft
    const fromBuilder = /^#sql=(.+)$/.exec(location.hash);
    if (fromBuilder) {
        let sql = "";
        try {
            sql = decodeURIComponent(fromBuilder[1]);
        } catch {
            // ignore a malformed link
        }
        history.replaceState(null, "", location.pathname);
        setEditor(sql);
        if (sql) run();
    } else {
        editor.value = storageGet(DRAFT_KEY, "") || EXAMPLES[0].sql;
    }
    renderHistory();

    api("/api/schema")
        .then(renderSchema)
        .catch(err => $("schema-tree").replaceChildren(el("p", { class: "error-text", text: `Could not load the schema. ${err.message}` })));
})();
