const axios = require("axios");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function assertConfig() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase env vars missing (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
  }
}

function headers(extra = {}) {
  return {
    "Content-Type": "application/json",
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

// Insert a row. Returns the created row(s) unless minimal=true.
async function insert(table, record, { minimal = true } = {}) {
  assertConfig();
  const prefer = minimal ? "return=minimal" : "return=representation";
  const res = await axios.post(`${SUPABASE_URL}/rest/v1/${table}`, record, {
    headers: headers({ Prefer: prefer }),
  });
  return res.data;
}

// Patch rows matching a PostgREST filter (e.g. { user_id: "eq.abc" }).
async function patch(table, filter, updates) {
  assertConfig();
  const params = new URLSearchParams(filter).toString();
  const res = await axios.patch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, updates, {
    headers: headers({ Prefer: "return=representation" }),
  });
  return res.data;
}

// Select rows matching a PostgREST filter. Returns an array.
async function select(table, filter, { columns = "*" } = {}) {
  assertConfig();
  const params = new URLSearchParams({ select: columns, ...filter }).toString();
  const res = await axios.get(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: headers(),
  });
  return res.data;
}

module.exports = { insert, patch, select };
