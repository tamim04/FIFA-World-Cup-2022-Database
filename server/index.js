const path = require("path");

// Load DB_* and PORT settings from .env before any module reads process.env
try {
    process.loadEnvFile(path.join(__dirname, "../.env"));
} catch (err) {
    if (err.code !== "ENOENT") throw err; // no .env file: use real environment variables or defaults
}

const express = require("express");
const viewRoutes = require("../routes/view_routes");
const insertRoutes = require("../routes/insert_routes");
const deleteRoutes = require("../routes/delete_routes");
const searchRoutes = require("../routes/search_routes");
const queryRoutes = require("../routes/query_routes");

const app = express();

// Configure Express app
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "../views"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "../public")));

// Static menu pages
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "../pages/index.html"));
});

app.get("/view_tables", (req, res) => {
    res.sendFile(path.join(__dirname, "../pages/view_table_list.html"));
});

app.get("/insert_data_into_tables", (req, res) => {
    res.sendFile(path.join(__dirname, "../pages/insert_table_list.html"));
});

// Feature routes
app.use("/", viewRoutes);
app.use("/", insertRoutes);
app.use("/", deleteRoutes);
app.use("/", searchRoutes);
app.use("/", queryRoutes);

// Start the server
const PORT = process.env.PORT || 9000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

module.exports = app;
