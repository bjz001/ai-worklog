import { loadEnvFile } from "node:process";
import mysql from "mysql2/promise";

loadEnvFile(".env.local");
const appUser = process.env.APP_DB_USER ?? "";
const appPassword = process.env.APP_DB_PASSWORD ?? "";
const database = process.env.MYSQL_DATABASE ?? "";
if (!/^[a-z][a-z0-9_]{2,31}$/.test(appUser)) {
  throw new Error("APP_DB_USER is invalid");
}
if (appPassword.length < 24 || appPassword.length > 256) {
  throw new Error("APP_DB_PASSWORD is invalid");
}
if (!/^[A-Za-z0-9_]{1,64}$/.test(database)) {
  throw new Error("MYSQL_DATABASE is invalid");
}

const connection = await mysql.createConnection({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  connectTimeout: 5_000,
  ssl: process.env.MYSQL_SSL === "true"
    ? { minVersion: "TLSv1.2", rejectUnauthorized: true }
    : undefined
});

try {
  const [existing] = await connection.execute(
    "SELECT 1 FROM mysql.user WHERE user = ? AND host = '%' LIMIT 1",
    [appUser]
  );
  if (existing.length > 0) throw new Error("APP_DB_USER already exists");
  await connection.query(
    `CREATE USER '${appUser}'@'%' IDENTIFIED BY ${connection.escape(appPassword)}`
  );
  await connection.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON \`${database}\`.* TO '${appUser}'@'%'`
  );
  console.log(
    JSON.stringify({
      created: true,
      scope: database,
      privileges: ["SELECT", "INSERT", "UPDATE", "DELETE"]
    })
  );
} finally {
  await connection.end();
}
