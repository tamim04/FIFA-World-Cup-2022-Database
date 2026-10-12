// Helpers shared by the query builder and the SQL console.
(function () {
    async function api(url, body) {
        const options = body === undefined
            ? {}
            : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
        const res = await fetch(url, options);
        let data;
        try {
            data = await res.json();
        } catch {
            throw new Error(`The server returned an unexpected response (${res.status}).`);
        }
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
        return data;
    }

    // Tiny DOM builder: el("button", { class: "btn", text: "Run", onclick }, [children])
    function el(tag, props = {}, children = []) {
        const node = document.createElement(tag);
        let value;
        for (const [key, v] of Object.entries(props)) {
            if (v === undefined || v === null || v === false) continue;
            if (key === "class") node.className = v;
            else if (key === "text") node.textContent = v;
            else if (key === "value") value = v; // set after children so <select> options exist
            else if (key.startsWith("on") && typeof v === "function") node.addEventListener(key.slice(2), v);
            else if (v === true) node[key] = true;
            else node.setAttribute(key, v);
        }
        for (const child of [].concat(children)) {
            if (child !== null && child !== undefined && child !== false) node.append(child);
        }
        if (value !== undefined) node.value = value;
        return node;
    }

    function debounce(fn, ms) {
        let timer;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), ms);
        };
    }

    const fmt = n => Number(n).toLocaleString();

    const KEYWORDS = new Set((
        "SELECT DISTINCT FROM AS INNER LEFT RIGHT OUTER CROSS JOIN ON WHERE AND OR NOT IN IS NULL LIKE " +
        "BETWEEN GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET WITH UNION ALL EXISTS CASE WHEN THEN ELSE END " +
        "SHOW TABLES DESCRIBE DESC EXPLAIN COUNT SUM AVG MIN MAX ROUND NULLIF OVER PARTITION RANK TABLE"
    ).split(" "));

    function escapeHtml(text) {
        return text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    // Returns HTML with SQL keywords, identifiers, strings and numbers wrapped in spans
    function highlightSql(sql) {
        return sql.replace(
            /(`(?:[^`]|``)*`)|('(?:[^'\\]|\\.|'')*')|([A-Za-z_][A-Za-z0-9_]*)|(\b\d+(?:\.\d+)?\b)|([\s\S])/g,
            (match, ident, str, word, num, other) => {
                if (ident) return `<span class="sql-ident">${escapeHtml(ident)}</span>`;
                if (str) return `<span class="sql-str">${escapeHtml(str)}</span>`;
                if (word) return KEYWORDS.has(word.toUpperCase()) ? `<span class="sql-kw">${word}</span>` : word;
                if (num) return `<span class="sql-num">${num}</span>`;
                return escapeHtml(other);
            }
        );
    }

    function toCsv(columns, rows) {
        const cell = v => {
            if (v === null || v === undefined) return "";
            const s = typeof v === "object" ? JSON.stringify(v) : String(v);
            return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        return [columns, ...rows].map(row => row.map(cell).join(",")).join("\r\n");
    }

    function downloadCsv(filename, columns, rows) {
        // The byte-order mark makes Excel read accented names correctly
        const blob = new Blob(["﻿" + toCsv(columns, rows)], { type: "text/csv;charset=utf-8" });
        const link = el("a", { href: URL.createObjectURL(blob), download: filename });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }

    function resultCell(value) {
        if (value === null || value === undefined) return el("td", { class: "null", text: "NULL" });
        if (typeof value === "object") return el("td", { text: JSON.stringify(value) });
        const numeric = typeof value === "number" || /^-?\d+(\.\d+)?$/.test(value);
        return el("td", { class: numeric ? "num" : null, text: String(value) });
    }

    // Draws a result set: summary, optional pager, CSV download and the table itself.
    // options.pager = { offset, limit, total, onPage(newOffset) } for server-side paging.
    function renderResult(container, result, options = {}) {
        const { columns = [], rows = [] } = result;
        const pager = options.pager;

        const summary = [];
        if (pager) {
            summary.push(pager.total === 0
                ? "No rows"
                : `Rows ${fmt(pager.offset + 1)}–${fmt(pager.offset + rows.length)} of ${fmt(pager.total)}`);
        } else if (result.truncated) {
            summary.push(`First ${fmt(rows.length)} rows shown (there are more; add a LIMIT or a filter)`);
        } else {
            summary.push(`${fmt(rows.length)} row${rows.length === 1 ? "" : "s"}`);
        }
        if (result.elapsedMs !== undefined) summary.push(`${fmt(result.elapsedMs)} ms`);

        const tools = [];
        if (pager && pager.total > rows.length) {
            tools.push(
                el("button", {
                    class: "btn ghost small", type: "button", text: "‹ Previous", disabled: pager.offset === 0,
                    onclick: () => pager.onPage(Math.max(0, pager.offset - pager.limit)),
                }),
                el("button", {
                    class: "btn ghost small", type: "button", text: "Next ›", disabled: pager.offset + pager.limit >= pager.total,
                    onclick: () => pager.onPage(pager.offset + pager.limit),
                })
            );
        }
        if (columns.length && rows.length) {
            tools.push(el("button", {
                class: "btn ghost small", type: "button", text: "Download CSV",
                title: "Download the rows shown here as a CSV file",
                onclick: () => downloadCsv(options.filename || "query-result.csv", columns, rows),
            }));
        }

        const bar = el("div", { class: "result-bar" }, [
            el("span", { class: "result-summary", text: summary.join(" · ") }),
            el("div", { class: "result-tools" }, tools),
        ]);

        if (!columns.length) {
            container.replaceChildren(el("div", { class: "card result-card" }, [
                bar, el("p", { class: "muted", text: "The statement ran but returned no result set." }),
            ]));
            return;
        }

        const body = rows.length
            ? rows.map(row => el("tr", {}, row.map(resultCell)))
            : el("tr", {}, el("td", { class: "empty", colspan: String(columns.length), text: "No rows match." }));
        const table = el("table", { class: "result-table" }, [
            el("thead", {}, el("tr", {}, columns.map(c => el("th", { scope: "col", text: c })))),
            el("tbody", {}, body),
        ]);
        container.replaceChildren(el("div", { class: "card result-card" }, [bar, el("div", { class: "table-wrap" }, table)]));
    }

    function errorBox(message) {
        return el("div", { class: "card error-box", role: "alert" }, [
            el("strong", { text: "Query failed" }),
            el("p", { text: message }),
        ]);
    }

    function loadingBox(text = "Running…") {
        return el("div", { class: "card loading", text });
    }

    window.QueryKit = { api, el, debounce, fmt, highlightSql, renderResult, errorBox, loadingBox };
})();
