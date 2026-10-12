// mysql2 supports MySQL 8's default caching_sha2_password auth (the old "mysql" package does not)
var mysql = require('mysql2');

// Settings come from .env (see .env.example); the defaults suit a local MySQL install
var con = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "123456",
    database: process.env.DB_NAME || "worldcup2022",
});

// Fail loudly at startup if the database is unreachable
con.getConnection((err, connection) => {
    if (err) {
        console.error("Could not connect to MySQL:", err.message);
        console.error("Check DB_HOST, DB_USER, DB_PASSWORD and DB_NAME in your .env file.");
        return;
    }
    console.log("Connected to MySQL database");
    connection.release();
});

module.exports = con;
